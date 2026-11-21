import { EventEmitter } from 'node:events'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { epicProgress, epicTaskPrompt, nextReadyTask, openEpicTasks, waitingReason } from '../shared/boardOrder'
import type { Board, Epic, EpicRun, ProviderChoice, RunSummary, Task } from '../shared/types'
import type { BoardService } from './board'
import type { ChatStore } from './chats'
import type { ProjectService } from './projects'
import { readJson, writeJson } from './store'

export interface EpicRunEvents {
  update: [run: EpicRun]
}

export interface EpicRunDeps {
  board: BoardService
  chats: ChatStore
  projects: Pick<ProjectService, 'get'>
  /** Opens a protocol chat on a task (ProtocolService.begin). */
  begin: (projectId: string, prompt: string, provider: ProviderChoice, opts: { taskId: string }) => Promise<RunSummary>
  /** Whether a turn of the chat is running now (AgentSupervisor.isChatLive). */
  isChatLive: (chatId: string) => boolean
  /** Subscribes to turns ending (a failed setup ends the turn without changing the chat record). */
  onTurnEnded: (cb: (projectId: string, chatId: string) => void) => void
}

const PROJECT_ID = /^[\w-]{1,100}$/
const ACTIVE = new Set<EpicRun['status']>(['running', 'waiting', 'paused'])

/**
 * alive: working, or waiting for the user. stuck: its setup failed and nothing runs. merged: it
 * merged or shipped, and the board is about to mark its task done. closed: discarded or finished.
 */
type ChatCondition = 'alive' | 'stuck' | 'merged' | 'closed'

/**
 * Works through an epic one task at a time: a protocol chat on the next ready task, and
 * when the board says that task is done (it ships, or is merged), the next one. Every stage
 * inside a chat still waits for the user; this only saves starting each chat by hand.
 * One at a time on purpose: each ship merges into the base branch, and the next chat's
 * worktree must branch from that merge.
 * Runs live at <appData>/epic-runs/<projectId>.json, so they go on after a restart.
 */
export class EpicRunService extends EventEmitter<EpicRunEvents> {
  private readonly dir: string
  private readonly runs = new Map<string, EpicRun>()
  private readonly paths = new Map<string, string>()
  /** Steps of one project's run happen one at a time, so a task is never started twice. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Files are written in order, always with the latest state (stop writes outside the queue). */
  private readonly writes = new Map<string, Promise<void>>()
  private readonly loaded: Promise<void>

  constructor(appDataDir: string, private readonly deps: EpicRunDeps) {
    super()
    this.dir = join(appDataDir, 'epic-runs')
    this.loaded = this.load()
    deps.board.on('change', (path) => {
      for (const [projectId, p] of this.paths) if (p === path) this.kick(projectId)
    })
    // The board follows chats asynchronously; read it once it has caught up. A chat whose setup
    // failed comes back to life when the user retries it there: the paused run goes on by itself.
    const chatChanged = (projectId: string, chatId: string) => {
      if (this.runs.get(projectId)?.currentChatId === chatId) void deps.board.settled().then(() => this.kick(projectId, true))
    }
    deps.chats.on('update', (chat) => chatChanged(chat.projectId, chat.id))
    deps.onTurnEnded(chatChanged)
  }

  async status(projectId: string): Promise<EpicRun | null> {
    await this.loaded
    return this.runs.get(projectId) ?? null
  }

  /** Throws what start() would refuse with, without changing anything (asked before any approval dialog). */
  async check(projectId: string, epicRef: string): Promise<void> {
    await this.loaded
    const board = this.deps.board.board(await this.projectPath(projectId))
    this.validate(projectId, board, epicRef)
  }

  /** Starts (or resumes) running an epic. Refuses while another epic of the project is running. */
  async start(projectId: string, epicRef: string, provider: ProviderChoice): Promise<EpicRun> {
    await this.loaded
    return this.serial(projectId, async () => {
      const path = await this.projectPath(projectId)
      const board = this.deps.board.board(path)
      const { epic, resume } = this.validate(projectId, board, epicRef)
      const existing = this.runs.get(projectId)
      const now = new Date().toISOString()
      const run: EpicRun =
        resume && existing
          ? { ...existing, provider, status: 'running', reason: null }
          : {
              projectId,
              epicId: epic.id,
              epicKey: epic.key,
              epicTitle: epic.title,
              provider,
              status: 'running',
              currentTaskId: null,
              currentTaskKey: null,
              currentChatId: null,
              reason: null,
              ...epicProgress(board, epic.id),
              startedAt: now,
              updatedAt: now
            }
      // Resuming after a closed chat: the task is open again, so it gets a new chat.
      if (resume && run.currentChatId && (await this.condition(run.currentChatId)) === 'closed') {
        Object.assign(run, { currentTaskId: null, currentTaskKey: null, currentChatId: null })
      }
      await this.save(run, true)
      try {
        if (epic.status === 'todo') this.deps.board.update(path, epic.id, { status: 'doing' })
        await this.step(run)
      } catch (err) {
        await this.fail(projectId, err)
      }
      return this.runs.get(projectId)!
    })
  }

  /**
   * Stops opening new chats; chats already open stay as they are. Applied at once, outside the
   * queue, so it never waits behind a chat that is still being set up. A finished run is dismissed.
   */
  async stop(projectId: string): Promise<EpicRun | null> {
    await this.loaded
    const run = this.runs.get(projectId)
    if (!run || (!ACTIVE.has(run.status) && run.status !== 'finished')) return run ?? null
    await this.save({ ...run, status: 'stopped', reason: null }, true)
    return this.runs.get(projectId)!
  }

  /** Resolves once the steps queued so far for a project are done (tests). */
  async settled(projectId: string): Promise<void> {
    await this.queues.get(projectId)
    await this.writes.get(projectId)
  }

  private validate(projectId: string, board: Board, epicRef: string): { epic: Epic; resume: boolean } {
    const epic = board.epics.find((e) => (e.id === epicRef || e.key === epicRef) && !e.archivedAt)
    if (!epic) throw new Error('Epic not found')
    const existing = this.runs.get(projectId)
    if (existing && ACTIVE.has(existing.status) && existing.epicId !== epic.id) {
      throw new Error(`${existing.epicKey} is already running in this project; stop it first`)
    }
    const resume = !!existing && existing.epicId === epic.id && ACTIVE.has(existing.status)
    if (!openEpicTasks(board, epic.id).length) throw new Error(`Every task of ${epic.key} is done already`)
    if (!resume && !nextReadyTask(board, epic.id)) throw new Error(`No task of ${epic.key} can start yet. ${waitingReason(board, epic.id).reason}`)
    return { epic, resume }
  }

  /** Re-reads the board for a running or waiting run; `chatUpdate` also lets a paused run go on once its chat is alive again. */
  private kick(projectId: string, chatUpdate = false): void {
    void this.serial(projectId, async () => {
      const run = this.runs.get(projectId)
      if (!run) return
      const revive = chatUpdate && run.status === 'paused' && !!run.currentChatId && (await this.condition(run.currentChatId)) === 'alive'
      if (run.status !== 'running' && run.status !== 'waiting' && !revive) return
      try {
        await this.step(run)
      } catch (err) {
        await this.fail(projectId, err)
      }
    }).catch(() => {})
  }

  /** A step that failed (folder gone, board locked) pauses the run with the reason, never leaves it looking busy. */
  private async fail(projectId: string, err: unknown): Promise<void> {
    const run = this.runs.get(projectId)
    if (!run || run.status === 'stopped' || run.status === 'finished') return
    await this.save({ ...run, status: 'paused', reason: `The epic run stopped on an error: ${(err as Error).message}. Resume to try again.` })
  }

  /** Looks at the board and does the one thing the run needs next, if anything. */
  private async step(run: EpicRun): Promise<void> {
    const path = this.paths.get(run.projectId) ?? (await this.projectPath(run.projectId))
    const board = this.deps.board.board(path)
    const epic = board.epics.find((e) => e.id === run.epicId)
    if (!epic || epic.archivedAt) return this.save({ ...run, status: 'paused', reason: `${run.epicKey} was archived or removed` })
    const counts = { epicKey: epic.key, epicTitle: epic.title, ...epicProgress(board, epic.id) }

    if (run.currentTaskId) {
      const task = board.tasks.find((t) => t.id === run.currentTaskId)
      if (task && !task.archivedAt && task.status !== 'done') {
        const chatId = run.currentChatId ?? task.chatIds.at(-1) ?? null
        const state = chatId ? await this.condition(chatId) : null
        // Merged: the board follows the chat a moment later, and that change brings the run back here.
        if (state === 'alive' || state === 'merged') return this.save({ ...run, ...counts, currentChatId: chatId, status: 'running', reason: null })
        if (state === 'stuck') {
          return this.save({ ...run, ...counts, currentChatId: chatId, status: 'paused', reason: `The chat on ${task.key} could not be set up. Open it and send a message to retry; the run goes on once it works.` })
        }
        if (state === 'closed') {
          return this.save({ ...run, ...counts, currentChatId: chatId, status: 'paused', reason: `The chat on ${task.key} was closed before the task was done. Resume to start a new chat on it, or stop.` })
        }
      }
      // Done, archived or never started: on to the next task.
      run = { ...run, currentTaskId: null, currentTaskKey: null, currentChatId: null }
    }

    const next = nextReadyTask(board, epic.id)
    if (!next) {
      if (!openEpicTasks(board, epic.id).length) {
        if (epic.status !== 'done') this.deps.board.update(path, epic.id, { status: 'done' })
        return this.save({ ...run, ...counts, status: 'finished', reason: null })
      }
      const why = waitingReason(board, epic.id)
      return this.save({ ...run, ...counts, status: why.held ? 'waiting' : 'paused', reason: why.reason })
    }
    await this.startTask(run, epic, next, board, counts)
  }

  private async startTask(run: EpicRun, epic: Epic, task: Task, board: Board, counts: Partial<EpicRun>): Promise<void> {
    // A chat the user already opened on this task is adopted, never doubled.
    for (const id of [...task.chatIds].reverse()) {
      const state = await this.condition(id)
      if (state === 'alive' || state === 'stuck') {
        await this.save({ ...run, ...counts, status: 'running', reason: null, currentTaskId: task.id, currentTaskKey: task.key, currentChatId: id })
        return this.step(this.runs.get(run.projectId)!)
      }
    }
    // Saved before the chat starts: the board changes the chat makes must not start it again.
    await this.save({ ...run, ...counts, status: 'running', reason: null, currentTaskId: task.id, currentTaskKey: task.key, currentChatId: null })
    if (this.runs.get(run.projectId)!.status === 'stopped') return
    try {
      const summary = await this.deps.begin(run.projectId, epicTaskPrompt(epic, task), run.provider, { taskId: task.id })
      // Stopped while the chat was being set up: the chat stays (Stop leaves open chats), the run stays stopped.
      await this.save({ ...this.runs.get(run.projectId)!, currentChatId: summary.chatId ?? summary.id, ...epicProgress(board, epic.id) })
    } catch (err) {
      await this.save({ ...this.runs.get(run.projectId)!, status: 'paused', currentTaskId: null, currentTaskKey: null, currentChatId: null, reason: `Could not start a chat on ${task.key}: ${(err as Error).message}` })
    }
  }

  private async condition(chatId: string): Promise<ChatCondition> {
    const chat = await this.deps.chats.get(chatId)
    if (chat && chat.doneReason !== 'discarded' && (chat.state === 'merged' || chat.protocol?.stage === 'shipped')) return 'merged'
    if (!chat || chat.worktreeRemoved || chat.doneReason === 'discarded' || (chat.state !== 'active' && chat.state !== 'setting-up')) return 'closed'
    // A chat stays 'setting-up' after its setup command failed; only a running turn is still setting it up.
    if (chat.state === 'setting-up' && !this.deps.isChatLive(chatId)) return 'stuck'
    return 'alive'
  }

  private async projectPath(projectId: string): Promise<string> {
    if (!PROJECT_ID.test(projectId)) throw new Error('Invalid project id')
    const project = await this.deps.projects.get(projectId)
    if (project.status !== 'ok') throw new Error('Project folder is missing')
    this.paths.set(projectId, project.path)
    return project.path
  }

  private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve()
    const next = prev.then(fn)
    this.queues.set(projectId, next.then(() => {}, () => {}))
    return next
  }

  /**
   * Records the run's new state. Once stopped, only a new start (`restart`) changes the status:
   * a step that was already under way must not bring a stopped run back.
   */
  private async save(run: EpicRun, restart = false): Promise<void> {
    const prev = this.runs.get(run.projectId)
    const status = !restart && prev?.status === 'stopped' && prev.epicId === run.epicId ? 'stopped' : run.status
    const next: EpicRun = { ...run, status, reason: status === 'stopped' ? null : run.reason, updatedAt: new Date().toISOString() }
    this.runs.set(run.projectId, next)
    this.emit('update', next)
    const file = join(this.dir, `${run.projectId}.json`)
    const write = (this.writes.get(run.projectId) ?? Promise.resolve()).then(() => writeJson(file, this.runs.get(run.projectId)))
    this.writes.set(run.projectId, write.catch(() => {}))
    await write
  }

  /** Reads saved runs and lets the active ones catch up with what happened while the app was closed. */
  private async load(): Promise<void> {
    const files = await readdir(this.dir).catch(() => [] as string[])
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const run = await readJson<EpicRun>(join(this.dir, f)).catch(() => null)
      if (!run || !PROJECT_ID.test(run.projectId)) continue
      this.runs.set(run.projectId, run)
      if (run.status === 'running' || run.status === 'waiting') {
        void this.projectPath(run.projectId).then(
          () => this.kick(run.projectId),
          (err) => void this.serial(run.projectId, () => this.fail(run.projectId, err)).catch(() => {})
        )
      }
    }
  }
}

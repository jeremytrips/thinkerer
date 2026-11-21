import { EventEmitter } from 'node:events'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { epicProgress, epicTaskPrompt, nextReadyTask, openEpicTasks, outsideBlockers } from '../shared/boardOrder'
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
}

const PROJECT_ID = /^[\w-]{1,100}$/
const ACTIVE = new Set<EpicRun['status']>(['running', 'waiting', 'paused'])

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
  private readonly loaded: Promise<void>

  constructor(appDataDir: string, private readonly deps: EpicRunDeps) {
    super()
    this.dir = join(appDataDir, 'epic-runs')
    this.loaded = this.load()
    deps.board.on('change', (path) => {
      for (const [projectId, p] of this.paths) if (p === path) this.kick(projectId)
    })
    deps.chats.on('update', (chat) => {
      const run = this.runs.get(chat.projectId)
      // The board follows chats asynchronously; read it once it has caught up.
      if (run?.currentChatId === chat.id) void deps.board.settled().then(() => this.kick(chat.projectId))
    })
  }

  async status(projectId: string): Promise<EpicRun | null> {
    await this.loaded
    return this.runs.get(projectId) ?? null
  }

  /** Starts (or resumes) running an epic. Refuses while another epic of the project is running. */
  async start(projectId: string, epicRef: string, provider: ProviderChoice): Promise<EpicRun> {
    await this.loaded
    return this.serial(projectId, async () => {
      const path = await this.projectPath(projectId)
      const board = this.deps.board.board(path)
      const epic = board.epics.find((e) => (e.id === epicRef || e.key === epicRef) && !e.archivedAt)
      if (!epic) throw new Error('Epic not found')
      const existing = this.runs.get(projectId)
      if (existing && ACTIVE.has(existing.status) && existing.epicId !== epic.id) {
        throw new Error(`${existing.epicKey} is already running in this project; stop it first`)
      }
      if (!openEpicTasks(board, epic.id).length) throw new Error(`Every task of ${epic.key} is done already`)
      if (!nextReadyTask(board, epic.id) && !(existing?.epicId === epic.id && existing.currentTaskId)) {
        const keys = outsideBlockers(board, epic.id).map((t) => t.key)
        throw new Error(`No task of ${epic.key} can start yet: they wait on ${keys.join(', ') || 'blocked tasks'}`)
      }
      const now = new Date().toISOString()
      const resume = existing?.epicId === epic.id && ACTIVE.has(existing.status)
      const run: EpicRun = resume
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
      if (resume && run.currentChatId && !(await this.chatAlive(run.currentChatId))) Object.assign(run, { currentTaskId: null, currentTaskKey: null, currentChatId: null })
      if (epic.status === 'todo') this.deps.board.update(path, epic.id, { status: 'doing' })
      this.paths.set(projectId, path)
      await this.save(run)
      await this.step(run)
      return this.runs.get(projectId)!
    })
  }

  /** Stops starting new chats. Chats already open stay as they are. */
  async stop(projectId: string): Promise<EpicRun | null> {
    await this.loaded
    return this.serial(projectId, async () => {
      const run = this.runs.get(projectId)
      if (!run || !ACTIVE.has(run.status)) return run ?? null
      await this.save({ ...run, status: 'stopped', reason: null })
      return this.runs.get(projectId)!
    })
  }

  /** Resolves once the steps queued so far for a project are done (tests). */
  settled(projectId: string): Promise<void> {
    return this.queues.get(projectId) ?? Promise.resolve()
  }

  private kick(projectId: string): void {
    void this.serial(projectId, async () => {
      const run = this.runs.get(projectId)
      if (run && (run.status === 'running' || run.status === 'waiting')) await this.step(run)
    }).catch(() => {})
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
        if (chatId && (await this.chatAlive(chatId))) return this.save({ ...run, ...counts, currentChatId: chatId, status: 'running', reason: null })
        if (chatId) {
          return this.save({ ...run, ...counts, currentChatId: chatId, status: 'paused', reason: `The chat on ${task.key} was closed before the task was done. Run the epic again to start a new chat on it, or stop.` })
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
      const keys = outsideBlockers(board, epic.id).map((t) => t.key)
      return this.save({ ...run, ...counts, status: 'waiting', reason: `The remaining tasks wait on ${keys.join(', ') || 'blocked tasks'}` })
    }
    await this.startTask(run, epic, next, board, counts)
  }

  private async startTask(run: EpicRun, epic: Epic, task: Task, board: Board, counts: Partial<EpicRun>): Promise<void> {
    // A chat the user already opened on this task is adopted, never doubled.
    for (const id of [...task.chatIds].reverse()) {
      if (await this.chatAlive(id)) return this.save({ ...run, ...counts, status: 'running', reason: null, currentTaskId: task.id, currentTaskKey: task.key, currentChatId: id })
    }
    // Saved before the chat starts: the board changes the chat makes must not start it again.
    await this.save({ ...run, ...counts, status: 'running', reason: null, currentTaskId: task.id, currentTaskKey: task.key, currentChatId: null })
    try {
      const summary = await this.deps.begin(run.projectId, epicTaskPrompt(epic, task), run.provider, { taskId: task.id })
      const latest = this.runs.get(run.projectId)!
      await this.save({ ...latest, currentChatId: summary.chatId ?? summary.id, ...epicProgress(board, epic.id) })
    } catch (err) {
      const latest = this.runs.get(run.projectId)!
      await this.save({ ...latest, status: 'paused', currentTaskId: null, currentTaskKey: null, currentChatId: null, reason: `Could not start a chat on ${task.key}: ${(err as Error).message}` })
    }
  }

  private async chatAlive(chatId: string): Promise<boolean> {
    const chat = await this.deps.chats.get(chatId)
    return !!chat && !chat.worktreeRemoved && chat.doneReason !== 'discarded' && (chat.state === 'active' || chat.state === 'setting-up')
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

  private async save(run: EpicRun): Promise<void> {
    const next = { ...run, updatedAt: new Date().toISOString() }
    this.runs.set(run.projectId, next)
    await writeJson(join(this.dir, `${run.projectId}.json`), next)
    this.emit('update', next)
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
        void this.projectPath(run.projectId).then(() => this.kick(run.projectId), () => {})
      }
    }
  }
}

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeLine } from '../engine/agents/claude'
import { AgentSupervisor } from '../engine/agents/supervisor'
import type { AgentAdapter, InvocationOptions } from '../engine/agents/types'
import { Approvals } from '../engine/approvals'
import { BoardService } from '../engine/board'
import { EpicRunService } from '../engine/epicRuns'
import { ProjectService } from '../engine/projects'
import { ProtocolService } from '../engine/protocol'
import { writeJson } from '../engine/store'
import type { ChatRecord, Epic, EpicRun, RunSummary, Task } from '../shared/types'

// Running an epic end to end: real temp repo, real git, real board, the real supervisor and
// protocol with a stand-in agent. Ship and discard are applied to the chat record the way
// the protocol and /discard leave it, so the board follows them as it does in the app.

const FIXTURE = join(__dirname, 'fixtures', 'stand-in-agent.mjs')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function standIn(calls: InvocationOptions[]): AgentAdapter {
  return {
    id: 'claude',
    label: 'Stand-in',
    policySummary: 'test',
    detect: async () => ({ id: 'claude', label: 'Stand-in', installed: true, executable: process.execPath, version: 'test', authenticated: true, adapterAvailable: true, detail: '', policy: 'test' }),
    buildInvocation: (opts) => {
      calls.push(opts)
      return { command: opts.executable, args: [FIXTURE, 'readonly'], stdin: opts.prompt, env: process.env }
    },
    createParser: () => ({ parseLine: parseClaudeLine })
  }
}

let tmp: string
let repo: string
let appData: string
let projectId: string
let projects: ProjectService
let board: BoardService
let sup: AgentSupervisor
let protocol: ProtocolService
let runs: EpicRunService
let calls: InvocationOptions[]
let epic: Epic
let t1: Task
let t2: Task

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-epicrun-')))
  repo = join(tmp, 'repo')
  appData = join(tmp, 'appdata')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  execFileSync('sh', ['-c', 'echo hello > README.md && git add -A && git commit -qm initial'], { cwd: repo })
  projects = new ProjectService(appData)
  projectId = (await projects.importFolder(repo)).id
  board = new BoardService(20)
  epic = board.create(repo, { kind: 'epic', title: 'Blink' }) as Epic
  t1 = board.create(repo, { kind: 'task', title: 'First', epicId: epic.id }) as Task
  t2 = board.create(repo, { kind: 'task', title: 'Second', epicId: epic.id, blockedBy: [t1.id] }) as Task
  calls = []
  const approvals = new Approvals(appData)
  sup = new AgentSupervisor(appData, projects, { adapters: [standIn(calls)], approvals, board })
  board.followChats(sup.chats, async () => repo)
  protocol = new ProtocolService({ supervisor: sup, projects, approvals })
  runs = newService()
})
afterEach(async () => {
  sup.cancelAll()
  board.close()
  rmSync(tmp, { recursive: true, force: true })
})

const newService = () => new EpicRunService(appData, { board, chats: sup.chats, projects, begin: (...a) => protocol.begin(...a) })

function runWhen(service: EpicRunService, pred: (r: EpicRun) => boolean): Promise<EpicRun> {
  return new Promise((resolve) => {
    const on = (r: EpicRun) => {
      if (!pred(r)) return
      service.off('update', on)
      resolve(r)
    }
    service.on('update', on)
    void service.status(projectId).then((r) => r && pred(r) && (service.off('update', on), resolve(r)))
  })
}

function turnEnded(chatId: string): Promise<RunSummary> {
  return new Promise((resolve) => {
    const check = async () => {
      const turns = await sup.getChat(projectId, chatId)
      return turns.length > 0 && turns.every((t) => t.endedAt) && !sup.isChatLive(chatId)
    }
    const on = async (s: RunSummary) => {
      if ((s.chatId ?? s.id) !== chatId || !s.endedAt || !(await check())) return
      sup.off('update', on)
      resolve(s)
    }
    sup.on('update', on)
  })
}

/** What a chat looks like after the protocol's ship (merged) or /discard. */
async function finish(chatId: string, how: 'shipped' | 'discarded'): Promise<ChatRecord> {
  const next = await sup.chats.update(chatId, (c) => {
    if (how === 'shipped') {
      c.state = 'merged'
      if (c.protocol) c.protocol.stage = 'shipped'
    } else {
      c.state = 'done'
      c.doneReason = 'discarded'
      c.worktreeRemoved = true
    }
  })
  sup.chats.emit('update', next)
  return next
}

const task = (id: string) => board.board(repo).tasks.find((t) => t.id === id)!

describe('epic runs', () => {
  it('opens a protocol chat on each ready task in turn and finishes the epic', async () => {
    const first = runWhen(runs, (r) => !!r.currentChatId)
    const started = await runs.start(projectId, epic.key, 'claude')
    expect(started).toMatchObject({ epicId: epic.id, status: 'running', currentTaskId: t1.id, total: 2, done: 0 })
    const r1 = await first
    const chat1 = (await sup.chats.get(r1.currentChatId!))!
    // A protocol chat in its read-only plan stage, linked to the task, told about the epic.
    expect(chat1.protocol?.stage).toBe('plan')
    await turnEnded(chat1.id)
    expect(calls[0].mode).toBe('plan')
    expect(calls[0].prompt).toMatch(/^T-1: First/)
    expect(calls[0].prompt).toContain('Part of epic E-1: Blink.')
    expect(task(t1.id)).toMatchObject({ status: 'doing', chatIds: [chat1.id] })
    expect(board.board(repo).epics[0].status).toBe('doing')

    // T-1 ships: T-2 (blocked by it until now) gets its own chat without the user.
    const second = runWhen(runs, (r) => r.currentTaskId === t2.id && !!r.currentChatId)
    await finish(chat1.id, 'shipped')
    const r2 = await second
    expect(r2).toMatchObject({ status: 'running', done: 1, currentTaskKey: 'T-2' })
    expect(r2.currentChatId).not.toBe(chat1.id)
    expect(task(t1.id).status).toBe('done')
    await turnEnded(r2.currentChatId!)
    expect(calls).toHaveLength(2)
    expect(calls[1].prompt).toContain('T-2: Second')

    const finished = runWhen(runs, (r) => r.status === 'finished')
    await finish(r2.currentChatId!, 'shipped')
    expect(await finished).toMatchObject({ done: 2, total: 2, currentTaskId: null })
    expect(board.board(repo).epics[0].status).toBe('done')
    expect(calls).toHaveLength(2)
  })

  it('pauses when a task’s chat is discarded, and starts a new chat on it when resumed', async () => {
    const first = runWhen(runs, (r) => !!r.currentChatId)
    await runs.start(projectId, epic.id, 'claude')
    const chatId = (await first).currentChatId!
    await turnEnded(chatId)
    const paused = runWhen(runs, (r) => r.status === 'paused')
    await finish(chatId, 'discarded')
    expect((await paused).reason).toMatch(/chat on T-1 was closed/)
    expect(task(t1.id).status).toBe('todo')
    expect(calls).toHaveLength(1)

    const again = runWhen(runs, (r) => r.status === 'running' && !!r.currentChatId && r.currentChatId !== chatId)
    await runs.start(projectId, epic.id, 'claude')
    const resumed = await again
    expect(resumed.currentTaskId).toBe(t1.id)
    await turnEnded(resumed.currentChatId!)
    expect(calls).toHaveLength(2)
  })

  it('stops opening chats when stopped, and refuses a second epic while one is running', async () => {
    const other = board.create(repo, { kind: 'epic', title: 'Other' }) as Epic
    board.create(repo, { kind: 'task', title: 'Elsewhere', epicId: other.id })
    const first = runWhen(runs, (r) => !!r.currentChatId)
    await runs.start(projectId, epic.id, 'claude')
    const chatId = (await first).currentChatId!
    await expect(runs.start(projectId, other.id, 'claude')).rejects.toThrow(/E-1 is already running/)
    await turnEnded(chatId)

    expect((await runs.stop(projectId))?.status).toBe('stopped')
    await finish(chatId, 'shipped')
    await board.settled()
    await runs.settled(projectId)
    expect((await runs.status(projectId))?.status).toBe('stopped')
    expect(calls).toHaveLength(1)
    // Stopped, another epic may run.
    const otherRun = runWhen(runs, (r) => r.epicId === other.id && !!r.currentChatId)
    await runs.start(projectId, other.id, 'claude')
    await turnEnded((await otherRun).currentChatId!)
  })

  it('waits on a blocker outside the epic, and goes on once it is done', async () => {
    const outside = board.create(repo, { kind: 'task', title: 'Outside' }) as Task
    board.update(repo, t1.id, { blockedBy: [outside.id] })
    await expect(runs.start(projectId, epic.id, 'claude')).rejects.toThrow(/wait on T-3/)

    // Ready at start; then T-1 picks up a blocker outside the epic while the run is between tasks.
    board.update(repo, t1.id, { blockedBy: [] })
    const first = runWhen(runs, (r) => !!r.currentChatId)
    await runs.start(projectId, epic.id, 'claude')
    const chatId = (await first).currentChatId!
    await turnEnded(chatId)
    board.update(repo, t2.id, { blockedBy: [t1.id, outside.id] })
    const waiting = runWhen(runs, (r) => r.status === 'waiting')
    await finish(chatId, 'shipped')
    expect((await waiting).reason).toMatch(/wait on T-3/)
    expect(calls).toHaveLength(1)

    const next = runWhen(runs, (r) => r.status === 'running' && r.currentTaskId === t2.id && !!r.currentChatId)
    board.update(repo, outside.id, { status: 'done' })
    await turnEnded((await next).currentChatId!)
  })

  it('picks up a saved run after a restart', async () => {
    board.update(repo, t1.id, { status: 'done' })
    const now = new Date().toISOString()
    const saved: EpicRun = {
      projectId,
      epicId: epic.id,
      epicKey: epic.key,
      epicTitle: epic.title,
      provider: 'claude',
      status: 'running',
      currentTaskId: t1.id,
      currentTaskKey: t1.key,
      currentChatId: null,
      reason: null,
      done: 0,
      total: 2,
      startedAt: now,
      updatedAt: now
    }
    await writeJson(join(appData, 'epic-runs', `${projectId}.json`), saved)
    // T-1 was done while the app was closed: the restarted service starts T-2.
    const restarted = newService()
    const next = await runWhen(restarted, (r) => r.currentTaskId === t2.id && !!r.currentChatId)
    expect(next).toMatchObject({ status: 'running', done: 1 })
    await turnEnded(next.currentChatId!)
  })
})

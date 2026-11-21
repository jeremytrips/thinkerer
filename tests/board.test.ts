import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardService, chatEventOf } from '../engine/board'
import { ChatStore, newChat } from '../engine/chats'
import { openBoard } from '../mcp/board/store.mjs'
import type { ChatRecord, Epic, Milestone, Task } from '../shared/types'

const run = promisify(execFile)
const STORE = join(__dirname, '..', 'mcp', 'board', 'store.mjs')

let dir: string
let board: BoardService
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-board-')))
  board = new BoardService(20)
})
afterEach(() => {
  board.close()
  rmSync(dir, { recursive: true, force: true })
})

const milestone = (title: string, extra = {}) => board.create(dir, { kind: 'milestone', title, ...extra }) as Milestone
const epic = (title: string, extra = {}) => board.create(dir, { kind: 'epic', title, ...extra }) as Epic
const task = (title: string, extra = {}) => board.create(dir, { kind: 'task', title, ...extra }) as Task

describe('BoardService storage', () => {
  it('stores milestones → epics → tasks with short keys, in an ignored SQLite file that persists', () => {
    execFileSync('git', ['init', '-q', dir])
    const m = milestone('  v1 board  ', { targetDate: '2026-12-31' })
    const e = epic('Blink firmware', { type: 'firmware', milestoneId: m.key, criteria: [{ text: 'LED blinks at 1 Hz' }] })
    const t = task('Toggle the GPIO', { epicId: e.id, labels: ['GPIO', 'gpio', 'hw'], priority: 'high' })
    const loose = task('Write the README')
    expect(m).toMatchObject({ key: 'M-1', title: 'v1 board', status: 'planned', targetDate: '2026-12-31', archivedAt: null })
    expect(e).toMatchObject({ key: 'E-1', milestoneId: m.id, type: 'firmware', status: 'todo', criteria: [{ text: 'LED blinks at 1 Hz', done: false }] })
    // A task takes its epic's type unless it says otherwise; labels are deduplicated, lowercase.
    expect(t).toMatchObject({ key: 'T-1', epicId: e.id, type: 'firmware', status: 'todo', priority: 'high', labels: ['gpio', 'hw'] })
    expect(loose).toMatchObject({ key: 'T-2', epicId: null, type: 'software' })

    expect(readFileSync(join(dir, '.thinkerer', 'local', '.gitignore'), 'utf8')).toBe('*\n')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('')

    board.close()
    const reopened = new BoardService()
    expect(reopened.board(dir).tasks.map((x) => x.key)).toEqual(['T-1', 'T-2'])
    expect(reopened.history(dir, 'T-1')).toEqual([expect.objectContaining({ source: 'user', change: 'created' })])
    reopened.close()
  })

  it('updates fields, keeps a history of who changed what, and refuses bad input', () => {
    const e = epic('Enclosure', { type: 'mechanical' })
    const a = task('Model the lid')
    const b = task('Print the lid', { blockedBy: [a.key] })
    const updated = board.update(dir, a.key, { status: 'done', epicId: e.key, criteria: [{ text: 'fits', done: true }] }) as Task
    expect(updated).toMatchObject({ status: 'done', epicId: e.id, criteria: [{ text: 'fits', done: true }] })
    expect(updated.doneAt).toEqual(expect.any(String))
    expect((board.update(dir, a.id, { status: 'review' }) as Task).doneAt).toBeNull()
    expect(board.history(dir, a.key).map((h) => h.change)).toEqual(['status done → review', expect.stringMatching(/status todo → done/), 'created'])
    expect((board.board(dir).tasks.find((x) => x.id === b.id) as Task).blockedBy).toEqual([a.id])

    expect(() => board.update(dir, a.key, { blockedBy: [b.key] })).toThrow(/loop: T-2 already waits/)
    expect(() => board.update(dir, a.key, { blockedBy: [a.key] })).toThrow(/can't block itself/)
    expect(() => board.update(dir, a.key, { status: 'blocked' as never })).toThrow(/Invalid task status/)
    expect(() => board.update(dir, a.key, { type: 'pottery' as never })).toThrow(/Invalid type/)
    expect(() => board.update(dir, a.key, { targetDate: '2026-01-01' })).toThrow(/targetDate can't be set on a task/)
    expect(() => board.update(dir, e.key, { epicId: null })).toThrow(/epicId can't be set on a epic/)
    expect(() => board.update(dir, a.key, { epicId: a.key })).toThrow(/No epic T-1/)
    expect(() => board.update(dir, 'T-99', { title: 'x' })).toThrow(/No milestone, epic or task T-99/)
    expect(() => board.create(dir, { kind: 'task', title: '   ' })).toThrow(/Title can't be empty/)
    expect(() => board.create(dir, { kind: 'milestone', title: 'x', targetDate: 'soon' })).toThrow(/YYYY-MM-DD/)
    expect(() => board.create(dir, { kind: 'bug' } as never)).toThrow(/milestone, epic or task/)
    // A failed write changes nothing.
    expect(board.board(dir).tasks).toHaveLength(2)
  })

  it('archives with children, restores what was archived together, and deletes only archived items', () => {
    const m = milestone('v1')
    const e = epic('Epic', { milestoneId: m.id })
    const t1 = task('One', { epicId: e.id })
    const t2 = task('Two', { epicId: e.id })
    board.archive(dir, t2.key)
    board.archive(dir, m.key)
    const archived = board.board(dir)
    expect([...archived.milestones, ...archived.epics, ...archived.tasks].every((i) => i.archivedAt)).toBe(true)

    // Restoring the epic brings back its milestone and the task archived with it, not T-2 (archived before).
    board.unarchive(dir, e.key)
    const b = board.board(dir)
    expect(b.milestones[0].archivedAt).toBeNull()
    expect(b.tasks.find((x) => x.id === t1.id)!.archivedAt).toBeNull()
    expect(b.tasks.find((x) => x.id === t2.id)!.archivedAt).not.toBeNull()

    expect(() => board.remove(dir, e.key)).toThrow(/Archive E-1 first/)
    board.remove(dir, t2.key)
    board.archive(dir, e.key)
    board.remove(dir, e.key)
    expect(board.board(dir)).toMatchObject({ epics: [], tasks: [], milestones: [{ key: 'M-1' }] })
    // Keys are never reused.
    expect(task('Three').key).toBe('T-3')
  })

  it('reorders items of one kind', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((t) => task(t))
    board.reorder(dir, 'task', [c.id, a.id, b.id])
    expect(board.board(dir).tasks.map((x) => x.title)).toEqual(['c', 'a', 'b'])
  })

  it('keeps archived items in place when the live ones are reordered, and moves atomically', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((t) => task(t))
    board.archive(dir, b.key)
    // The views only send live ids.
    board.reorder(dir, 'task', [c.id, a.id])
    board.unarchive(dir, b.key)
    const tasks = board.board(dir).tasks
    expect(tasks.map((x) => x.title)).toEqual(['c', 'b', 'a'])
    expect(new Set(tasks.map((x) => x.position)).size).toBe(3)

    // A drag saves the change and the order together, or neither.
    expect(board.move(dir, a.key, { status: 'doing' }, [a.id, c.id, b.id])).toMatchObject({ status: 'doing' })
    expect(board.board(dir).tasks.map((x) => x.title)).toEqual(['a', 'c', 'b'])
    expect(() => board.move(dir, c.key, { status: 'nope' as never }, [c.id, a.id, b.id])).toThrow(/Invalid task status/)
    expect(board.board(dir).tasks.map((x) => x.title)).toEqual(['a', 'c', 'b'])
  })

  it('refuses archived parents and fields of another kind', () => {
    const m = milestone('Old')
    const e = epic('Old epic', { milestoneId: m.id })
    const t = task('In it', { epicId: e.id })
    const other = task('Other')
    board.archive(dir, e.key)
    board.unarchive(dir, t.key) // brings back its epic and milestone
    board.archive(dir, e.key)
    expect(() => task('New', { epicId: e.key })).toThrow(/E-1 is archived; restore it first/)
    expect(() => board.update(dir, other.key, { epicId: e.key })).toThrow(/E-1 is archived/)
    board.archive(dir, m.key)
    expect(() => epic('New epic', { milestoneId: m.key })).toThrow(/M-1 is archived/)
    // An archived item keeps its archived parent when other fields change.
    expect(board.update(dir, t.key, { epicId: e.id, title: 'Still in it' })).toMatchObject({ title: 'Still in it', epicId: e.id })
    // Waiting for an archived task is allowed (the views ignore it).
    expect((board.update(dir, other.key, { blockedBy: [t.key] }) as Task).blockedBy).toEqual([t.id])

    expect(() => board.create(dir, { kind: 'task', title: 'x', milestoneId: m.id } as never)).toThrow(/milestoneId can't be set on a task/)
    expect(() => board.create(dir, { kind: 'milestone', title: 'x', criteria: [] } as never)).toThrow(/criteria can't be set on a milestone/)
  })

  it('reads a project without a board without creating one, and notices when one appears', async () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-fresh-')))
    try {
      expect(board.board(fresh)).toEqual({ milestones: [], epics: [], tasks: [] })
      expect(board.history(fresh, 'T-1')).toEqual([])
      expect(board.runStarted(fresh, 'T-1', 'c', 'r')).toBeNull()
      expect(existsSync(join(fresh, '.thinkerer'))).toBe(false)
      // An agent's first write (another process) creates it: the app is told.
      const seen = new Promise<string>((resolve) => board.once('change', resolve))
      const agent = openBoard(fresh)
      agent.create({ kind: 'task', title: 'First' }, 'agent:x')
      agent.close()
      expect(await seen).toBe(fresh)
      expect(board.board(fresh).tasks.map((t) => t.title)).toEqual(['First'])
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('keeps the board and the other listeners working when a listener throws', async () => {
    board.on('change', () => {
      throw new Error('window closed')
    })
    const seen: string[] = []
    board.on('change', (p) => seen.push(p))
    expect(task('Saved anyway')).toMatchObject({ key: 'T-1' })
    expect(seen).toEqual([dir])
    for (const title of ['From agent 1', 'From agent 2']) {
      const agent = openBoard(dir)
      agent.create({ kind: 'task', title }, 'agent:x')
      agent.close()
      const before = seen.length
      await expect.poll(() => seen.length).toBeGreaterThan(before)
    }
    expect(board.board(dir).tasks).toHaveLength(3)
  })

  it('imports the old .thinkerer/tasks.json once, keeping ids and runs, and leaves the file alone', () => {
    mkdirSync(join(dir, '.thinkerer'))
    const old = {
      schemaVersion: 1,
      tasks: [
        { id: 'old-1', title: 'Old todo', notes: 'n', status: 'todo', runIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'old-2', title: 'Old done', notes: '', status: 'done', runIds: ['r1'], createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
        { id: 'bad', title: '', status: 'nope', runIds: [] }
      ]
    }
    const file = join(dir, '.thinkerer', 'tasks.json')
    writeFileSync(file, JSON.stringify(old))
    expect(board.board(dir).tasks).toMatchObject([
      { id: 'old-1', key: 'T-1', title: 'Old todo', notes: 'n', status: 'todo', type: 'software' },
      { id: 'old-2', key: 'T-2', status: 'done', runIds: ['r1'], doneAt: '2026-01-03T00:00:00.000Z' }
    ])
    expect(board.history(dir, 'old-1')[0].change).toMatch(/imported/)
    board.close()
    const again = new BoardService()
    expect(again.board(dir).tasks).toHaveLength(2)
    again.close()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(old)
  })

  it('does not lose writes from other processes, and notices them', async () => {
    task('from the app')
    let changes = 0
    board.on('change', (path) => path === dir && changes++)
    const before = changes
    const script = `
      import { openBoard } from ${JSON.stringify(STORE)}
      const b = openBoard(process.argv[1])
      for (let i = 0; i < 25; i++) b.create({ kind: 'task', title: 'child ' + process.argv[2] + ' ' + i }, 'agent:test')
      b.close()`
    const children = [1, 2].map((n) => run(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, dir, String(n)]))
    for (let i = 0; i < 25; i++) task(`app ${i}`)
    await Promise.all(children)
    const tasks = board.board(dir).tasks
    expect(tasks).toHaveLength(76)
    expect(new Set(tasks.map((t) => t.key)).size).toBe(76)
    expect(board.history(dir, tasks.find((t) => t.title === 'child 1 0')!.key)[0].source).toBe('agent:test')
    await new Promise((r) => setTimeout(r, 100))
    expect(changes).toBeGreaterThan(before + 25)
  })
})

describe('tasks follow their chats', () => {
  const chatId = () => randomUUID()
  let chats: ChatStore
  beforeEach(() => {
    chats = new ChatStore(join(dir, 'appdata'))
    board.followChats(chats, async (projectId) => (projectId === 'p1' ? dir : null))
  })

  async function emit(id: string, change: (c: ChatRecord) => void): Promise<void> {
    const existing = (await chats.get(id)) ?? (await chats.create(newChat(id, 'p1', 'chat')))
    const next = await chats.update(existing.id, change)
    chats.emit('update', next)
    await board.settled()
  }

  const status = (ref: string) => (board.board(dir).tasks.find((t) => t.key === ref) as Task).status

  it('moves a task to In progress on a run, In review on protocol review, Done on merge; a manual move sticks', async () => {
    const t = task('Ship the thing', { status: 'backlog' })
    const c = chatId()
    expect(board.runStarted(dir, t.id, c, 'run-1')).toMatchObject({ status: 'doing', chatIds: [c], runIds: ['run-1'] })
    await emit(c, (x) => (x.protocol = { id: 'software', stage: 'review', round: 1, checks: null }))
    expect(status(t.key)).toBe('review')
    await emit(c, (x) => {
      x.state = 'merged'
      x.protocol!.stage = 'shipped'
    })
    expect(status(t.key)).toBe('done')
    // The user reopens it; later updates of the same merged chat don't override that.
    board.update(dir, t.key, { status: 'todo' })
    await emit(c, (x) => (x.state = 'done'))
    expect(status(t.key)).toBe('todo')
    expect(board.history(dir, t.key).filter((h) => h.source === 'auto').map((h) => h.change)).toEqual([
      'status review → done',
      'status doing → review',
      'status backlog → doing',
      'chat linked'
    ])
  })

  it('moves a task back to To do when its chat is discarded, unless another chat still works on it', async () => {
    const t = task('Try two ways')
    const [a, b] = [chatId(), chatId()]
    await chats.create({ ...newChat(b, 'p1', 'other'), state: 'active' })
    board.runStarted(dir, t.id, a, 'r-a')
    board.runStarted(dir, t.id, b, 'r-b')
    await emit(a, (x) => {
      x.state = 'done'
      x.doneReason = 'discarded'
    })
    expect(status(t.key)).toBe('doing')
    await emit(b, (x) => {
      x.state = 'done'
      x.doneReason = 'discarded'
    })
    expect(status(t.key)).toBe('todo')
  })

  it('never creates a board for a chat, and a removed task does not fail the run', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-noboard-')))
    const quiet = new ChatStore(join(other, 'appdata'))
    board.followChats(quiet, async () => other)
    const c = await quiet.create({ ...newChat(chatId(), 'p2', 'x'), state: 'merged' })
    quiet.emit('update', c)
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(join(other, '.thinkerer'))).toBe(false)
    rmSync(other, { recursive: true, force: true })
    expect(board.runStarted(dir, 'T-404', chatId(), 'r')).toBeNull()
  })

  it('leaves a task alone when its chat is cleaned up without ever merging, and announces only real changes', async () => {
    const t = task('Just asking')
    const c = chatId()
    board.runStarted(dir, t.id, c, 'run-1')
    let changes = 0
    board.on('change', () => changes++)
    await emit(c, (x) => {
      x.state = 'done'
      x.doneReason = 'cleanup'
    })
    expect(status(t.key)).toBe('doing')
    expect(changes).toBe(0)
    // A merge is announced once; later updates of the merged chat change nothing and stay quiet.
    await emit(c, (x) => (x.state = 'merged'))
    await emit(c, (x) => (x.title = 'renamed'))
    expect(status(t.key)).toBe('done')
    expect(changes).toBe(1)
  })

  it('maps chat states to events', () => {
    const base = newChat(chatId(), 'p', 't')
    expect(chatEventOf(base)).toBeNull()
    expect(chatEventOf({ ...base, state: 'merged' })).toBe('merged')
    // /cleanup also finishes chats that never committed anything: not a merge.
    expect(chatEventOf({ ...base, state: 'done', doneReason: 'cleanup' })).toBeNull()
    expect(chatEventOf({ ...base, state: 'done', doneReason: 'manual' })).toBeNull()
    expect(chatEventOf({ ...base, state: 'done', doneReason: 'discarded' })).toBe('discarded')
    expect(chatEventOf({ ...base, protocol: { id: 'software', stage: 'implement', round: 0, checks: null } })).toBeNull()
  })
})

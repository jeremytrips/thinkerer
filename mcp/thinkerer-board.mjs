#!/usr/bin/env node
// Thinkerer's board MCP server: the project's milestones → epics → tasks, for any agent
// provider. Reads and writes the same SQLite board as the app (mcp/board/store.mjs), always
// in the main project folder, never the chat's worktree copy, so agent edits show live in
// the Tasks tab and never conflict in Git. Agents can archive but never delete; deleting is
// only possible in the app. Speaks MCP's stdio transport (newline-delimited JSON-RPC 2.0).
//
// Env: THINKERER_BOARD_ROOT (required: the main project folder),
//      THINKERER_CHAT_ID (the chat; recorded as the source of changes),
//      THINKERER_TASK_ID (the task the chat works on, if any).
import { createInterface } from 'node:readline'
import { EPIC_STATUSES, MILESTONE_STATUSES, PRIORITIES, TASK_STATUSES, WORK_TYPES, openBoard } from './board/store.mjs'

const root = process.env.THINKERER_BOARD_ROOT || ''
const chatId = (process.env.THINKERER_CHAT_ID || '').replace(/[^\w-]/g, '').slice(0, 100)
const taskId = process.env.THINKERER_TASK_ID || ''
const source = `agent:${chatId}`

const ref = { type: 'string', description: 'Key such as T-12, E-3 or M-1 (or the item id)' }
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description })
const criteria = { type: 'array', items: { type: 'string' }, description: '"Done when" checklist: checks that prove the item is finished, not work to do (work is a task under the epic). One line per criterion; replaces the whole list; use board_check to tick one' }
const fields = {
  title: { type: 'string', maxLength: 300 },
  description: { type: 'string', description: 'Milestones and epics' },
  notes: { type: 'string', description: 'Tasks' },
  type: { type: 'string', enum: WORK_TYPES, description: 'Epics and tasks; a new task defaults to its epic’s type' },
  status: { type: 'string', enum: [...new Set([...TASK_STATUSES, ...EPIC_STATUSES, ...MILESTONE_STATUSES])], description: `Task: ${TASK_STATUSES.join('|')}. Epic: ${EPIC_STATUSES.join('|')}. Milestone: ${MILESTONE_STATUSES.join('|')}` },
  priority: { type: 'string', enum: PRIORITIES, description: 'Tasks' },
  labels: strings('Tasks'),
  criteria,
  epic: { type: 'string', description: 'Task: the epic key it belongs to (empty: none)' },
  milestone: { type: 'string', description: 'Epic: the milestone key it belongs to (empty: none)' },
  blockedBy: strings('Task: keys of tasks that must be done first (replaces the list)'),
  targetDate: { type: 'string', description: 'Milestone: YYYY-MM-DD (empty: none)' }
}
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const read = { readOnlyHint: true }

const TOOLS = [
  { name: 'board_overview', description: 'The project board at a glance: milestones and epics with progress, and every open task (key, status, title). Start here.', inputSchema: obj({}), annotations: read },
  {
    name: 'board_list',
    description: 'List board items with filters. Archived items are left out unless archived is true.',
    inputSchema: obj({
      kind: { type: 'string', enum: ['milestone', 'epic', 'task'] },
      status: { type: 'string' },
      type: { type: 'string', enum: WORK_TYPES },
      epic: { type: 'string', description: 'Epic key: its tasks' },
      milestone: { type: 'string', description: 'Milestone key: its epics and their tasks' },
      label: { type: 'string' },
      archived: { type: 'boolean' }
    }),
    annotations: read
  },
  { name: 'board_get', description: 'One milestone, epic or task in full: notes, criteria, blockers, children, linked chats and recent history.', inputSchema: obj({ key: ref }, ['key']), annotations: read },
  { name: 'board_current_task', description: 'The task this chat works on, in full (null if the chat was not started from a task).', inputSchema: obj({}), annotations: read },
  {
    name: 'board_create',
    description: 'Add a milestone, epic or task. Use for breaking work down (an epic into tasks, each small enough for one chat) or recording follow-up work.',
    inputSchema: obj({ kind: { type: 'string', enum: ['milestone', 'epic', 'task'] }, ...fields }, ['kind', 'title'])
  },
  { name: 'board_update', description: 'Change fields of an item (only the ones given). Status changes are recorded with this chat as the source.', inputSchema: obj({ key: ref, ...fields }, ['key']) },
  {
    name: 'board_check',
    description: 'Tick (or untick) one "done when" criterion of an epic or task. Tick only what you verified.',
    inputSchema: obj({ key: ref, index: { type: 'integer', minimum: 1, description: '1-based position in the list' }, done: { type: 'boolean' } }, ['key', 'index', 'done'])
  },
  { name: 'board_archive', description: 'Archive an item (and its children). Reversible with board_unarchive; agents cannot delete.', inputSchema: obj({ key: ref }, ['key']) },
  { name: 'board_unarchive', description: 'Restore an archived item.', inputSchema: obj({ key: ref }, ['key']) }
]

let db = null
function board() {
  if (!root) throw new Error('THINKERER_BOARD_ROOT is not set; this server runs inside Thinkerer')
  db ??= openBoard(root)
  return db
}

/** Compact views with keys instead of ids, to keep tool output (tokens) small. */
function views(b) {
  const keyOf = new Map([...b.milestones, ...b.epics, ...b.tasks].map((i) => [i.id, i.key]))
  const k = (id) => (id ? (keyOf.get(id) ?? null) : null)
  const brief = (i) => ({
    key: i.key,
    kind: i.kind,
    title: i.title,
    status: i.status,
    ...(i.kind !== 'milestone' ? { type: i.type } : {}),
    ...(i.kind === 'task' ? { epic: k(i.epicId), priority: i.priority, labels: i.labels } : {}),
    ...(i.kind === 'epic' ? { milestone: k(i.milestoneId) } : {}),
    ...(i.archivedAt ? { archived: true } : {})
  })
  const full = (i) => {
    const out = { ...brief(i), ...(i.kind === 'task' ? { notes: i.notes, blockedBy: i.blockedBy.map(k), chats: i.chatIds.length } : { description: i.description }) }
    if (i.kind !== 'milestone') out.criteria = i.criteria.map((c, n) => `${n + 1}. [${c.done ? 'x' : ' '}] ${c.text}`)
    if (i.kind === 'milestone') out.targetDate = i.targetDate
    if (i.kind === 'epic') out.tasks = b.tasks.filter((t) => t.epicId === i.id && !t.archivedAt).map((t) => `${t.key} ${t.status} ${t.title}`)
    if (i.kind === 'milestone') out.epics = b.epics.filter((e) => e.milestoneId === i.id && !e.archivedAt).map((e) => `${e.key} ${e.status} ${e.title}`)
    return out
  }
  return { k, brief, full }
}

function progressOf(b, epicIds) {
  const tasks = b.tasks.filter((t) => !t.archivedAt && epicIds.has(t.epicId))
  return `${tasks.filter((t) => t.status === 'done').length}/${tasks.length} tasks done`
}

/** MCP field names (keys, epic/milestone) → the store's patch. */
function patchOf(args) {
  const p = {}
  for (const f of ['title', 'description', 'notes', 'type', 'status', 'priority', 'labels', 'blockedBy', 'targetDate']) if (args[f] !== undefined) p[f] = args[f]
  if (args.criteria !== undefined) {
    if (!Array.isArray(args.criteria)) throw new Error('criteria must be a list of strings')
    p.criteria = args.criteria.map((text) => ({ text, done: false }))
  }
  if (args.epic !== undefined) p.epicId = args.epic
  if (args.milestone !== undefined) p.milestoneId = args.milestone
  return p
}

function call(name, args = {}) {
  const b = board()
  switch (name) {
    case 'board_overview': {
      const all = b.board()
      const v = views(all)
      const liveEpics = all.epics.filter((e) => !e.archivedAt)
      return {
        milestones: all.milestones.filter((m) => !m.archivedAt).map((m) => ({ ...v.brief(m), targetDate: m.targetDate, progress: progressOf(all, new Set(liveEpics.filter((e) => e.milestoneId === m.id).map((e) => e.id))) })),
        epics: liveEpics.map((e) => ({ ...v.brief(e), progress: progressOf(all, new Set([e.id])) })),
        openTasks: all.tasks.filter((t) => !t.archivedAt && t.status !== 'done').map((t) => `${t.key} [${t.status}] ${t.title}${t.epicId ? ` (${v.k(t.epicId)})` : ''}`),
        doneTasks: all.tasks.filter((t) => !t.archivedAt && t.status === 'done').length
      }
    }
    case 'board_list': {
      const all = b.board()
      const v = views(all)
      const find = (key, kind) => {
        const item = b.get(String(key))
        if (!item || item.kind !== kind) throw new Error(`No ${kind} ${key}`)
        return item
      }
      const epic = args.epic ? find(args.epic, 'epic') : null
      const milestone = args.milestone ? find(args.milestone, 'milestone') : null
      const epicsOfMilestone = milestone ? new Set(all.epics.filter((e) => e.milestoneId === milestone.id).map((e) => e.id)) : null
      return [...all.milestones, ...all.epics, ...all.tasks]
        .filter((i) => !!i.archivedAt === !!args.archived)
        .filter((i) => !args.kind || i.kind === args.kind)
        .filter((i) => !args.status || i.status === args.status)
        .filter((i) => !args.type || (i.kind !== 'milestone' && i.type === args.type))
        .filter((i) => !args.label || (i.kind === 'task' && i.labels.includes(String(args.label).toLowerCase())))
        .filter((i) => !epic || (i.kind === 'task' && i.epicId === epic.id))
        .filter((i) => !epicsOfMilestone || (i.kind === 'epic' && epicsOfMilestone.has(i.id)) || (i.kind === 'task' && epicsOfMilestone.has(i.epicId)))
        .map(v.brief)
    }
    case 'board_get': {
      const item = b.get(String(args.key ?? ''))
      if (!item) throw new Error(`No milestone, epic or task ${args.key}`)
      return { ...views(b.board()).full(item), history: b.history(item.id).slice(0, 10).map((h) => `${h.at.slice(0, 16)} ${h.source === 'user' ? 'user' : h.source === 'auto' ? 'thinkerer' : 'agent'}: ${h.change}`) }
    }
    case 'board_current_task': {
      const ids = [taskId, ...(chatId ? b.tasksOfChat(chatId) : [])].filter(Boolean)
      const item = ids.map((id) => b.get(id)).find(Boolean)
      return item ? views(b.board()).full(item) : null
    }
    case 'board_create': {
      const item = b.create({ kind: args.kind, ...patchOf(args) }, source)
      return views(b.board()).full(item)
    }
    case 'board_update': {
      const item = b.update(String(args.key ?? ''), patchOf(args), source)
      return views(b.board()).full(item)
    }
    case 'board_check': {
      const item = b.get(String(args.key ?? ''))
      if (!item || item.kind === 'milestone') throw new Error(`No epic or task ${args.key}`)
      const i = Number(args.index) - 1
      if (!Number.isInteger(i) || i < 0 || i >= item.criteria.length) throw new Error(`${item.key} has ${item.criteria.length} criteria; index must be 1–${item.criteria.length}`)
      const next = item.criteria.map((c, n) => (n === i ? { ...c, done: args.done === true } : c))
      return views(b.board()).full(b.update(item.id, { criteria: next }, source))
    }
    case 'board_archive':
      return views(b.board()).brief(b.archive(String(args.key ?? ''), source))
    case 'board_unarchive':
      return views(b.board()).brief(b.unarchive(String(args.key ?? ''), source))
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

function handle(req) {
  switch (req.method) {
    case 'initialize':
      return { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'thinkerer-board', version: '0.1.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      try {
        return { content: [{ type: 'text', text: JSON.stringify(call(req.params?.name, req.params?.arguments ?? {})) }], isError: false }
      } catch (err) {
        // The store names fields as the app does; agents know them as epic and milestone.
        const text = err.message.replace(/\bepicId\b/g, 'epic').replace(/\bmilestoneId\b/g, 'milestone')
        return { content: [{ type: 'text', text }], isError: true }
      }
    default: {
      const err = new Error(`Method not found: ${req.method}`)
      err.code = -32601
      throw err
    }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  if (req.id === undefined || req.id === null) return // notification
  try {
    send({ id: req.id, result: handle(req) })
  } catch (err) {
    send({ id: req.id, error: { code: err.code ?? -32603, message: err.message } })
  }
})
process.stdin.on('end', () => db?.close())

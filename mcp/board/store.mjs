// The project board (milestones → epics → tasks) in <project>/.thinkerer/local/board.sqlite.
// Shared by the app (engine/board.ts) and the thinkerer-board MCP server, which run in
// different processes: SQLite's locking (WAL + busy timeout + BEGIN IMMEDIATE) keeps their
// writes from losing each other. The folder is git-ignored, so the binary file never reaches
// a commit, a checkpoint or a merge. Plain JS so the MCP server runs without a build.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setBlockers, setCriteria, setLabels } from './lists.mjs'
import { date, epicOf, groupBy, milestoneOf, now, oneOf, sourceOf, taskOf, text } from './rows.mjs'
import { EPIC_STATUSES, MILESTONE_STATUSES, PRIORITIES, TASK_STATUSES, WORK_TYPES, migrate, readV1Tasks, v1TasksFile } from './schema.mjs'

export { EPIC_STATUSES, MILESTONE_STATUSES, PRIORITIES, TASK_STATUSES, WORK_TYPES, v1TasksFile }

const TABLE = { milestone: 'milestones', epic: 'epics', task: 'tasks' }
const PREFIX = { milestone: 'M', epic: 'E', task: 'T' }
const HISTORY_KEPT = 50
const FIELDS = {
  milestone: ['title', 'description', 'targetDate', 'status'],
  epic: ['title', 'description', 'type', 'milestoneId', 'status', 'criteria'],
  task: ['title', 'notes', 'type', 'epicId', 'status', 'priority', 'labels', 'criteria', 'blockedBy']
}

export function boardFile(projectRoot) {
  return join(projectRoot, '.thinkerer', 'local', 'board.sqlite')
}

export function openBoard(projectRoot) {
  return new BoardDb(projectRoot)
}

export class BoardDb {
  constructor(projectRoot) {
    const dir = join(projectRoot, '.thinkerer', 'local')
    mkdirSync(dir, { recursive: true })
    // Keeps the database (and its -wal/-shm files) out of Git in every project.
    if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n')
    this.db = new DatabaseSync(boardFile(projectRoot))
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.tx(() => {
      migrate(this.db)
      if (!this.meta('v1_import')) {
        const old = readV1Tasks(projectRoot)
        for (const t of old) this.insertV1(t)
        this.setMeta('v1_import', old.length ? `${old.length} tasks at ${now()}` : 'none')
      }
    })
  }

  close() {
    this.db.close()
  }

  /** Changes whenever another connection (another process) commits a write. */
  dataVersion() {
    return this.db.prepare('PRAGMA data_version').get().data_version
  }

  /** Everything, archived items included (they carry `archivedAt`). */
  board() {
    const criteria = groupBy(this.all('SELECT * FROM criteria ORDER BY position'), 'item_id', (r) => ({ text: r.text, done: !!r.done }))
    const labels = groupBy(this.all('SELECT * FROM labels ORDER BY label'), 'task_id', (r) => r.label)
    const blockers = groupBy(this.all('SELECT * FROM blocked_by'), 'task_id', (r) => r.blocker_id)
    const chats = groupBy(this.all('SELECT * FROM task_chats ORDER BY linked_at'), 'task_id', (r) => r.chat_id)
    const runs = groupBy(this.all('SELECT * FROM task_runs ORDER BY linked_at'), 'task_id', (r) => r.run_id)
    return {
      milestones: this.all('SELECT * FROM milestones ORDER BY position').map(milestoneOf),
      epics: this.all('SELECT * FROM epics ORDER BY position').map((r) => epicOf(r, criteria)),
      tasks: this.all('SELECT * FROM tasks ORDER BY position').map((r) => taskOf(r, { criteria, labels, blockers, chats, runs }))
    }
  }

  /** One item by id or key (T-12), or null. */
  get(ref) {
    const found = this.find(ref)
    if (!found) return null
    const b = this.board()
    return [...b.milestones, ...b.epics, ...b.tasks].find((i) => i.id === found.row.id) ?? null
  }

  history(ref) {
    const { row } = this.mustFind(ref)
    return this.all('SELECT at, source, change FROM history WHERE item_id = ? ORDER BY id DESC', row.id).map((r) => ({ at: r.at, source: r.source, change: r.change }))
  }

  create(input, source = 'user') {
    const kind = input?.kind
    if (!TABLE[kind]) throw new Error('Choose what to create: milestone, epic or task')
    // Same rule as update: a field of another kind is an error, never silently dropped.
    const wrong = Object.keys(input).find((k) => k !== 'kind' && input[k] !== undefined && !FIELDS[kind].includes(k))
    if (wrong) throw new Error(`${wrong} can't be set on a ${kind}`)
    const id = this.tx(() => {
      const id = randomUUID()
      const at = now()
      const key = this.nextKey(kind)
      const position = (this.db.prepare(`SELECT MAX(position) AS p FROM ${TABLE[kind]}`).get().p ?? 0) + 1
      const title = text(input.title, 'Title', 300, true)
      if (kind === 'milestone') {
        this.run(
          'INSERT INTO milestones VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)',
          id, key, title, text(input.description ?? '', 'Description', 10_000), date(input.targetDate ?? null),
          oneOf(input.status ?? 'planned', MILESTONE_STATUSES, 'milestone status'), position, at, at
        )
      } else if (kind === 'epic') {
        const milestoneId = this.parent(input.milestoneId ?? null, 'milestone')
        this.run(
          'INSERT INTO epics VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)',
          id, key, title, text(input.description ?? '', 'Description', 10_000), oneOf(input.type ?? 'software', WORK_TYPES, 'type'),
          milestoneId, oneOf(input.status ?? 'todo', EPIC_STATUSES, 'epic status'), position, at, at
        )
        setCriteria(this, id, input.criteria ?? [])
      } else {
        const epicId = this.parent(input.epicId ?? null, 'epic')
        const epicType = epicId ? this.db.prepare('SELECT type FROM epics WHERE id = ?').get(epicId).type : 'software'
        const status = oneOf(input.status ?? 'todo', TASK_STATUSES, 'task status')
        this.run(
          'INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)',
          id, key, title, text(input.notes ?? '', 'Notes', 10_000), oneOf(input.type ?? epicType, WORK_TYPES, 'type'),
          epicId, status, oneOf(input.priority ?? 'none', PRIORITIES, 'priority'), position, status === 'done' ? at : null, at, at
        )
        setCriteria(this, id, input.criteria ?? [])
        setLabels(this, id, input.labels ?? [])
        setBlockers(this, id, input.blockedBy ?? [])
      }
      this.log(id, source, 'created')
      return id
    })
    return this.get(id)
  }

  update(ref, patch, source = 'user') {
    return this.get(this.tx(() => this.applyUpdate(ref, patch, source)))
  }

  /** An update and the new order of its kind in one transaction (a drag in the Tasks tab). */
  move(ref, patch, ids, source = 'user') {
    const id = this.tx(() => {
      const { kind } = this.mustFind(ref)
      const id = this.applyUpdate(ref, patch, source)
      this.applyOrder(kind, ids)
      return id
    })
    return this.get(id)
  }

  applyUpdate(ref, patch, source) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid update')
    const { kind, row } = this.mustFind(ref)
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
    const wrong = keys.find((k) => !FIELDS[kind].includes(k))
    if (wrong) throw new Error(`${wrong} can't be set on a ${kind}`)
    const changes = []
    const set = (column, value, label) => {
      if (row[column] === value) return
      this.run(`UPDATE ${TABLE[kind]} SET ${column} = ? WHERE id = ?`, value, row.id)
      changes.push(label ?? `${column.replace('_id', '').replace('_', ' ')} changed`)
    }
    for (const k of keys) {
      const v = patch[k]
      if (k === 'title') set('title', text(v, 'Title', 300, true), 'title changed')
      else if (k === 'description') set('description', text(v, 'Description', 10_000))
      else if (k === 'notes') set('notes', text(v, 'Notes', 10_000))
      else if (k === 'targetDate') set('target_date', date(v), 'target date changed')
      else if (k === 'type') set('type', oneOf(v, WORK_TYPES, 'type'), `type → ${v}`)
      else if (k === 'priority') set('priority', oneOf(v, PRIORITIES, 'priority'), `priority → ${v}`)
      else if (k === 'milestoneId') set('milestone_id', this.parent(v, 'milestone', row.milestone_id), this.parentLabel(v, 'milestone'))
      else if (k === 'epicId') set('epic_id', this.parent(v, 'epic', row.epic_id), this.parentLabel(v, 'epic'))
      else if (k === 'status') {
        const statuses = { milestone: MILESTONE_STATUSES, epic: EPIC_STATUSES, task: TASK_STATUSES }[kind]
        const status = oneOf(v, statuses, `${kind} status`)
        set('status', status, `status ${row.status} → ${status}`)
        if (kind === 'task' && row.status !== status) this.run('UPDATE tasks SET done_at = ? WHERE id = ?', status === 'done' ? now() : null, row.id)
      } else if (k === 'criteria') {
        if (setCriteria(this, row.id, v)) changes.push('criteria changed')
      } else if (k === 'labels') {
        if (setLabels(this, row.id, v)) changes.push('labels changed')
      } else if (k === 'blockedBy') {
        if (setBlockers(this, row.id, v)) changes.push('blockers changed')
      }
    }
    if (changes.length) this.touch(kind, row.id, source, changes.join('; '))
    return row.id
  }

  /** Archives the item and its children that aren't archived yet. */
  archive(ref, source = 'user') {
    const id = this.tx(() => {
      const { kind, row } = this.mustFind(ref)
      if (row.archived_at) return row.id
      const at = now()
      const batch = randomUUID()
      for (const d of [{ kind, id: row.id }, ...this.descendants(kind, row.id)]) {
        if (!this.run(`UPDATE ${TABLE[d.kind]} SET archived_at = ?, archive_batch = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`, at, batch, at, d.id).changes) continue
        this.log(d.id, source, d.id === row.id ? 'archived' : 'archived with its parent')
      }
      return row.id
    })
    return this.get(id)
  }

  /** Restores the item, the children archived with it, and its archived parents (so it's visible again). */
  unarchive(ref, source = 'user') {
    const id = this.tx(() => {
      const { kind, row } = this.mustFind(ref)
      if (!row.archived_at) return row.id
      const at = now()
      const together = this.descendants(kind, row.id).filter((d) => d.batch === row.archive_batch)
      for (const d of [{ kind, id: row.id }, ...together, ...this.ancestors(kind, row)]) {
        if (!this.run(`UPDATE ${TABLE[d.kind]} SET archived_at = NULL, archive_batch = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL`, at, d.id).changes) continue
        this.log(d.id, source, 'restored')
      }
      return row.id
    })
    return this.get(id)
  }

  /** Deletes an archived item for good, with the children archived together with it. */
  remove(ref) {
    this.tx(() => {
      const { kind, row } = this.mustFind(ref)
      if (!row.archived_at) throw new Error(`Archive ${row.key} first; only archived items can be deleted`)
      const together = this.descendants(kind, row.id).filter((d) => d.batch === row.archive_batch)
      // Children first, so the parent's ON DELETE SET NULL doesn't touch rows we delete anyway.
      for (const d of [...together.reverse(), { kind, id: row.id }]) {
        this.run(`DELETE FROM ${TABLE[d.kind]} WHERE id = ?`, d.id)
        this.run('DELETE FROM criteria WHERE item_id = ?', d.id)
        this.run('DELETE FROM history WHERE item_id = ?', d.id)
      }
    })
    return true
  }

  /** Sets the order of items of one kind (the ids in their new order). */
  reorder(kind, ids) {
    this.tx(() => this.applyOrder(kind, ids))
    return true
  }

  /**
   * The given ids take the places of those same items, in the given order; every other item
   * (archived ones, which the views leave out) keeps its place. All items are renumbered, so
   * no two share a position and a restored item comes back where it was.
   */
  applyOrder(kind, ids) {
    if (!TABLE[kind] || !Array.isArray(ids) || ids.length > 5000) throw new Error('Invalid order')
    const all = this.all(`SELECT id FROM ${TABLE[kind]} ORDER BY position, created_at`).map((r) => r.id)
    const moved = new Set(ids.map(String).filter((id) => all.includes(id)))
    const queue = [...moved]
    all.map((id) => (moved.has(id) ? queue.shift() : id)).forEach((id, i) => this.run(`UPDATE ${TABLE[kind]} SET position = ? WHERE id = ?`, i + 1, id))
  }

  /** Ids of the tasks a chat is linked to. */
  tasksOfChat(chatId) {
    return this.all('SELECT task_id FROM task_chats WHERE chat_id = ?', String(chatId)).map((r) => r.task_id)
  }

  /**
   * Thinkerer following a chat that works on a task. Events: 'run' (a turn started),
   * 'review' (protocol review), 'merged' (merged or shipped), 'discarded' (with
   * `otherActive`: another linked chat is still open). Each chat applies an event other
   * than 'run' once, so a later manual move sticks. Returns the task (null if it's gone) and
   * whether anything changed, so the app only announces real changes.
   */
  chatEvent(ref, event, { chatId = null, runId = null, otherActive = false } = {}) {
    if (!['run', 'review', 'merged', 'discarded'].includes(event)) throw new Error('Invalid chat event')
    let changed = false
    const id = this.tx(() => {
      const found = this.find(ref)
      if (!found || found.kind !== 'task') return null
      const { row } = found
      const at = now()
      if (chatId && this.run('INSERT OR IGNORE INTO task_chats VALUES (?, ?, ?, NULL)', row.id, chatId, at).changes) {
        this.log(row.id, 'auto', 'chat linked')
        changed = true
      }
      if (runId && this.run('INSERT OR IGNORE INTO task_runs VALUES (?, ?, ?)', row.id, runId, at).changes) changed = true
      if (chatId && event !== 'run') {
        if (this.db.prepare('SELECT last_event FROM task_chats WHERE task_id = ? AND chat_id = ?').get(row.id, chatId).last_event === event) return row.id
        this.run('UPDATE task_chats SET last_event = ? WHERE task_id = ? AND chat_id = ?', event, row.id, chatId)
      }
      const next =
        event === 'run' ? (['backlog', 'todo'].includes(row.status) ? 'doing' : null)
        : event === 'review' ? (row.status !== 'done' && row.status !== 'review' ? 'review' : null)
        : event === 'merged' ? (row.status !== 'done' ? 'done' : null)
        : event === 'discarded' ? (!otherActive && ['doing', 'review'].includes(row.status) ? 'todo' : null)
        : null
      if (next) {
        this.run('UPDATE tasks SET status = ?, done_at = ? WHERE id = ?', next, next === 'done' ? at : null, row.id)
        this.touch('task', row.id, 'auto', `status ${row.status} → ${next}${event === 'discarded' ? ' (chat discarded)' : ''}`)
        changed = true
      }
      return row.id
    })
    return { task: id ? this.get(id) : null, changed }
  }

  // --- internals ---

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  all(sql, ...args) {
    return this.db.prepare(sql).all(...args)
  }

  run(sql, ...args) {
    return this.db.prepare(sql).run(...args)
  }

  meta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
  }

  setMeta(key, value) {
    this.run('INSERT INTO meta VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value))
  }

  nextKey(kind) {
    const n = Number(this.meta(`next_${kind}`) ?? 1)
    this.setMeta(`next_${kind}`, n + 1)
    return `${PREFIX[kind]}-${n}`
  }

  find(ref) {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 100) return null
    const r = ref.trim()
    const m = /^([MET])-(\d+)$/i.exec(r)
    const kinds = m ? [Object.keys(PREFIX).find((k) => PREFIX[k] === m[1].toUpperCase())] : Object.keys(TABLE)
    for (const kind of kinds) {
      const row = this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE ${m ? 'key' : 'id'} = ?`).get(m ? r.toUpperCase() : r)
      if (row) return { kind, row }
    }
    return null
  }

  mustFind(ref) {
    const found = this.find(ref)
    if (!found) throw new Error(`No milestone, epic or task ${typeof ref === 'string' ? ref.slice(0, 100) : ''}`.trim())
    return found
  }

  /**
   * A parent reference (id or key) → its id, checked to be of the right kind and not archived
   * (an item under an archived parent would show nowhere); null clears. `current` is the
   * item's present parent, which may stay even if archived.
   */
  parent(ref, kind, current = null) {
    if (ref === null || ref === '') return null
    const found = this.find(ref)
    if (!found || found.kind !== kind) throw new Error(`No ${kind} ${String(ref).slice(0, 100)}`)
    if (found.row.archived_at && found.row.id !== current) throw new Error(`${found.row.key} is archived; restore it first`)
    return found.row.id
  }

  parentLabel(ref, kind) {
    return ref === null || ref === '' ? `removed from ${kind}` : `moved to ${this.find(ref)?.row.key ?? kind}`
  }

  touch(kind, id, source, change) {
    this.run(`UPDATE ${TABLE[kind]} SET updated_at = ? WHERE id = ?`, now(), id)
    this.log(id, source, change)
  }

  log(itemId, source, change) {
    this.run('INSERT INTO history (item_id, at, source, change) VALUES (?, ?, ?, ?)', itemId, now(), sourceOf(source), change)
    this.run('DELETE FROM history WHERE item_id = ? AND id NOT IN (SELECT id FROM history WHERE item_id = ? ORDER BY id DESC LIMIT ?)', itemId, itemId, HISTORY_KEPT)
  }

  descendants(kind, id) {
    const tasksOf = (epicId) => this.all('SELECT id, archive_batch FROM tasks WHERE epic_id = ?', epicId).map((r) => ({ kind: 'task', id: r.id, batch: r.archive_batch }))
    if (kind === 'epic') return tasksOf(id)
    if (kind !== 'milestone') return []
    return this.all('SELECT id, archive_batch FROM epics WHERE milestone_id = ?', id).flatMap((e) => [{ kind: 'epic', id: e.id, batch: e.archive_batch }, ...tasksOf(e.id)])
  }

  ancestors(kind, row) {
    const out = []
    const epic = kind === 'task' && row.epic_id ? this.db.prepare('SELECT id, milestone_id FROM epics WHERE id = ?').get(row.epic_id) : null
    if (epic) out.push({ kind: 'epic', id: epic.id })
    const milestoneId = kind === 'epic' ? row.milestone_id : epic?.milestone_id
    if (milestoneId) out.push({ kind: 'milestone', id: milestoneId })
    return out
  }

  insertV1(t) {
    if (this.find(t.id)) return
    const position = (this.db.prepare('SELECT MAX(position) AS p FROM tasks').get().p ?? 0) + 1
    this.run(
      "INSERT INTO tasks VALUES (?, ?, ?, ?, 'software', NULL, ?, 'none', ?, ?, NULL, ?, ?, NULL)",
      t.id, this.nextKey('task'), t.title, t.notes, t.status, position, t.status === 'done' ? t.updatedAt : null, t.createdAt, t.updatedAt
    )
    for (const r of t.runIds) this.run('INSERT OR IGNORE INTO task_runs VALUES (?, ?, ?)', t.id, r, t.updatedAt)
    this.log(t.id, 'auto', 'imported from .thinkerer/tasks.json')
  }
}

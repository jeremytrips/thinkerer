// Board schema, migrations and the one-time import of the old .thinkerer/tasks.json.
// Plain JS so the thinkerer-board MCP server runs without a build.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORK_TYPES = ['software', 'firmware', 'electronics', 'mechanical', 'marketing', 'research', 'other']
export const TASK_STATUSES = ['backlog', 'todo', 'doing', 'review', 'done']
export const EPIC_STATUSES = ['todo', 'doing', 'done']
export const MILESTONE_STATUSES = ['planned', 'active', 'done']
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent']

// Each entry upgrades the database by one version (PRAGMA user_version). Never edit a
// shipped entry: projects keep their database, so add a new one instead.
const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE milestones (
    id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    target_date TEXT, status TEXT NOT NULL, position REAL NOT NULL, archived_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archive_batch TEXT
  );
  CREATE TABLE epics (
    id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL, milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
    status TEXT NOT NULL, position REAL NOT NULL, archived_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archive_batch TEXT
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL, epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
    status TEXT NOT NULL, priority TEXT NOT NULL, position REAL NOT NULL, done_at TEXT, archived_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archive_batch TEXT
  );
  -- archive_batch: one id per archive action, so restoring or deleting an item takes along
  -- exactly the children archived with it (timestamps can collide).
  -- Checklists of epics and tasks (item_id is either).
  CREATE TABLE criteria (item_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL,
    PRIMARY KEY (item_id, position));
  CREATE TABLE labels (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, label TEXT NOT NULL,
    PRIMARY KEY (task_id, label));
  CREATE TABLE blocked_by (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocker_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, PRIMARY KEY (task_id, blocker_id));
  -- last_event: the chat event last applied to the task, so a chat that stays merged doesn't
  -- keep overriding a status the user set by hand.
  CREATE TABLE task_chats (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, chat_id TEXT NOT NULL,
    linked_at TEXT NOT NULL, last_event TEXT, PRIMARY KEY (task_id, chat_id));
  CREATE INDEX task_chats_chat ON task_chats (chat_id);
  CREATE TABLE task_runs (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id TEXT NOT NULL,
    linked_at TEXT NOT NULL, PRIMARY KEY (task_id, run_id));
  CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, at TEXT NOT NULL,
    source TEXT NOT NULL, change TEXT NOT NULL);
  CREATE INDEX history_item ON history (item_id, id);
  `
]

/** Brings the database to the latest schema. Runs inside the caller's write transaction. */
export function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version > MIGRATIONS.length) {
    throw new Error(`This project's board was written by a newer Thinkerer (schema ${version}); update Thinkerer to open it`)
  }
  for (let v = version; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v])
  if (version !== MIGRATIONS.length) db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
}

const V1_STATUS = { todo: 'todo', doing: 'doing', done: 'done' }

/**
 * Imports the tasks of the old JSON board once (ids and run links kept). The JSON file is
 * left untouched. Returns the old tasks to insert; the caller writes them.
 */
export function v1TasksFile(projectRoot) {
  return join(projectRoot, '.thinkerer', 'tasks.json')
}

export function readV1Tasks(projectRoot) {
  const file = v1TasksFile(projectRoot)
  if (!existsSync(file)) return []
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return [] // A broken file has nothing safe to import.
  }
  if (!Array.isArray(raw?.tasks)) return []
  return raw.tasks
    .filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string' && t.title.trim() && V1_STATUS[t.status])
    .map((t) => ({
      id: t.id.slice(0, 100),
      title: t.title.trim().slice(0, 300),
      notes: typeof t.notes === 'string' ? t.notes.slice(0, 10_000) : '',
      status: V1_STATUS[t.status],
      runIds: Array.isArray(t.runIds) ? t.runIds.filter((r) => typeof r === 'string') : [],
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString()
    }))
}

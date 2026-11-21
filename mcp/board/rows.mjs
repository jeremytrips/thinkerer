// Input checks and row → object mapping for the board store. Plain JS (see store.mjs).

export function now() {
  return new Date().toISOString()
}

export function text(value, name, max, required = false) {
  if (typeof value !== 'string') throw new Error(`${name} must be text`)
  const v = value.trim()
  if (required && !v) throw new Error(`${name} can't be empty`)
  if (v.length > max) throw new Error(`${name} must be at most ${max} characters`)
  return v
}

export function oneOf(value, list, name) {
  if (!list.includes(value)) throw new Error(`Invalid ${name}: use one of ${list.join(', ')}`)
  return value
}

export function date(value) {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error('Dates must be YYYY-MM-DD')
  return value
}

export function sourceOf(source) {
  if (source === 'user' || source === 'auto') return source
  if (typeof source === 'string' && /^agent:[\w-]{0,100}$/.test(source)) return source
  return 'agent:'
}

export function groupBy(rows, key, map) {
  const out = new Map()
  for (const r of rows) out.set(r[key], [...(out.get(r[key]) ?? []), map(r)])
  return out
}

export function base(r) {
  return { id: r.id, key: r.key, title: r.title, position: r.position, archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at }
}

export function milestoneOf(r) {
  return { kind: 'milestone', ...base(r), description: r.description, targetDate: r.target_date, status: r.status }
}

export function epicOf(r, criteria) {
  return { kind: 'epic', ...base(r), description: r.description, type: r.type, milestoneId: r.milestone_id, status: r.status, criteria: criteria.get(r.id) ?? [] }
}

export function taskOf(r, g) {
  return {
    kind: 'task',
    ...base(r),
    notes: r.notes,
    type: r.type,
    epicId: r.epic_id,
    status: r.status,
    priority: r.priority,
    labels: g.labels.get(r.id) ?? [],
    criteria: g.criteria.get(r.id) ?? [],
    blockedBy: g.blockers.get(r.id) ?? [],
    chatIds: g.chats.get(r.id) ?? [],
    runIds: g.runs.get(r.id) ?? [],
    doneAt: r.done_at
  }
}

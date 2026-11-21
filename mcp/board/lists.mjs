// The list fields of board items (criteria, labels, blockers), replaced as a whole.
// Each runs inside the caller's transaction and returns whether the list changed.
// Plain JS (see store.mjs).
import { text } from './rows.mjs'

/** "Done when" checklist of an epic or task. */
export function setCriteria(store, itemId, list) {
  if (!Array.isArray(list) || list.length > 50) throw new Error('Criteria must be a list of at most 50 items')
  const next = list.map((c) => ({ text: text(c?.text, 'Criterion', 500, true), done: c?.done === true }))
  const prev = store.all('SELECT text, done FROM criteria WHERE item_id = ? ORDER BY position', itemId).map((r) => ({ text: r.text, done: !!r.done }))
  if (JSON.stringify(prev) === JSON.stringify(next)) return false
  store.run('DELETE FROM criteria WHERE item_id = ?', itemId)
  next.forEach((c, i) => store.run('INSERT INTO criteria VALUES (?, ?, ?, ?)', itemId, i, c.text, c.done ? 1 : 0))
  return true
}

export function setLabels(store, taskId, list) {
  if (!Array.isArray(list) || list.length > 20) throw new Error('Labels must be a list of at most 20')
  const next = [...new Set(list.map((l) => text(l, 'Label', 40, true).toLowerCase()))].sort()
  const prev = store.all('SELECT label FROM labels WHERE task_id = ? ORDER BY label', taskId).map((r) => r.label)
  if (prev.join('\n') === next.join('\n')) return false
  store.run('DELETE FROM labels WHERE task_id = ?', taskId)
  for (const l of next) store.run('INSERT INTO labels VALUES (?, ?)', taskId, l)
  return true
}

/**
 * Tasks this one waits for. Archived blockers are allowed (unlike parents): the views
 * ignore them, and refusing them would make a task with one uneditable.
 */
export function setBlockers(store, taskId, list) {
  if (!Array.isArray(list) || list.length > 50) throw new Error('Blockers must be a list of at most 50 tasks')
  const idOf = (ref) => {
    const found = store.find(ref)
    if (!found || found.kind !== 'task') throw new Error(`No task ${String(ref).slice(0, 100)}`)
    return found.row.id
  }
  const next = [...new Set(list.map(idOf))].sort()
  if (next.includes(taskId)) throw new Error("A task can't block itself")
  // Refuse cycles: nothing this task (transitively) blocks may block it.
  const blocked = new Set()
  const queue = [taskId]
  while (queue.length) {
    const id = queue.pop()
    for (const r of store.all('SELECT task_id FROM blocked_by WHERE blocker_id = ?', id)) {
      if (blocked.has(r.task_id)) continue
      blocked.add(r.task_id)
      queue.push(r.task_id)
    }
  }
  const cycle = next.find((id) => blocked.has(id))
  if (cycle) throw new Error(`That would make a loop: ${store.find(cycle).row.key} already waits for this task`)
  const prev = store.all('SELECT blocker_id FROM blocked_by WHERE task_id = ? ORDER BY blocker_id', taskId).map((r) => r.blocker_id)
  if (prev.join('\n') === next.join('\n')) return false
  store.run('DELETE FROM blocked_by WHERE task_id = ?', taskId)
  for (const b of next) store.run('INSERT INTO blocked_by VALUES (?, ?)', taskId, b)
  return true
}

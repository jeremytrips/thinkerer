import type { Board, Epic, Task } from './types'

// Pure board helpers shared by the engine (epic runs) and the renderer (Tasks tab).

/** Blockers of a task that aren't done yet. */
export function openBlockers(board: Board, t: Task): Task[] {
  return t.blockedBy.map((id) => board.tasks.find((x) => x.id === id)).filter((x): x is Task => !!x && x.status !== 'done' && !x.archivedAt)
}

/** The prompt a new chat on a task starts with: key, title, notes and its "done when" list. */
export function taskPrompt(t: Task): string {
  const parts = [`${t.key}: ${t.title}`]
  if (t.notes) parts.push(t.notes)
  if (t.criteria.length) parts.push(`Done when:\n${t.criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')}`)
  return parts.join('\n\n')
}

/** The epic's live tasks that aren't done, in plan order. */
export function openEpicTasks(board: Board, epicId: string): Task[] {
  return board.tasks.filter((t) => t.epicId === epicId && !t.archivedAt && t.status !== 'done').sort((a, b) => a.position - b.position)
}

/** The next task an epic run should start: the first open one, in plan order, with no open blockers. */
export function nextReadyTask(board: Board, epicId: string): Task | null {
  return openEpicTasks(board, epicId).find((t) => openBlockers(board, t).length === 0) ?? null
}

/** Done and total live tasks of an epic. */
export function epicProgress(board: Board, epicId: string): { done: number; total: number } {
  const tasks = board.tasks.filter((t) => t.epicId === epicId && !t.archivedAt)
  return { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length }
}

/** Blockers that hold up the rest of an epic: open tasks it waits on that belong to another epic (or none). */
export function outsideBlockers(board: Board, epicId: string): Task[] {
  const seen = new Map<string, Task>()
  for (const t of openEpicTasks(board, epicId)) for (const b of openBlockers(board, t)) if (b.epicId !== epicId) seen.set(b.id, b)
  return [...seen.values()]
}

/** An epic-run chat's first message: the task (it names the chat), then which epic it belongs to, so the agent stays within its task. */
export function epicTaskPrompt(epic: Epic, task: Task): string {
  return `${taskPrompt(task)}\n\nPart of epic ${epic.key}: ${epic.title}. The other tasks of this epic get their own chats; stay within this task.`
}

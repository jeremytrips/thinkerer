import { useCallback, useEffect, useState } from 'react'
import type { Board, BoardItem, Epic, EpicStatus, Milestone, MilestoneStatus, Project, Task, TaskPriority, TaskStatus, WorkType } from '../../shared/types'
import { api, errorMessage } from '../api'

export { openBlockers, taskPrompt } from '../../shared/boardOrder'

// Labels and pure helpers for the Tasks tab (no rendering).

export const TYPES: { id: WorkType; label: string }[] = [
  { id: 'software', label: 'Software' },
  { id: 'firmware', label: 'Firmware' },
  { id: 'electronics', label: 'Electronics' },
  { id: 'mechanical', label: 'Mechanical / 3D' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'research', label: 'Research' },
  { id: 'other', label: 'Other' }
]
export const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label])) as Record<WorkType, string>

export const TASK_COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'done', label: 'Done' }
]
export const TASK_STATUS_LABEL = Object.fromEntries(TASK_COLUMNS.map((c) => [c.id, c.label])) as Record<TaskStatus, string>
export const EPIC_STATUS_LABEL: Record<EpicStatus, string> = { todo: 'To do', doing: 'In progress', done: 'Done' }
export const MILESTONE_STATUS_LABEL: Record<MilestoneStatus, string> = { planned: 'Planned', active: 'Active', done: 'Done' }
export const PRIORITY_LABEL: Record<TaskPriority, string> = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' }

export const EMPTY_BOARD: Board = { milestones: [], epics: [], tasks: [] }

export interface BoardFilter {
  text: string
  type: WorkType | ''
  label: string
  status: TaskStatus | ''
}
export const NO_FILTER: BoardFilter = { text: '', type: '', label: '', status: '' }

export function isFiltering(f: BoardFilter): boolean {
  return !!(f.text.trim() || f.type || f.label || f.status)
}

export function matchesTask(t: Task, f: BoardFilter): boolean {
  const q = f.text.trim().toLowerCase()
  if (q && !`${t.key} ${t.title} ${t.notes}`.toLowerCase().includes(q)) return false
  if (f.type && t.type !== f.type) return false
  if (f.label && !t.labels.includes(f.label)) return false
  if (f.status && t.status !== f.status) return false
  return true
}

export function live(board: Board): Board {
  return { milestones: board.milestones.filter((m) => !m.archivedAt), epics: board.epics.filter((e) => !e.archivedAt), tasks: board.tasks.filter((t) => !t.archivedAt) }
}

/** Done and total live tasks under an epic or milestone. */
export function progress(board: Board, item: Epic | Milestone): { done: number; total: number } {
  const epicIds = item.kind === 'epic' ? new Set([item.id]) : new Set(board.epics.filter((e) => e.milestoneId === item.id && !e.archivedAt).map((e) => e.id))
  const tasks = board.tasks.filter((t) => !t.archivedAt && t.epicId && epicIds.has(t.epicId))
  return { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length }
}

export function allLabels(board: Board): string[] {
  return [...new Set(board.tasks.flatMap((t) => t.labels))].sort()
}

export function findItem(board: Board, id: string | null): BoardItem | null {
  if (!id) return null
  return board.milestones.find((m) => m.id === id) ?? board.epics.find((e) => e.id === id) ?? board.tasks.find((t) => t.id === id) ?? null
}

/** Moves `id` before `beforeId` (or to the end) in an ordered id list. */
export function moveBefore(ids: string[], id: string, beforeId: string | null): string[] {
  const rest = ids.filter((x) => x !== id)
  const at = beforeId ? rest.indexOf(beforeId) : -1
  if (at < 0) return [...rest, id]
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** The project's board, kept live (edits here, by Thinkerer following chats, or by agents via MCP). */
export function useBoard(project: Project) {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.board.get(project.id).then(setBoard, (e) => setError(errorMessage(e)))
  }, [project.id])

  useEffect(() => {
    refresh()
    return api.board.onChange((path) => path === project.path && refresh())
  }, [project.id, project.path, refresh])

  /** Runs a change and shows its error near the board; the change event refreshes the board. */
  const act = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | null> => {
      setError(null)
      try {
        const result = await fn()
        refresh()
        return result
      } catch (err) {
        setError(errorMessage(err))
        return null
      }
    },
    [refresh]
  )

  return { board, error, setError, act }
}

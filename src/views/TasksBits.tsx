import type { TaskPriority, TaskStatus, WorkType } from '../../shared/types'
import { PRIORITY_LABEL, TASK_STATUS_LABEL, TYPE_LABEL } from './boardModel'

export function TypeBadge({ type }: { type: WorkType }) {
  return (
    <span className="badge type-badge">
      <span className={`dot type-${type}`} aria-hidden="true" />
      {TYPE_LABEL[type]}
    </span>
  )
}

const STATUS_GLYPH: Record<TaskStatus, string> = { backlog: '◌', todo: '○', doing: '◐', review: '◑', done: '●' }

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`pill task-status-${status}`}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span> {TASK_STATUS_LABEL[status]}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  if (priority === 'none') return null
  return <span className={`badge priority-${priority}`}>{PRIORITY_LABEL[priority]}</span>
}

/** Done / total tasks; a bar only when there is something to count. */
export function Progress({ done, total }: { done: number; total: number }) {
  if (!total) return <span className="small muted">No tasks</span>
  return (
    <span className="progress" title={`${done} of ${total} tasks done`}>
      <span className="progress-track" aria-hidden="true">
        <span className="progress-fill" style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </span>
      <span className="small muted">
        {done}/{total}
      </span>
    </span>
  )
}

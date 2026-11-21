import { useState } from 'react'
import type { Board, Task, TaskStatus } from '../../shared/types'
import { TASK_COLUMNS, moveBefore, openBlockers } from './boardModel'
import { PriorityBadge, TypeBadge } from './TasksBits'

interface Props {
  board: Board
  /** Live tasks that pass the filter. */
  tasks: Task[]
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (task: Task, status: TaskStatus, order: string[] | null) => void
}

/** Kanban by task status. Drag a card to another column or between cards; Shift+←/→ moves the focused card. */
export function TasksBoard({ board, tasks, selectedId, onSelect, onMove }: Props) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStatus | null>(null)

  function drop(status: TaskStatus, beforeId: string | null) {
    const task = tasks.find((t) => t.id === dragging)
    setDragging(null)
    setOver(null)
    if (!task) return
    const order = moveBefore(board.tasks.map((t) => t.id), task.id, beforeId)
    onMove(task, status, order)
  }

  return (
    <div className="kanban">
      {TASK_COLUMNS.map((col, ci) => {
        const items = tasks.filter((t) => t.status === col.id)
        return (
          <section
            key={col.id}
            className={over === col.id ? 'column drop-target' : 'column'}
            aria-label={col.label}
            onDragOver={(e) => {
              if (!dragging) return
              e.preventDefault()
              setOver(col.id)
            }}
            onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              drop(col.id, null)
            }}
          >
            <h3>
              {col.label} <span className="muted">{items.length}</span>
            </h3>
            {items.map((t) => {
              const blockers = openBlockers(board, t)
              const epic = t.epicId ? board.epics.find((e) => e.id === t.epicId) : null
              return (
                <article
                  key={t.id}
                  className={`card task-card${selectedId === t.id ? ' selected' : ''}`}
                  tabIndex={0}
                  draggable
                  aria-label={`${t.key} ${t.title}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', t.id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDragging(t.id)
                  }}
                  onDragEnd={() => (setDragging(null), setOver(null))}
                  onDragOver={(e) => dragging && dragging !== t.id && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    drop(col.id, t.id)
                  }}
                  onClick={() => onSelect(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelect(t.id)
                    const next = e.shiftKey && e.key === 'ArrowRight' ? TASK_COLUMNS[ci + 1] : e.shiftKey && e.key === 'ArrowLeft' ? TASK_COLUMNS[ci - 1] : null
                    if (next) {
                      e.preventDefault()
                      onMove(t, next.id, null)
                    }
                  }}
                >
                  <div className="row small">
                    <span className="mono muted">{t.key}</span>
                    <TypeBadge type={t.type} />
                    <PriorityBadge priority={t.priority} />
                  </div>
                  <div className="task-title">{t.title}</div>
                  {epic && <div className="small muted ellipsis">{epic.key} · {epic.title}</div>}
                  {(blockers.length > 0 || t.criteria.length > 0 || t.chatIds.length > 0) && (
                    <div className="row small">
                      {blockers.length > 0 && <span className="badge badge-warn">⏸ Waits for {blockers.map((b) => b.key).join(', ')}</span>}
                      {t.criteria.length > 0 && (
                        <span className="muted">☑ {t.criteria.filter((c) => c.done).length}/{t.criteria.length}</span>
                      )}
                      {t.chatIds.length > 0 && <span className="muted">{t.chatIds.length} chat{t.chatIds.length === 1 ? '' : 's'}</span>}
                    </div>
                  )}
                </article>
              )
            })}
            {items.length === 0 && <p className="small muted">Nothing here.</p>}
          </section>
        )
      })}
    </div>
  )
}

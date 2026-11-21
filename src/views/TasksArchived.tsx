import { useState } from 'react'
import type { Board, BoardItem } from '../../shared/types'
import { relativeTime } from './RunBits'
import { TaskStatusBadge, TypeBadge } from './TasksBits'

interface Props {
  board: Board
  selectedId: string | null
  onSelect: (id: string) => void
  onRestore: (item: BoardItem) => void
  onDelete: (item: BoardItem) => void
}

/** Archived milestones, epics and tasks: restore them, or delete them for good (asks first). */
export function TasksArchived({ board, selectedId, onSelect, onRestore, onDelete }: Props) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const groups: { label: string; items: BoardItem[] }[] = [
    { label: 'Milestones', items: board.milestones.filter((m) => m.archivedAt) },
    { label: 'Epics', items: board.epics.filter((e) => e.archivedAt) },
    { label: 'Tasks', items: board.tasks.filter((t) => t.archivedAt) }
  ]
  const byNewest = (a: BoardItem, b: BoardItem) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')

  if (groups.every((g) => !g.items.length)) return <p className="muted">Nothing archived. Archive a finished or dropped item from its details.</p>

  return (
    <div className="archived">
      {groups.map(
        (g) =>
          g.items.length > 0 && (
            <section key={g.label} className="card" aria-label={`Archived ${g.label.toLowerCase()}`}>
              <h3>
                {g.label} <span className="muted">{g.items.length}</span>
              </h3>
              <ul>
                {[...g.items].sort(byNewest).map((item) => (
                  <li key={item.id} className={`archived-row${selectedId === item.id ? ' selected' : ''}`}>
                    <button className="plan-row" onClick={() => onSelect(item.id)}>
                      <span className="mono muted">{item.key}</span>
                      <span className="ellipsis plan-title">{item.title}</span>
                      {item.kind === 'task' && <TaskStatusBadge status={item.status} />}
                      {item.kind !== 'milestone' && <TypeBadge type={item.type} />}
                      <span className="small muted">Archived {relativeTime(item.archivedAt!)}</span>
                    </button>
                    <div className="row">
                      <button className="small" onClick={() => onRestore(item)}>Restore</button>
                      {confirm === item.id ? (
                        <>
                          <button className="small" onClick={() => setConfirm(null)}>Keep</button>
                          <button className="small danger" onClick={() => (setConfirm(null), onDelete(item))}>
                            Delete {item.key} for good
                          </button>
                        </>
                      ) : (
                        <button className="small link" onClick={() => setConfirm(item.id)}>Delete…</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )
      )}
      <p className="small muted">Deleting also deletes the children that were archived with the item. It can't be undone.</p>
    </div>
  )
}

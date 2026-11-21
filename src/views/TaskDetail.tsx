import { useEffect, useState } from 'react'
import type { Board, BoardHistoryEntry, BoardItem, BoardPatch, ChatRecord, Project, Task } from '../../shared/types'
import { api } from '../api'
import {
  EPIC_STATUS_LABEL,
  MILESTONE_STATUS_LABEL,
  PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TYPES,
  progress
} from './boardModel'
import { relativeTime } from './RunBits'
import { BlockersEditor, CriteriaEditor, EditableText, LinkedChats } from './TaskDetailParts'
import { Progress, TaskStatusBadge } from './TasksBits'

interface Props {
  project: Project
  board: Board
  item: BoardItem
  chats: ChatRecord[]
  act: <T>(fn: () => Promise<T>) => Promise<T | null>
  onClose: () => void
  onSelect: (id: string) => void
  onStartChat: (task: Task) => void
  onOpenChat: (chatId: string) => void
}

const KIND_LABEL = { milestone: 'Milestone', epic: 'Epic', task: 'Task' }

/** The details of one milestone, epic or task, editable; side pane of the Tasks tab. */
export function TaskDetail({ project, board, item, chats, act, onClose, onSelect, onStartChat, onOpenChat }: Props) {
  const [history, setHistory] = useState<BoardHistoryEntry[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = (patch: BoardPatch) => act(() => api.board.update(project.id, item.id, patch))

  useEffect(() => {
    api.board.history(project.id, item.id).then(setHistory, () => setHistory([]))
  }, [project.id, item.id, item.updatedAt, item.archivedAt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const archived = !!item.archivedAt
  const liveEpics = board.epics.filter((e) => !e.archivedAt || e.id === (item.kind === 'task' ? item.epicId : null))
  const liveMilestones = board.milestones.filter((m) => !m.archivedAt || m.id === (item.kind === 'epic' ? item.milestoneId : null))

  return (
    <aside className="detail" aria-label={`${KIND_LABEL[item.kind]} ${item.key}`}>
      <div className="row space detail-head">
        <span className="small muted">
          {KIND_LABEL[item.kind]} <span className="mono">{item.key}</span>
          {archived && <span className="badge push-gap">Archived</span>}
        </span>
        <button className="small" onClick={onClose} aria-label="Close details" title="Close (esc)">
          ✕
        </button>
      </div>

      <EditableText value={item.title} label="Title" maxLength={300} onSave={(title) => save({ title })} />

      <div className="detail-grid">
        <label>
          Status
          {item.kind === 'task' ? (
            <select value={item.status} onChange={(e) => save({ status: e.target.value as Task['status'] })}>
              {Object.entries(TASK_STATUS_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          ) : item.kind === 'epic' ? (
            <select value={item.status} onChange={(e) => save({ status: e.target.value as BoardPatch['status'] })}>
              {Object.entries(EPIC_STATUS_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          ) : (
            <select value={item.status} onChange={(e) => save({ status: e.target.value as BoardPatch['status'] })}>
              {Object.entries(MILESTONE_STATUS_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          )}
        </label>
        {item.kind !== 'milestone' && (
          <label>
            Type
            <select value={item.type} onChange={(e) => save({ type: e.target.value as Task['type'] })}>
              {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
        )}
        {item.kind === 'task' && (
          <label>
            Priority
            <select value={item.priority} onChange={(e) => save({ priority: e.target.value as Task['priority'] })}>
              {Object.entries(PRIORITY_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
        )}
        {item.kind === 'task' && (
          <label>
            Epic
            <select value={item.epicId ?? ''} onChange={(e) => save({ epicId: e.target.value || null })}>
              <option value="">No epic</option>
              {liveEpics.map((e) => <option key={e.id} value={e.id}>{e.key} · {e.title}</option>)}
            </select>
          </label>
        )}
        {item.kind === 'epic' && (
          <label>
            Milestone
            <select value={item.milestoneId ?? ''} onChange={(e) => save({ milestoneId: e.target.value || null })}>
              <option value="">No milestone</option>
              {liveMilestones.map((m) => <option key={m.id} value={m.id}>{m.key} · {m.title}</option>)}
            </select>
          </label>
        )}
        {item.kind === 'milestone' && (
          <label>
            Target date
            <input type="date" value={item.targetDate ?? ''} onChange={(e) => save({ targetDate: e.target.value || null })} />
          </label>
        )}
      </div>

      <section>
        <h3>{item.kind === 'task' ? 'Notes' : 'Description'}</h3>
        {item.kind === 'task' ? (
          <EditableText multiline value={item.notes} label="Notes" placeholder="What this task is about, links, decisions…" maxLength={10_000} onSave={(notes) => save({ notes })} />
        ) : (
          <EditableText multiline value={item.description} label="Description" placeholder="What this is for" maxLength={10_000} onSave={(description) => save({ description })} />
        )}
      </section>

      {item.kind === 'task' && (
        <section>
          <h3>Labels</h3>
          <EditableText
            value={item.labels.join(', ')}
            label="Labels"
            placeholder="Comma-separated, e.g. ui, bom"
            onSave={(v) => save({ labels: v.split(',').map((l) => l.trim()).filter(Boolean) })}
          />
        </section>
      )}

      {item.kind !== 'milestone' && (
        <section>
          <h3>Done when</h3>
          <CriteriaEditor criteria={item.criteria} onSave={(criteria) => save({ criteria })} />
        </section>
      )}

      {item.kind === 'task' && (
        <>
          <section>
            <h3>Waits for</h3>
            <BlockersEditor board={board} task={item} onSave={(blockedBy) => save({ blockedBy })} />
          </section>
          <section>
            <h3>Chats</h3>
            <LinkedChats task={item} chats={chats} onOpenChat={onOpenChat} />
            {!archived && item.status !== 'done' && (
              <button className="primary detail-start" onClick={() => onStartChat(item)}>
                Start a chat on {item.key}
              </button>
            )}
          </section>
        </>
      )}

      {item.kind !== 'task' && <Children board={board} item={item} onSelect={onSelect} />}

      <details className="detail-history">
        <summary className="small">History ({history.length})</summary>
        <ul>
          {history.map((h, i) => (
            <li key={i} className="small">
              <span className="muted">{relativeTime(h.at)}</span> · <span className="muted">{sourceLabel(h.source)}</span> · {h.change}
            </li>
          ))}
        </ul>
      </details>

      <div className="row detail-actions">
        {archived ? (
          <>
            <button onClick={() => act(() => api.board.unarchive(project.id, item.id))}>Restore</button>
            {confirmDelete ? (
              <>
                <button onClick={() => setConfirmDelete(false)}>Keep</button>
                <button className="danger" onClick={() => act(() => api.board.remove(project.id, item.id)).then((ok) => ok && onClose())}>
                  Delete {item.key} for good
                </button>
              </>
            ) : (
              <button className="link" onClick={() => setConfirmDelete(true)}>Delete…</button>
            )}
          </>
        ) : (
          <button onClick={() => act(() => api.board.archive(project.id, item.id))} title={item.kind === 'task' ? undefined : 'Archives its children too'}>
            Archive
          </button>
        )}
        <span className="small muted push-right">Updated {relativeTime(item.updatedAt)}</span>
      </div>
    </aside>
  )
}

function Children({ board, item, onSelect }: { board: Board; item: Exclude<BoardItem, Task>; onSelect: (id: string) => void }) {
  const children: BoardItem[] =
    item.kind === 'epic' ? board.tasks.filter((t) => t.epicId === item.id && !t.archivedAt) : board.epics.filter((e) => e.milestoneId === item.id && !e.archivedAt)
  return (
    <section>
      <h3>{item.kind === 'epic' ? 'Tasks' : 'Epics'}</h3>
      <Progress {...progress(board, item)} />
      <ul className="detail-children">
        {children.map((c) => (
          <li key={c.id}>
            <button className="plan-row" onClick={() => onSelect(c.id)}>
              {c.kind === 'task' && <TaskStatusBadge status={c.status} />}
              <span className="mono muted">{c.key}</span>
              <span className="ellipsis">{c.title}</span>
            </button>
          </li>
        ))}
        {!children.length && <li className="small muted">None yet.</li>}
      </ul>
    </section>
  )
}

function sourceLabel(source: string): string {
  if (source === 'user') return 'you'
  if (source === 'auto') return 'Thinkerer'
  return 'an agent'
}

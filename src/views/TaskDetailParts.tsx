import { useEffect, useRef, useState } from 'react'
import type { Board, ChatRecord, Criterion, Task } from '../../shared/types'
import { TaskStatusBadge } from './TasksBits'

/** A text input (or textarea) that saves on blur or Enter, and follows outside changes while not focused. */
export function EditableText(props: { value: string; label: string; multiline?: boolean; placeholder?: string; maxLength?: number; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(props.value)
  }, [props.value])
  const commit = () => {
    focused.current = false
    if (draft.trim() !== props.value.trim()) props.onSave(draft)
  }
  const common = {
    value: draft,
    'aria-label': props.label,
    placeholder: props.placeholder,
    maxLength: props.maxLength,
    onFocus: () => (focused.current = true),
    onBlur: commit
  }
  return props.multiline ? (
    <textarea {...common} rows={5} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input {...common} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
  )
}

/** "Done when" checklist: tick, remove, add. Saves the whole list on every change. */
export function CriteriaEditor({ criteria, onSave }: { criteria: Criterion[]; onSave: (next: Criterion[]) => void }) {
  const [text, setText] = useState('')
  const add = () => {
    if (!text.trim()) return
    onSave([...criteria, { text: text.trim(), done: false }])
    setText('')
  }
  return (
    <div className="criteria">
      <ul>
        {criteria.map((c, i) => (
          <li key={`${i}-${c.text}`} className="row">
            <label className="criterion">
              <input type="checkbox" checked={c.done} onChange={() => onSave(criteria.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))} />
              <span className={c.done ? 'muted' : ''}>{c.text}</span>
            </label>
            <button className="small link" aria-label={`Remove “${c.text}”`} onClick={() => onSave(criteria.filter((_, j) => j !== i))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add a criterion" aria-label="New criterion" maxLength={500} />
        <button className="small" onClick={add} disabled={!text.trim()}>Add</button>
      </div>
    </div>
  )
}

/** Tasks this one waits for. */
export function BlockersEditor({ board, task, onSave }: { board: Board; task: Task; onSave: (ids: string[]) => void }) {
  const blockers = task.blockedBy.map((id) => board.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t)
  const candidates = board.tasks.filter((t) => t.id !== task.id && !t.archivedAt && !task.blockedBy.includes(t.id))
  return (
    <div className="blockers">
      {blockers.length > 0 && (
        <ul>
          {blockers.map((b) => (
            <li key={b.id} className="row small">
              <TaskStatusBadge status={b.status} />
              <span className="mono muted">{b.key}</span>
              <span className="ellipsis">{b.title}</span>
              <button className="small link" aria-label={`Stop waiting for ${b.key}`} onClick={() => onSave(task.blockedBy.filter((id) => id !== b.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <select aria-label="Add a blocker" value="" onChange={(e) => e.target.value && onSave([...task.blockedBy, e.target.value])}>
        <option value="">{candidates.length ? 'Waits for…' : 'No other tasks'}</option>
        {candidates.map((t) => (
          <option key={t.id} value={t.id}>{t.key} · {t.title}</option>
        ))}
      </select>
    </div>
  )
}

const STAGE_LABEL: Record<string, string> = { plan: 'Plan', implement: 'Implement', review: 'Review', shipped: 'Shipped' }
const STATE_LABEL: Record<ChatRecord['state'], string> = { 'setting-up': 'Setting up', active: 'Active', merged: 'Merged', done: 'Done' }

/** The chats that worked on a task, with where each one is. */
export function LinkedChats({ task, chats, onOpenChat }: { task: Task; chats: ChatRecord[]; onOpenChat: (chatId: string) => void }) {
  if (!task.chatIds.length) return <p className="small muted">No chat has worked on this task yet.</p>
  return (
    <ul className="linked-chats">
      {[...task.chatIds].reverse().map((id) => {
        const chat = chats.find((c) => c.id === id)
        return (
          <li key={id} className="row small">
            <span className="ellipsis">{chat?.title ?? 'Chat unavailable'}</span>
            {chat && <span className="badge">{chat.doneReason === 'discarded' ? 'Discarded' : STATE_LABEL[chat.state]}</span>}
            {chat?.protocol && <span className="badge badge-accent">{STAGE_LABEL[chat.protocol.stage]}</span>}
            {chat && (
              <button className="small" onClick={() => onOpenChat(id)}>
                Open chat
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

import { useEffect, useState } from 'react'
import type { Board, BoardCreate, BoardKind, WorkType } from '../../shared/types'
import { TYPES } from './boardModel'

interface Props {
  /** Live items only. */
  board: Board
  /** Parent preselected from the item open in the details pane. */
  defaultEpicId: string | null
  defaultMilestoneId: string | null
  onCreate: (input: BoardCreate) => Promise<boolean>
}

/** One-line "add" form for a task, epic or milestone. */
export function TasksNew({ board, defaultEpicId, defaultMilestoneId, onCreate }: Props) {
  const [kind, setKind] = useState<BoardKind>('task')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<WorkType | ''>('')
  const [epicId, setEpicId] = useState(defaultEpicId ?? '')
  const [milestoneId, setMilestoneId] = useState(defaultMilestoneId ?? '')
  useEffect(() => setEpicId(defaultEpicId ?? ''), [defaultEpicId])
  useEffect(() => setMilestoneId(defaultMilestoneId ?? ''), [defaultMilestoneId])

  // A parent that's no longer offered (archived, deleted) must not be sent while the select shows "No …".
  const epic = board.epics.some((e) => e.id === epicId) ? epicId : ''
  const milestone = board.milestones.some((m) => m.id === milestoneId) ? milestoneId : ''

  async function submit() {
    if (!title.trim()) return
    // Without a chosen type, a task takes its epic's type (the store's default).
    const input: BoardCreate =
      kind === 'milestone'
        ? { kind, title }
        : kind === 'epic'
          ? { kind, title, milestoneId: milestone || null, ...(type ? { type } : {}) }
          : { kind, title, epicId: epic || null, ...(type ? { type } : {}) }
    if (await onCreate(input)) setTitle('')
  }

  return (
    <form
      className="card task-new"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <select value={kind} onChange={(e) => setKind(e.target.value as BoardKind)} aria-label="What to add">
        <option value="task">Task</option>
        <option value="epic">Epic</option>
        <option value="milestone">Milestone</option>
      </select>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`New ${kind} title`} aria-label="Title of the new item" maxLength={300} />
      {kind !== 'milestone' && (
        <select value={type} onChange={(e) => setType(e.target.value as WorkType | '')} aria-label="Type">
          <option value="">{kind === 'task' ? 'Type: as its epic' : 'Type: Software'}</option>
          {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      )}
      {kind === 'task' && (
        <select value={epic} onChange={(e) => setEpicId(e.target.value)} aria-label="Epic">
          <option value="">No epic</option>
          {board.epics.map((e) => <option key={e.id} value={e.id}>{e.key} · {e.title}</option>)}
        </select>
      )}
      {kind === 'epic' && (
        <select value={milestone} onChange={(e) => setMilestoneId(e.target.value)} aria-label="Milestone">
          <option value="">No milestone</option>
          {board.milestones.map((m) => <option key={m.id} value={m.id}>{m.key} · {m.title}</option>)}
        </select>
      )}
      <button type="submit" className="primary" disabled={!title.trim()}>
        Add {kind}
      </button>
    </form>
  )
}

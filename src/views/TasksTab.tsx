import { useCallback, useEffect, useState } from 'react'
import type { Project, RunSummary, Task, TaskStatus } from '../../shared/types'
import { api, errorMessage } from '../api'
import { StatusPill } from './RunBits'

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' }
]

export function TasksTab({ project, onRunAgent }: { project: Project; onRunAgent: (task: Task) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.tasks.list(project.id).then(setTasks, (e) => setError(errorMessage(e)))
    api.runs.list(project.id).then(setRuns, () => {})
  }, [project.id])

  useEffect(() => {
    refresh()
    return api.runs.onUpdate((s) => s.projectId === project.id && s.endedAt && refresh())
  }, [project.id, refresh])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section className="tasks">
      <h1>Tasks</h1>
      <form
        className="card task-new"
        onSubmit={(e) => {
          e.preventDefault()
          if (!title.trim()) return
          void act(async () => {
            await api.tasks.create(project.id, title, notes)
            setTitle('')
            setNotes('')
          })
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title" aria-label="Task title" maxLength={300} />
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Task notes" />
        <button type="submit" className="primary" disabled={!title.trim()}>Add task</button>
      </form>
      <p className="small muted">Saved in <span className="mono">.thinkerer/tasks.json</span> inside the project.</p>
      {error && <div className="banner banner-error">{error}</div>}

      <div className="board">
        {COLUMNS.map((col, ci) => {
          const items = (tasks ?? []).filter((t) => t.status === col.id)
          return (
            <section key={col.id} className="column" aria-label={col.label}>
              <h3>
                {col.label} <span className="muted">{items.length}</span>
              </h3>
              {items.map((t) => {
                const linked = t.runIds.map((id) => runs.find((r) => r.id === id)).filter(Boolean) as RunSummary[]
                const latest = linked.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
                return (
                  <article key={t.id} className="card task-card">
                    <div className="task-title">{t.title}</div>
                    {t.notes && <div className="small muted task-notes">{t.notes}</div>}
                    {latest && (
                      <div className="row small">
                        <StatusPill status={latest.status} />
                        <span className="muted">{linked.length} run{linked.length === 1 ? '' : 's'}</span>
                      </div>
                    )}
                    <div className="row task-actions">
                      {ci > 0 && (
                        <button className="small" onClick={() => act(() => api.tasks.update(project.id, t.id, { status: COLUMNS[ci - 1].id }))} aria-label={`Move to ${COLUMNS[ci - 1].label}`}>
                          ←
                        </button>
                      )}
                      {ci < COLUMNS.length - 1 && (
                        <button className="small" onClick={() => act(() => api.tasks.update(project.id, t.id, { status: COLUMNS[ci + 1].id }))} aria-label={`Move to ${COLUMNS[ci + 1].label}`}>
                          →
                        </button>
                      )}
                      {t.status !== 'done' && <button className="small" onClick={() => onRunAgent(t)}>Run agent</button>}
                      {confirmDelete === t.id ? (
                        <>
                          <button className="small" onClick={() => setConfirmDelete(null)}>Keep</button>
                          <button className="small danger" onClick={() => act(() => api.tasks.remove(project.id, t.id))}>Delete</button>
                        </>
                      ) : (
                        <button className="small link" onClick={() => setConfirmDelete(t.id)}>Delete</button>
                      )}
                    </div>
                  </article>
                )
              })}
              {tasks && items.length === 0 && <p className="small muted">Nothing here.</p>}
            </section>
          )
        })}
      </div>
    </section>
  )
}

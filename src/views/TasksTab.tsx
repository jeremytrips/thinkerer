import { useEffect, useMemo, useState } from 'react'
import type { BoardPatch, ChatRecord, Project, Task, TaskStatus, WorkType } from '../../shared/types'
import { api, loadState, saveState } from '../api'
import { EMPTY_BOARD, NO_FILTER, TASK_COLUMNS, TYPES, allLabels, findItem, isFiltering, live, matchesTask, useBoard, type BoardFilter } from './boardModel'
import { EpicRunBar, epicRunActive, useEpicRun } from './EpicRunBar'
import { TaskDetail } from './TaskDetail'
import { TasksArchived } from './TasksArchived'
import { TasksBoard } from './TasksBoard'
import { TasksNew } from './TasksNew'
import { TasksPlan } from './TasksPlan'

type View = 'plan' | 'board' | 'archived'
const VIEWS: { id: View; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'board', label: 'Board' },
  { id: 'archived', label: 'Archived' }
]

interface Props {
  project: Project
  onStartChat: (task: Task) => void
  onOpenChat: (chatId: string) => void
}

/** The project board: milestones → epics → tasks, as a plan, a kanban board, and an archive. */
export function TasksTab({ project, onStartChat, onOpenChat }: Props) {
  const { board, error, setError, act } = useBoard(project)
  const [view, setView] = useState<View>(() => loadState<View>('tasks.view', 'plan'))
  const [filter, setFilter] = useState<BoardFilter>(NO_FILTER)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatRecord[]>([])
  const { run, setRun } = useEpicRun(project)

  useEffect(() => {
    const load = () => api.chats.list(project.id).then(setChats, () => {})
    load()
    return api.chats.onUpdate((c) => c.projectId === project.id && load())
  }, [project.id])

  const all = board ?? EMPTY_BOARD
  const current = useMemo(() => live(all), [all])
  // The status filter is Plan's only: the Board shows statuses as columns and has no control for it.
  const shown = useMemo(() => (view === 'board' ? { ...filter, status: '' as const } : filter), [view, filter])
  const tasks = useMemo(() => current.tasks.filter((t) => matchesTask(t, shown)), [current, shown])
  const labels = useMemo(() => allLabels(current), [current])
  const selected = findItem(all, selectedId)
  const filtering = isFiltering(shown)

  const pick = (v: View) => {
    setView(v)
    saveState('tasks.view', v)
  }
  const setF = (patch: Partial<BoardFilter>) => setFilter((f) => ({ ...f, ...patch }))

  /** Moves an item to a new parent or status, and saves the new order with it. */
  function move(id: string, patch: BoardPatch, order: string[] | null) {
    void act(() => (order ? api.board.move(project.id, id, patch, order) : api.board.update(project.id, id, patch)))
  }

  // New items go under the open item's epic or milestone, but never under an archived one.
  const isLive = (itemId: string | null) => !!itemId && !!findItem(current, itemId)
  const openEpicId = selected?.kind === 'epic' ? selected.id : selected?.kind === 'task' ? selected.epicId : null
  const openMilestoneId = selected?.kind === 'milestone' ? selected.id : selected?.kind === 'epic' ? selected.milestoneId : null
  const defaultEpicId = isLive(openEpicId) ? openEpicId : null
  const defaultMilestoneId = isLive(openMilestoneId) ? openMilestoneId : null

  return (
    <section className={selected ? 'tasks with-detail' : 'tasks'}>
      <div className="tasks-main">
        <div className="row space">
          <h1>Tasks</h1>
          <div className="row segmented" role="tablist" aria-label="Tasks view">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'tab active' : 'tab'} onClick={() => pick(v.id)}>
                {v.label}
                {v.id === 'archived' && <ArchivedCount n={all.milestones.length + all.epics.length + all.tasks.length - (current.milestones.length + current.epics.length + current.tasks.length)} />}
              </button>
            ))}
          </div>
        </div>

        {view !== 'archived' && (
          <>
            <TasksNew board={current} defaultEpicId={defaultEpicId} defaultMilestoneId={defaultMilestoneId} onCreate={async (input) => !!(await act(() => api.board.create(project.id, input)))} />
            <div className="row filters" role="search" aria-label="Filter tasks">
              <input value={filter.text} onChange={(e) => setF({ text: e.target.value })} placeholder="Filter by key, title or notes" aria-label="Filter text" />
              <select value={filter.type} onChange={(e) => setF({ type: e.target.value as WorkType | '' })} aria-label="Filter by type">
                <option value="">All types</option>
                {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              {labels.length > 0 && (
                <select value={filter.label} onChange={(e) => setF({ label: e.target.value })} aria-label="Filter by label">
                  <option value="">All labels</option>
                  {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              )}
              {view === 'plan' && (
                <select value={filter.status} onChange={(e) => setF({ status: e.target.value as TaskStatus | '' })} aria-label="Filter by status">
                  <option value="">All statuses</option>
                  {TASK_COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              )}
              {filtering && <button className="small link" onClick={() => setFilter(NO_FILTER)}>Clear filters</button>}
            </div>
          </>
        )}
        <EpicRunBar project={project} run={run} onRun={setRun} onOpenChat={onOpenChat} />
        {error && (
          <div className="banner banner-error row space">
            <span>{error}</span>
            <button className="small" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {!board ? (
          !error && <p className="muted">Loading…</p>
        ) : view === 'plan' ? (
          <TasksPlan
            board={current}
            tasks={tasks}
            filtering={filtering}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMoveTask={(t, epicId, order) => move(t.id, epicId !== t.epicId ? { epicId } : {}, order)}
            onMoveEpic={(e, milestoneId, order) => move(e.id, milestoneId !== e.milestoneId ? { milestoneId } : {}, order)}
            runEpicId={epicRunActive(run) ? run!.epicId : null}
            onRunEpic={(e) => void act(() => api.epicRuns.start(project.id, e.id, project.config!.agent.provider)).then((r) => r && setRun(r))}
          />
        ) : view === 'board' ? (
          <TasksBoard
            board={current}
            tasks={tasks}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={(t, status, order) => move(t.id, status !== t.status ? { status } : {}, order)}
          />
        ) : (
          <TasksArchived
            board={all}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRestore={(item) => void act(() => api.board.unarchive(project.id, item.id))}
            onDelete={(item) => void act(() => api.board.remove(project.id, item.id)).then(() => selectedId === item.id && setSelectedId(null))}
          />
        )}
        <p className="small muted">
          Saved in <span className="mono">.thinkerer/local/board.sqlite</span> inside the project (not committed). Agents read and update it through the
          thinkerer-board MCP server.
        </p>
      </div>

      {selected && board && (
        <TaskDetail
          key={selected.id}
          project={project}
          board={all}
          item={selected}
          chats={chats}
          act={act}
          onClose={() => setSelectedId(null)}
          onSelect={setSelectedId}
          onStartChat={onStartChat}
          onOpenChat={onOpenChat}
        />
      )}
    </section>
  )
}

function ArchivedCount({ n }: { n: number }) {
  return n > 0 ? <span className="muted"> {n}</span> : null
}

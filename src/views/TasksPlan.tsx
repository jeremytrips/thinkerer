import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Board, Epic, EpicRunStatus, Milestone, Task } from '../../shared/types'
import { nextReadyTask, openEpicTasks, waitingReason } from '../../shared/boardOrder'
import { EPIC_STATUS_LABEL, MILESTONE_STATUS_LABEL, moveBefore, openBlockers, progress } from './boardModel'
import { EPIC_RUN_LABEL } from './EpicRunBar'
import { PriorityBadge, Progress, TaskStatusBadge, TypeBadge } from './TasksBits'

interface Props {
  /** Live items only. */
  board: Board
  /** Live tasks that pass the filter. */
  tasks: Task[]
  filtering: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onMoveTask: (task: Task, epicId: string | null, order: string[]) => void
  onMoveEpic: (epic: Epic, milestoneId: string | null, order: string[]) => void
  /** The epic whose run is active in this project (running, waiting or paused), if any, and its status. */
  runEpicId?: string | null
  runStatus?: EpicRunStatus | null
  /** Starts a chat on each of the epic's tasks in turn. */
  onRunEpic?: (epic: Epic) => void
}

type Drag = { kind: 'task' | 'epic'; id: string } | null

/** Milestone → epic → task tree. Drag a task onto an epic (or between tasks), an epic onto a milestone; ↑/↓ move between rows. */
export function TasksPlan({ board, tasks, filtering, selectedId, onSelect, onMoveTask, onMoveEpic, runEpicId = null, runStatus = null, onRunEpic }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<Drag>(null)
  const [over, setOver] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const shownTasks = (epicId: string | null) => tasks.filter((t) => t.epicId === epicId)
  const shownEpics = (milestoneId: string | null) =>
    board.epics.filter((e) => e.milestoneId === milestoneId && (!filtering || shownTasks(e.id).length > 0))
  const toggle = (id: string) => setCollapsed((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))

  /** Drop handlers for a row that accepts `kind`; `apply` gets the dragged id. */
  function target(key: string, kind: 'task' | 'epic', apply: (id: string) => void) {
    return {
      onDragOver: (e: DragEvent) => {
        if (drag?.kind !== kind || drag.id === key) return
        e.preventDefault()
        e.stopPropagation()
        setOver(key)
      },
      onDragLeave: () => setOver((o) => (o === key ? null : o)),
      onDrop: (e: DragEvent) => {
        if (drag?.kind !== kind) return
        e.preventDefault()
        e.stopPropagation()
        apply(drag.id)
        setDrag(null)
        setOver(null)
      }
    }
  }
  const source = (kind: 'task' | 'epic', id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData('text/plain', id)
      e.dataTransfer.effectAllowed = 'move'
      setDrag({ kind, id })
    },
    onDragEnd: () => (setDrag(null), setOver(null))
  })

  const taskIds = board.tasks.map((t) => t.id)
  const epicIds = board.epics.map((e) => e.id)
  const moveTask = (id: string, epicId: string | null, beforeId: string | null) => {
    const t = board.tasks.find((x) => x.id === id)
    if (t) onMoveTask(t, epicId, moveBefore(taskIds, id, beforeId))
  }
  const moveEpic = (id: string, milestoneId: string | null, beforeId: string | null) => {
    const e = board.epics.find((x) => x.id === id)
    if (e) onMoveEpic(e, milestoneId, moveBefore(epicIds, id, beforeId))
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[data-plan-row]') ?? [])]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    const next = rows[i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  const cls = (base: string, id: string) => `${base}${selectedId === id ? ' selected' : ''}${over === id ? ' drop-target' : ''}`

  function taskRow(t: Task) {
    const blockers = openBlockers(board, t)
    return (
      <li key={t.id}>
        <button data-plan-row className={cls('plan-row plan-task', t.id)} onClick={() => onSelect(t.id)} {...source('task', t.id)} {...target(t.id, 'task', (id) => moveTask(id, t.epicId, t.id))}>
          <TaskStatusBadge status={t.status} />
          <span className="mono muted">{t.key}</span>
          <span className="ellipsis plan-title">{t.title}</span>
          {blockers.length > 0 && <span className="badge badge-warn">⏸ {blockers.map((b) => b.key).join(', ')}</span>}
          <PriorityBadge priority={t.priority} />
          {t.labels.map((l) => <span key={l} className="badge">{l}</span>)}
          <TypeBadge type={t.type} />
        </button>
      </li>
    )
  }

  function epicBlock(e: Epic) {
    const list = shownTasks(e.id)
    const open = !collapsed.has(e.id)
    return (
      <li key={e.id} className="plan-epic">
        <div className="row plan-head">
          <Caret open={open} label={e.title} onClick={() => toggle(e.id)} />
          <button data-plan-row className={cls('plan-row', e.id)} onClick={() => onSelect(e.id)} {...source('epic', e.id)} {...dropBoth(e.id, (id) => moveEpic(id, e.milestoneId, e.id), (id) => moveTask(id, e.id, null))}>
            <span className="mono muted">{e.key}</span>
            <strong className="ellipsis plan-title">{e.title}</strong>
            <span className="badge">{EPIC_STATUS_LABEL[e.status]}</span>
            <Progress {...progress(board, e)} />
            <TypeBadge type={e.type} />
          </button>
          {onRunEpic && <RunEpicButton board={board} epic={e} runEpicId={runEpicId} runStatus={runStatus} onRun={onRunEpic} />}
        </div>
        {open && <ul className="plan-children">{list.length ? list.map(taskRow) : <li className="small muted plan-empty">No tasks yet. Drag one here, or add one with this epic.</li>}</ul>}
      </li>
    )
  }

  /** An epic row takes epics (reorder) and tasks (move into it). */
  function dropBoth(key: string, epicDrop: (id: string) => void, taskDrop: (id: string) => void) {
    const asEpic = target(key, 'epic', epicDrop)
    const asTask = target(key, 'task', taskDrop)
    return {
      onDragOver: (e: DragEvent) => (drag?.kind === 'epic' ? asEpic : asTask).onDragOver(e),
      onDragLeave: () => setOver((o) => (o === key ? null : o)),
      onDrop: (e: DragEvent) => (drag?.kind === 'epic' ? asEpic : asTask).onDrop(e)
    }
  }

  function milestoneBlock(m: Milestone | null, children: ReactNode, empty: boolean) {
    const id = m?.id ?? 'no-milestone'
    const open = !collapsed.has(id)
    return (
      <section key={id} className="plan-milestone card" aria-label={m ? `Milestone ${m.title}` : 'Epics without a milestone'}>
        <div className="row plan-head">
          <Caret open={open} label={m?.title ?? 'No milestone'} onClick={() => toggle(id)} />
          {m ? (
            <button data-plan-row className={cls('plan-row', m.id)} onClick={() => onSelect(m.id)} {...target(m.id, 'epic', (eid) => moveEpic(eid, m.id, null))}>
              <span className="mono muted">{m.key}</span>
              <span className="ellipsis plan-title plan-milestone-title">{m.title}</span>
              <span className="badge">{MILESTONE_STATUS_LABEL[m.status]}</span>
              {m.targetDate && <span className="small muted">Target {m.targetDate}</span>}
              <Progress {...progress(board, m)} />
            </button>
          ) : (
            <div className={cls('plan-row plan-row-static', id)} {...target(id, 'epic', (eid) => moveEpic(eid, null, null))}>
              <h2 className="plan-title muted">No milestone</h2>
            </div>
          )}
        </div>
        {open && (empty ? <p className="small muted plan-empty">No epics yet.</p> : <ul className="plan-children">{children}</ul>)}
      </section>
    )
  }

  const loose = shownTasks(null)
  const orphanEpics = shownEpics(null)
  const milestones = board.milestones.filter((m) => !filtering || shownEpics(m.id).length > 0)
  const nothing = !milestones.length && !orphanEpics.length && !loose.length

  return (
    <div className="plan" ref={root} onKeyDown={onKeyDown}>
      {nothing && <p className="muted">{filtering ? 'No tasks match the filter.' : 'Nothing planned yet. Add a milestone, an epic or a task above.'}</p>}
      {milestones.map((m) => {
        const epics = shownEpics(m.id)
        return milestoneBlock(m, epics.map(epicBlock), epics.length === 0)
      })}
      {orphanEpics.length > 0 && milestoneBlock(null, orphanEpics.map(epicBlock), false)}
      {(loose.length > 0 || (!filtering && board.epics.length > 0)) && (
        <section className="plan-milestone card" aria-label="Tasks without an epic">
          <div className={cls('plan-row plan-row-static', 'no-epic')} {...target('no-epic', 'task', (id) => moveTask(id, null, null))}>
            <h2 className="plan-title muted">Tasks without an epic</h2>
          </div>
          <ul className="plan-children">{loose.length ? loose.map(taskRow) : <li className="small muted plan-empty">None. Drag a task here to take it out of its epic.</li>}</ul>
        </section>
      )}
    </div>
  )
}

function Caret({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button className="caret" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} onClick={onClick}>
      {open ? '▾' : '▸'}
    </button>
  )
}

/** Disabled, with the reason as its title, when nothing of the epic can start or another epic is running. */
function RunEpicButton(p: { board: Board; epic: Epic; runEpicId: string | null; runStatus: EpicRunStatus | null; onRun: (epic: Epic) => void }) {
  const { board, epic, runEpicId, onRun } = p
  if (runEpicId === epic.id) {
    const cls = p.runStatus === 'running' ? 'badge badge-accent plan-run' : 'badge badge-warn plan-run'
    return <span className={cls}>{EPIC_RUN_LABEL[p.runStatus ?? 'running']}</span>
  }
  const why = runEpicId
    ? 'Another epic is running in this project; stop it first'
    : !openEpicTasks(board, epic.id).length
      ? 'Every task of this epic is done'
      : !nextReadyTask(board, epic.id)
        ? waitingReason(board, epic.id).reason
        : null
  return (
    <button className="small plan-run" disabled={!!why} title={why ?? 'Open a chat on each task in turn; the next starts once the last ships'} aria-label={`Run epic ${epic.key}`} onClick={() => onRun(epic)}>
      Run epic
    </button>
  )
}

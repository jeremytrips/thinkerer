import { useEffect, useState } from 'react'
import type { EpicRun, EpicRunStatus, Project } from '../../shared/types'
import { api, errorMessage } from '../api'

const STATUS_LABEL: Record<EpicRunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  paused: 'Paused',
  stopped: 'Stopped',
  finished: 'Finished'
}

/** The project's epic run, kept live. */
export function useEpicRun(project: Project) {
  const [run, setRun] = useState<EpicRun | null>(null)
  useEffect(() => {
    let alive = true
    api.epicRuns.status(project.id).then((r) => alive && setRun(r), () => {})
    const off = api.epicRuns.onUpdate((r) => r.projectId === project.id && setRun(r))
    return () => {
      alive = false
      off()
    }
  }, [project.id])
  return { run, setRun }
}

export const epicRunActive = (run: EpicRun | null): boolean => !!run && (run.status === 'running' || run.status === 'waiting' || run.status === 'paused')

interface Props {
  project: Project
  run: EpicRun | null
  onRun: (run: EpicRun | null) => void
  /** Hidden in the chat it is showing. */
  onOpenChat?: (chatId: string) => void
}

/** One line about the running epic: which task is on, how far it got, and Stop / Resume. */
export function EpicRunBar({ project, run, onRun, onOpenChat }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!run || run.status === 'stopped') return null

  async function act(fn: () => Promise<EpicRun | null>) {
    setBusy(true)
    setError(null)
    try {
      onRun(await fn())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const step = Math.min(run.done + (run.currentTaskId ? 1 : 0), run.total)
  return (
    <div className={`banner epic-run epic-run-${run.status}`} role="status" aria-label={`Epic run ${run.epicKey}`}>
      <div className="row space">
        <span className="row">
          <span className="badge">{STATUS_LABEL[run.status]}</span>
          <span className="mono muted">{run.epicKey}</span>
          <strong className="ellipsis">{run.epicTitle}</strong>
          <span className="muted">
            {run.status === 'finished' ? `${run.done} of ${run.total} tasks done` : `task ${step} of ${run.total}`}
            {run.currentTaskKey && run.status === 'running' ? ` · ${run.currentTaskKey} in progress` : ''}
          </span>
        </span>
        <span className="row">
          {run.currentChatId && onOpenChat && run.status !== 'finished' && (
            <button className="small" onClick={() => onOpenChat(run.currentChatId!)}>Open chat</button>
          )}
          {run.status === 'paused' && (
            <button className="small primary" disabled={busy} onClick={() => void act(() => api.epicRuns.start(project.id, run.epicId, run.provider))}>Resume</button>
          )}
          {run.status !== 'finished' && (
            <button className="small" disabled={busy} onClick={() => void act(() => api.epicRuns.stop(project.id))}>Stop</button>
          )}
        </span>
      </div>
      {run.reason && <p className="small epic-run-reason">{run.reason}</p>}
      {run.status === 'running' && <p className="small muted epic-run-reason">Each task’s chat waits for you to approve its plan, review and ship; the next task starts once it ships.</p>}
      {error && <p className="small epic-run-error">{error}</p>}
    </div>
  )
}

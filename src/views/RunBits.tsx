import { useEffect, useState } from 'react'
import type { RunEvent, RunStatus, UsageObservation } from '../../shared/types'

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  'awaiting-approval': 'Awaiting approval',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

export function StatusPill({ status }: { status: RunStatus }) {
  return <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>
}

export function relativeTime(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** Elapsed time that ticks while the run is live. */
export function Elapsed({ startedAt, endedAt }: { startedAt: string | null; endedAt: string | null }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!startedAt || endedAt) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [startedAt, endedAt])
  if (!startedAt) return <span>—</span>
  const end = endedAt ? Date.parse(endedAt) : Date.now()
  return <span>{formatDuration(end - Date.parse(startedAt))}</span>
}

/** Shows only what the CLI reported. Never estimates quota. */
export function UsageView({ usage }: { usage: UsageObservation | null }) {
  const windows = Object.entries(usage?.windows ?? {})
  const tokens = usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
  if (!windows.length && !tokens) return <span className="muted">usage unavailable</span>
  return (
    <span className="usage">
      {tokens && (
        <span>
          {fmt(usage!.inputTokens)} in · {fmt(usage!.outputTokens)} out
          {usage!.cacheReadTokens ? ` · ${fmt(usage!.cacheReadTokens)} cache read` : ''}
        </span>
      )}
      {windows.map(([name, w]) => (
        <span key={name} title={w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : undefined}>
          {name.replace(/_/g, '-')} window: {Math.round(w.utilization * 100)}% used
        </span>
      ))}
      <span className="small muted">as reported by the CLI</span>
    </span>
  )
}

function fmt(n: number | undefined): string {
  return n === undefined ? '?' : n.toLocaleString()
}

export function EventLine({ event, root }: { event: RunEvent; root: string }) {
  // Show paths relative to the project root.
  const text = root ? event.text.split(root + '/').join('') : event.text
  switch (event.kind) {
    case 'text':
      return <div className="ev ev-text">{text}</div>
    case 'tool-use':
      return (
        <div className="ev ev-tool">
          <span className="tool-chip">{String(event.meta?.tool ?? 'tool')}</span>
          <span className="mono">{text.replace(/^[^:]+:\s*/, '')}</span>
        </div>
      )
    case 'tool-result':
      return (
        <details className={`ev ev-result${event.meta?.isError ? ' is-error' : ''}`}>
          <summary>{event.meta?.isError ? 'Tool error' : 'Tool output'}</summary>
          <pre>{text || '(empty)'}</pre>
        </details>
      )
    case 'result':
      return null // rendered separately as the run summary
    case 'error':
      return <div className="ev ev-error">{text}</div>
    case 'stderr':
    case 'log':
      return <pre className="ev ev-log">{text}</pre>
    default:
      return <div className="ev ev-status">{text}</div>
  }
}

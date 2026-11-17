import { useEffect, useState } from 'react'
import type { FileChange, RestorePreview } from '../../shared/types'
import { api, errorMessage } from '../api'
import { useOverlay } from '../overlay'

const STATUS_LABEL: Record<FileChange['status'], string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' }

/** Read-only unified diff with line colouring. */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="muted small">No textual differences (binary file or mode change).</p>
  return (
    <pre className="diff" aria-readonly>
      {diff.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
            ? 'd-meta'
            : line.startsWith('@@')
              ? 'd-hunk'
              : line.startsWith('+')
                ? 'd-add'
                : line.startsWith('-')
                  ? 'd-del'
                  : ''
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

/** List of changed files; clicking a file loads and shows its diff inline. */
export function ChangeList({ changes, loadDiff }: { changes: FileChange[]; loadDiff: (path: string) => Promise<string> }) {
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggle(path: string) {
    if (open === path) return setOpen(null)
    setOpen(path)
    setDiff(null)
    setError(null)
    try {
      setDiff(await loadDiff(path))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <ul className="change-list">
      {changes.map((c) => (
        <li key={c.path}>
          <button className={`change-item${open === c.path ? ' active' : ''}`} onClick={() => toggle(c.path)} aria-expanded={open === c.path}>
            <span className={`change-status s-${c.status}`} title={STATUS_LABEL[c.status]}>{c.status}</span>
            <span className="mono small ellipsis">{c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}</span>
            {(c.additions !== null || c.deletions !== null) && (
              <span className="small change-counts">
                <span className="add">+{c.additions ?? '?'}</span> <span className="del">−{c.deletions ?? '?'}</span>
              </span>
            )}
          </button>
          {open === c.path && (
            <div className="change-diff">{error ? <div className="error-text small">{error}</div> : diff === null ? <p className="muted small">Loading diff…</p> : <DiffView diff={diff} />}</div>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Restore flow: always shows what will change before asking for confirmation
 * (spec F6). A safety checkpoint of the current state is taken first, so the
 * restore itself can be undone.
 */
export function RestoreDialog({ projectId, checkpointId, label, onClose, onRestored }: {
  projectId: string
  checkpointId: string
  label: string
  onClose: () => void
  onRestored: (message: string) => void
}) {
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useOverlay()

  useEffect(() => {
    api.checkpoints.preview(projectId, checkpointId).then(setPreview, (e) => setError(errorMessage(e)))
  }, [projectId, checkpointId])

  async function restore() {
    setBusy(true)
    try {
      const res = await api.checkpoints.restore(projectId, checkpointId)
      onRestored(`Restored ${res.changes.length} file${res.changes.length === 1 ? '' : 's'}. The previous state was saved as a checkpoint, so this can be undone.`)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const groups = preview && {
    reverted: preview.changes.filter((c) => c.status === 'M' || c.status === 'T'),
    deleted: preview.changes.filter((c) => c.status === 'D'),
    recreated: preview.changes.filter((c) => c.status === 'A')
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="restore-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="restore-title">Restore checkpoint</h2>
        <p className="small muted">{label}</p>
        {error && <div className="banner banner-error">{error}</div>}
        {!preview && !error && <p className="muted">Comparing with the current folder…</p>}
        {preview && groups && (
          <>
            {preview.changes.length === 0 ? (
              <p>The folder already matches this checkpoint. Nothing would change.</p>
            ) : (
              <>
                <p>Restoring will make the project folder match the checkpoint:</p>
                {groups.reverted.length > 0 && <FileGroup title={`Revert ${groups.reverted.length} modified file(s)`} items={groups.reverted} />}
                {groups.deleted.length > 0 && <FileGroup title={`Delete ${groups.deleted.length} file(s) created since`} items={groups.deleted} danger />}
                {groups.recreated.length > 0 && <FileGroup title={`Recreate ${groups.recreated.length} file(s) deleted since`} items={groups.recreated} />}
              </>
            )}
            {preview.headMoved && (
              <p className="small banner banner-info">
                The current branch commit has changed since this checkpoint. Restoring changes files only; it does not move the branch.
              </p>
            )}
            <p className="small muted">Ignored files (e.g. node_modules) are not touched. Your current state is checkpointed first.</p>
          </>
        )}
        <div className="row space">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="danger" onClick={restore} disabled={!preview || preview.changes.length === 0 || busy}>
            {busy ? 'Restoring…' : 'Restore files'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FileGroup({ title, items, danger }: { title: string; items: FileChange[]; danger?: boolean }) {
  return (
    <details open={items.length <= 12} className="file-group">
      <summary className={danger ? 'error-text' : ''}>{title}</summary>
      <ul className="mono small">
        {items.map((c) => <li key={c.path}>{c.path}</li>)}
      </ul>
    </details>
  )
}

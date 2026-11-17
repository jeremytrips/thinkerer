import { useCallback, useEffect, useState } from 'react'
import type { Checkpoint, FileChange, FileContent, FileEntry, Project } from '../../shared/types'
import { api, errorMessage } from '../api'
import { ChangeList, RestoreDialog } from './Changes'
import { relativeTime } from './RunBits'

type View = 'browse' | 'changes' | 'checkpoints'

/** Read-only explorer. There is intentionally no way to edit source here. */
export function FilesTab({ project }: { project: Project }) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('browse')
  const [changes, setChanges] = useState<FileChange[] | null>(null)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null)
  const [restore, setRestore] = useState<Checkpoint | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(
    async (dir: string) => {
      try {
        const list = await api.files.list(project.id, dir)
        setChildren((c) => ({ ...c, [dir]: list }))
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [project.id]
  )

  const refresh = useCallback(() => {
    setChildren({})
    setError(null)
    for (const dir of open) void load(dir)
    if (file) api.files.read(project.id, file.path).then(setFile, () => setFile(null))
    loadGit()
  }, [open, load, project.id, file])

  function loadGit() {
    api.git.workingChanges(project.id).then(setChanges, () => setChanges(null))
    api.checkpoints.list(project.id).then(setCheckpoints, () => setCheckpoints(null))
  }

  useEffect(() => {
    void load('')
    loadGit()
  }, [load, project.id])

  async function toggle(entry: FileEntry) {
    if (entry.kind === 'dir') {
      const next = new Set(open)
      if (next.has(entry.path)) next.delete(entry.path)
      else {
        next.add(entry.path)
        if (!children[entry.path]) await load(entry.path)
      }
      setOpen(next)
    } else {
      await openFile(entry.path)
    }
  }

  async function openFile(path: string) {
    try {
      setFile(await api.files.read(project.id, path))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  function renderDir(dir: string, depth: number) {
    return (children[dir] ?? []).map((e) => (
      <li key={e.path}>
        <button
          className={`tree-item${file?.path === e.path ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => toggle(e)}
          title={e.path}
        >
          <span className="tree-icon" aria-hidden>{e.kind === 'dir' ? (open.has(e.path) ? '▾' : '▸') : e.kind === 'symlink' ? '↪' : ' '}</span>
          {e.name}
        </button>
        {e.kind === 'dir' && open.has(e.path) && <ul>{renderDir(e.path, depth + 1)}</ul>}
      </li>
    ))
  }

  return (
    <section className="files">
      <div className="row space">
        <h1>Files</h1>
        <div className="row">
          <span className="badge">Read-only — source changes are made by agents</span>
          <button className="small" onClick={refresh}>Refresh</button>
        </div>
      </div>
      <div className="row segmented" role="tablist">
        <button role="tab" aria-selected={view === 'browse'} className={view === 'browse' ? 'tab active' : 'tab'} onClick={() => setView('browse')}>Browse</button>
        <button role="tab" aria-selected={view === 'changes'} className={view === 'changes' ? 'tab active' : 'tab'} onClick={() => setView('changes')}>
          Uncommitted changes{changes ? ` (${changes.length})` : ''}
        </button>
        <button role="tab" aria-selected={view === 'checkpoints'} className={view === 'checkpoints' ? 'tab active' : 'tab'} onClick={() => setView('checkpoints')}>
          Checkpoints{checkpoints ? ` (${checkpoints.length})` : ''}
        </button>
      </div>
      {error && <div className="banner banner-error">{error}</div>}
      {notice && <div className="banner banner-info">{notice}</div>}
      {view === 'changes' && (
        <div className="card files-panel">
          {changes === null ? (
            <p className="muted">Not a Git repository.</p>
          ) : changes.length === 0 ? (
            <p className="muted">No uncommitted changes.</p>
          ) : (
            <ChangeList changes={changes} loadDiff={(path) => api.git.workingDiff(project.id, path)} />
          )}
        </div>
      )}
      {view === 'checkpoints' && (
        <div className="card files-panel">
          {checkpoints === null ? (
            <p className="muted">Not a Git repository.</p>
          ) : checkpoints.length === 0 ? (
            <p className="muted">No checkpoints yet. One is saved automatically before every agent run.</p>
          ) : (
            <ul className="checkpoint-list">
              {checkpoints.map((c) => (
                <li key={c.id} className="row space">
                  <span className="ellipsis">
                    {c.label.replace(/^Thinkerer: /, '')} <span className="small muted">· {relativeTime(c.createdAt)} · {c.commit.slice(0, 8)}</span>
                  </span>
                  <button className="small" onClick={() => setRestore(c)}>Restore…</button>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">Checkpoints are local Git refs (refs/thinkerer/*). They are never pushed by default.</p>
        </div>
      )}
      {restore && (
        <RestoreDialog
          projectId={project.id}
          checkpointId={restore.id}
          label={`${restore.label} · ${new Date(restore.createdAt).toLocaleString()}`}
          onClose={() => setRestore(null)}
          onRestored={(msg) => {
            setRestore(null)
            setNotice(msg)
            refresh()
          }}
        />
      )}
      <div className="files-body" hidden={view !== 'browse'}>
        <div className="tree card">
          <ul>{renderDir('', 0)}</ul>
        </div>
        <div className="viewer card">
          {!file ? (
            <p className="muted">Select a file to preview it.</p>
          ) : (
            <>
              <div className="viewer-head mono small">{file.path} <span className="muted">· {file.size.toLocaleString()} bytes</span></div>
              {file.kind === 'text' ? (
                <pre className="code" aria-readonly>
                  {file.text.split('\n').map((line, i) => (
                    <div key={i} className="code-line">
                      <span className="ln">{i + 1}</span>
                      <span>{line || ' '}</span>
                    </div>
                  ))}
                </pre>
              ) : (
                <p className="muted">{file.kind === 'binary' ? 'Binary file — no preview.' : 'File too large to preview.'}</p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

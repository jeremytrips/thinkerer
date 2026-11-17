import { useCallback, useEffect, useState } from 'react'
import type { FileContent, FileEntry, GitStatus, Project } from '../../shared/types'
import { api, errorMessage } from '../api'

/** Read-only explorer. There is intentionally no way to edit source here. */
export function FilesTab({ project }: { project: Project }) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))
  const [file, setFile] = useState<FileContent | null>(null)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    api.git.status(project.id).then(setGit, () => setGit(null))
    if (file) api.files.read(project.id, file.path).then(setFile, () => setFile(null))
  }, [open, load, project.id, file])

  useEffect(() => {
    void load('')
    api.git.status(project.id).then(setGit, () => setGit(null))
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
      {error && <div className="banner banner-error">{error}</div>}
      <div className="files-body">
        <div className="tree card">
          {git && git.entries.length > 0 && (
            <details className="tree-changes" open={git.entries.length <= 10}>
              <summary className="small muted">Uncommitted changes ({git.entries.length})</summary>
              <ul>
                {git.entries.slice(0, 50).map((e) => (
                  <li key={e.path}>
                    <button className="tree-item mono small" onClick={() => !e.path.endsWith('/') && openFile(e.path.replace(/^.* -> /, ''))}>
                      <span className="git-code">{e.code}</span> {e.path}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
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

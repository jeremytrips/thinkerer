import { useState } from 'react'
import type { AppInfo, Project } from '../../shared/types'
import { api, browserPreview, errorMessage } from '../api'
import { usePaletteSource } from '../palette'
import { AboutDialog } from './AboutDialog'
import { PaletteButton } from './CommandPalette'
import { RestartButton } from './RestartButton'

interface Props {
  projects: Project[] | null
  info: AppInfo | null
  onOpen: (id: string) => void
  onChanged: () => Promise<void>
  onPalette: () => void
}

export function Home({ projects, info, onOpen, onChanged, onPalette }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState<string | null>(null)
  const [about, setAbout] = useState(false)
  usePaletteSource('home', () =>
    busy
      ? []
      : [
          { id: 'home:import', section: 'Actions', title: 'Import folder…', hint: 'Add an existing folder as a project', keywords: 'add open', run: () => void act(() => api.projects.importFolder()) },
          { id: 'home:new', section: 'Actions', title: 'New project', hint: 'Create an empty project folder', keywords: 'create', run: () => setNewName('') },
          { id: 'home:about', section: 'Actions', title: 'About Thinkerer', hint: 'Version and source folder', run: () => setAbout(true) }
        ]
  )

  async function act(fn: () => Promise<Project | boolean | null>) {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      await onChanged()
      if (result && typeof result === 'object') onOpen(result.id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="home">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◆</span> Thinkerer
          {info?.isDev && <span className="badge">dev build</span>}
        </div>
        <span className="row">
          <PaletteButton onClick={onPalette} />
          <button className="small" onClick={() => setAbout(true)}>About</button>
          <RestartButton info={info} />
        </span>
      </header>
      {about && <AboutDialog info={info} onClose={() => setAbout(false)} />}

      <main className="home-main">
        <div className="home-head">
          <div>
            <h1>Projects</h1>
            <p className="muted">Each project is a real folder on disk. Agents change the source; you review the result.</p>
          </div>
          <div className="row">
            <button onClick={() => setNewName('')} disabled={busy}>New project</button>
            <button className="primary" onClick={() => act(() => api.projects.importFolder())} disabled={busy}>
              Import folder…
            </button>
          </div>
        </div>

        {newName !== null && (
          <form
            className="card new-project"
            onSubmit={(e) => {
              e.preventDefault()
              void act(() => api.projects.create(newName)).then(() => setNewName(null))
            }}
          >
            <label>
              Folder name
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-website" />
            </label>
            <div className="row">
              <button type="button" onClick={() => setNewName(null)}>Cancel</button>
              <button type="submit" className="primary" disabled={!newName.trim() || busy}>Choose location & create</button>
            </div>
          </form>
        )}

        {browserPreview && (
          <div className="banner banner-info">Browser preview — desktop features (projects, agents, files) are only available in the Thinkerer app.</div>
        )}
        {error && <div className="banner banner-error">{error}</div>}

        {projects === null ? (
          <p className="muted">Loading…</p>
        ) : projects.length === 0 ? (
          <div className="empty card">
            <h2>No projects yet</h2>
            <p className="muted">
              Import an existing folder — for example Thinkerer’s own repository — to start working on it with an agent.
            </p>
          </div>
        ) : (
          <ul className="project-grid">
            {projects.map((p) => (
              <li key={p.id}>
                {p.status === 'missing' ? (
                  <div className="card project-card missing">
                    <div className="project-card-title">{p.path.split(/[/\\]/).pop()}</div>
                    <div className="mono small muted">{p.path}</div>
                    <div className="row space">
                      <span className="pill pill-failed">Folder missing</span>
                      <button className="small" onClick={() => act(() => api.projects.remove(p.id))}>Remove from list</button>
                    </div>
                  </div>
                ) : (
                  <button className="card project-card" onClick={() => onOpen(p.id)}>
                    <div className="project-card-title">{p.config?.name}</div>
                    <div className="mono small muted">{p.path}</div>
                    <div className="row">
                      {p.config?.components.map((c) => <span key={c} className="badge">{c}</span>)}
                      <span className="badge">{p.config?.target} target</span>
                      {info?.sourceRoot === p.path && <span className="badge badge-accent">this app’s source</span>}
                    </div>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

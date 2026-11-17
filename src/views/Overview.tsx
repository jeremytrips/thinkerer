import { useEffect, useState } from 'react'
import type { GitStatus, Project, ProviderStatus, RunSummary } from '../../shared/types'
import { api } from '../api'
import { ProviderList } from './ProviderList'
import { StatusPill, relativeTime } from './RunBits'
import type { TabId } from './ProjectView'

export function Overview({ project, isSelf, onTab }: { project: Project; isSelf: boolean; onTab: (t: TabId) => void }) {
  const config = project.config!
  const [git, setGit] = useState<GitStatus | null | undefined>(undefined)
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)

  useEffect(() => {
    api.git.status(project.id).then(setGit, () => setGit(null))
    api.runs.list(project.id).then(setRuns, () => setRuns([]))
    api.agents.providers().then(setProviders, () => setProviders([]))
  }, [project.id])

  return (
    <section>
      <h1>{config.name}</h1>
      <p className="mono small muted">{project.path}</p>
      {isSelf && (
        <div className="banner banner-info">
          This project is the source of the Thinkerer build you are running. Renderer changes hot-reload; main, preload and
          engine changes take effect after <strong>Restart app</strong>.
        </div>
      )}

      <div className="grid-3">
        <div className="card">
          <h3>Website</h3>
          {config.components.includes('website') ? (
            <dl className="kv">
              <dt>Target</dt><dd>{config.target}</dd>
              <dt>Dev command</dt><dd className="mono">{config.website.devCommand || '—'}</dd>
              <dt>Preview URL</dt><dd className="mono">{config.website.previewUrl || '—'}</dd>
            </dl>
          ) : (
            <p className="muted">Not a component of this project.</p>
          )}
        </div>
        <div className="card">
          <h3>Mobile</h3>
          <p className="muted">{config.components.includes('mobile') ? 'Enabled — studio is post-MVP.' : 'Not a component of this project.'}</p>
        </div>
        <div className="card">
          <h3>Hardware</h3>
          <p className="muted">{config.components.includes('hardware') ? 'Enabled — studio is post-MVP.' : 'Not a component of this project.'}</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Git</h3>
          {git === undefined ? (
            <p className="muted">Checking…</p>
          ) : git === null ? (
            <p className="muted">Not a Git repository. Checkpoints (Phase 1) will need Git.</p>
          ) : (
            <p>
              Branch <span className="mono">{git.branch ?? 'detached'}</span> ·{' '}
              {git.entries.length === 0 ? 'clean working tree' : `${git.entries.length} changed file${git.entries.length === 1 ? '' : 's'}`}
            </p>
          )}
        </div>
        <div className="card">
          <h3>Agents</h3>
          {providers ? <ProviderList providers={providers} compact /> : <p className="muted">Detecting CLIs…</p>}
        </div>
      </div>

      <div className="card">
        <div className="row space">
          <h3>Recent activity</h3>
          <button className="small" onClick={() => onTab('agent')}>Open Agent</button>
        </div>
        {!runs ? (
          <p className="muted">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="muted">No agent runs yet.</p>
        ) : (
          <ul className="activity">
            {runs.slice(0, 5).map((r) => (
              <li key={r.id}>
                <StatusPill status={r.status} />
                <span className="ellipsis">{r.prompt}</span>
                <span className="small muted">{r.provider} · {relativeTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'
import type { Component, Project, ProviderChoice, ProviderStatus, Target } from '../../shared/types'
import { api, errorMessage } from '../api'
import { ProviderList } from './ProviderList'

const COMPONENTS: { id: Component; label: string; note?: string }[] = [
  { id: 'website', label: 'Website' },
  { id: 'mobile', label: 'Mobile', note: 'studio post-MVP' },
  { id: 'hardware', label: 'Hardware', note: 'studio post-MVP' }
]

export function SettingsTab({ project, onChanged, onRemoved }: { project: Project; onChanged: () => Promise<void>; onRemoved: () => void }) {
  const config = project.config!
  const [name, setName] = useState(config.name)
  const [components, setComponents] = useState<Component[]>(config.components)
  const [target, setTarget] = useState<Target>(config.target)
  const [devCommand, setDevCommand] = useState(config.website.devCommand)
  const [previewUrl, setPreviewUrl] = useState(config.website.previewUrl)
  const [provider, setProvider] = useState<ProviderChoice>(config.agent.provider)
  const [setupCommand, setSetupCommand] = useState(config.worktrees.setupCommand)
  const [teardownCommand, setTeardownCommand] = useState(config.worktrees.teardownCommand)
  const [ports, setPorts] = useState(String(config.worktrees.ports))
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)

  const detectProviders = () => api.agents.providers().then(setProviders, () => setProviders([]))

  useEffect(() => {
    void detectProviders()
  }, [])

  async function save() {
    setStatus(null)
    try {
      await api.projects.update(project.id, {
        name,
        components,
        target,
        website: { devCommand, previewUrl },
        agent: { provider },
        worktrees: { setupCommand, teardownCommand, ports: Number(ports) }
      })
      await onChanged()
      setStatus({ tone: 'ok', text: 'Saved to .thinkerer/project.json' })
    } catch (err) {
      setStatus({ tone: 'error', text: errorMessage(err) })
    }
  }

  return (
    <section className="settings">
      <h1>Settings</h1>
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset>
          <legend>Components</legend>
          {COMPONENTS.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={components.includes(c.id)}
                onChange={(e) => setComponents(e.target.checked ? [...components, c.id] : components.filter((x) => x !== c.id))}
              />
              {c.label} {c.note && <span className="small muted">({c.note})</span>}
            </label>
          ))}
        </fieldset>
        <label>
          Runtime target
          <select value={target} onChange={(e) => setTarget(e.target.value as Target)}>
            <option value="web">Web</option>
            <option value="electron">Electron</option>
          </select>
        </label>
        <label>
          Development command
          <input className="mono" value={devCommand} onChange={(e) => setDevCommand(e.target.value)} placeholder="npm run dev" />
          <span className="small muted">
            Runs the site for the preview: in the project folder from the Website tab, and in each chat’s worktree from the preview beside
            the chat. Worktree ports are in <span className="mono">$THINKERER_PORT_1</span>…, e.g.{' '}
            <span className="mono">npm run dev -- --port $THINKERER_PORT_1</span>.
          </span>
        </label>
        <label>
          Preview URL
          <input className="mono" value={previewUrl} onChange={(e) => setPreviewUrl(e.target.value)} placeholder="http://localhost:5173" />
          <span className="small muted">
            Use <span className="mono">{'{port1}'}</span> for a worktree’s own port, e.g. <span className="mono">{'http://localhost:{port1}'}</span>.
          </span>
        </label>
        <fieldset>
          <legend>Chat worktrees</legend>
          <p className="small muted">
            Every chat works in its own Git worktree and branch. These commands run there (with your user permissions; each one asks for
            approval when it changes): setup when the chat starts, teardown when <span className="mono">/cleanup</span> or{' '}
            <span className="mono">/discard</span> removes it. They get <span className="mono">THINKERER_PORT_1…N</span>,{' '}
            <span className="mono">COMPOSE_PROJECT_NAME</span>, <span className="mono">THINKERER_WORKTREE</span>,{' '}
            <span className="mono">THINKERER_PROJECT_ROOT</span> and <span className="mono">THINKERER_BRANCH</span>; so does the agent.
          </p>
          <label>
            Setup command
            <input
              className="mono"
              value={setupCommand}
              onChange={(e) => setSetupCommand(e.target.value)}
              placeholder='cp "$THINKERER_PROJECT_ROOT/.env" . && npm ci && docker compose up -d'
            />
          </label>
          <label>
            Teardown command
            <input className="mono" value={teardownCommand} onChange={(e) => setTeardownCommand(e.target.value)} placeholder="docker compose down -v" />
          </label>
          <label>
            Ports per worktree
            <input type="number" min={0} max={10} value={ports} onChange={(e) => setPorts(e.target.value)} />
            <span className="small muted">Free ports Thinkerer reserves for each chat (0–10).</span>
          </label>
        </fieldset>
        <label>
          Default agent provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderChoice)}>
            <option value="auto">Auto</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <div className="row">
          <button type="submit" className="primary">Save</button>
          {status && <span className={status.tone === 'ok' ? 'small muted' : 'small error-text'}>{status.text}</span>}
        </div>
      </form>

      <div className="card form">
        <h3>LLM providers</h3>
        {providers ? <ProviderList providers={providers} /> : <p className="muted small">Detecting…</p>}
        <div className="row">
          <button className="small" onClick={() => void detectProviders()}>Re-check</button>
        </div>
      </div>

      <div className="card form">
        <h3>Project folder</h3>
        <div className="row">
          <span className="mono small">{project.path}</span>
          <button className="small" onClick={() => api.projects.reveal(project.id)}>Show in folder</button>
        </div>
        <h3>Agent permissions</h3>
        <p className="small muted">
          Each provider's limits are under “What runs may do” above. npm scripts and other project commands run with your user permissions, so only use agents on projects whose scripts you trust.
        </p>
        <h3>Remove</h3>
        {confirmRemove ? (
          <div className="row">
            <span className="small">Remove from Thinkerer? The folder on disk is not deleted.</span>
            <button className="small" onClick={() => setConfirmRemove(false)}>Cancel</button>
            <button
              className="small danger"
              onClick={async () => {
                try {
                  await api.projects.remove(project.id)
                  onRemoved()
                  await onChanged()
                } catch (err) {
                  setStatus({ tone: 'error', text: errorMessage(err) })
                  setConfirmRemove(false)
                }
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <button className="small" onClick={() => setConfirmRemove(true)}>Remove project from list…</button>
        )}
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'
import type { ClaudeOptionalTool, Component, Effort, Project, ProviderChoice, ProviderStatus, Target } from '../../shared/types'
import { api, errorMessage } from '../api'
import { ProviderList } from './ProviderList'

const COMPONENTS: { id: Component; label: string; note?: string }[] = [
  { id: 'website', label: 'Website' },
  { id: 'mobile', label: 'Mobile', note: 'studio post-MVP' },
  { id: 'hardware', label: 'Hardware', note: 'studio post-MVP' }
]

const CLAUDE_TOOLS: { id: ClaudeOptionalTool; label: string; note: string }[] = [
  { id: 'Task', label: 'Subagents', note: 'Lets Claude hand work to Explore, Plan and general-purpose subagents. They have the same limits as the run.' },
  { id: 'Skill', label: 'Skills', note: 'Lets Claude use skills (yours and built-in ones) on its own. You can always type /skill-name.' },
  { id: 'WebSearch', label: 'Web search', note: 'Searches the web. Search queries leave your machine.' },
  { id: 'NotebookEdit', label: 'Jupyter notebooks', note: 'Edits .ipynb cells in the project.' }
]
const EFFORTS: { id: Effort; label: string }[] = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
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
  const [model, setModel] = useState(config.agent.claude.model)
  const [effort, setEffort] = useState<Effort>(config.agent.claude.effort)
  const [claudeTools, setClaudeTools] = useState<ClaudeOptionalTool[]>(config.agent.claude.tools)
  const [checkCommand, setCheckCommand] = useState(config.protocol.checkCommand)
  const [reviewRounds, setReviewRounds] = useState(String(config.protocol.maxReviewRounds))
  const [reviewModel, setReviewModel] = useState(config.protocol.review.model)
  const [reviewEffort, setReviewEffort] = useState<Effort>(config.protocol.review.effort)
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
        agent: { provider, claude: { model, effort, tools: claudeTools } },
        worktrees: { setupCommand, teardownCommand, ports: Number(ports) },
        protocol: { checkCommand, maxReviewRounds: Number(reviewRounds), review: { model: reviewModel, effort: reviewEffort } }
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
        <fieldset>
          <legend>Claude Code</legend>
          <p className="small muted">
            Options for this project’s Claude Code runs. Each message can also run in <strong>plan mode</strong> (read-only), chosen under the
            composer. Claude’s own slash commands and skills (<span className="mono">/compact</span>, <span className="mono">/init</span>,{' '}
            <span className="mono">/code-review</span>…) work in chats: type <span className="mono">/</span> to see them.
          </p>
          <label>
            Model
            <input className="mono" list="claude-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Claude Code’s default" />
            <datalist id="claude-models">
              {['fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'].map((m) => <option key={m} value={m} />)}
            </datalist>
            <span className="small muted">An alias such as <span className="mono">opus</span> or <span className="mono">sonnet</span>, or a full model name. Leave empty for Claude Code’s default.</span>
          </label>
          <label>
            Effort
            <select value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
              {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <div className="tool-options" role="group" aria-label="Optional Claude Code tools">
            <span className="small">Optional tools (file tools and the approved shell commands are always on)</span>
            {CLAUDE_TOOLS.map((t) => (
              <label key={t.id} className="check">
                <input
                  type="checkbox"
                  checked={claudeTools.includes(t.id)}
                  onChange={(e) => setClaudeTools(e.target.checked ? [...claudeTools, t.id] : claudeTools.filter((x) => x !== t.id))}
                />
                <span>
                  {t.label} <span className="mono small muted">{t.id}</span>
                  <br />
                  <span className="small muted">{t.note}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Software protocol</legend>
          <p className="small muted">
            Protocol chats go plan → implement + tests → review → ship. Thinkerer runs the check command itself after each implementation
            turn (it asks for approval when the command changes) and sends only failing output back to the agent. Reviews run in a fresh, read-only
            session: Claude Code runs its <span className="mono">/code-review</span> skill on the chat’s branch (with Skill enabled for it, and
            sub-agents only if enabled above), Codex gets the plan and the diff. Both are checked against the plan.
          </p>
          <label>
            Check command
            <input className="mono" value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)} placeholder="npm run typecheck && npm test" />
            <span className="small muted">Runs in the chat’s worktree. Leave empty to skip the checks; the agent then runs its own and reports them.</span>
          </label>
          <label>
            Review rounds
            <input type="number" min={1} max={5} value={reviewRounds} onChange={(e) => setReviewRounds(e.target.value)} />
            <span className="small muted">How many reviews a chat can have before you ship it or continue by hand (1–5).</span>
          </label>
          <label>
            Review model
            <input className="mono" list="claude-models" value={reviewModel} onChange={(e) => setReviewModel(e.target.value)} placeholder="Same as above" />
            <span className="small muted">Claude Code only. A cheaper model such as <span className="mono">sonnet</span> often suffices for reviewing a diff.</span>
          </label>
          <label>
            Review effort
            <select value={reviewEffort} onChange={(e) => setReviewEffort(e.target.value as Effort)}>
              {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.id ? x.label : 'Same as above'}</option>)}
            </select>
            <span className="small muted">
              Also the <span className="mono">/code-review</span> level (medium when neither is set). Max starts many reviewer sub-agents and
              costs the most, so an inherited max is held at Extra high.
            </span>
          </label>
        </fieldset>
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

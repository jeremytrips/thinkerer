import { useEffect, useState } from 'react'
import type { ClaudeOptionalTool, Component, Effort, Project, ProviderChoice, ProviderStatus, Target } from '../../shared/types'
import { api, errorMessage } from '../api'
import { formFromConfig, isDirty, patchFromForm, PORTS_RANGE, REVIEW_ROUNDS_RANGE, type SettingsForm } from '../settingsForm'
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
  const [baseline, setBaseline] = useState(project.config!)
  const [form, setForm] = useState<SettingsForm>(() => formFromConfig(project.config!))
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  /** The config on disk changed (e.g. after /merge) while the form had edits; saving would overwrite it. */
  const [stale, setStale] = useState(false)
  const dirty = isDirty(form, baseline)

  // Follow config changes made elsewhere: reload a clean form, warn about an edited one.
  const incoming = project.config!
  useEffect(() => {
    if (!isDirty(formFromConfig(incoming), baseline)) return setBaseline(incoming) // nothing the form shows changed
    if (isDirty(form, baseline)) return setStale(true)
    setBaseline(incoming)
    setForm(formFromConfig(incoming))
  }, [incoming])

  function reload() {
    setBaseline(incoming)
    setForm(formFromConfig(incoming))
    setStale(false)
    setStatus(null)
  }

  const detectProviders = () => api.agents.providers().then(setProviders, () => setProviders([]))

  useEffect(() => {
    void detectProviders()
  }, [])

  function set<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setStatus(null)
  }

  async function save() {
    if (saving) return
    const result = patchFromForm(form)
    if ('error' in result) return setStatus({ tone: 'error', text: result.error })
    const submitted = form
    setSaving(true)
    setStatus(null)
    try {
      const updated = await api.projects.update(project.id, result.patch)
      const saved = updated.config!
      setBaseline(saved)
      // Edits typed while the save ran are kept; they then show as unsaved changes.
      setForm((current) => (current === submitted ? formFromConfig(saved) : current))
      setStale(false)
      setStatus({ tone: 'ok', text: 'Saved to .thinkerer/project.json' })
    } catch (err) {
      setStatus({ tone: 'error', text: errorMessage(err) })
      return
    } finally {
      setSaving(false)
    }
    try {
      await onChanged()
    } catch (err) {
      setStatus({ tone: 'error', text: `Saved, but the project list did not refresh: ${errorMessage(err)}. Restart the app to see the change everywhere.` })
    }
  }

  return (
    <section className="settings">
      <h1>Settings</h1>
      {stale && (
        <div className="banner banner-error" role="alert">
          These settings changed on disk since you started editing (for example after <span className="mono">/merge</span>). Saving
          now overwrites them with this form.{' '}
          <button type="button" className="small" onClick={reload}>Discard my edits and reload</button>
        </div>
      )}
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          Display name
          <input value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <fieldset>
          <legend>Components</legend>
          {COMPONENTS.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={form.components.includes(c.id)}
                onChange={(e) => set('components', e.target.checked ? [...form.components, c.id] : form.components.filter((x) => x !== c.id))}
              />
              {c.label} {c.note && <span className="small muted">({c.note})</span>}
            </label>
          ))}
        </fieldset>
        <label>
          Runtime target
          <select value={form.target} onChange={(e) => set('target', e.target.value as Target)}>
            <option value="web">Web</option>
            <option value="electron">Electron</option>
          </select>
        </label>
        <label>
          Development command
          <input className="mono" value={form.devCommand} onChange={(e) => set('devCommand', e.target.value)} placeholder="npm run dev" />
          <span className="small muted">
            Runs the site for the preview: in the project folder from the Website tab, and in each chat’s worktree from the preview beside
            the chat. Worktree ports are in <span className="mono">$THINKERER_PORT_1</span>…, e.g.{' '}
            <span className="mono">npm run dev -- --port $THINKERER_PORT_1</span>.
          </span>
        </label>
        <label>
          Preview URL
          <input className="mono" value={form.previewUrl} onChange={(e) => set('previewUrl', e.target.value)} placeholder="http://localhost:5173" />
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
              value={form.setupCommand}
              onChange={(e) => set('setupCommand', e.target.value)}
              placeholder='cp "$THINKERER_PROJECT_ROOT/.env" . && npm ci && docker compose up -d'
            />
          </label>
          <label>
            Teardown command
            <input className="mono" value={form.teardownCommand} onChange={(e) => set('teardownCommand', e.target.value)} placeholder="docker compose down -v" />
          </label>
          <label>
            Ports per worktree
            <input type="number" min={PORTS_RANGE.min} max={PORTS_RANGE.max} value={form.ports} onChange={(e) => set('ports', e.target.value)} />
            <span className="small muted">Free ports Thinkerer reserves for each chat (0–10).</span>
          </label>
        </fieldset>
        <label>
          Default agent provider
          <select value={form.provider} onChange={(e) => set('provider', e.target.value as ProviderChoice)}>
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
            <input className="mono" list="claude-models" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="Claude Code’s default" />
            <datalist id="claude-models">
              {['fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'].map((m) => <option key={m} value={m} />)}
            </datalist>
            <span className="small muted">An alias such as <span className="mono">opus</span> or <span className="mono">sonnet</span>, or a full model name. Leave empty for Claude Code’s default.</span>
          </label>
          <label>
            Effort
            <select value={form.effort} onChange={(e) => set('effort', e.target.value as Effort)}>
              {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <div className="tool-options" role="group" aria-label="Optional Claude Code tools">
            <span className="small">Optional tools (file tools and the approved shell commands are always on)</span>
            {CLAUDE_TOOLS.map((t) => (
              <label key={t.id} className="check">
                <input
                  type="checkbox"
                  checked={form.claudeTools.includes(t.id)}
                  onChange={(e) => set('claudeTools', e.target.checked ? [...form.claudeTools, t.id] : form.claudeTools.filter((x) => x !== t.id))}
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
            turn (it asks for approval when the command changes) and sends only failing output back to the agent. Reviews run in a fresh,
            read-only session that sees just the plan and the diff.
          </p>
          <label>
            Check command
            <input className="mono" value={form.checkCommand} onChange={(e) => set('checkCommand', e.target.value)} placeholder="npm run typecheck && npm test" />
            <span className="small muted">Runs in the chat’s worktree. Leave empty to skip the checks; the agent then runs its own and reports them.</span>
          </label>
          <label>
            Review rounds
            <input type="number" min={REVIEW_ROUNDS_RANGE.min} max={REVIEW_ROUNDS_RANGE.max} value={form.reviewRounds} onChange={(e) => set('reviewRounds', e.target.value)} />
            <span className="small muted">How many reviews a chat can have before you ship it or continue by hand (1–5).</span>
          </label>
          <label>
            Review model
            <input className="mono" list="claude-models" value={form.reviewModel} onChange={(e) => set('reviewModel', e.target.value)} placeholder="Same as above" />
            <span className="small muted">Claude Code only. A cheaper model such as <span className="mono">sonnet</span> often suffices for reviewing a diff.</span>
          </label>
          <label>
            Review effort
            <select value={form.reviewEffort} onChange={(e) => set('reviewEffort', e.target.value as Effort)}>
              {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.id ? x.label : 'Same as above'}</option>)}
            </select>
          </label>
        </fieldset>
        <div className="row">
          <button type="submit" className="primary" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
          {status && (
            <span role={status.tone === 'error' ? 'alert' : 'status'} className={status.tone === 'ok' ? 'small muted' : 'small error-text'}>{status.text}</span>
          )}
          {dirty && status?.tone !== 'ok' && <span className="small muted">Unsaved changes</span>}
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
                setRemoveError(null)
                try {
                  await api.projects.remove(project.id)
                  onRemoved()
                  await onChanged()
                } catch (err) {
                  setRemoveError(errorMessage(err))
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
        {removeError && <p role="alert" className="small error-text">{removeError}</p>}
      </div>
    </section>
  )
}

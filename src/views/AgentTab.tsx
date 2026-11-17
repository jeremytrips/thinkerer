import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppInfo, EffectiveMcp, Project, ProviderChoice, ProviderStatus, RunArtifact, RunRecord, RunSummary, Task } from '../../shared/types'
import { api, errorMessage } from '../api'
import { ChangeList, RestoreDialog } from './Changes'
import type { TabId } from './ProjectView'
import { ProviderList, providerState } from './ProviderList'
import { RestartButton } from './RestartButton'
import { Elapsed, EventLine, StatusPill, UsageView, relativeTime } from './RunBits'

const LIVE: RunSummary['status'][] = ['queued', 'running', 'awaiting-approval']
// Paths in Thinkerer's own repo that only take effect after a main-process restart.
const NEEDS_RESTART = /^(electron|engine|shared|mcp)\/|^package\.json$|^electron\.vite\.config\.ts$/

export interface AgentPrefill {
  prompt: string
  taskId: string
  nonce: number
}

interface Props {
  project: Project
  info: AppInfo | null
  isSelf: boolean
  onTab: (tab: TabId) => void
  prefill?: AgentPrefill | null
}

export function AgentTab({ project, info, isSelf, onTab, prefill }: Props) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [choice, setChoice] = useState<ProviderChoice>(project.config!.agent.provider)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<RunRecord | null>(null)
  const selectedId = useRef<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [taskId, setTaskId] = useState<string>('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [mcp, setMcp] = useState<EffectiveMcp[]>([])
  const [isGit, setIsGit] = useState<boolean | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [restoreFor, setRestoreFor] = useState<RunRecord | null>(null)
  const [retryAsk, setRetryAsk] = useState(false)
  const logEnd = useRef<HTMLDivElement>(null)

  function select(record: RunRecord | null) {
    selectedId.current = record?.id ?? null
    setSelected(record)
    setRetryAsk(false)
  }

  const refreshContext = useCallback(() => {
    api.git.status(project.id).then((s) => setIsGit(!!s), () => setIsGit(null))
    api.tasks.list(project.id).then(setTasks, () => {})
    api.mcp.effective(project.id).then(setMcp, () => {})
  }, [project.id])

  useEffect(() => {
    api.agents.providers().then(setProviders, (e) => setError(errorMessage(e)))
    api.runs.list(project.id).then(setRuns, () => {})
    refreshContext()
    // Re-attach to a live run after a renderer reload.
    api.runs.active(project.id).then((r) => r && select(r), () => {})

    const offEvent = api.runs.onEvent((runId, event) => {
      if (runId !== selectedId.current) return
      setSelected((cur) => (cur && cur.id === runId ? { ...cur, events: [...cur.events, event] } : cur))
    })
    const offUpdate = api.runs.onUpdate((summary) => {
      if (summary.projectId !== project.id) return
      setRuns((cur) => [summary, ...cur.filter((r) => r.id !== summary.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      if (summary.id === selectedId.current) setSelected((cur) => (cur ? { ...cur, ...summary } : cur))
      if (summary.endedAt) refreshContext()
    })
    return () => {
      offEvent()
      offUpdate()
    }
  }, [project.id, refreshContext])

  useEffect(() => {
    if (!prefill) return
    setPrompt(prefill.prompt)
    setTaskId(prefill.taskId)
  }, [prefill?.nonce])

  useEffect(() => {
    if (selected && LIVE.includes(selected.status)) logEnd.current?.scrollIntoView({ block: 'end' })
  }, [selected?.events.length, selected?.status])

  const activeRun = runs.find((r) => LIVE.includes(r.status))

  async function start(text = prompt) {
    if (!text.trim() || starting) return
    setStarting(true)
    setError(null)
    setNotice(null)
    try {
      const summary = await api.runs.start(project.id, text, choice, taskId || null)
      setPrompt('')
      select(await api.runs.get(summary.id))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  async function openRun(id: string) {
    try {
      select(await api.runs.get(id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function initGit() {
    try {
      await api.git.init(project.id)
      refreshContext()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const finished = selected && !LIVE.includes(selected.status)
  const changes = selected?.changes ?? null
  const needsRestart = isSelf && changes?.some((c) => NEEDS_RESTART.test(c.path))
  const rendererChanged = isSelf && changes?.some((c) => c.path.startsWith('src/'))
  const effective = mcp.find((m) => m.provider === (choice === 'auto' ? 'claude' : choice))
  const includedTools = effective?.servers.filter((s) => s.included) ?? []
  const excludedTools = effective?.servers.filter((s) => !s.included) ?? []

  return (
    <section className="agent">
      <div className="agent-main">
        <div className="agent-head">
          <h1>Agent</h1>
          <label className="inline">
            Provider
            <select value={choice} onChange={(e) => setChoice(e.target.value as ProviderChoice)} disabled={!!activeRun}>
              <option value="auto">Auto</option>
              {(providers ?? []).map((p) => (
                <option key={p.id} value={p.id} disabled={providerState(p).tone === 'off'}>
                  {p.label} {providerState(p).tone === 'ok' ? '' : `(${providerState(p).label.toLowerCase()})`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {isGit === false && (
          <div className="banner banner-info row space">
            <span>Agents need Git so Thinkerer can checkpoint the folder before every run and let you roll back.</span>
            <button className="small primary" onClick={initGit}>Initialize Git repository</button>
          </div>
        )}
        {error && <div className="banner banner-error">{error}</div>}
        {notice && <div className="banner banner-info">{notice}</div>}

        <div className="run-view">
          {!selected ? (
            <div className="empty">
              <p className="muted">
                Describe a change. The agent works directly in <span className="mono">{project.path}</span>. A Git checkpoint
                is saved before it starts, so every run can be reviewed and rolled back.
              </p>
            </div>
          ) : (
            <>
              <div className="bubble-user">{selected.prompt}</div>
              <div className="run-meta">
                <StatusPill status={selected.status} />
                <span>{selected.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
                <span className="muted">·</span>
                <Elapsed startedAt={selected.startedAt} endedAt={selected.endedAt} />
                {selected.exitCode !== null && <span className="muted">· exit {selected.exitCode}</span>}
                <span className="muted">·</span>
                <UsageView usage={selected.usage} />
              </div>
              <div className="small muted">
                {selected.selection.rationale}
                {selected.taskId && <> · task: {tasks.find((t) => t.id === selected.taskId)?.title ?? 'removed task'}</>}
              </div>
              {selected.currentAction && LIVE.includes(selected.status) && (
                <div className="current-action">
                  <span className="spinner" aria-hidden /> {selected.currentAction}
                </div>
              )}
              <div className="events">
                {selected.events.map((e, i) => <EventLine key={i} event={e} root={project.path} />)}
                <div ref={logEnd} />
              </div>

              {selected.artifacts.length > 0 && <ArtifactGallery runId={selected.id} artifacts={selected.artifacts} />}

              {finished && (
                <div className="run-summary card">
                  {selected.resultText && !selected.events.some((e) => e.kind === 'text' && e.text.trim() === selected.resultText!.trim()) && (
                    <>
                      <h3>Agent summary</h3>
                      <div className="ev-text">{selected.resultText}</div>
                    </>
                  )}
                  {selected.error && <div className="banner banner-error">{selected.error}</div>}
                  {selected.permissionDenials.length > 0 && (
                    <>
                      <h3>Denied by policy</h3>
                      <ul className="mono small">
                        {selected.permissionDenials.map((d, i) => <li key={i}>{d.tool}: {d.input}</li>)}
                      </ul>
                    </>
                  )}
                  <h3>Changes made by this run</h3>
                  {changes === null ? (
                    <p className="muted">Not recorded for this run.</p>
                  ) : changes.length === 0 ? (
                    <p className="muted">No files changed.</p>
                  ) : (
                    <ChangeList changes={changes} loadDiff={(path) => api.git.runDiff(project.id, selected.id, path)} />
                  )}

                  <div className="row run-actions">
                    {selected.checkpoint && (
                      <button className="small" onClick={() => setRestoreFor(selected)} disabled={!!activeRun}>
                        Restore checkpoint…
                      </button>
                    )}
                    {(selected.status === 'failed' || selected.status === 'cancelled') && !retryAsk && (
                      <button
                        className="small"
                        disabled={!!activeRun}
                        onClick={() => (changes && changes.length > 0 ? setRetryAsk(true) : void start(selected.prompt))}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                  {retryAsk && (
                    <div className="banner banner-info">
                      <p>
                        This run already changed {changes!.length} file{changes!.length === 1 ? '' : 's'}. Retrying won’t undo them.
                      </p>
                      <div className="row">
                        <button className="small" onClick={() => setRetryAsk(false)}>Cancel</button>
                        <button className="small" onClick={() => setRestoreFor(selected)}>Restore checkpoint first…</button>
                        <button className="small primary" onClick={() => void start(selected.prompt)}>
                          Retry on top with {choice === 'auto' ? 'Auto' : choice === 'claude' ? 'Claude Code' : 'Codex'}
                        </button>
                      </div>
                    </div>
                  )}

                  {needsRestart && (
                    <div className="banner banner-info row space">
                      <span>This run changed Electron main/preload/engine code. Restart Thinkerer to load it.</span>
                      <RestartButton info={info} label="Restart now" />
                    </div>
                  )}
                  {rendererChanged && !needsRestart && <div className="banner banner-info">UI changes were hot-reloaded into this window.</div>}
                </div>
              )}
            </>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void start()
              }
            }}
            placeholder={activeRun ? 'An agent run is in progress…' : 'e.g. Add a visible About Thinkerer dialog, and test that it opens.'}
            disabled={!!activeRun || isGit === false}
            rows={3}
            aria-label="Instruction for the agent"
          />
          <div className="row space">
            <div className="row small">
              <label className="inline">
                Task
                <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!!activeRun}>
                  <option value="">None</option>
                  {tasks.filter((t) => t.status !== 'done').map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="link small" onClick={() => onTab('mcp')} title="Tools this provider will receive">
                MCP tools: {includedTools.length ? includedTools.map((s) => s.id).join(', ') : 'none'}
                {excludedTools.length > 0 && ` (${excludedTools.length} unavailable)`}
              </button>
            </div>
            {activeRun ? (
              <button type="button" className="danger" onClick={() => api.runs.cancel(project.id).catch((e) => setError(errorMessage(e)))}>
                Stop run
              </button>
            ) : (
              <button type="submit" className="primary" disabled={!prompt.trim() || starting || isGit === false}>
                {starting ? 'Starting…' : 'Run agent'}
              </button>
            )}
          </div>
        </form>
      </div>

      <aside className="agent-side">
        <h3>Providers</h3>
        {providers ? <ProviderList providers={providers} /> : <p className="muted small">Detecting…</p>}
        <button className="small" onClick={() => api.agents.providers().then(setProviders, () => {})}>Re-check</button>
        <h3>Run history</h3>
        {runs.length === 0 ? (
          <p className="muted small">No runs yet.</p>
        ) : (
          <ul className="history">
            {runs.map((r) => (
              <li key={r.id}>
                <button className={selected?.id === r.id ? 'history-item active' : 'history-item'} onClick={() => openRun(r.id)}>
                  <span className="ellipsis">{r.prompt}</span>
                  <span className="row small">
                    <StatusPill status={r.status} />
                    <span className="muted">{relativeTime(r.createdAt)}</span>
                    {r.changes && r.changes.length > 0 && <span className="muted">{r.changes.length} file{r.changes.length === 1 ? '' : 's'}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {restoreFor?.checkpoint && (
        <RestoreDialog
          projectId={project.id}
          checkpointId={restoreFor.checkpoint.id}
          label={`Before: “${restoreFor.prompt.slice(0, 120)}” · ${new Date(restoreFor.checkpoint.createdAt).toLocaleString()}`}
          onClose={() => setRestoreFor(null)}
          onRestored={(msg) => {
            setRestoreFor(null)
            setRetryAsk(false)
            setNotice(msg)
            refreshContext()
          }}
        />
      )}
    </section>
  )
}

/** Screenshots captured by the agent's browser during the run. */
export function ArtifactGallery({ runId, artifacts }: { runId: string; artifacts: RunArtifact[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [zoom, setZoom] = useState<string | null>(null)
  const requested = useRef(new Set<string>())

  useEffect(() => {
    for (const a of artifacts) {
      const key = `${runId}/${a.name}`
      if (requested.current.has(key)) continue
      requested.current.add(key)
      api.runs.artifact(runId, a.name).then((u) => setUrls((cur) => ({ ...cur, [a.name]: u })), () => {})
    }
  }, [runId, artifacts])

  return (
    <div className="artifacts card">
      <h3>Browser screenshots ({artifacts.length})</h3>
      <div className="artifact-grid">
        {artifacts.map((a) => (
          <button key={a.name} className="artifact" onClick={() => setZoom(a.name)} title={a.name}>
            {urls[a.name] ? <img src={urls[a.name]} alt={`Screenshot ${a.name}`} /> : <span className="muted small">Loading…</span>}
            <span className="small mono ellipsis">{a.name}</span>
          </button>
        ))}
      </div>
      {zoom && urls[zoom] && (
        <div className="modal-backdrop" role="presentation" onClick={() => setZoom(null)}>
          <img className="artifact-zoom" src={urls[zoom]} alt={`Screenshot ${zoom}`} />
        </div>
      )}
    </div>
  )
}

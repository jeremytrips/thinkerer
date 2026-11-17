import { useEffect, useRef, useState } from 'react'
import type { AppInfo, GitStatus, Project, ProviderChoice, ProviderStatus, RunRecord, RunSummary } from '../../shared/types'
import { api, errorMessage } from '../api'
import { ProviderList, providerState } from './ProviderList'
import { RestartButton } from './RestartButton'
import { Elapsed, EventLine, StatusPill, UsageView, relativeTime } from './RunBits'

const LIVE: RunSummary['status'][] = ['queued', 'running', 'awaiting-approval']
// Paths in Thinkerer's own repo that only take effect after a main-process restart.
const NEEDS_RESTART = /^(electron|engine|shared)\/|^package\.json$|^electron\.vite\.config\.ts$/

interface Props {
  project: Project
  info: AppInfo | null
  isSelf: boolean
}

export function AgentTab({ project, info, isSelf }: Props) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [choice, setChoice] = useState<ProviderChoice>(project.config!.agent.provider)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<RunRecord | null>(null)
  const selectedId = useRef<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  function select(record: RunRecord | null) {
    selectedId.current = record?.id ?? null
    setSelected(record)
  }

  useEffect(() => {
    api.agents.providers().then(setProviders, (e) => setError(errorMessage(e)))
    api.runs.list(project.id).then(setRuns, () => {})
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
    })
    return () => {
      offEvent()
      offUpdate()
    }
  }, [project.id])

  useEffect(() => {
    if (selected && LIVE.includes(selected.status)) logEnd.current?.scrollIntoView({ block: 'end' })
  }, [selected?.events.length, selected?.status])

  const activeRun = runs.find((r) => LIVE.includes(r.status))

  async function start() {
    if (!prompt.trim() || starting) return
    setStarting(true)
    setError(null)
    try {
      const summary = await api.runs.start(project.id, prompt, choice)
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

  const changed = selected && !LIVE.includes(selected.status) ? changedDuringRun(selected.gitBefore, selected.gitAfter) : null
  const needsRestart = isSelf && changed?.some((e) => NEEDS_RESTART.test(e.path))
  const rendererChanged = isSelf && changed?.some((e) => e.path.startsWith('src/'))

  return (
    <section className="agent">
      <div className="agent-main">
        <div className="agent-head">
          <h1>Agent</h1>
          <div className="row">
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
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        <div className="run-view">
          {!selected ? (
            <div className="empty">
              <p className="muted">
                Describe a change. The agent works directly in <span className="mono">{project.path}</span>. Each provider runs
                under its own restrictions — see “What runs may do” under Providers.
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
              <div className="small muted">{selected.selection.rationale}</div>
              {selected.currentAction && LIVE.includes(selected.status) && (
                <div className="current-action">
                  <span className="spinner" aria-hidden /> {selected.currentAction}
                </div>
              )}
              <div className="events">
                {selected.events.map((e, i) => <EventLine key={i} event={e} root={project.path} />)}
                <div ref={logEnd} />
              </div>

              {!LIVE.includes(selected.status) && (
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
                  <h3>Git status changes during this run</h3>
                  {selected.gitAfter === null ? (
                    <p className="muted">Not a Git repository — changes can’t be listed.</p>
                  ) : changed!.length === 0 ? (
                    <p className="muted">No new changes in the working tree.</p>
                  ) : (
                    <ul className="changed mono small">
                      {changed!.map((e) => <li key={e.path}><span className="git-code">{e.code}</span> {e.path}</li>)}
                    </ul>
                  )}
                  {needsRestart && (
                    <div className="banner banner-info row space">
                      <span>This run changed Electron main/preload/engine code. Restart Thinkerer to load it.</span>
                      <RestartButton info={info} label="Restart now" />
                    </div>
                  )}
                  {rendererChanged && !needsRestart && (
                    <div className="banner banner-info">UI changes were hot-reloaded into this window.</div>
                  )}
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
            disabled={!!activeRun}
            rows={3}
            aria-label="Instruction for the agent"
          />
          <div className="row space">
            <span className="small muted">⌘/Ctrl + Enter to run</span>
            {activeRun ? (
              <button type="button" className="danger" onClick={() => api.runs.cancel(project.id).catch((e) => setError(errorMessage(e)))}>
                Stop run
              </button>
            ) : (
              <button type="submit" className="primary" disabled={!prompt.trim() || starting}>
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
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </section>
  )
}

function changedDuringRun(before: GitStatus | null, after: GitStatus | null): GitStatus['entries'] {
  if (!after) return []
  const prior = new Map((before?.entries ?? []).map((e) => [e.path, e.code]))
  return after.entries.filter((e) => prior.get(e.path) !== e.code)
}

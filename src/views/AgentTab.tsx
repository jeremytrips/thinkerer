import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  EffectiveMcp,
  PreviewCapture,
  Project,
  PromptAttachment,
  ProviderChoice,
  ProviderStatus,
  RunArtifact,
  RunEvent,
  RunRecord,
  RunSummary,
  Task
} from '../../shared/types'
import { api, errorMessage, loadState, saveState } from '../api'
import { useOverlay } from '../overlay'
import { ChangeList, RestoreDialog } from './Changes'
import { PreviewPane, type PreviewDevice } from './PreviewPane'
import type { TabId } from './ProjectView'
import { ProviderList, providerState } from './ProviderList'
import { RestartButton } from './RestartButton'
import { Elapsed, EventLine, StatusPill, UsageView, relativeTime } from './RunBits'

const LIVE: RunSummary['status'][] = ['queued', 'running', 'awaiting-approval']
// Paths in Thinkerer's own repo that only take effect after a main-process restart.
const NEEDS_RESTART = /^(electron|engine|shared|mcp)\/|^package\.json$|^electron\.vite\.config\.ts$/
// Share of the split given to the chat when the preview is shown.
const SPLIT_MIN = 0.25
const SPLIT_MAX = 0.75
const clampSplit = (v: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
const SIDE_WIDTH = 280 // .agent-side width in styles.css

// What the preview panel beside the chat can show. Add new surfaces here.
type SurfaceId = 'web' | 'mobile'
const SURFACES: { id: SurfaceId; label: string }[] = [
  { id: 'web', label: 'Web browser' },
  { id: 'mobile', label: 'Mobile simulator' }
]
const DEVICES: PreviewDevice[] = [
  { id: 'iphone-15', label: 'iPhone 15', width: 393, height: 852 },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667 },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915 },
  { id: 'ipad-mini', label: 'iPad mini', width: 744, height: 1133 }
]

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
  // Chat tabs stay open after their run finishes, until the user closes them.
  const [openIds, setOpenIds] = useState<string[]>([])
  const [attachments, setAttachments] = useState<PreviewCapture[]>([])
  const [showPreview, setShowPreview] = useState(() => loadState('agent.preview', true))
  const [surface, setSurface] = useState<SurfaceId>(() => {
    const saved = loadState<SurfaceId>('agent.surface', 'web')
    return SURFACES.some((s) => s.id === saved) ? saved : 'web'
  })
  const [deviceId, setDeviceId] = useState(() => loadState('agent.device', DEVICES[0].id))
  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0]
  const [showHistory, setShowHistory] = useState(() => loadState('agent.history', false))
  const [split, setSplit] = useState(() => clampSplit(loadState('agent.split', 0.5)))
  const [dragging, setDragging] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const logEnd = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const reloadedFor = useRef(new Set<string>())

  function select(record: RunRecord | null) {
    selectedId.current = record?.id ?? null
    setSelected(record)
    setRetryAsk(false)
    if (record) setOpenIds((cur) => (cur.includes(record.id) ? cur : [...cur, record.id]))
  }

  function closeTab(id: string) {
    const idx = openIds.indexOf(id)
    const rest = openIds.filter((x) => x !== id)
    setOpenIds(rest)
    if (selectedId.current !== id) return
    const next = rest[Math.min(idx, rest.length - 1)]
    if (next) void openRun(next)
    else select(null)
  }

  const refreshContext = useCallback(() => {
    api.git.status(project.id).then((s) => setIsGit(!!s), () => setIsGit(null))
    api.tasks.list(project.id).then(setTasks, () => {})
    api.mcp.effective(project.id).then(setMcp, () => {})
  }, [project.id])

  useEffect(() => {
    setOpenIds([])
    api.agents.providers().then(setProviders, (e) => setError(errorMessage(e)))
    api.runs.list(project.id).then(setRuns, () => {})
    refreshContext()
    // Re-attach to the newest live chat after a renderer reload.
    api.runs.active(project.id).then((live) => live.length && select(live[live.length - 1]), () => {})

    const offEvent = api.runs.onEvent((runId, event) => {
      if (runId !== selectedId.current) return
      setSelected((cur) => (cur && cur.id === runId ? { ...cur, events: [...cur.events, event] } : cur))
    })
    const offUpdate = api.runs.onUpdate((summary) => {
      if (summary.projectId !== project.id) return
      setRuns((cur) => [summary, ...cur.filter((r) => r.id !== summary.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      if (summary.id === selectedId.current) setSelected((cur) => (cur ? { ...cur, ...summary } : cur))
      if (summary.endedAt) refreshContext()
      // Show the result: reload the preview once when a run that changed files finishes.
      if (summary.endedAt && summary.changes?.length && !reloadedFor.current.has(summary.id)) {
        reloadedFor.current.add(summary.id)
        setReloadNonce((n) => n + 1)
      }
    })
    return () => {
      offEvent()
      offUpdate()
    }
  }, [project.id, refreshContext])

  useEffect(() => {
    if (!prefill) return
    select(null)
    setPrompt(prefill.prompt)
    setTaskId(prefill.taskId)
  }, [prefill?.nonce])

  useEffect(() => {
    if (selected && LIVE.includes(selected.status)) logEnd.current?.scrollIntoView({ block: 'end' })
  }, [selected?.events.length, selected?.status])

  // Chats that are still working, oldest first; each one is a separate agent run.
  const liveRuns = runs.filter((r) => LIVE.includes(r.status)).reverse()
  const anyLive = liveRuns.length > 0
  const liveKey = liveRuns.map((r) => r.id).join()

  // Every live chat gets a tab; finished ones keep theirs until closed.
  useEffect(() => {
    setOpenIds((cur) => {
      const add = liveRuns.map((r) => r.id).filter((id) => !cur.includes(id))
      return add.length ? [...cur, ...add] : cur
    })
  }, [liveKey])

  const chatTabs = openIds
    .map((id) => runs.find((r) => r.id === id) ?? (selected?.id === id ? selected : null))
    .filter((r): r is RunSummary => !!r)

  function cancel(runId: string) {
    api.runs.cancel(runId).catch((e) => setError(errorMessage(e)))
  }

  /** Retries pass the old prompt and don't take the composer's screenshots with them. */
  async function start(text = prompt, attach = attachments) {
    if (!text.trim() || starting) return
    setStarting(true)
    setError(null)
    setNotice(null)
    try {
      const summary = await api.runs.start(project.id, text, choice, taskId || null, attach.map((a) => a.id))
      if (text === prompt) setPrompt('')
      if (attach.length) setAttachments((cur) => cur.filter((a) => !attach.includes(a)))
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

  function attach(capture: PreviewCapture) {
    setAttachments((cur) => [...cur, capture])
    composerRef.current?.focus()
  }

  function detach(capture: PreviewCapture) {
    setAttachments((cur) => cur.filter((a) => a.id !== capture.id))
    void api.preview.discard(project.id, capture.id).catch(() => {})
  }

  function togglePreview() {
    setShowPreview((v) => (saveState('agent.preview', !v), !v))
  }

  function chooseSurface(id: SurfaceId) {
    setSurface(id)
    saveState('agent.surface', id)
  }

  function chooseDevice(id: string) {
    setDeviceId(id)
    saveState('agent.device', id)
  }

  function toggleHistory() {
    setShowHistory((v) => (saveState('agent.history', !v), !v))
  }

  /** The split covers everything right of the history panel: chat, divider, preview. */
  function resizeTo(clientX: number) {
    const left = mainRef.current?.getBoundingClientRect().left
    const right = sectionRef.current?.getBoundingClientRect().right
    if (left !== undefined && right !== undefined && right > left) setSplit(clampSplit((clientX - left) / (right - left)))
  }

  function nudgeSplit(delta: number) {
    setSplit((v) => {
      const next = clampSplit(v + delta)
      saveState('agent.split', next)
      return next
    })
  }

  async function showInPreview(url: string) {
    setError(null)
    try {
      if (!showPreview) togglePreview()
      await api.preview.navigate(project.id, url)
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
  const agentPage = selected ? lastAgentPage(selected.events) : null

  return (
    <section className={dragging ? 'agent dragging' : 'agent'} ref={sectionRef}>
      {showHistory && (
        <aside className="agent-side" aria-label="Run history and providers">
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
          <h3>Providers</h3>
          {providers ? <ProviderList providers={providers} /> : <p className="muted small">Detecting…</p>}
          <button className="small" onClick={() => api.agents.providers().then(setProviders, () => {})}>Re-check</button>
        </aside>
      )}

      <div className="agent-main" ref={mainRef} style={showPreview ? { flex: `0 0 calc((100% - ${showHistory ? SIDE_WIDTH : 0}px) * ${split})` } : undefined}>
        <div className="agent-head">
          <h1>Agent</h1>
          <div className="row">
            <label className="inline">
              Provider
              <select value={choice} onChange={(e) => setChoice(e.target.value as ProviderChoice)}>
                <option value="auto">Auto</option>
                {(providers ?? []).map((p) => (
                  <option key={p.id} value={p.id} disabled={providerState(p).tone === 'off'}>
                    {p.label} {providerState(p).tone === 'ok' ? '' : `(${providerState(p).label.toLowerCase()})`}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={showHistory ? 'small toggle on' : 'small toggle'} aria-pressed={showHistory} onClick={toggleHistory}>
              History
            </button>
            <button type="button" className={showPreview ? 'small toggle on' : 'small toggle'} aria-pressed={showPreview} onClick={togglePreview}>
              Preview
            </button>
          </div>
        </div>

        {isGit === false && (
          <div className="banner banner-info row space">
            <span>Agents need Git so Thinkerer can checkpoint the folder before every run and let you roll back.</span>
            <button className="small primary" onClick={initGit}>Initialize Git repository</button>
          </div>
        )}
        {error && <div className="banner banner-error">{error}</div>}
        {notice && <div className="banner banner-info">{notice}</div>}

        {(chatTabs.length > 0 || selected) && (
          <div className="chat-tabs" role="tablist" aria-label="Chats">
            {chatTabs.map((r) => (
              <div key={r.id} className={selected?.id === r.id ? 'chat-tab-wrap active' : 'chat-tab-wrap'}>
                <button
                  role="tab"
                  aria-selected={selected?.id === r.id}
                  className="chat-tab"
                  onClick={() => selected?.id !== r.id && openRun(r.id)}
                  title={r.prompt}
                >
                  {LIVE.includes(r.status) ? <span className="spinner" aria-label="Running" /> : <StatusPill status={r.status} />}
                  <span className="ellipsis">{r.prompt}</span>
                </button>
                {!LIVE.includes(r.status) && (
                  <button type="button" className="chat-tab-close" onClick={() => closeTab(r.id)} aria-label={`Close chat: ${r.prompt.slice(0, 60)}`} title="Close chat">
                    ×
                  </button>
                )}
              </div>
            ))}
            <button role="tab" aria-selected={!selected} className={!selected ? 'chat-tab active' : 'chat-tab'} onClick={() => select(null)}>
              + New chat
            </button>
          </div>
        )}

        <div className="run-view">
          {!selected ? (
            <div className="empty">
              <p className="muted">
                Describe a change. The agent works directly in <span className="mono">{project.path}</span>. A Git checkpoint
                is saved before it starts, so every run can be reviewed and rolled back.
              </p>
              {anyLive && (
                <p className="muted">
                  {liveRuns.length} chat{liveRuns.length === 1 ? ' is' : 's are'} already running in this folder. A new chat runs
                  alongside {liveRuns.length === 1 ? 'it' : 'them'}, so give them separate areas of the code to avoid conflicting edits.
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="bubble-user">
                {selected.prompt}
                {(selected.attachments?.length ?? 0) > 0 && <SentAttachments runId={selected.id} attachments={selected.attachments!} />}
              </div>
              <div className="run-meta">
                <StatusPill status={selected.status} />
                <span>{selected.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
                <span className="muted">·</span>
                <Elapsed startedAt={selected.startedAt} endedAt={selected.endedAt} />
                {selected.exitCode !== null && <span className="muted">· exit {selected.exitCode}</span>}
                <span className="muted">·</span>
                <UsageView usage={selected.usage} />
                {LIVE.includes(selected.status) && (
                  <button type="button" className="small danger push-right" onClick={() => cancel(selected.id)}>
                    Stop run
                  </button>
                )}
              </div>
              <div className="small muted">
                {selected.selection.rationale}
                {selected.taskId && <> · task: {tasks.find((t) => t.id === selected.taskId)?.title ?? 'removed task'}</>}
              </div>
              {agentPage && (
                <div className="agent-page small">
                  <span className="muted">Agent’s browser is on</span>
                  <span className="mono ellipsis" title={agentPage}>{agentPage}</span>
                  <button type="button" className="small" onClick={() => void showInPreview(agentPage)}>
                    Show in my preview
                  </button>
                </div>
              )}
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
                  {(selected.concurrentRunIds?.length ?? 0) > 0 && (
                    <div className="banner banner-info">
                      Ran alongside {selected.concurrentRunIds!.length} other chat{selected.concurrentRunIds!.length === 1 ? '' : 's'} in
                      this folder, so this list and its checkpoint may include their edits too.
                    </div>
                  )}
                  {changes === null ? (
                    <p className="muted">Not recorded for this run.</p>
                  ) : changes.length === 0 ? (
                    <p className="muted">No files changed.</p>
                  ) : (
                    <ChangeList changes={changes} loadDiff={(path) => api.git.runDiff(project.id, selected.id, path)} />
                  )}

                  <div className="row run-actions">
                    {selected.checkpoint && (
                      <button
                        className="small"
                        onClick={() => setRestoreFor(selected)}
                        disabled={anyLive}
                        title={anyLive ? 'Stop or wait for the running chats first' : undefined}
                      >
                        Restore checkpoint…
                      </button>
                    )}
                    {(selected.status === 'failed' || selected.status === 'cancelled') && !retryAsk && (
                      <button
                        className="small"
                        onClick={() => (changes && changes.length > 0 ? setRetryAsk(true) : void start(selected.prompt, []))}
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
                        <button className="small" onClick={() => setRestoreFor(selected)} disabled={anyLive}>Restore checkpoint first…</button>
                        <button className="small primary" onClick={() => void start(selected.prompt, [])}>
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
          {attachments.length > 0 && (
            <ul className="composer-attachments" aria-label="Screenshots to send">
              {attachments.map((a) => (
                <li key={a.id} className="attachment-chip" title={[a.url, ...a.consoleErrors].filter(Boolean).join('\n')}>
                  <img src={a.dataUrl} alt={`Preview screenshot of ${a.url ?? 'the site'}`} />
                  <span className="small ellipsis">
                    {a.url ? new URL(a.url).pathname : 'Preview'}
                    {a.consoleErrors.length > 0 && <span className="error-text"> · {a.consoleErrors.length} console error{a.consoleErrors.length === 1 ? '' : 's'}</span>}
                  </span>
                  <button type="button" className="chat-tab-close" onClick={() => detach(a)} aria-label="Remove screenshot" title="Remove screenshot">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={composerRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void start()
              }
            }}
            placeholder={
              attachments.length
                ? 'Describe what to change on this page…'
                : anyLive
                  ? 'Start another chat in parallel…'
                  : 'e.g. Add a visible About Thinkerer dialog, and test that it opens.'
            }
            disabled={isGit === false}
            rows={3}
            aria-label="Instruction for the agent"
          />
          <div className="row space">
            <div className="row small">
              <label className="inline">
                Task
                <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
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
            <button type="submit" className="primary" disabled={!prompt.trim() || starting || isGit === false}>
              {starting ? 'Starting…' : anyLive ? 'Run in parallel' : 'Run agent'}
            </button>
          </div>
        </form>
      </div>

      {showPreview && (
        <>
          <div
            className="split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat and preview"
            aria-valuemin={SPLIT_MIN * 100}
            aria-valuemax={SPLIT_MAX * 100}
            aria-valuenow={Math.round(split * 100)}
            tabIndex={0}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              setDragging(true)
            }}
            onPointerMove={(e) => dragging && resizeTo(e.clientX)}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId)
              setDragging(false)
              saveState('agent.split', split)
            }}
            onDoubleClick={() => nudgeSplit(0.5 - split)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') nudgeSplit(-0.05)
              else if (e.key === 'ArrowRight') nudgeSplit(0.05)
            }}
          />
          <div className="agent-preview">
            <div className="surface-bar">
              <div className="row segmented" role="tablist" aria-label="Preview surface">
                {SURFACES.map((s) => (
                  <button key={s.id} role="tab" aria-selected={surface === s.id} className={surface === s.id ? 'tab active' : 'tab'} onClick={() => chooseSurface(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
              {surface === 'mobile' && (
                <label className="inline small">
                  Device
                  <select value={device.id} onChange={(e) => chooseDevice(e.target.value)}>
                    {DEVICES.map((d) => (
                      <option key={d.id} value={d.id}>{d.label} ({d.width}×{d.height})</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <PreviewPane
              project={project}
              onCapture={attach}
              suspended={dragging}
              reloadNonce={reloadNonce}
              device={surface === 'mobile' ? device : null}
            />
          </div>
        </>
      )}

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
      {zoom && urls[zoom] && <ZoomedImage src={urls[zoom]} alt={`Screenshot ${zoom}`} onClose={() => setZoom(null)} />}
    </div>
  )
}

function ZoomedImage({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useOverlay()
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <img className="artifact-zoom" src={src} alt={alt} />
    </div>
  )
}

/** Preview screenshots the user sent with a prompt, shown in their message. */
function SentAttachments({ runId, attachments }: { runId: string; attachments: PromptAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [zoom, setZoom] = useState<string | null>(null)

  useEffect(() => {
    for (const a of attachments) api.runs.attachment(runId, a.id).then((u) => setUrls((cur) => ({ ...cur, [a.id]: u })), () => {})
  }, [runId, attachments.length])

  return (
    <div className="sent-attachments">
      {attachments.map((a) => (
        <button key={a.id} type="button" className="sent-attachment" onClick={() => setZoom(a.id)} title={[a.url, ...a.consoleErrors].filter(Boolean).join('\n')}>
          {urls[a.id] ? <img src={urls[a.id]} alt={`Screenshot of ${a.url ?? 'the preview'}`} /> : <span className="muted small">Loading…</span>}
        </button>
      ))}
      {zoom && urls[zoom] && <ZoomedImage src={urls[zoom]} alt="Sent screenshot" onClose={() => setZoom(null)} />}
    </div>
  )
}

/** The last page the agent opened in its Playwright browser, if any. */
export function lastAgentPage(events: RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind !== 'tool-use') continue
    const tool = String(e.meta?.tool ?? '') + ' ' + e.text
    if (!/playwright/.test(tool) || !/navigate/.test(tool)) continue
    const url = e.text.match(/https?:\/\/[^\s"'<>)]+/)?.[0]
    if (url) return url
  }
  return null
}

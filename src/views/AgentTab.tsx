import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  EffectiveMcp,
  PreviewCapture,
  Project,
  ProviderChoice,
  ProviderStatus,
  RunEvent,
  RunRecord,
  RunSummary,
  Task
} from '../../shared/types'
import { api, errorMessage, loadState, saveState } from '../api'
import { RestoreDialog } from './Changes'
import { ChatTurn, LIVE } from './ChatTurn'
import { PreviewPane, type PreviewDevice } from './PreviewPane'
import type { TabId } from './ProjectView'
import { ProviderList, providerState } from './ProviderList'
import { StatusPill, relativeTime } from './RunBits'

// Share of the split given to the chat when the preview is shown.
const SPLIT_MIN = 0.25
const SPLIT_MAX = 0.75
const clampSplit = (v: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
const SIDE_WIDTH = 260 // .agent-side width in styles.css
const NEW = 'new' // draft key for the "New chat" composer

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

/** A conversation: runs sharing a chatId, oldest first. */
interface Chat {
  id: string
  title: string
  turns: RunSummary[]
  last: RunSummary
  live: boolean
}

/** A message typed while the chat was working; it is sent when the agent finishes. */
interface Queued {
  text: string
  attachments: PreviewCapture[]
}

const byCreated = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt)
const chatOf = (r: RunSummary) => r.chatId ?? r.id

function groupChats(runs: RunSummary[]): Chat[] {
  const by = new Map<string, RunSummary[]>()
  for (const r of runs) by.set(chatOf(r), [...(by.get(chatOf(r)) ?? []), r])
  return [...by.entries()]
    .map(([id, list]) => {
      const turns = list.sort(byCreated)
      return { id, title: turns[0].prompt, turns, last: turns[turns.length - 1], live: turns.some((t) => LIVE.includes(t.status)) }
    })
    .sort((a, b) => byCreated(b.last, a.last))
}

export function AgentTab({ project, info, isSelf, onTab, prefill }: Props) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [choice, setChoice] = useState<ProviderChoice>(project.config!.agent.provider)
  const [runs, setRuns] = useState<RunSummary[]>([])
  // The open chat (null: a new one) and its turns with their events.
  const [chatId, setChatId] = useState<string | null>(null)
  const chatRef = useRef<string | null>(null)
  const [turns, setTurns] = useState<RunRecord[]>([])
  const turnsRef = useRef<RunRecord[]>([])
  turnsRef.current = turns
  const fetching = useRef(new Set<string>())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [queued, setQueued] = useState<Record<string, Queued>>({})
  const sendingQueued = useRef(new Set<string>())
  // The first message of a new chat, shown while its checkpoint is being saved.
  const [pending, setPending] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string>('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [mcp, setMcp] = useState<EffectiveMcp[]>([])
  const [isGit, setIsGit] = useState<boolean | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [restoreFor, setRestoreFor] = useState<RunRecord | null>(null)
  const [attachments, setAttachments] = useState<PreviewCapture[]>([])
  const [showPreview, setShowPreview] = useState(() => loadState('agent.preview', true))
  const [surface, setSurface] = useState<SurfaceId>(() => {
    const saved = loadState<SurfaceId>('agent.surface', 'web')
    return SURFACES.some((s) => s.id === saved) ? saved : 'web'
  })
  const [deviceId, setDeviceId] = useState(() => loadState('agent.device', DEVICES[0].id))
  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0]
  const [showChats, setShowChats] = useState(() => loadState('agent.chats', true))
  const [split, setSplit] = useState(() => clampSplit(loadState('agent.split', 0.5)))
  const [dragging, setDragging] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow new output only while the user is at the bottom of the transcript.
  const stick = useRef(true)
  const sectionRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const reloadedFor = useRef(new Set<string>())

  const chats = groupChats(runs)
  const chat = chats.find((c) => c.id === chatId) ?? null
  const liveChats = chats.filter((c) => c.live)
  const anyLive = liveChats.length > 0
  const draftKey = chatId ?? NEW
  const draft = drafts[draftKey] ?? ''
  const setDraft = (text: string, key = draftKey) => setDrafts((cur) => ({ ...cur, [key]: text }))

  function openChat(id: string | null) {
    chatRef.current = id
    stick.current = true
    setChatId(id)
    setTurns([])
    saveState(`agent.chat.${project.id}`, id)
    if (!id) return
    api.runs.chat(project.id, id).then(
      (loaded) => chatRef.current === id && setTurns((cur) => [...loaded, ...cur.filter((t) => !loaded.some((l) => l.id === t.id))].sort(byCreated)),
      (e) => setError(errorMessage(e))
    )
  }

  /** Loads a turn of the open chat that the transcript doesn't have yet (a follow-up that just started). */
  function ensureTurn(runId: string) {
    if (fetching.current.has(runId) || turnsRef.current.some((t) => t.id === runId)) return
    fetching.current.add(runId)
    const forChat = chatRef.current
    api.runs
      .get(runId)
      .then((rec) => {
        if (!rec || chatRef.current !== forChat) return
        setTurns((cur) => (cur.some((t) => t.id === rec.id) ? cur : [...cur, rec].sort(byCreated)))
      }, () => {})
      .finally(() => fetching.current.delete(runId))
  }

  const refreshContext = useCallback(() => {
    api.git.status(project.id).then((s) => setIsGit(!!s), () => setIsGit(null))
    api.tasks.list(project.id).then(setTasks, () => {})
    api.mcp.effective(project.id).then(setMcp, () => {})
  }, [project.id])

  useEffect(() => {
    api.agents.providers().then(setProviders, (e) => setError(errorMessage(e)))
    refreshContext()
    // Reopen the newest working chat (e.g. after a renderer reload), else the one open last time.
    Promise.all([api.runs.list(project.id), api.runs.active(project.id)]).then(([list, live]) => {
      setRuns(list)
      const saved = loadState<string | null>(`agent.chat.${project.id}`, null)
      const newest = live[live.length - 1]
      if (newest) openChat(newest.chatId ?? newest.id)
      else openChat(saved && list.some((r) => chatOf(r) === saved) ? saved : null)
    }, () => openChat(null))

    const offEvent = api.runs.onEvent((runId: string, event: RunEvent) => {
      setTurns((cur) => (cur.some((t) => t.id === runId) ? cur.map((t) => (t.id === runId ? { ...t, events: [...t.events, event] } : t)) : cur))
    })
    const offUpdate = api.runs.onUpdate((summary) => {
      if (summary.projectId !== project.id) return
      setRuns((cur) => [summary, ...cur.filter((r) => r.id !== summary.id)])
      if (chatOf(summary) === chatRef.current) {
        if (turnsRef.current.some((t) => t.id === summary.id)) setTurns((cur) => cur.map((t) => (t.id === summary.id ? { ...t, ...summary } : t)))
        else ensureTurn(summary.id)
      }
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
    openChat(null)
    setDraft(prefill.prompt, NEW)
    setTaskId(prefill.taskId)
  }, [prefill?.nonce])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [turns, chatId, pending, queued])

  // Send queued follow-ups once their chat finishes. A stopped chat gives the message back instead.
  useEffect(() => {
    for (const [id, q] of Object.entries(queued)) {
      const c = chats.find((x) => x.id === id)
      if (!c || c.live || sendingQueued.current.has(id)) continue
      sendingQueued.current.add(id)
      setQueued(({ [id]: _sent, ...rest }) => rest)
      if (c.last.status === 'cancelled') {
        giveBack(id, q)
        sendingQueued.current.delete(id)
        continue
      }
      void send(id, q.text, q.attachments)
        .then((ok) => ok || giveBack(id, q))
        .finally(() => sendingQueued.current.delete(id))
    }
  }, [runs, queued])

  /** Puts an unsent message back into its chat's composer. */
  function giveBack(id: string, q: Queued) {
    setDrafts((cur) => ({ ...cur, [id]: cur[id]?.trim() ? `${q.text}\n\n${cur[id]}` : q.text }))
    if (q.attachments.length) setAttachments((cur) => [...q.attachments, ...cur])
  }

  function cancel(runId: string) {
    api.runs.cancel(runId).catch((e) => setError(errorMessage(e)))
  }

  /** Starts a run: a new chat when `target` is null, else a follow-up in that chat. */
  async function send(target: string | null, text: string, attach: PreviewCapture[]): Promise<boolean> {
    setError(null)
    setNotice(null)
    try {
      const summary = await api.runs.start(project.id, text, choice, target ? null : taskId || null, attach.map((a) => a.id), target)
      if (!target) {
        setTaskId('')
        openChat(chatOf(summary))
      } else if (chatRef.current === target) {
        stick.current = true
        ensureTurn(summary.id)
      }
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    }
  }

  function submit() {
    const text = draft
    if (!text.trim() || starting || isGit === false) return
    const target = chatId
    const attach = attachments
    setDraft('')
    setAttachments([])
    if (target && chat?.live) {
      setQueued((cur) => ({
        ...cur,
        [target]: cur[target] ? { text: `${cur[target].text}\n\n${text}`, attachments: [...cur[target].attachments, ...attach] } : { text, attachments: attach }
      }))
      return
    }
    setStarting(true)
    if (!target) setPending(text)
    void send(target, text, attach)
      .then((ok) => ok || giveBack(target ?? NEW, { text, attachments: attach }))
      .finally(() => {
        setStarting(false)
        setPending(null)
      })
  }

  function unqueue(id: string) {
    const q = queued[id]
    if (!q) return
    setQueued(({ [id]: _removed, ...rest }) => rest)
    giveBack(id, q)
    composerRef.current?.focus()
  }

  function retry(turn: RunRecord) {
    void send(chatOf(turn), turn.prompt, [])
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

  function toggleChats() {
    setShowChats((v) => (saveState('agent.chats', !v), !v))
  }

  /** The split covers everything right of the chat list: chat, divider, preview. */
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

  const chatProvider = chat ? chat.last.provider : choice === 'auto' ? 'claude' : choice
  const effective = mcp.find((m) => m.provider === chatProvider)
  const includedTools = effective?.servers.filter((s) => s.included) ?? []
  const excludedTools = effective?.servers.filter((s) => !s.included) ?? []
  const agentPage = lastAgentPage(turns.flatMap((t) => t.events))
  const chatTask = chat?.turns[0].taskId ? (tasks.find((t) => t.id === chat.turns[0].taskId)?.title ?? 'removed task') : null
  const waiting = chatId ? queued[chatId] : undefined
  const liveTurn = turns.find((t) => LIVE.includes(t.status))

  return (
    <section className={dragging ? 'agent dragging' : 'agent'} ref={sectionRef}>
      {showChats && (
        <aside className="agent-side" aria-label="Chats and providers">
          <button type="button" className={chatId === null ? 'new-chat active' : 'new-chat'} onClick={() => (openChat(null), composerRef.current?.focus())}>
            + New chat
          </button>
          {chats.length === 0 ? (
            <p className="muted small">No chats yet.</p>
          ) : (
            <ul className="history" aria-label="Chats">
              {chats.map((c) => (
                <li key={c.id}>
                  <button
                    className={chatId === c.id ? 'history-item active' : 'history-item'}
                    aria-current={chatId === c.id ? 'true' : undefined}
                    onClick={() => chatId !== c.id && openChat(c.id)}
                    title={c.title}
                  >
                    <span className="ellipsis">{c.title}</span>
                    <span className="row small">
                      {c.live ? <span className="spinner" aria-label="Working" /> : <StatusPill status={c.last.status} />}
                      <span className="muted">{relativeTime(c.last.createdAt)}</span>
                      {c.turns.length > 1 && <span className="muted">{c.turns.length} messages</span>}
                      {queued[c.id] && <span className="muted">· 1 queued</span>}
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

      <div className="agent-main" ref={mainRef} style={showPreview ? { flex: `0 0 calc((100% - ${showChats ? SIDE_WIDTH : 0}px) * ${split})` } : undefined}>
        <div className="agent-head">
          <h1 className="chat-title ellipsis" title={chat?.title}>{chat ? chat.title : 'New chat'}</h1>
          <div className="row">
            <button type="button" className={showChats ? 'small toggle on' : 'small toggle'} aria-pressed={showChats} onClick={toggleChats}>
              Chats
            </button>
            <button type="button" className={showPreview ? 'small toggle on' : 'small toggle'} aria-pressed={showPreview} onClick={togglePreview}>
              Preview
            </button>
          </div>
        </div>

        {isGit === false && (
          <div className="banner banner-info row space">
            <span>Agents need Git so Thinkerer can checkpoint the folder before every message and let you roll back.</span>
            <button className="small primary" onClick={initGit}>Initialize Git repository</button>
          </div>
        )}

        <div
          className="transcript"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {!chatId ? (
            pending ? (
              <article className="turn">
                <div className="bubble-user">{pending}</div>
                <div className="agent-reply">
                  <div className="working">
                    <span className="spinner" aria-hidden /> <span className="mono">Saving a checkpoint…</span>
                  </div>
                </div>
              </article>
            ) : (
              <div className="empty">
                <p className="muted">
                  Describe a change. The agent works directly in <span className="mono">{project.path}</span>, and you can keep talking to it
                  in this chat. A Git checkpoint is saved before every message, so each one can be reviewed and rolled back.
                </p>
                {anyLive && (
                  <p className="muted">
                    {liveChats.length} chat{liveChats.length === 1 ? ' is' : 's are'} already working in this folder. A new chat runs alongside{' '}
                    {liveChats.length === 1 ? 'it' : 'them'}, so give them separate areas of the code to avoid conflicting edits.
                  </p>
                )}
              </div>
            )
          ) : (
            <>
              {turns.map((t, i) => (
                <ChatTurn
                  key={t.id}
                  turn={t}
                  projectId={project.id}
                  root={project.path}
                  isLast={i === turns.length - 1}
                  anyLive={anyLive}
                  info={info}
                  isSelf={isSelf}
                  taskTitle={chatTask}
                  onRestore={setRestoreFor}
                  onRetry={retry}
                  onCancel={cancel}
                />
              ))}
              {waiting && (
                <article className="turn queued">
                  <div className="bubble-user">
                    {waiting.text}
                    {waiting.attachments.length > 0 && (
                      <div className="small muted">+ {waiting.attachments.length} screenshot{waiting.attachments.length === 1 ? '' : 's'}</div>
                    )}
                  </div>
                  <div className="queued-note small muted">
                    Queued · sends when the agent finishes
                    <button type="button" className="link small" onClick={() => unqueue(chatId)}>Edit</button>
                  </div>
                </article>
              )}
            </>
          )}
        </div>

        {error && <div className="banner banner-error">{error}</div>}
        {notice && <div className="banner banner-info">{notice}</div>}
        {agentPage && (
          <div className="agent-page small">
            <span className="muted">Agent’s browser is on</span>
            <span className="mono ellipsis" title={agentPage}>{agentPage}</span>
            <button type="button" className="small" onClick={() => void showInPreview(agentPage)}>
              Show in my preview
            </button>
          </div>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
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
          <div className="composer-box">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a new line. Not while an IME is composing.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={
                chat?.live
                  ? 'Queue a follow-up for when the agent finishes…'
                  : chat
                    ? 'Reply to the agent…'
                    : attachments.length
                      ? 'Describe what to change on this page…'
                      : 'Describe a change, e.g. “Add a visible About dialog, and test that it opens.”'
              }
              disabled={isGit === false}
              rows={2}
              aria-label="Message to the agent"
            />
            <div className="composer-actions">
              {liveTurn && (
                <button type="button" className="small danger" onClick={() => cancel(liveTurn.id)}>
                  Stop
                </button>
              )}
              <button type="submit" className="primary small" disabled={!draft.trim() || starting || isGit === false}>
                {starting ? 'Sending…' : chat?.live ? 'Queue' : 'Send'}
              </button>
            </div>
          </div>
          <div className="row small composer-foot">
            {chat ? (
              <span className="muted">
                {chat.last.provider === 'claude' ? 'Claude Code' : 'Codex'}
                {chatTask && <> · task: {chatTask}</>}
              </span>
            ) : (
              <>
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
                <label className="inline">
                  Task
                  <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                    <option value="">None</option>
                    {tasks.filter((t) => t.status !== 'done').map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <button type="button" className="link small" onClick={() => onTab('mcp')} title="Tools this provider will receive">
              MCP tools: {includedTools.length ? includedTools.map((s) => s.id).join(', ') : 'none'}
              {excludedTools.length > 0 && ` (${excludedTools.length} unavailable)`}
            </button>
            <span className="muted push-right">Enter to send · Shift+Enter for a new line</span>
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
            setNotice(msg)
            refreshContext()
          }}
        />
      )}
    </section>
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

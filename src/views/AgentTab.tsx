import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  ChatCommand,
  ChatNote,
  ChatRecord,
  EffectiveMcp,
  PreviewCapture,
  Project,
  ProtocolAction,
  ProviderChoice,
  ProviderStatus,
  RunEvent,
  RunMode,
  RunRecord,
  RunSummary,
  Task
} from '../../shared/types'
import { api, errorMessage, loadState, saveState } from '../api'
import { RestoreDialog } from './Changes'
import { ChatNoteView, SlashMenu, agentItems, commandOf, matchingCommands, type SlashItem } from './ChatBits'
import { ChatTurn, LIVE } from './ChatTurn'
import { EmulatorPane } from './EmulatorPane'
import { PreviewPane, type PreviewDevice } from './PreviewPane'
import { ProtocolBar } from './ProtocolBar'
import type { TabId } from './ProjectView'
import { providerState } from './ProviderList'
import { StatusPill, relativeTime } from './RunBits'

// Share of the split given to the chat when the preview is shown.
const SPLIT_MIN = 0.25
const SPLIT_MAX = 0.75
const clampSplit = (v: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
const SIDE_WIDTH = 260 // .agent-side width in styles.css
const NEW = 'new' // draft key for the "New chat" composer

// What the preview panel beside the chat can show. Add new surfaces here.
type SurfaceId = 'web' | 'mobile' | 'emulator'
const SURFACES: { id: SurfaceId; label: string; title: string }[] = [
  { id: 'web', label: 'Web browser', title: 'The site in the embedded browser' },
  { id: 'mobile', label: 'Phone viewport', title: 'The site in the embedded browser, sized like a phone (no device emulation)' },
  { id: 'emulator', label: 'Emulator', title: 'A real Android emulator or iOS simulator running on this machine' }
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

/** A conversation: runs sharing a chatId, oldest first, with its chat record (worktree, state, notes). */
interface Chat {
  id: string
  title: string
  turns: RunSummary[]
  last: RunSummary
  live: boolean
  record: ChatRecord | null
}

/** A message typed while the chat was working; it is sent when the agent finishes. */
interface Queued {
  text: string
  attachments: PreviewCapture[]
  mode: RunMode
}

const byCreated = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt)
const chatOf = (r: RunSummary) => r.chatId ?? r.id

function groupChats(runs: RunSummary[], records: ChatRecord[]): Chat[] {
  const by = new Map<string, RunSummary[]>()
  for (const r of runs) by.set(chatOf(r), [...(by.get(chatOf(r)) ?? []), r])
  const recordOf = new Map(records.map((c) => [c.id, c]))
  return [...by.entries()]
    .map(([id, list]) => {
      const turns = list.sort(byCreated)
      const record = recordOf.get(id) ?? null
      return { id, title: record?.title ?? turns[0].prompt, turns, last: turns[turns.length - 1], live: turns.some((t) => LIVE.includes(t.status)), record }
    })
    .sort((a, b) => byCreated(b.last, a.last))
}

// Chat records arrive both pushed (chats:update) and fetched (chats:list); a
// fetch that was read before a later push must not overwrite it.
const newer = (a: ChatRecord, b: ChatRecord | undefined) => (b && b.updatedAt > a.updatedAt ? b : a)
const upsert = (cur: ChatRecord[], c: ChatRecord) => [newer(c, cur.find((x) => x.id === c.id)), ...cur.filter((x) => x.id !== c.id)]
const mergeList = (cur: ChatRecord[], list: ChatRecord[]) => list.map((c) => newer(c, cur.find((x) => x.id === c.id)))

/** Done chats leave the main list (a live one stays until it stops). */
const isDone = (c: Chat) => c.record?.state === 'done' && !c.live

function chatHint(c: Chat): string | null {
  if (c.live) return null
  if (c.record?.state === 'setting-up') return 'Setup failed · send to retry'
  if (c.record?.state === 'merged') return 'Merged · /cleanup'
  const p = c.record?.protocol
  if (p) return p.stage === 'plan' ? 'Plan ready · approve' : p.stage === 'review' ? 'Reviewed' : p.checks?.status === 'failed' ? 'Checks failed' : null
  return null
}

export function AgentTab({ project, info, isSelf, onTab, prefill }: Props) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [choice, setChoice] = useState<ProviderChoice>(project.config!.agent.provider)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [records, setRecords] = useState<ChatRecord[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  // How the next message runs; plan mode is read-only and goes back to auto once sent.
  const [mode, setMode] = useState<RunMode>('auto')
  // New chats follow the software protocol (plan → implement + tests → review → ship) unless turned off.
  const [useProtocol, setUseProtocol] = useState(() => loadState('agent.protocol', true))
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

  const chats = groupChats(runs, records)
  const chat = chats.find((c) => c.id === chatId) ?? null
  const activeChats = chats.filter((c) => !isDone(c))
  const doneChats = chats.filter(isDone)
  const liveChats = chats.filter((c) => c.live)
  const record = chat?.record ?? null
  const worktree = record?.worktree && !record.worktreeRemoved ? record.worktree : null
  const finished = !!record?.worktreeRemoved
  // A chat with a worktree has its own dev server, ports and preview.
  const previewChat = worktree ? chatId : null
  const draftKey = chatId ?? NEW
  const draft = drafts[draftKey] ?? ''
  const setDraft = (text: string, key = draftKey) => setDrafts((cur) => ({ ...cur, [key]: text }))
  const chatProvider = chat ? chat.last.provider : choice === 'auto' ? 'claude' : choice
  // The agent CLI's own commands and skills, as it reported them for this chat (or the project's latest run).
  const capabilities = [...(chat ? chat.turns : runs)].filter((r) => r.capabilities && r.provider === chatProvider).sort(byCreated).at(-1)?.capabilities ?? null
  const agentCommands = capabilities ? agentItems(capabilities.commands, capabilities.skills) : []
  const menu = finished ? [] : matchingCommands(draft, agentCommands, !!chatId)
  /** Live runs working in a folder: only they can conflict with restoring a checkpoint there. */
  const liveIn = (folder: string) => runs.some((r) => LIVE.includes(r.status) && (r.cwd ?? r.projectPath) === folder)

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

  const refreshChats = useCallback(() => {
    api.chats.list(project.id).then((list) => setRecords((cur) => mergeList(cur, list)), () => {})
  }, [project.id])

  const refreshContext = useCallback(() => {
    refreshChats()
    api.git.status(project.id).then((s) => setIsGit(!!s), () => setIsGit(null))
    api.tasks.list(project.id).then(setTasks, () => {})
    api.mcp.effective(project.id).then(setMcp, () => {})
  }, [project.id, refreshChats])

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

    const offChat = api.chats.onUpdate((c) => {
      if (c.projectId === project.id) setRecords((cur) => upsert(cur, c))
    })
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
      offChat()
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
  }, [turns, chatId, pending, queued, record?.notes.length])

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
      void send(id, q.text, q.attachments, q.mode)
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
  async function send(target: string | null, text: string, attach: PreviewCapture[], runMode: RunMode = 'auto'): Promise<boolean> {
    setError(null)
    setNotice(null)
    try {
      const summary = await api.runs.start(project.id, text, choice, target ? null : taskId || null, attach.map((a) => a.id), target, runMode, !target && useProtocol)
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

  async function runCommand(name: ChatCommand) {
    if (!chatId) return
    setError(null)
    setNotice(null)
    setDraft('')
    setStarting(true)
    stick.current = true
    try {
      const updated = await api.chats.command(project.id, chatId, name)
      setRecords((cur) => upsert(cur, updated))
    } catch (err) {
      if (errorMessage(err) !== 'Cancelled') setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  async function advance(action: ProtocolAction) {
    if (!chatId) return
    setError(null)
    setNotice(null)
    setStarting(true)
    stick.current = true
    try {
      const updated = await api.chats.advance(project.id, chatId, action)
      setRecords((cur) => upsert(cur, updated))
    } catch (err) {
      if (errorMessage(err) !== 'Cancelled') setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  function submit() {
    const text = draft
    if (!text.trim() || starting || isGit === false || finished) return
    const command = commandOf(text)
    if (command) {
      if (!chatId) return setError('Slash commands act on a chat; open one first.')
      return void runCommand(command)
    }
    const target = chatId
    const attach = attachments
    const runMode = mode
    setDraft('')
    setAttachments([])
    setMode('auto')
    if (target && chat?.live) {
      setQueued((cur) => ({
        ...cur,
        [target]: cur[target]
          ? { text: `${cur[target].text}\n\n${text}`, attachments: [...cur[target].attachments, ...attach], mode: runMode }
          : { text, attachments: attach, mode: runMode }
      }))
      return
    }
    setStarting(true)
    if (!target) setPending(text)
    void send(target, text, attach, runMode)
      .then((ok) => ok || giveBack(target ?? NEW, { text, attachments: attach, mode: runMode }))
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
    void send(chatOf(turn), turn.prompt, [], turn.mode ?? 'auto')
  }

  /** A Thinkerer command runs now; an agent command is completed in the composer so arguments can follow. */
  function pick(item: SlashItem) {
    if (item.kind === 'thinkerer') return void runCommand(item.name as ChatCommand)
    setDraft(`/${item.name} `)
    composerRef.current?.focus()
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
      await api.preview.navigate(project.id, previewChat, url)
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

  const effective = mcp.find((m) => m.provider === chatProvider)
  const includedTools = effective?.servers.filter((s) => s.included) ?? []
  const excludedTools = effective?.servers.filter((s) => !s.included) ?? []
  const agentPage = lastAgentPage(turns.flatMap((t) => t.events))
  const chatTask = chat?.turns[0].taskId ? (tasks.find((t) => t.id === chat.turns[0].taskId)?.title ?? 'removed task') : null
  const waiting = chatId ? queued[chatId] : undefined
  const liveTurn = turns.find((t) => LIVE.includes(t.status))
  // In a protocol chat the stage decides how a message runs, not the mode picker.
  const protocolChat = chat ? !!record?.protocol : useProtocol
  const planning = protocolChat ? !chat || record?.protocol?.stage === 'plan' : mode === 'plan'

  function chatItem(c: Chat) {
    const hint = chatHint(c)
    return (
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
          {hint && <span className="small chat-hint">{hint}</span>}
        </button>
      </li>
    )
  }

  // Turns and notes (hook output, slash command results) in the order they happened.
  const items: ({ at: string; turn: RunRecord } | { at: string; note: ChatNote })[] = [
    // A turn counts from when its agent started, so the worktree setup it waited for comes first.
    ...turns.map((t) => ({ at: t.startedAt ?? t.createdAt, turn: t })),
    ...(record?.notes ?? []).map((n) => ({ at: n.at, note: n }))
  ].sort((a, b) => a.at.localeCompare(b.at))
  const lastTurnId = turns.at(-1)?.id

  return (
    <section className={dragging ? 'agent dragging' : 'agent'} ref={sectionRef}>
      {showChats && (
        <aside className="agent-side" aria-label="Chats">
          <button type="button" className={chatId === null ? 'new-chat active' : 'new-chat'} onClick={() => (openChat(null), composerRef.current?.focus())}>
            + New chat
          </button>
          {activeChats.length === 0 ? (
            <p className="muted small">{doneChats.length ? 'No open chats.' : 'No chats yet.'}</p>
          ) : (
            <ul className="history" aria-label="Open chats">
              {activeChats.map((c) => chatItem(c))}
            </ul>
          )}
          {doneChats.length > 0 && (
            <details className="done-chats" open={!!chat && isDone(chat)}>
              <summary className="small muted">Done ({doneChats.length})</summary>
              <ul className="history" aria-label="Done chats">
                {doneChats.map((c) => chatItem(c))}
              </ul>
            </details>
          )}
        </aside>
      )}

      <div className="agent-main" ref={mainRef} style={showPreview ? { flex: `0 0 calc((100% - ${showChats ? SIDE_WIDTH : 0}px) * ${split})` } : undefined}>
        <div className="agent-head">
          <div className="chat-head">
            <h1 className="chat-title ellipsis" title={chat?.title}>{chat ? chat.title : 'New chat'}</h1>
            {worktree ? (
              <div className="row small muted chat-meta">
                <span className="mono" title={`From ${worktree.base} at ${worktree.baseCommit.slice(0, 7)}`}>{worktree.branch}</span>
                {record!.ports.length > 0 && <span className="mono">ports {record!.ports.join(', ')}</span>}
                <button type="button" className="link small" onClick={() => api.chats.reveal(project.id, chatId!).catch((e) => setError(errorMessage(e)))}>
                  Show worktree
                </button>
              </div>
            ) : (
              chat && (
                <div className="small muted chat-meta">{finished ? `Worktree removed (${record?.doneReason === 'discarded' ? 'discarded' : 'cleaned up'})` : 'Works in the project folder'}</div>
              )
            )}
          </div>
          <div className="row">
            <button type="button" className={showChats ? 'small toggle on' : 'small toggle'} aria-pressed={showChats} onClick={toggleChats}>
              Chats
            </button>
            <button type="button" className={showPreview ? 'small toggle on' : 'small toggle'} aria-pressed={showPreview} onClick={togglePreview}>
              Preview
            </button>
          </div>
        </div>

        {record?.protocol && (
          <ProtocolBar
            protocol={record.protocol}
            base={worktree?.base ?? null}
            busy={!!chat?.live || starting}
            maxRounds={project.config!.protocol.maxReviewRounds}
            lastReview={chat?.turns.filter((t) => t.protocolStage === 'review').at(-1)}
            onAction={(a) => void advance(a)}
          />
        )}

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
                    <span className="spinner" aria-hidden /> <span className="mono">Setting up the chat’s worktree…</span>
                  </div>
                </div>
              </article>
            ) : (
              <div className="empty">
                <p className="muted">
                  Describe a change. Each chat gets its own Git worktree and branch from the project’s current branch, so chats never step on
                  each other. Thinkerer commits every message’s changes on the chat’s branch, and a checkpoint before each one lets you roll it back.
                </p>
                <p className="muted">
                  When you’re happy, type <span className="mono">/merge</span> to merge the branch into{' '}
                  <span className="mono">{isGit ? 'its base branch' : 'main'}</span>, then <span className="mono">/cleanup</span> to check nothing
                  is left and remove the worktree.
                </p>
                {useProtocol && (
                  <p className="muted">
                    With the software protocol on, your first message is planned read-only. You approve the plan, the agent implements it with
                    tests, Thinkerer runs the checks, a fresh session reviews the diff, and you ship it to the base branch.
                  </p>
                )}
                {liveChats.length > 0 && (
                  <p className="muted">
                    {liveChats.length} chat{liveChats.length === 1 ? ' is' : 's are'} working right now.
                  </p>
                )}
              </div>
            )
          ) : (
            <>
              {items.map((item) =>
                'note' in item ? (
                  <ChatNoteView key={`note-${item.at}-${item.note.kind}`} note={item.note} />
                ) : (
                  <ChatTurn
                    key={item.turn.id}
                    turn={item.turn}
                    projectId={project.id}
                    root={item.turn.cwd ?? project.path}
                    isLast={item.turn.id === lastTurnId}
                    anyLive={liveIn(item.turn.cwd ?? item.turn.projectPath) || finished}
                    info={info}
                    isSelf={isSelf}
                    taskTitle={chatTask}
                    onRestore={setRestoreFor}
                    onRetry={retry}
                    onCancel={cancel}
                  />
                )
              )}
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
                <li key={a.id} className="attachment-chip" title={[a.device ?? a.url, ...a.consoleErrors].filter(Boolean).join('\n')}>
                  <img src={a.dataUrl} alt={a.device ? `Screenshot of ${a.device}` : `Preview screenshot of ${a.url ?? 'the site'}`} />
                  <span className="small ellipsis">
                    {a.device ? a.device.replace(/ \[.*\]$/, '') : a.url ? new URL(a.url).pathname : 'Preview'}
                    {a.consoleErrors.length > 0 && <span className="error-text"> · {a.consoleErrors.length} console error{a.consoleErrors.length === 1 ? '' : 's'}</span>}
                  </span>
                  <button type="button" className="chat-tab-close" onClick={() => detach(a)} aria-label="Remove screenshot" title="Remove screenshot">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <SlashMenu items={menu} active={Math.min(menuIndex, menu.length - 1)} onPick={pick} />
          <div className="composer-box">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setMenuIndex(0)
              }}
              onKeyDown={(e) => {
                if (menu.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault()
                  setMenuIndex((i) => (Math.min(i, menu.length - 1) + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length)
                  return
                }
                if (menu.length && e.key === 'Tab') {
                  e.preventDefault()
                  const item = menu[Math.min(menuIndex, menu.length - 1)]
                  setDraft(item.kind === 'agent' ? `/${item.name} ` : `/${item.name}`)
                  return
                }
                // Enter sends; Shift+Enter is a new line. Not while an IME is composing.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (menu.length && !commandOf(draft)) {
                    const item = menu[Math.min(menuIndex, menu.length - 1)]
                    // An agent command typed out in full is sent as it is; a partial one is completed first.
                    if (item.kind === 'thinkerer' || draft.trim() !== `/${item.name}`) return pick(item)
                  }
                  submit()
                }
              }}
              placeholder={
                finished
                  ? 'This chat is finished and its worktree was removed. Start a new chat to keep going.'
                  : chat?.live
                  ? 'Queue a follow-up for when the agent finishes…'
                  : chat
                    ? 'Reply to the agent, or type / for commands…'
                    : attachments.length
                      ? 'Describe what to change on this page…'
                      : 'Describe a change, e.g. “Add a visible About dialog, and test that it opens.”'
              }
              disabled={isGit === false || finished}
              rows={2}
              aria-label="Message to the agent"
            />
            <div className="composer-actions">
              {liveTurn && (
                <button type="button" className="small danger" onClick={() => cancel(liveTurn.id)}>
                  Stop
                </button>
              )}
              <button type="submit" className="primary small" disabled={!draft.trim() || starting || isGit === false || finished}>
                {starting ? 'Sending…' : commandOf(draft) ? 'Run' : chat?.live ? 'Queue' : planning ? 'Plan' : 'Send'}
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
            {!chat && (
              <label className="inline" title="Plan, then implement with tests, then an independent review, then ship. Thinkerer runs the checks and the merge itself.">
                <input type="checkbox" checked={useProtocol} onChange={(e) => (saveState('agent.protocol', e.target.checked), setUseProtocol(e.target.checked))} />
                Software protocol
              </label>
            )}
            {!protocolChat && (
              <label className="inline" title="Plan: the agent only investigates (read-only) and proposes a plan; reply to carry it out">
                Mode
                <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)} aria-label="Mode for the next message" disabled={finished}>
                  <option value="auto">Make changes</option>
                  <option value="plan">Plan only (read-only)</option>
                </select>
              </label>
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
                  <button key={s.id} role="tab" aria-selected={surface === s.id} className={surface === s.id ? 'tab active' : 'tab'} title={s.title} onClick={() => chooseSurface(s.id)}>
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
            {surface === 'emulator' ? (
              <EmulatorPane project={project} chatId={previewChat} onCapture={attach} />
            ) : (
              <PreviewPane
                project={project}
                chatId={previewChat}
                onCapture={attach}
                suspended={dragging}
                reloadNonce={reloadNonce}
                device={surface === 'mobile' ? device : null}
              />
            )}
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

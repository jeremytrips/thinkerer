import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  ChatCommand,
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
import { looksLikeApproval } from '../../shared/protocol'
import { api, errorMessage, loadState, saveState } from '../api'
import { AgentComposer } from './AgentComposer'
import { ChatHeader, ChatList, byCreated, chatOf, groupChats, mergeRecords, upsertRecord } from './AgentChats'
import { AgentPreviewSide, usePreviewLayout } from './AgentPreview'
import { AgentTranscript, lastAgentPage, transcriptItems } from './AgentTranscript'
import { RestoreDialog } from './Changes'
import { agentItems, commandOf, matchingCommands, type SlashItem } from './ChatBits'
import { LIVE } from './ChatTurn'
import { ProtocolBar } from './ProtocolBar'
import { modeAfterGiveBack, type Queued } from './queue'
import type { TabId } from './ProjectView'
import { useFollowUps } from './useFollowUps'

const NEW = 'new' // draft key for the "New chat" composer

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
  const [records, setRecords] = useState<ChatRecord[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  // How each composer's next message runs (keyed like drafts); plan mode is read-only and goes back to auto once sent.
  const [modes, setModes] = useState<Record<string, RunMode>>({})
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
  const [reloadNonce, setReloadNonce] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow new output only while the user is at the bottom of the transcript.
  const stick = useRef(true)
  const sectionRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const layout = usePreviewLayout(sectionRef, mainRef)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const reloadedFor = useRef(new Set<string>())

  const chats = groupChats(runs, records)
  const chat = chats.find((c) => c.id === chatId) ?? null
  const liveChats = chats.filter((c) => c.live)
  const record = chat?.record ?? null
  const worktree = record?.worktree && !record.worktreeRemoved ? record.worktree : null
  const finished = !!record?.worktreeRemoved
  // A chat with a worktree has its own dev server, ports and preview.
  const previewChat = worktree ? chatId : null
  const draftKey = chatId ?? NEW
  const draft = drafts[draftKey] ?? ''
  const setDraft = (text: string, key = draftKey) => setDrafts((cur) => ({ ...cur, [key]: text }))
  const mode = modes[draftKey] ?? 'auto'
  const setMode = (m: RunMode, key = draftKey) => setModes((cur) => ({ ...cur, [key]: m }))
  const chatProvider = chat ? chat.last.provider : choice === 'auto' ? 'claude' : choice
  // The agent CLI's own commands and skills, as it reported them for this chat (or the project's latest run).
  const capabilities = [...(chat ? chat.turns : runs)].filter((r) => r.capabilities && r.provider === chatProvider).sort(byCreated).at(-1)?.capabilities ?? null
  const agentCommands = capabilities ? agentItems(capabilities.commands, capabilities.skills) : []
  const menu = finished ? [] : matchingCommands(draft, agentCommands, !!chatId)
  /** Live runs working in a folder: only they can conflict with restoring a checkpoint there. */
  const liveIn = (folder: string) => runs.some((r) => LIVE.includes(r.status) && (r.cwd ?? r.projectPath) === folder)
  const followUps = useFollowUps({ chats, runs, send: (id, q) => send(id, q.text, q.attachments, q.mode), giveBack })
  const queued = followUps.queued

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
    api.chats.list(project.id).then((list) => setRecords((cur) => mergeRecords(cur, list)), () => {})
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
      if (c.projectId === project.id) setRecords((cur) => upsertRecord(cur, c))
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

  /** Puts an unsent message back into its chat's composer, with its mode (plan wins over a draft already there, so nothing read-only turns into edits). */
  function giveBack(id: string, q: Queued) {
    setDrafts((cur) => ({ ...cur, [id]: cur[id]?.trim() ? `${q.text}\n\n${cur[id]}` : q.text }))
    setModes((cur) => ({ ...cur, [id]: modeAfterGiveBack(q.mode, cur[id]) }))
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
      setRecords((cur) => upsertRecord(cur, updated))
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
      setRecords((cur) => upsertRecord(cur, updated))
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
    if (target && chat?.live) {
      const refused = followUps.queue(target, { text, attachments: attach, mode: runMode })
      if (refused) {
        setError(null)
        return setNotice(refused) // the draft stays in the composer
      }
    }
    setDraft('')
    setAttachments([])
    setMode('auto')
    if (target && chat?.live) return
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
    const q = followUps.take(id)
    if (!q) return
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

  async function showInPreview(url: string) {
    setError(null)
    try {
      if (!layout.showPreview) layout.togglePreview()
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
  // The engine decides with the same rule (shared/protocol.ts), so what the button says is what happens.
  const approving = !!chat && record?.protocol?.stage === 'plan' && looksLikeApproval(draft)
  const planning = protocolChat ? !approving && (!chat || record?.protocol?.stage === 'plan') : mode === 'plan'

  const items = transcriptItems(turns, record?.notes ?? [])
  const lastTurnId = turns.at(-1)?.id

  return (
    <section className={layout.dragging ? 'agent dragging' : 'agent'} ref={sectionRef}>
      {layout.showChats && (
        <ChatList chats={chats} chatId={chatId} isQueued={(id) => !!queued[id]} onOpen={openChat} onNew={() => (openChat(null), composerRef.current?.focus())} />
      )}

      <div className="agent-main" ref={mainRef} style={layout.mainStyle}>
        <ChatHeader chat={chat} layout={layout} onReveal={() => api.chats.reveal(project.id, chatId!).catch((e) => setError(errorMessage(e)))} />

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
          <AgentTranscript
            project={project}
            info={info}
            isSelf={isSelf}
            chatId={chatId}
            pending={pending}
            isGit={isGit}
            liveChats={liveChats.length}
            useProtocol={useProtocol}
            items={items}
            lastTurnId={lastTurnId}
            chatTask={chatTask}
            finished={finished}
            liveIn={liveIn}
            waiting={waiting}
            onUnqueue={unqueue}
            onRestore={setRestoreFor}
            onRetry={retry}
            onCancel={cancel}
          />
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

        <AgentComposer
          composerRef={composerRef}
          draft={draft}
          setDraft={(text) => setDraft(text)}
          onSubmit={submit}
          attachments={attachments}
          onDetach={detach}
          menu={menu}
          menuIndex={menuIndex}
          setMenuIndex={setMenuIndex}
          onPick={pick}
          chat={chat ? { provider: chat.last.provider, live: chat.live } : null}
          chatTask={chatTask}
          finished={finished}
          noGit={isGit === false}
          starting={starting}
          liveTurnId={liveTurn?.id ?? null}
          onStop={cancel}
          mode={mode}
          setMode={setMode}
          useProtocol={useProtocol}
          setUseProtocol={(on) => (saveState('agent.protocol', on), setUseProtocol(on))}
          protocolChat={protocolChat}
          planning={planning}
          approving={approving}
          providers={providers}
          choice={choice}
          setChoice={setChoice}
          tasks={tasks}
          taskId={taskId}
          setTaskId={setTaskId}
          includedTools={includedTools}
          excludedTools={excludedTools}
          onTab={onTab}
        />
      </div>

      {layout.showPreview && <AgentPreviewSide layout={layout} project={project} previewChat={previewChat} reloadNonce={reloadNonce} onCapture={attach} />}

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

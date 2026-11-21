import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChatRecord, EffectiveMcp, ProviderStatus, RunEvent, RunRecord, RunSummary, Task } from '../../shared/types'
import { api, errorMessage, loadState, saveState } from '../api'
import { byCreated, chatOf, mergeRecords, upsertRecord } from './AgentChats'

interface Options {
  projectId: string
  onError: (message: string) => void
  /** The transcript's "follow new output" flag; opening a chat jumps back to the bottom. */
  stick: MutableRefObject<boolean>
}

/** The Agent tab's data: the project's runs and chats, the open chat's turns, and the context the composer needs. */
export function useAgentChat({ projectId, onError, stick }: Options) {
  // Set when a prefill (from the Tasks tab) chose what to show, so reopening the last chat doesn't override it.
  const prefilled = useRef(false)
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [records, setRecords] = useState<ChatRecord[]>([])
  // The open chat (null: a new one) and its turns with their events.
  const [chatId, setChatId] = useState<string | null>(null)
  const chatRef = useRef<string | null>(null)
  const [turns, setTurns] = useState<RunRecord[]>([])
  const turnsRef = useRef<RunRecord[]>([])
  turnsRef.current = turns
  const fetching = useRef(new Set<string>())
  const [tasks, setTasks] = useState<Task[]>([])
  const [mcp, setMcp] = useState<EffectiveMcp[]>([])
  const [isGit, setIsGit] = useState<boolean | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const reloadedFor = useRef(new Set<string>())

  function openChat(id: string | null) {
    chatRef.current = id
    stick.current = true
    setChatId(id)
    setTurns([])
    saveState(`agent.chat.${projectId}`, id)
    if (!id) return
    api.runs.chat(projectId, id).then(
      (loaded) => chatRef.current === id && setTurns((cur) => [...loaded, ...cur.filter((t) => !loaded.some((l) => l.id === t.id))].sort(byCreated)),
      (e) => onError(errorMessage(e))
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
    api.chats.list(projectId).then((list) => setRecords((cur) => mergeRecords(cur, list)), () => {})
  }, [projectId])

  const refreshContext = useCallback(() => {
    refreshChats()
    api.git.status(projectId).then((s) => setIsGit(!!s), () => setIsGit(null))
    api.board.get(projectId).then((b) => setTasks(b.tasks), () => {})
    api.mcp.effective(projectId).then(setMcp, () => {})
  }, [projectId, refreshChats])

  useEffect(() => {
    api.agents.providers().then(setProviders, (e) => onError(errorMessage(e)))
    refreshContext()
    // Reopen the newest working chat (e.g. after a renderer reload), else the one open last time.
    Promise.all([api.runs.list(projectId), api.runs.active(projectId)]).then(([list, live]) => {
      setRuns(list)
      if (prefilled.current) return
      const saved = loadState<string | null>(`agent.chat.${projectId}`, null)
      const newest = live[live.length - 1]
      if (newest) openChat(newest.chatId ?? newest.id)
      else openChat(saved && list.some((r) => chatOf(r) === saved) ? saved : null)
    }, () => !prefilled.current && openChat(null))

    const offChat = api.chats.onUpdate((c) => {
      if (c.projectId === projectId) setRecords((cur) => upsertRecord(cur, c))
    })
    const offEvent = api.runs.onEvent((runId: string, event: RunEvent) => {
      setTurns((cur) => (cur.some((t) => t.id === runId) ? cur.map((t) => (t.id === runId ? { ...t, events: [...t.events, event] } : t)) : cur))
    })
    const offUpdate = api.runs.onUpdate((summary) => {
      if (summary.projectId !== projectId) return
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
  }, [projectId, refreshContext])

  return { prefilled, providers, runs, records, setRecords, chatId, chatRef, turns, openChat, ensureTurn, refreshContext, isGit, tasks, mcp, reloadNonce }
}

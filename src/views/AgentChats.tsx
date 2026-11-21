import type { ChatRecord, RunSummary } from '../../shared/types'
import type { PreviewLayout } from './AgentPreview'
import { LIVE } from './ChatTurn'
import { StatusPill, relativeTime } from './RunBits'

// The Agent tab's chat list: runs grouped into conversations, open ones first,
// done ones folded away.

/** A conversation: runs sharing a chatId, oldest first, with its chat record (worktree, state, notes). */
export interface Chat {
  id: string
  title: string
  turns: RunSummary[]
  last: RunSummary
  live: boolean
  record: ChatRecord | null
}

export const byCreated = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt)
export const chatOf = (r: RunSummary) => r.chatId ?? r.id

export function groupChats(runs: RunSummary[], records: ChatRecord[]): Chat[] {
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

/** Done chats leave the main list (a live one stays until it stops). */
export const isDone = (c: Chat) => c.record?.state === 'done' && !c.live

function chatHint(c: Chat): string | null {
  if (c.live) return null
  if (c.record?.state === 'setting-up') return 'Setup failed · send to retry'
  if (c.record?.state === 'merged') return 'Merged · /cleanup'
  const p = c.record?.protocol
  if (p) return p.stage === 'plan' ? 'Plan ready · approve' : p.stage === 'review' ? 'Reviewed' : p.checks?.status === 'failed' ? 'Checks failed' : null
  return null
}

// Chat records arrive both pushed (chats:update) and fetched (chats:list); a
// fetch that was read before a later push must not overwrite it.
const newer = (a: ChatRecord, b: ChatRecord | undefined) => (b && b.updatedAt > a.updatedAt ? b : a)
export const upsertRecord = (cur: ChatRecord[], c: ChatRecord) => [newer(c, cur.find((x) => x.id === c.id)), ...cur.filter((x) => x.id !== c.id)]
export const mergeRecords = (cur: ChatRecord[], list: ChatRecord[]) => list.map((c) => newer(c, cur.find((x) => x.id === c.id)))

interface Props {
  chats: Chat[]
  chatId: string | null
  isQueued: (chatId: string) => boolean
  onOpen: (chatId: string) => void
  onNew: () => void
}

export function ChatList({ chats, chatId, isQueued, onOpen, onNew }: Props) {
  const activeChats = chats.filter((c) => !isDone(c))
  const doneChats = chats.filter(isDone)
  const chat = chats.find((c) => c.id === chatId)

  function chatItem(c: Chat) {
    const hint = chatHint(c)
    return (
      <li key={c.id}>
        <button
          className={chatId === c.id ? 'history-item active' : 'history-item'}
          aria-current={chatId === c.id ? 'true' : undefined}
          onClick={() => chatId !== c.id && onOpen(c.id)}
          title={c.title}
        >
          <span className="ellipsis">{c.title}</span>
          <span className="row small">
            {c.live ? <span className="spinner" aria-label="Working" /> : <StatusPill status={c.last.status} />}
            <span className="muted">{relativeTime(c.last.createdAt)}</span>
            {c.turns.length > 1 && <span className="muted">{c.turns.length} messages</span>}
            {isQueued(c.id) && <span className="muted">· 1 queued</span>}
          </span>
          {hint && <span className="small chat-hint">{hint}</span>}
        </button>
      </li>
    )
  }

  return (
    <aside className="agent-side" aria-label="Chats">
      <button type="button" className={chatId === null ? 'new-chat active' : 'new-chat'} onClick={onNew}>
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
  )
}

interface HeaderProps {
  chat: Chat | null
  layout: PreviewLayout
  onReveal: () => void
}

/** The open chat's title, branch and ports, with the Chats and Preview toggles. */
export function ChatHeader({ chat, layout, onReveal }: HeaderProps) {
  const record = chat?.record ?? null
  const worktree = record?.worktree && !record.worktreeRemoved ? record.worktree : null
  return (
    <div className="agent-head">
      <div className="chat-head">
        <h1 className="chat-title ellipsis" title={chat?.title}>{chat ? chat.title : 'New chat'}</h1>
        {worktree ? (
          <div className="row small muted chat-meta">
            <span className="mono" title={`From ${worktree.base} at ${worktree.baseCommit.slice(0, 7)}`}>{worktree.branch}</span>
            {record!.ports.length > 0 && <span className="mono">ports {record!.ports.join(', ')}</span>}
            <button type="button" className="link small" onClick={onReveal}>
              Show worktree
            </button>
          </div>
        ) : (
          chat && (
            <div className="small muted chat-meta">
              {record?.worktreeRemoved ? `Worktree removed (${record.doneReason === 'discarded' ? 'discarded' : 'cleaned up'})` : 'Works in the project folder'}
            </div>
          )
        )}
      </div>
      <div className="row">
        <button type="button" className={layout.showChats ? 'small toggle on' : 'small toggle'} aria-pressed={layout.showChats} onClick={layout.toggleChats}>
          Chats
        </button>
        <button type="button" className={layout.showPreview ? 'small toggle on' : 'small toggle'} aria-pressed={layout.showPreview} onClick={layout.togglePreview}>
          Preview
        </button>
      </div>
    </div>
  )
}

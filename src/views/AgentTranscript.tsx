import type { AppInfo, ChatNote, Project, RunEvent, RunRecord } from '../../shared/types'
import { ChatNoteView } from './ChatBits'
import { ChatTurn } from './ChatTurn'
import type { Queued } from './queue'

// What the Agent tab's transcript shows: the new-chat explainer, the first
// message while its worktree is set up, or the open chat's turns and notes
// with any queued follow-up.

/** Turns and notes (hook output, slash command results) in the order they happened. */
export type TranscriptItem = { at: string; turn: RunRecord } | { at: string; note: ChatNote }

export function transcriptItems(turns: RunRecord[], notes: ChatNote[]): TranscriptItem[] {
  return [
    // A turn counts from when its agent started, so the worktree setup it waited for comes first.
    ...turns.map((t) => ({ at: t.startedAt ?? t.createdAt, turn: t })),
    ...notes.map((n) => ({ at: n.at, note: n }))
  ].sort((a, b) => a.at.localeCompare(b.at))
}

interface Props {
  project: Project
  info: AppInfo | null
  isSelf: boolean
  chatId: string | null
  /** The first message of a new chat, while it is being set up. */
  pending: string | null
  isGit: boolean | null
  liveChats: number
  /** The new chat will follow the software protocol. */
  useProtocol: boolean
  items: TranscriptItem[]
  /** The newest turn by creation time; only it offers Retry. */
  lastTurnId: string | undefined
  chatTask: string | null
  finished: boolean
  /** Whether a live run works in this folder (restoring a checkpoint there would conflict). */
  liveIn: (folder: string) => boolean
  waiting: Queued | undefined
  onUnqueue: (chatId: string) => void
  onRestore: (turn: RunRecord) => void
  onRetry: (turn: RunRecord) => void
  onCancel: (runId: string) => void
}

export function AgentTranscript(p: Props) {
  const { chatId, items, waiting } = p
  if (!chatId) {
    if (p.pending) {
      return (
        <article className="turn">
          <div className="bubble-user">{p.pending}</div>
          <div className="agent-reply">
            <div className="working">
              <span className="spinner" aria-hidden /> <span className="mono">Setting up the chat’s worktree…</span>
            </div>
          </div>
        </article>
      )
    }
    return (
      <div className="empty">
        <p className="muted">
          Describe a change. Each chat gets its own Git worktree and branch from the project’s current branch, so chats never step on
          each other. Thinkerer commits every message’s changes on the chat’s branch, and a checkpoint before each one lets you roll it back.
        </p>
        <p className="muted">
          When you’re happy, type <span className="mono">/merge</span> to merge the branch into{' '}
          <span className="mono">{p.isGit ? 'its base branch' : 'main'}</span>, then <span className="mono">/cleanup</span> to check nothing
          is left and remove the worktree.
        </p>
        {p.useProtocol ? (
          <p className="muted">
            A feature chat follows the software protocol: your first message is planned read-only. You approve the plan, the agent
            implements it with tests, Thinkerer runs the checks, a fresh session reviews the diff, and you ship it to the base branch.
          </p>
        ) : (
          <p className="muted">
            A plain chat has no plan, review or ship steps: each message runs in the mode you pick below. Choose “Feature” under Type for
            the full protocol.
          </p>
        )}
        {p.liveChats > 0 && (
          <p className="muted">
            {p.liveChats} chat{p.liveChats === 1 ? ' is' : 's are'} working right now.
          </p>
        )}
      </div>
    )
  }
  return (
    <>
      {items.map((item) =>
        'note' in item ? (
          <ChatNoteView key={`note-${item.at}-${item.note.kind}`} note={item.note} />
        ) : (
          <ChatTurn
            key={item.turn.id}
            turn={item.turn}
            projectId={p.project.id}
            root={item.turn.cwd ?? p.project.path}
            isLast={item.turn.id === p.lastTurnId}
            anyLive={p.liveIn(item.turn.cwd ?? item.turn.projectPath) || p.finished}
            info={p.info}
            isSelf={p.isSelf}
            taskTitle={p.chatTask}
            onRestore={p.onRestore}
            onRetry={p.onRetry}
            onCancel={p.onCancel}
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
            Queued{waiting.mode === 'plan' ? ' · plan only (read-only)' : ''} · sends when the agent finishes
            <button type="button" className="link small" onClick={() => p.onUnqueue(chatId)}>Edit</button>
          </div>
        </article>
      )}
    </>
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

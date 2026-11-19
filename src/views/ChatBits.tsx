import type { ChatCommand, ChatNote } from '../../shared/types'

/** Slash commands Thinkerer runs itself; the agent never sees them. */
export const COMMANDS: { name: ChatCommand; hint: string }[] = [
  { name: 'merge', hint: 'Merge this chat’s branch into its base branch (locally, never pushed)' },
  { name: 'cleanup', hint: 'Check nothing is left to do, run the teardown hook, remove the worktree' },
  { name: 'done', hint: 'File the chat under Done and keep its worktree' },
  { name: 'discard', hint: 'Delete the worktree and branch, merged or not (asks first)' }
]

/** The command a draft is, e.g. "/merge" → 'merge'; null for an ordinary message. */
export function commandOf(draft: string): ChatCommand | null {
  const m = draft.trim().match(/^\/([a-z]+)$/)
  return (m && COMMANDS.find((c) => c.name === m[1])?.name) || null
}

/** Commands matching a draft that is being typed as one ("/", "/cl"…). */
export function matchingCommands(draft: string): typeof COMMANDS {
  const m = draft.match(/^\/([a-z]*)$/)
  return m ? COMMANDS.filter((c) => c.name.startsWith(m[1])) : []
}

export function SlashMenu({ items, active, onPick }: { items: typeof COMMANDS; active: number; onPick: (name: ChatCommand) => void }) {
  if (!items.length) return null
  return (
    <ul className="slash-menu" role="listbox" aria-label="Chat commands">
      {items.map((c, i) => (
        <li key={c.name} role="option" aria-selected={i === active}>
          <button
            type="button"
            className={i === active ? 'slash-item active' : 'slash-item'}
            // Keep focus in the composer.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c.name)}
          >
            <span className="mono">/{c.name}</span>
            <span className="small muted">{c.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

const ICON: Record<ChatNote['kind'], string> = {
  setup: 'Setup',
  teardown: 'Teardown',
  info: 'Note',
  merge: '/merge',
  cleanup: '/cleanup',
  done: '/done',
  discard: '/discard'
}

/** A system message in the transcript: hook output, or a slash command's checklist. */
export function ChatNoteView({ note }: { note: ChatNote }) {
  const hook = note.kind === 'setup' || note.kind === 'teardown'
  const body = note.lines.length > 0 && <pre className="note-lines mono small">{note.lines.join('\n')}</pre>
  return (
    <article className={note.ok ? 'chat-note' : 'chat-note chat-note-failed'} aria-label={`${ICON[note.kind]}: ${note.title}`}>
      <div className="row small">
        <span className="pill">{ICON[note.kind]}</span>
        <strong>{note.title}</strong>
        <span className="muted push-right">{new Date(note.at).toLocaleTimeString()}</span>
      </div>
      {hook && note.ok ? (
        body && (
          <details>
            <summary className="small muted">Output ({note.lines.length} line{note.lines.length === 1 ? '' : 's'})</summary>
            {body}
          </details>
        )
      ) : (
        body
      )}
    </article>
  )
}

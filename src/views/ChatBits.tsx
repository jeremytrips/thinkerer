import type { ChatCommand, ChatNote } from '../../shared/types'
import type { PaletteItem } from '../paletteModel'

/** Slash commands Thinkerer runs itself; the agent never sees them. */
export const COMMANDS: { name: ChatCommand; hint: string }[] = [
  { name: 'merge', hint: 'Merge this chat’s branch into its base branch (locally, never pushed)' },
  { name: 'cleanup', hint: 'Check nothing is left to do, run the teardown hook, remove the worktree' },
  { name: 'done', hint: 'File the chat under Done and keep its worktree' },
  { name: 'discard', hint: 'Delete the worktree and branch, merged or not (asks first)' }
]

/** A slash menu entry: a Thinkerer command, or one of the agent CLI's own commands and skills (sent to the agent). */
export interface SlashItem {
  name: string
  hint: string
  kind: 'thinkerer' | 'agent'
}

/** Hints for Claude Code commands that are useful in a chat; others show as "Claude Code command" or "Skill". */
const AGENT_HINTS: Record<string, string> = {
  compact: 'Summarize the conversation so far to free up context',
  context: 'Show what is using the context window',
  cost: 'Show session cost and usage',
  usage: 'Show plan usage limits',
  init: 'Write a CLAUDE.md describing this codebase',
  review: 'Review the changes on this branch',
  'code-review': 'Review the changes on this branch',
  'security-review': 'Security review of the pending changes',
  simplify: 'Look for ways to simplify the recent changes',
  debug: 'Debug a problem step by step',
  verify: 'Verify the change works',
  recap: 'Recap what happened in this session',
  insights: 'Insights about your Claude Code sessions'
}

export function agentItems(commands: string[], skills: string[]): SlashItem[] {
  const isSkill = new Set(skills)
  const own = new Set<string>(COMMANDS.map((c) => c.name))
  return commands
    .filter((c) => !own.has(c))
    .map((name) => ({ name, kind: 'agent' as const, hint: AGENT_HINTS[name] ?? (isSkill.has(name) ? 'Skill · sent to the agent' : 'Claude Code command · sent to the agent') }))
}

/** The Thinkerer command a draft is, e.g. "/merge" → 'merge'; null for an ordinary message (including agent commands). */
export function commandOf(draft: string): ChatCommand | null {
  const m = draft.trim().match(/^\/([a-z]+)$/)
  return (m && COMMANDS.find((c) => c.name === m[1])?.name) || null
}

/** Items matching a draft that is being typed as a command ("/", "/cl"…). Thinkerer's commands first. */
export function matchingCommands(draft: string, agent: SlashItem[] = [], thinkerer = true): SlashItem[] {
  const m = draft.match(/^\/([\w:.-]*)$/)
  if (!m) return []
  const q = m[1].toLowerCase()
  const own: SlashItem[] = thinkerer ? COMMANDS.map((c) => ({ ...c, kind: 'thinkerer' as const })) : []
  const hits = [...own, ...agent].filter((c) => c.name.toLowerCase().startsWith(q))
  // Also match inside names ("/rev" finds code-review), after the prefix matches.
  const inner = q ? agent.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : []
  return [...hits, ...inner].slice(0, 12)
}

export function SlashMenu({ items, active, onPick }: { items: SlashItem[]; active: number; onPick: (item: SlashItem) => void }) {
  if (!items.length) return null
  return (
    <ul className="slash-menu" role="listbox" aria-label="Chat commands">
      {items.map((c, i) => (
        <li key={`${c.kind}:${c.name}`} role="option" aria-selected={i === active}>
          <button
            type="button"
            className={i === active ? 'slash-item active' : 'slash-item'}
            // Keep focus in the composer.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
          >
            <span className="mono">/{c.name}</span>
            <span className="small muted">{c.hint}</span>
            {c.kind === 'agent' && <span className="badge push-right">agent</span>}
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
  checks: 'Checks',
  protocol: 'Protocol',
  merge: '/merge',
  cleanup: '/cleanup',
  done: '/done',
  discard: '/discard'
}

/** A system message in the transcript: hook output, or a slash command's checklist. */
export function ChatNoteView({ note }: { note: ChatNote }) {
  const hook = note.kind === 'setup' || note.kind === 'teardown' || note.kind === 'checks'
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

/**
 * The open chat's slash commands as palette entries. Thinkerer's commands run on that chat
 * right away, as picking them from the slash menu does; the agent's own commands go into
 * the composer, so arguments can follow.
 */
export function chatPaletteItems(p: {
  chatTitle: string | null
  /** No message can be sent (finished chat, or no Git). */
  closed: boolean
  agentCommands: SlashItem[]
  run: (name: ChatCommand) => void
  complete: (name: string) => void
}): PaletteItem[] {
  if (p.closed) return []
  const own: PaletteItem[] = p.chatTitle
    ? COMMANDS.map((c) => ({ id: `slash:${c.name}`, section: 'Slash commands', title: `/${c.name}`, hint: `${c.hint} · ${p.chatTitle}`, run: () => p.run(c.name) }))
    : []
  const agent: PaletteItem[] = p.agentCommands.map((c) => ({ id: `slash-agent:${c.name}`, section: 'Slash commands', title: `/${c.name}`, hint: c.hint, shortcut: 'agent', run: () => p.complete(c.name) }))
  return [...own, ...agent]
}

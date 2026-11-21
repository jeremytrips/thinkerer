import type { RefObject } from 'react'
import type { ChatCommand } from '../../shared/types'
import { usePaletteSource } from '../palette'
import type { PaletteItem } from '../paletteModel'
import { COMMANDS, type SlashItem } from './ChatBits'

// The Agent tab's entries in the ⌘K palette (kept out of AgentTab.tsx, which is at its size limit).

/**
 * The open chat's slash commands as palette entries. Thinkerer's commands run on that chat
 * right away, as picking them from the slash menu does; the agent's own commands go into
 * the composer, so arguments can follow.
 */
export function chatPaletteItems(p: {
  chatTitle: string | null
  /** No message can be sent (finished chat, or no Git). */
  closed: boolean
  /** A command or first message is already on its way: no second Thinkerer command may race it. */
  busy: boolean
  agentCommands: SlashItem[]
  run: (name: ChatCommand) => void
  complete: (name: string) => void
}): PaletteItem[] {
  if (p.closed) return []
  const own: PaletteItem[] =
    p.chatTitle && !p.busy
      ? COMMANDS.map((c) => ({ id: `slash:${c.name}`, section: 'Slash commands', title: `/${c.name}`, hint: `${c.hint} · ${p.chatTitle}`, run: () => p.run(c.name) }))
      : []
  const agent: PaletteItem[] = p.agentCommands.map((c) => ({ id: `slash-agent:${c.name}`, section: 'Slash commands', title: `/${c.name}`, hint: c.hint, shortcut: 'agent', run: () => p.complete(c.name) }))
  return [...own, ...agent]
}

/** The draft after picking an agent command from the palette: what was typed stays, after the command. */
export function withCommand(draft: string, name: string): string {
  const rest = draft.replace(/^\/[\w:.-]*\s*/, '') // a command already at the start is replaced, not stacked
  return rest.trim() ? `/${name} ${rest}` : `/${name} `
}

interface Options {
  chatTitle: string | null
  closed: boolean
  busy: boolean
  agentCommands: SlashItem[]
  draft: string
  setDraft: (text: string) => void
  composerRef: RefObject<HTMLTextAreaElement | null>
  /** Runs a Thinkerer command on the open chat; `keepDraft` leaves the composer's text alone. */
  runCommand: (name: ChatCommand, keepDraft: boolean) => void
}

export function useChatPalette(o: Options): void {
  usePaletteSource('agent', () =>
    chatPaletteItems({
      ...o,
      // From the palette the draft is not the command, so it must survive.
      run: (name) => o.runCommand(name, true),
      complete: (name) => {
        o.setDraft(withCommand(o.draft, name))
        o.composerRef.current?.focus()
      }
    })
  )
}

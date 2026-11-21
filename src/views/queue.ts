import type { PreviewCapture, RunMode } from '../../shared/types'

/** A message typed while the chat was working; it is sent when the agent finishes. */
export interface Queued {
  text: string
  attachments: PreviewCapture[]
  mode: RunMode
}

const MODE_LABEL: Record<RunMode, string> = { auto: 'Make changes', plan: 'Plan only' }

/**
 * Adds a follow-up to a chat's queue. Queued messages are sent as one run, so
 * they must share a mode: a message in another mode is refused (with the reason)
 * rather than silently turning a plan into edits, or an edit request read-only.
 */
export function enqueue(current: Queued | undefined, next: Queued): { queued: Queued } | { refused: string } {
  if (!current) return { queued: next }
  if (current.mode !== next.mode) {
    return {
      refused: `A "${MODE_LABEL[current.mode]}" message is already queued. Wait for it to send, or click Edit on it, before queuing a "${MODE_LABEL[next.mode]}" one.`
    }
  }
  return { queued: { text: `${current.text}\n\n${next.text}`, attachments: [...current.attachments, ...next.attachments], mode: current.mode } }
}

/** Mode of a composer after an unsent message comes back into it: plan wins, so nothing read-only turns into edits. */
export function modeAfterGiveBack(returned: RunMode, draftMode: RunMode | undefined): RunMode {
  return returned === 'plan' || draftMode === 'plan' ? 'plan' : 'auto'
}

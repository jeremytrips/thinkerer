import type { ChatProtocol, RunSummary } from './types'

// Protocol rules the engine and the renderer must agree on. Pure functions
// only: this file is bundled into the untrusted renderer too.

/** Counts the reviewer's finding lines; null when it didn't use the format (then the text is all we have). */
export function countFindings(text: string | null | undefined): number | null {
  if (!text) return null
  if (/^\s*No findings\.?\s*$/i.test(text.trim().split('\n').at(-1) ?? '') && !/\[(high|medium|low)\]/i.test(text)) return 0
  const n = text.split('\n').filter((l) => /^\s*(?:[-*\d.]+\s*)?`?\[(high|medium|low)\]/i.test(l)).length
  return n || null
}

/**
 * True while Thinkerer still owes the checks for the chat's latest turn: they
 * are running, or the implement turn just ended and they aren't recorded yet.
 * Starting another step in that window would test half-edited files.
 */
export function checksPending(p: ChatProtocol, last: RunSummary | undefined, checkCommand: string): boolean {
  if (p.stage !== 'implement') return false
  if (p.checks?.status === 'running') return true
  if (!checkCommand.trim() || !last || last.status !== 'succeeded' || (last.protocolStage ?? 'implement') !== 'implement') return false
  return p.checks?.runId !== last.id
}

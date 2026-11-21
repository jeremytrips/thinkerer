import type { ChatProtocol, RunSummary } from './types'

// Pure protocol helpers shared by the engine (which decides) and the renderer
// (which shows the user what will happen before they send). This file is bundled
// into the untrusted renderer too.

const MAX_APPROVAL_CHARS = 80
const APPROVAL = /^(ok(ay)?|yes|yep|yeah|sure|go( ahead)?|lgtm|looks good|approved?|implement|do it|ship it|proceed|sounds good|perfect|great)\b/i
/** Anything that hints at a change to the plan keeps the message a plan reply. */
const CHANGE =
  /\?|\b(but|instead|except|change|don'?t|do not|not|no|nope|without|rather|first|wait|hold|also|remove|drop|add|skip|only|think|rethink|reconsider|revise|why|what|how|hmm+|let me|maybe|later|unsure)\b/i

/**
 * Whether a reply at the plan stage reads as "approved, go". Deliberately
 * narrow: a false positive starts writing code the user didn't agree to, a
 * false negative only costs one more read-only turn (and the Approve button
 * is always there).
 */
export function looksLikeApproval(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > MAX_APPROVAL_CHARS || t.startsWith('/')) return false
  return APPROVAL.test(t) && !CHANGE.test(t)
}

/** Counts the reviewer's finding lines; null when it didn't use the format (then the text is all we have). */
export function countFindings(text: string | null | undefined): number | null {
  if (!text) return null
  if (/^\s*No findings\.?\s*$/i.test(text.trim().split('\n').at(-1) ?? '') && !/\[(high|medium|low)\]/i.test(text)) return 0
  const n = text.split('\n').filter((l) => FINDING_LINE.test(l)).length
  return n || jsonFindings(text)
}

/** A finding line in the protocol's format: `[high|medium|low] path:line: …`, optionally as a list item. */
export const FINDING_LINE = /^\s*(?:[-*\d.]+\s*)?`?\[(high|medium|low)\]/i

/** A review command's own JSON answer (e.g. `[]`, or `[{"severity":"important",…}]`) at the end of the reply. */
function jsonFindings(text: string): number | null {
  const body = text.replace(/\s*(?:```)?\s*$/, '')
  if (!body.endsWith(']')) return null
  // The array starts at one of the '[' before the final ']'; try them from the nearest back.
  for (let i = body.lastIndexOf('['); i >= 0; i = body.lastIndexOf('[', i - 1)) {
    try {
      const v: unknown = JSON.parse(body.slice(i))
      return Array.isArray(v) && v.every((f) => f && typeof f === 'object' && 'severity' in f) ? v.length : null
    } catch {
      if (i === 0) break
    }
  }
  return null
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

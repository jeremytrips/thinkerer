// Pure protocol helpers shared by the engine (which decides) and the renderer
// (which shows the user what will happen before they send).

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

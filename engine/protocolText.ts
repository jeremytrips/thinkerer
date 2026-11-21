import type { ChatRecord, ChatWorktree, Effort, ProtocolChecks, RunRecord, UsageObservation } from '../shared/types'
import { branchExists, git } from './worktrees'

// What the software protocol tells the agent at each stage, and the report it
// leaves when the chat ships. Everything here is kept short on purpose: these
// strings are sent on every turn, so each sentence costs tokens in every chat.

/** Above this, the reviewer gets the file list only and opens the diffs it needs. */
export const MAX_REVIEW_DIFF_CHARS = 60_000
/** Lines of failing check output sent back to the agent. */
export const CHECK_TAIL_LINES = 50
const MAX_PLAN_CHARS = 8_000
const MAX_FINDINGS_CHARS = 8_000

/** Generated files that bloat a diff without telling a reviewer anything. */
const NOISE = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', '*.min.js', '*.min.css', '*.map']
const NOISE_SPECS = NOISE.map((n) => `:(glob,exclude)**/${n}`)

export const PLAN_INSTRUCTIONS = [
  'Thinkerer software protocol, stage 1 of 4 (plan). The user approves your plan before anything is implemented.',
  'Reply with four short sections: Goal; Steps (the files to change); Tests (to add or update); Acceptance criteria (each one checkable).',
  'Read only what the plan needs: search first, read the relevant parts of files, and do not start sub-agents unless the task spans many areas.'
].join(' ')

export function implementInstructions(checkCommand: string): string {
  return [
    'Thinkerer software protocol, stage 2 of 4 (implement and test). Implement the approved plan and add or update its tests.',
    checkCommand
      ? `After this turn Thinkerer runs \`${checkCommand}\` itself and shows the result, so while you work run only the tests you need, with quiet output (no full logs).`
      : 'Run the project\'s type check and tests, keep their output short, and report the exact result.',
    'End with at most five lines: what changed and what you verified.'
  ].join(' ')
}

export const REVIEW_INSTRUCTIONS = [
  'Thinkerer software protocol, stage 3 of 4 (code review). You are reviewing a change someone else made in this worktree; you are read-only.',
  'Report only real problems you are confident about: bugs, acceptance criteria not met or not tested, broken project rules.',
  'No praise and no summary of the change. One line per finding: `[high|medium|low] path:line: problem; fix`.',
  'If there are none, reply exactly: No findings.'
].join(' ')

/** Above this, the plan is cut in the review instructions (they are a system prompt). */
const MAX_REVIEW_PLAN_CHARS = 4_000

/**
 * The Claude effort for a review turn: an explicit review effort is the user's
 * choice (max included); an inherited max is held at xhigh, since a max review
 * starts many reviewer sub-agents. '' = the project's agent effort.
 */
export function reviewEffort(reviewEffort: Effort, agentEffort: Effort): Effort {
  return reviewEffort || (agentEffort === 'max' ? 'xhigh' : '')
}

/** The level passed to a CLI's review command: the review turn's effort, else medium. */
export function reviewLevel(reviewEffortSetting: Effort, agentEffort: Effort): string {
  return reviewEffort(reviewEffortSetting, agentEffort) || agentEffort || 'medium'
}

/**
 * Instructions for a review run by the CLI's own review command (e.g. Claude
 * Code's /code-review). They pin what is reviewed (the chat's own range, not
 * the repo's default branch), add the plan and check result the command can't
 * know, and override its output format so findings can be counted and forwarded.
 */
export function commandReviewInstructions(range: string, plan: string | null, checks: ProtocolChecks | null): string {
  return [
    'Thinkerer software protocol, stage 3 of 4 (code review). You are reviewing a change someone else made in this worktree; you are read-only: do not use --fix or --comment.',
    `Review exactly the change \`git diff ${range}\` (the chat's own base, not origin/HEAD or the default branch), and skip generated files: ${NOISE.join(', ')}.`,
    'Find files with the Glob, Grep and Read tools rather than shell commands (only read-only git commands are allowed).',
    `Also report acceptance criteria from this plan that the change does not meet or test. Plan: ${plan ? clip(plan, MAX_REVIEW_PLAN_CHARS) : '(no plan recorded)'}`,
    checks ? `Checks: \`${checks.command}\` ${checkStatus(checks)}.` : '',
    'Whatever output format the review asks for, end your reply with the findings converted to one line each: `[high|medium|low] path:line: problem; fix` (important = high, pre_existing = medium, nit = low; keep every finding). If there are none, end with exactly: No findings.'
  ]
    .filter(Boolean)
    .join(' ')
}

/** Section headings the plan stage asks for (Goal; Steps; Tests; Acceptance criteria), as headings, bold or list items. */
const PLAN_HEADING = /^\s*(?:#+\s*|\*\*|\d+[.)]\s*)?(goal|steps|tests|acceptance criteria)\b/gim

/**
 * The plan to review against: the latest succeeded plan-stage reply that reads
 * like a plan (two or more of its sections), so a later reply that is no plan
 * (e.g. "nothing was implemented") is skipped; else the latest succeeded reply.
 */
export function pickPlan(turns: Pick<RunRecord, 'protocolStage' | 'status' | 'resultText'>[]): string | null {
  const plans = turns.filter((t) => t.protocolStage === 'plan' && t.resultText?.trim())
  const ok = plans.filter((t) => t.status === 'succeeded')
  const sections = (t: string) => new Set([...t.matchAll(PLAN_HEADING)].map((m) => m[1].toLowerCase())).size
  const real = ok.filter((t) => sections(t.resultText!) >= 2)
  return (real.at(-1) ?? ok.at(-1) ?? plans.at(-1))?.resultText ?? null
}

/** The commits a chat's review covers: from its base branch (or the commit it started at) to HEAD. */
export async function reviewRange(wt: ChatWorktree, cwd: string): Promise<string> {
  return (await branchExists(cwd, wt.base)) ? `${wt.base}...HEAD` : `${wt.baseCommit}..HEAD`
}

function checkStatus(checks: ProtocolChecks): string {
  return checks.status === 'passed' ? 'passed' : checks.status === 'failed' ? `failed (exit code ${checks.exitCode})` : 'not run'
}

export const IMPLEMENT_PROMPT = 'The plan is approved. Implement it now, with the tests it lists.'

export function fixChecksPrompt(checks: ProtocolChecks): string {
  return [
    `Thinkerer ran \`${checks.command}\` after your last turn and it failed (exit code ${checks.exitCode ?? 'none'}). Last lines:`,
    '```',
    ...checks.tail,
    '```',
    'Fix the cause, not the test.'
  ].join('\n')
}

export function fixFindingsPrompt(findings: string): string {
  return [
    'A reviewer found these problems in your change. Fix the ones you agree with; for any you skip, say why in one line.',
    '',
    findingsToForward(findings)
  ].join('\n')
}

/** The reviewer's whole input: acceptance criteria, check result and the branch diff, nothing from the implementer's conversation. */
export async function reviewPrompt(wt: ChatWorktree, cwd: string, plan: string | null, checks: ProtocolChecks | null): Promise<string> {
  const base = await reviewRange(wt, cwd)
  const stat = (await git(cwd, ['diff', '--stat=120', base, '--', '.', ...NOISE_SPECS]).catch(() => '')).trim()
  const diff = await git(cwd, ['diff', '--no-color', '-U3', base, '--', '.', ...NOISE_SPECS]).catch(() => '')
  const lines = ['Review the change on this branch against the plan below.', '', '## Plan', plan ? clip(plan, MAX_PLAN_CHARS) : '(no plan recorded)', '']
  if (checks) lines.push('## Checks', `\`${checks.command}\`: ${checkStatus(checks)}`, '')
  lines.push('## Files changed', stat || '(no changes)', '')
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
    lines.push('## Diff', '```diff', diff.trimEnd(), '```')
  } else {
    lines.push(`The diff is too large to include (${Math.round(diff.length / 1000)}k characters). Open what you need with \`git diff ${base} -- <file>\`.`)
  }
  return lines.join('\n')
}

/** Counts the reviewer's finding lines; null when it didn't use the format (then the text is all we have). */
export function countFindings(text: string | null): number | null {
  if (!text) return null
  if (/^\s*No findings\.?\s*$/i.test(text.trim().split('\n').at(-1) ?? '') && !/\[(high|medium|low)\]/i.test(text)) return 0
  const n = text.split('\n').filter((l) => FINDING_LINE.test(l)).length
  return n || jsonFindings(text)
}

/** A finding line in the protocol's format: `[high|medium|low] path:line: …`, optionally as a list item. */
const FINDING_LINE = /^\s*(?:[-*\d.]+\s*)?`?\[(high|medium|low)\]/i

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
 * The note left when a protocol chat ships. Built only from what was recorded:
 * turns, the checks Thinkerer ran, the reviewer's replies, and the token counts
 * the provider CLI reported ("not reported" otherwise).
 */
export function protocolReport(chat: ChatRecord, turns: RunRecord[]): string[] {
  const of = (stage: string) => turns.filter((t) => (t.protocolStage ?? 'implement') === stage)
  const reviews = of('review')
  const implement = of('implement')
  const files = new Set(implement.flatMap((t) => (t.changes ?? []).map((c) => c.path)))
  const lines = [
    `Plan: ${of('plan').length} turn${of('plan').length === 1 ? '' : 's'}`,
    `Implementation: ${implement.length} turn${implement.length === 1 ? '' : 's'}, ${files.size} file${files.size === 1 ? '' : 's'} changed`
  ]
  const checks = chat.protocol?.checks
  lines.push(
    checks
      ? `Checks: \`${checks.command}\` ${checks.status === 'passed' ? 'passed' : checks.status === 'failed' ? `failed (exit code ${checks.exitCode})` : 'not run (command not approved)'}`
      : 'Checks: no check command set for this project'
  )
  if (!reviews.length) lines.push('Review: none')
  reviews.forEach((r, i) => {
    const n = countFindings(r.resultText)
    lines.push(`Review round ${i + 1}: ${n === null ? 'findings not in the expected format (see the review turn)' : n === 0 ? 'no findings' : `${n} finding${n === 1 ? '' : 's'}`}`)
  })
  const last = reviews.at(-1)?.resultText
  if (last && countFindings(last)) {
    const after = implement.some((t) => t.createdAt > reviews.at(-1)!.createdAt)
    lines.push(after ? 'Last findings (a fix turn ran after them):' : 'Last findings (not addressed before shipping):')
    lines.push(...last.split('\n').filter((l) => /\[(high|medium|low)\]/i.test(l)).slice(0, 20).map((l) => `  ${l.trim()}`))
  }
  lines.push('Tokens reported by the provider:')
  for (const stage of ['plan', 'implement', 'review']) {
    const t = of(stage)
    if (t.length) lines.push(`  ${stage}: ${tokens(t.map((x) => x.usage))}`)
  }
  lines.push('Run /cleanup when you are ready to remove the worktree.')
  return lines
}

function tokens(usage: (UsageObservation | null)[]): string {
  const known = usage.filter((u): u is UsageObservation => !!u && (u.inputTokens !== undefined || u.outputTokens !== undefined))
  if (!known.length) return 'not reported'
  const sum = (k: keyof Pick<UsageObservation, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>) => known.reduce((n, u) => n + (u[k] ?? 0), 0)
  const missing = usage.length - known.length
  return `${sum('inputTokens')} in, ${sum('outputTokens')} out, ${sum('cacheReadTokens')} cache read, ${sum('cacheCreationTokens')} cache write${missing ? ` (${missing} turn${missing === 1 ? '' : 's'} not reported)` : ''}`
}

/** Just the finding lines when the reviewer wrote them (they end a long review command's reply); else the reply's end, where the findings are. */
function findingsToForward(text: string): string {
  const lines = text.split('\n').filter((l) => FINDING_LINE.test(l))
  if (lines.length) return clip(lines.join('\n'), MAX_FINDINGS_CHARS)
  return text.length <= MAX_FINDINGS_CHARS ? text : `(start cut; last ${MAX_FINDINGS_CHARS} characters)\n${text.slice(-MAX_FINDINGS_CHARS)}`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (cut at ${max} characters)`
}

import type { ChatRecord, ChatWorktree, ProtocolChecks, RunRecord, UsageObservation } from '../shared/types'
import { git } from './worktrees'

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
    clip(findings, MAX_FINDINGS_CHARS)
  ].join('\n')
}

/**
 * What the reviewer looks at: from just before the first commit an implement
 * turn made, to HEAD. Not `base...HEAD`: once the base branch has this branch
 * merged, that diff is empty although the work is there. Chats whose turns
 * have no recorded commit fall back to the commit the worktree started from.
 * Null when the range has no changes, so no review is spent on nothing.
 */
export async function reviewRange(wt: ChatWorktree, cwd: string, turns: RunRecord[]): Promise<string | null> {
  const first = turns.find((t) => (t.protocolStage ?? 'implement') === 'implement' && t.commit)?.commit
  const range = first ? `${first}~1..HEAD` : `${wt.baseCommit}..HEAD`
  const files = (await git(cwd, ['diff', '--name-only', range]).catch(() => '')).trim()
  return files ? range : null
}

/** The reviewer's whole input: acceptance criteria, check result and the diff of the implement turns, nothing from the implementer's conversation. */
export async function reviewPrompt(cwd: string, range: string, plan: string | null, checks: ProtocolChecks | null): Promise<string> {
  const stat = (await git(cwd, ['diff', '--stat=120', range, '--', '.', ...NOISE_SPECS]).catch(() => '')).trim()
  const diff = await git(cwd, ['diff', '--no-color', '-U3', range, '--', '.', ...NOISE_SPECS]).catch(() => '')
  const lines = ['Review the change on this branch against the plan below.', '', '## Plan', plan ? clip(plan, MAX_PLAN_CHARS) : '(no plan recorded)', '']
  if (checks) lines.push('## Checks', `\`${checks.command}\`: ${checks.status === 'passed' ? 'passed' : checks.status === 'failed' ? `failed (exit code ${checks.exitCode})` : 'not run'}`, '')
  lines.push('## Files changed', stat || '(no changes)', '')
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
    lines.push('## Diff', '```diff', diff.trimEnd(), '```')
  } else {
    lines.push(`The diff is too large to include (${Math.round(diff.length / 1000)}k characters). Open what you need with \`git diff ${range} -- <file>\`.`)
  }
  return lines.join('\n')
}

/** Counts the reviewer's finding lines; null when it didn't use the format (then the text is all we have). */
export function countFindings(text: string | null): number | null {
  if (!text) return null
  if (/^\s*No findings\.?\s*$/i.test(text.trim().split('\n').at(-1) ?? '') && !/\[(high|medium|low)\]/i.test(text)) return 0
  const n = text.split('\n').filter((l) => /^\s*(?:[-*\d.]+\s*)?`?\[(high|medium|low)\]/i.test(l)).length
  return n || null
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

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (cut at ${max} characters)`
}

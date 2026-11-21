import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeLine } from '../engine/agents/claude'
import { AgentSupervisor } from '../engine/agents/supervisor'
import type { AgentAdapter, InvocationOptions } from '../engine/agents/types'
import { Approvals } from '../engine/approvals'
import { ProjectService } from '../engine/projects'
import { ProtocolService } from '../engine/protocol'
import { countFindings } from '../engine/protocolText'
import { checksPending } from '../shared/protocol'
import type { ChatProtocol, ChatRecord, ProtocolAction, RunSummary } from '../shared/types'

// The software protocol end to end with a stand-in agent, a real temp repo and
// real git: plan → implement (+ checks Thinkerer runs) → fresh-session review →
// fix → ship (merge + report).

const FIXTURE = join(__dirname, 'fixtures', 'stand-in-agent.mjs')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** How the stand-in answers review and implement turns (fixture modes). */
let reviewMode = 'readonly'
let implementMode = 'ok'

/** Records what each turn was started with; read-only turns write nothing (like a real plan or review). */
function recordingStandIn(calls: InvocationOptions[]): AgentAdapter {
  return {
    id: 'claude',
    label: 'Stand-in',
    policySummary: 'test',
    detect: async () => ({ id: 'claude', label: 'Stand-in', installed: true, executable: process.execPath, version: 'test', authenticated: true, adapterAvailable: true, detail: '', policy: 'test' }),
    buildInvocation: (opts) => {
      calls.push(opts)
      const review = opts.policy.appendSystemPrompt.includes('stage 3 of 4')
      return { command: opts.executable, args: [FIXTURE, review ? reviewMode : opts.mode === 'plan' ? 'readonly' : implementMode], stdin: opts.prompt, env: process.env }
    },
    createParser: () => ({ parseLine: parseClaudeLine })
  }
}

let tmp: string
let repo: string
let projects: ProjectService
let projectId: string
let approvals: Approvals
let sup: AgentSupervisor
let protocol: ProtocolService
let calls: InvocationOptions[]

async function setup(config: { checkCommand?: string; maxReviewRounds?: number; review?: { model?: string } } = {}) {
  await projects.updateConfig(projectId, { protocol: config })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'protocol config')
  if (config.checkCommand) await approvals.approve(projectId, 'check', config.checkCommand)
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-protocol-')))
  repo = join(tmp, 'repo')
  const appData = join(tmp, 'appdata')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  projects = new ProjectService(appData)
  projectId = (await projects.importFolder(repo)).id
  approvals = new Approvals(appData)
  calls = []
  reviewMode = 'readonly'
  implementMode = 'ok'
  sup =new AgentSupervisor(appData, projects, { adapters: [recordingStandIn(calls)], approvals })
  protocol = new ProtocolService({ supervisor: sup, projects, approvals })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function turnEnded(): Promise<RunSummary> {
  return new Promise((resolve) => {
    const on = (s: RunSummary) => {
      if (!s.endedAt) return
      sup.off('update', on)
      resolve(s)
    }
    sup.on('update', on)
  })
}

/** Resolves once the chat record satisfies `pred` (checks finish after the turn does). */
function chatWhen(chatId: string, pred: (c: ChatRecord) => boolean): Promise<ChatRecord> {
  return new Promise((resolve) => {
    const on = (c: ChatRecord) => {
      if (c.id !== chatId || !pred(c)) return
      sup.chats.off('update', on)
      resolve(c)
    }
    sup.chats.on('update', on)
    void sup.chats.get(chatId).then((c) => c && pred(c) && (sup.chats.off('update', on), resolve(c)))
  })
}

async function step(chatId: string, action: ProtocolAction): Promise<RunSummary> {
  const ended = turnEnded()
  await protocol.advance(projectId, chatId, action)
  return ended
}

const checksDone = (c: ChatRecord) => !!c.protocol?.checks && c.protocol.checks.status !== 'running'

describe('software protocol', () => {
  it('plans, implements with checks, reviews in a fresh session, fixes in the implementer session, and ships', async () => {
    const check = 'test -f made.txt && echo checks-ok'
    await setup({ checkCommand: check, review: { model: 'sonnet' } })

    // 1. The first message is the task, planned read-only.
    const ended = turnEnded()
    const plan = await protocol.begin(projectId, 'Add a file', 'claude')
    expect((await ended).status).toBe('succeeded')
    const chatId = plan.id
    expect((await sup.chats.get(chatId))!.protocol).toMatchObject({ stage: 'plan', round: 0 })
    expect(calls[0]).toMatchObject({ mode: 'plan', resumeSessionId: null })
    expect(calls[0].policy.appendSystemPrompt).toContain('stage 1 of 4 (plan)')
    await expect(protocol.advance(projectId, chatId, 'ship')).rejects.toThrow('Review the change before shipping it')

    // 2. Approve: an auto turn that continues the planning session; Thinkerer then runs the checks itself.
    const planTurn = (await sup.getChat(projectId, chatId))[0]
    const impl = await step(chatId, 'approve-plan')
    expect(impl.protocolStage).toBe('implement')
    expect(calls[1]).toMatchObject({ mode: 'auto', resumeSessionId: planTurn.sessionId })
    expect(calls[1].policy.appendSystemPrompt).toContain(`Thinkerer runs \`${check}\` itself`)
    let chat = await chatWhen(chatId, checksDone)
    expect(chat.protocol!.checks).toMatchObject({ status: 'passed', exitCode: 0, command: check, runId: impl.id })
    expect(chat.notes.at(-1)).toMatchObject({ kind: 'checks', ok: true, title: 'Checks passed' })
    expect(chat.notes.at(-1)!.lines).toContain('checks-ok')
    await expect(protocol.advance(projectId, chatId, 'approve-plan')).rejects.toThrow('already approved')

    // 3. Review: a fresh session, read-only, without sub-agents, on the review model; it gets the plan and the diff only.
    const review = await step(chatId, 'start-review')
    expect(review.protocolStage).toBe('review')
    expect(calls[2]).toMatchObject({ mode: 'plan', resumeSessionId: null })
    expect(calls[2].claude).toMatchObject({ model: 'sonnet' })
    expect(calls[2].claude!.tools).not.toContain('Task')
    expect(calls[2].prompt).toContain('## Plan')
    expect(calls[2].prompt).toContain('passed')
    expect(calls[2].prompt).toMatch(/## Diff[\s\S]*\+\+\+ b\/made\.txt/)
    expect(calls[2].policy.appendSystemPrompt).toContain('stage 3 of 4 (code review)')
    chat = (await sup.chats.get(chatId))!
    expect(chat.protocol).toMatchObject({ stage: 'review', round: 1 })

    // 4. Fix findings: back to the implementer's session (not the reviewer's), with only the findings.
    const fix = await step(chatId, 'fix-findings')
    expect(calls[3].resumeSessionId).toBe(impl.sessionId)
    expect(calls[3].resumeSessionId).not.toBe(review.sessionId)
    expect(calls[3].prompt).toContain('[high] made.txt:1: example finding')
    expect(fix.protocolStage).toBe('implement')
    await chatWhen(chatId, (c) => c.protocol?.checks?.runId === fix.id && checksDone(c))

    // 5. Ship: merged into main by Thinkerer, with a report built from what was recorded.
    chat = await protocol.advance(projectId, chatId, 'ship')
    expect(chat.state).toBe('merged')
    expect(chat.protocol!.stage).toBe('shipped')
    expect(readFileSync(join(repo, 'made.txt'), 'utf8')).toContain('A reviewer found these problems')
    const report = chat.notes.at(-1)!
    expect(report).toMatchObject({ kind: 'protocol', title: 'Shipped: protocol report' })
    expect(report.lines).toEqual(
      expect.arrayContaining([
        'Plan: 1 turn',
        'Implementation: 2 turns, 1 file changed',
        `Checks: \`${check}\` passed`,
        'Review round 1: 1 finding',
        'Last findings (a fix turn ran after them):',
        '  review: 7 in, 2 out, 0 cache read, 0 cache write',
        'Run /cleanup when you are ready to remove the worktree.'
      ])
    )
    expect(chat.notes.some((n) => n.kind === 'merge' && n.title === 'Merged into main')).toBe(true)
    expect(calls).toHaveLength(4) // shipping spent no agent turn
  })

  it('sends only the tail of failing checks back to the agent', async () => {
    const check = 'for i in $(seq 1 80); do echo line-$i; done; echo boom; exit 3'
    await setup({ checkCommand: check })
    const ended = turnEnded()
    const plan = await protocol.begin(projectId, 'Break it', 'claude')
    await ended
    await step(plan.id, 'approve-plan')
    const chat = await chatWhen(plan.id, checksDone)
    expect(chat.protocol!.checks).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(chat.protocol!.checks!.tail).toHaveLength(50)
    expect(chat.protocol!.checks!.tail.at(-1)).toBe('boom')

    await step(plan.id, 'fix-checks')
    const prompt = calls.at(-1)!.prompt
    expect(prompt).toContain('failed (exit code 3)')
    expect(prompt).toContain('boom')
    expect(prompt).not.toContain('line-1\n')
  })

  it('does not run a check command the user has not approved', async () => {
    await projects.updateConfig(projectId, { protocol: { checkCommand: 'echo unapproved' } })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'config')
    const ended = turnEnded()
    const plan = await protocol.begin(projectId, 'Task', 'claude')
    await ended
    await step(plan.id, 'approve-plan')
    const chat = await chatWhen(plan.id, checksDone)
    expect(chat.protocol!.checks).toMatchObject({ status: 'not-approved', tail: [] })
    expect(chat.notes.some((n) => n.kind === 'checks')).toBe(false)
  })

  it('caps review rounds at the project limit', async () => {
    await setup({ maxReviewRounds: 1 })
    const ended = turnEnded()
    const plan = await protocol.begin(projectId, 'Task', 'claude')
    await ended
    await step(plan.id, 'approve-plan')
    await step(plan.id, 'start-review')
    await step(plan.id, 'fix-findings')
    await expect(protocol.advance(projectId, plan.id, 'start-review')).rejects.toThrow('already had 1 review round')
    expect((await sup.chats.get(plan.id))!.protocol!.round).toBe(1)
  })

  it('keeps replies in the plan read-only, and treats later replies as implementation work', async () => {
    await setup()
    let ended = turnEnded()
    const plan = await protocol.begin(projectId, 'Task', 'claude')
    await ended
    ended = turnEnded()
    await protocol.reply((await sup.chats.get(plan.id))!, 'Also cover errors')
    expect((await ended).protocolStage).toBe('plan')
    expect(calls.at(-1)!.mode).toBe('plan')
    await step(plan.id, 'approve-plan')
    ended = turnEnded()
    await protocol.reply((await sup.chats.get(plan.id))!, 'Rename it')
    expect((await ended).protocolStage).toBe('implement')
    expect(calls.at(-1)!.mode).toBe('auto')
  })
})

describe('protocol guards', () => {
  async function planned(): Promise<string> {
    const ended = turnEnded()
    const plan = await protocol.begin(projectId, 'Task', 'claude')
    await ended
    return plan.id
  }

  it('holds replies and steps until the checks have run, and clears them when new work starts', async () => {
    await setup({ checkCommand: 'sleep 1 && echo checks-ok' })
    const chatId = await planned()
    const impl = await step(chatId, 'approve-plan')
    // The turn is over but its checks aren't: nothing may start editing the files under test.
    await expect(protocol.reply((await sup.chats.get(chatId))!, 'More')).rejects.toThrow('checks are still running')
    await expect(protocol.advance(projectId, chatId, 'start-review')).rejects.toThrow('checks are still running')
    const chat = await chatWhen(chatId, checksDone)
    expect(chat.protocol!.checks).toMatchObject({ status: 'passed', runId: impl.id })

    const ended = turnEnded()
    await protocol.reply(chat, 'Rename it')
    expect((await sup.chats.get(chatId))!.protocol!.checks?.runId).not.toBe(impl.id)
    const next = await ended
    const after = await chatWhen(chatId, (c) => c.protocol?.checks?.runId === next.id && checksDone(c))
    expect(after.protocol!.checks!.status).toBe('passed')
  })

  it('never reports earlier checks for work that came after them', async () => {
    await setup({ checkCommand: 'echo checks-ok' })
    const chatId = await planned()
    await step(chatId, 'approve-plan')
    await chatWhen(chatId, checksDone)
    await step(chatId, 'start-review')
    implementMode = 'fail'
    expect((await step(chatId, 'fix-findings')).status).toBe('failed')
    expect((await sup.chats.get(chatId))!.protocol!.checks).toBeNull()
    const shipped = await protocol.advance(projectId, chatId, 'ship')
    const report = shipped.notes.at(-1)!.lines
    expect(report).toContain('Checks: `echo checks-ok` not run on the latest changes')
    expect(report.join('\n')).not.toContain('passed')
  })

  it('retries a review that did not finish in the same round, even at the limit', async () => {
    await setup({ maxReviewRounds: 1 })
    const chatId = await planned()
    await step(chatId, 'approve-plan')
    reviewMode = 'fail'
    expect((await step(chatId, 'start-review')).status).toBe('failed')
    expect((await sup.chats.get(chatId))!.protocol).toMatchObject({ stage: 'review', round: 1 })
    reviewMode = 'readonly'
    expect((await step(chatId, 'start-review')).status).toBe('succeeded')
    expect((await sup.chats.get(chatId))!.protocol).toMatchObject({ stage: 'review', round: 1 })
    await expect(protocol.advance(projectId, chatId, 'start-review')).rejects.toThrow('nothing new to review')
  })

  it('treats "No findings." on the last line as a clean review', async () => {
    await setup()
    const chatId = await planned()
    await step(chatId, 'approve-plan')
    reviewMode = 'review-clean'
    await step(chatId, 'start-review')
    await expect(protocol.advance(projectId, chatId, 'fix-findings')).rejects.toThrow('nothing to fix')
  })
})

describe('protocol config and findings', () => {
  it('detects the check command from package.json and validates patches', async () => {
    const other = join(tmp, 'other')
    execFileSync('git', ['init', '-q', '-b', 'main', other])
    writeFileSync(join(other, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest run' } }))
    const p = await projects.importFolder(other)
    expect(p.config!.protocol).toEqual({ checkCommand: 'npm run typecheck && npm test', maxReviewRounds: 2, review: { model: '', effort: '' } })
    await expect(projects.updateConfig(p.id, { protocol: { maxReviewRounds: 0 } })).rejects.toThrow('Review rounds')
    await expect(projects.updateConfig(p.id, { protocol: { review: { model: 'bad model!' } } })).rejects.toThrow('Review model')
  })

  it('counts findings only in the expected format', () => {
    expect(countFindings('No findings.')).toBe(0)
    expect(countFindings('Checked the diff.\nNo findings.')).toBe(0)
    expect(countFindings('- [high] a.ts:1: x; y\n- [low] b.ts:2: z; w')).toBe(2)
    expect(countFindings('Looks fine to me')).toBeNull()
    expect(countFindings(null)).toBeNull()
  })

  it('knows when a chat still owes its checks (what holds back the UI and queued messages)', () => {
    const turn = { id: 'r2', status: 'succeeded', protocolStage: 'implement' } as RunSummary
    const at = (checks: ChatProtocol['checks'], stage: ChatProtocol['stage'] = 'implement'): ChatProtocol => ({ id: 'software', stage, round: 0, checks })
    const checks = (runId: string, status: 'running' | 'passed'): ChatProtocol['checks'] => ({ runId, command: 'npm test', status, exitCode: null, tail: [], at: '' })
    expect(checksPending(at(null), turn, 'npm test')).toBe(true)
    expect(checksPending(at(checks('r1', 'passed')), turn, 'npm test')).toBe(true)
    expect(checksPending(at(checks('r2', 'running')), turn, 'npm test')).toBe(true)
    expect(checksPending(at(checks('r2', 'passed')), turn, 'npm test')).toBe(false)
    expect(checksPending(at(null), turn, '')).toBe(false)
    expect(checksPending(at(null), { ...turn, status: 'failed' }, 'npm test')).toBe(false)
    expect(checksPending(at(null, 'review'), turn, 'npm test')).toBe(false)
  })
})

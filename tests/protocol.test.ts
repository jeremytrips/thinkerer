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
import type { ChatRecord, Effort, ProtocolAction, RunSummary } from '../shared/types'

// The software protocol end to end with a stand-in agent, a real temp repo and
// real git: plan → implement (+ checks Thinkerer runs) → fresh-session review →
// fix → ship (merge + report).

const FIXTURE = join(__dirname, 'fixtures', 'stand-in-agent.mjs')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Records what each turn was started with; read-only turns write nothing (like a real plan or review). */
function recordingStandIn(calls: InvocationOptions[], id: 'claude' | 'codex' = 'claude'): AgentAdapter {
  return {
    id,
    label: 'Stand-in',
    policySummary: 'test',
    detect: async () => ({ id, label: 'Stand-in', installed: true, executable: process.execPath, version: 'test', authenticated: true, adapterAvailable: true, detail: '', policy: 'test' }),
    buildInvocation: (opts) => {
      calls.push(opts)
      return { command: opts.executable, args: [FIXTURE, opts.mode === 'plan' ? 'readonly' : 'ok'], stdin: opts.prompt, env: process.env }
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

async function setup(config: { checkCommand?: string; maxReviewRounds?: number; review?: { model?: string; effort?: Effort } } = {}) {
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
  sup = new AgentSupervisor(appData, projects, { adapters: [recordingStandIn(calls)], approvals })
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
    await setup({ checkCommand: check, review: { model: 'sonnet', effort: 'medium' } })

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

    // 3. Review: Claude Code's /code-review on the chat's branch, in a fresh read-only session on the review model.
    const review = await step(chatId, 'start-review')
    expect(review.protocolStage).toBe('review')
    const branch = (await sup.chats.get(chatId))!.worktree!.branch
    expect(calls[2]).toMatchObject({ mode: 'plan', resumeSessionId: null, prompt: `/code-review medium ${branch}` })
    expect(review.prompt).toBe(`/code-review medium ${branch}`)
    expect(calls[2].prompt).not.toContain('## Plan')
    expect(calls[2].claude).toMatchObject({ model: 'sonnet', effort: 'medium' })
    expect(calls[2].claude!.tools).toContain('Skill')
    expect(calls[2].policy.appendSystemPrompt).toContain('stage 3 of 4 (code review)')
    expect(calls[2].policy.appendSystemPrompt).toContain('[high|medium|low] path:line')
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

  it('keeps the review prompt with the plan and diff for Codex chats, which have no skills', async () => {
    sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [recordingStandIn(calls, 'codex')], approvals })
    protocol = new ProtocolService({ supervisor: sup, projects, approvals })
    await setup()
    const ended = turnEnded()
    const plan = await protocol.begin(projectId, 'Add a file', 'codex')
    await ended
    await step(plan.id, 'approve-plan')
    await step(plan.id, 'start-review')
    const prompt = calls.at(-1)!.prompt
    expect(prompt).not.toContain('/code-review')
    expect(prompt).toContain('## Plan')
    expect(prompt).toMatch(/## Diff[\s\S]*\+\+\+ b\/made\.txt/)
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
    expect(countFindings('- [high] a.ts:1: x; y\n- [low] b.ts:2: z; w')).toBe(2)
    expect(countFindings('Looks fine to me')).toBeNull()
    expect(countFindings(null)).toBeNull()
  })
})

import { looksLikeApproval } from '../shared/protocol'
import type { ChatProtocol, ChatRecord, ProtocolAction, ProtocolChecks, ProviderChoice, RunSummary } from '../shared/types'
import type { AgentSupervisor, StartOptions } from './agents/supervisor'
import type { Approvals } from './approvals'
import { runChatCommand } from './chatCommands'
import type { ProjectService } from './projects'
import {
  CHECK_TAIL_LINES,
  IMPLEMENT_PROMPT,
  PLAN_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS,
  fixChecksPrompt,
  fixFindingsPrompt,
  implementInstructions,
  protocolReport,
  reviewPrompt,
  reviewRange
} from './protocolText'
import { runHook, worktreeEnv } from './worktrees'

// The software protocol: Plan → Implement + tests → Review → Ship. Thinkerer
// moves a chat through it only when the user asks (advance), and does the
// steps that need no agent itself: running the checks, merging, the report.
// That keeps both tokens and trust where they belong: no agent turn is spent
// on running a test suite or on claiming it passed.

export const PROTOCOL_ACTIONS: ProtocolAction[] = ['approve-plan', 'fix-checks', 'start-review', 'fix-findings', 'ship']
const NOTE_LINES = 200

type BaseStart = Pick<StartOptions, 'taskId' | 'attachments'>

export interface ProtocolDeps {
  supervisor: AgentSupervisor
  projects: ProjectService
  approvals: Approvals
  /** Stops the dev server in a chat's worktree (used by the merge's cleanup checks). */
  stopDevServer?: (projectId: string, chatId: string) => void
}

export class ProtocolService {
  /** Chats whose checks are running right now. */
  private readonly checking = new Set<string>()
  private readonly handled = new Set<string>()

  constructor(private readonly deps: ProtocolDeps) {
    deps.supervisor.on('update', (s) => {
      if (!s.endedAt || s.protocolStage !== 'implement' || s.status !== 'succeeded' || this.handled.has(s.id)) return
      this.handled.add(s.id)
      void this.runChecks(s).catch(async (err) => {
        // Never leave the chat waiting on checks that silently didn't run.
        const chatId = s.chatId ?? s.id
        this.checking.delete(chatId)
        const next = await this.chats.addNote(chatId, { kind: 'checks', ok: false, title: 'Checks could not run', lines: [(err as Error).message] }).catch(() => null)
        if (next) this.chats.emit('update', next)
      })
    })
  }

  private get chats() {
    return this.deps.supervisor.chats
  }

  isChecking(chatId: string): boolean {
    return this.checking.has(chatId)
  }

  /** A new protocol chat: its first message is the task, and runs as the read-only plan. */
  begin(projectId: string, prompt: string, provider: ProviderChoice, opts: BaseStart = {}): Promise<RunSummary> {
    const protocol: ChatProtocol = { id: 'software', stage: 'plan', round: 0, checks: null }
    return this.deps.supervisor.start(projectId, prompt, provider, { ...opts, mode: 'plan', protocolStage: 'plan', instructions: PLAN_INSTRUCTIONS, protocol })
  }

  /**
   * A message the user typed in a protocol chat. While planning it refines the
   * plan (still read-only), unless it plainly approves it ("ok implement"):
   * that is the user's go-ahead, so it must not run read-only once more.
   * Afterwards it is more work for the implementer.
   */
  async reply(chat: ChatRecord, prompt: string, opts: BaseStart = {}): Promise<RunSummary> {
    const p = chat.protocol!
    if (p.stage === 'plan' && looksLikeApproval(prompt)) {
      return this.implement(chat, `${IMPLEMENT_PROMPT}\n\nThe user replied: ${prompt.trim()}`, opts)
    }
    if (p.stage === 'plan') {
      return this.deps.supervisor.start(chat.projectId, prompt, 'auto', { ...opts, chatId: chat.id, mode: 'plan', protocolStage: 'plan', instructions: PLAN_INSTRUCTIONS })
    }
    return this.implement(chat, prompt, opts)
  }

  /** Runs one step the user picked; rejects it when the chat isn't at a stage where it makes sense. */
  async advance(projectId: string, chatId: string, action: ProtocolAction): Promise<ChatRecord> {
    if (!PROTOCOL_ACTIONS.includes(action)) throw new Error('Unknown protocol step')
    const chat = await this.chats.require(projectId, chatId)
    const p = chat.protocol
    if (!p) throw new Error('This chat does not follow the software protocol')
    if (chat.worktreeRemoved) throw new Error('This chat is finished')
    if (this.deps.supervisor.isChatLive(chatId)) throw new Error('This chat is still working; wait for it to finish or stop it first')
    if (this.checking.has(chatId)) throw new Error('The checks are still running; wait for them to finish')
    const project = await this.deps.projects.get(projectId)
    const max = project.config!.protocol.maxReviewRounds
    const latest = async (stage: 'plan' | 'review') => (await this.deps.supervisor.getChat(projectId, chatId)).filter((t) => t.protocolStage === stage).at(-1)

    switch (action) {
      case 'approve-plan':
        if (p.stage !== 'plan') throw new Error('The plan was already approved')
        await this.implement(chat, IMPLEMENT_PROMPT)
        break
      case 'fix-checks':
        if (p.stage !== 'implement' || p.checks?.status !== 'failed') throw new Error('There are no failed checks to fix')
        await this.implement(chat, fixChecksPrompt(p.checks))
        break
      case 'start-review': {
        // A review that didn't finish can be run again; otherwise only new work gets reviewed.
        const retry = p.stage === 'review' && (await latest('review'))?.status !== 'succeeded'
        if (p.stage !== 'implement' && !retry) throw new Error(p.stage === 'plan' ? 'Approve the plan first' : 'There is nothing new to review')
        if (p.round >= max) throw new Error(`This chat already had ${max} review round${max === 1 ? '' : 's'} (the project's limit). Ship it, or keep working by sending messages.`)
        if (!chat.worktree) throw new Error('Reviews need the chat to have its own worktree and branch')
        const turns = await this.deps.supervisor.getChat(projectId, chatId)
        // Diff what the implement turns committed, not the branch against its base: the base may already
        // have this branch merged (e.g. an early /merge), which leaves a branch diff with nothing in it.
        const range = await reviewRange(chat.worktree, chat.worktree.path, turns)
        if (!range) throw new Error('Nothing to review: the implement turns made no changes on this branch. Send a message to keep working, or check the plan.')
        const plan = turns.filter((t) => t.protocolStage === 'plan').at(-1)?.resultText ?? null
        const prompt = await reviewPrompt(chat.worktree.path, range, plan, p.checks)
        const { protocol: { review }, agent } = project.config!
        await this.startStage(chat, { stage: 'review', round: p.round + 1 }, prompt, {
          mode: 'plan',
          protocolStage: 'review',
          freshSession: true,
          instructions: REVIEW_INSTRUCTIONS,
          // A reviewer reads one diff; sub-agents would multiply its tokens for little gain.
          claude: { model: review.model, effort: review.effort, tools: agent.claude.tools.filter((t) => t !== 'Task') }
        })
        break
      }
      case 'fix-findings': {
        if (p.stage !== 'review') throw new Error('There is no review to act on')
        const findings = (await latest('review'))?.resultText
        if (!findings?.trim()) throw new Error('The review reported nothing to fix')
        await this.implement(chat, fixFindingsPrompt(findings))
        break
      }
      case 'ship': {
        if (!(p.stage === 'review' || (p.stage === 'implement' && p.round > 0))) throw new Error('Review the change before shipping it')
        return this.ship(project.id, chat)
      }
    }
    return (await this.chats.get(chatId))!
  }

  private implement(chat: ChatRecord, prompt: string, opts: BaseStart = {}): Promise<RunSummary> {
    return this.deps.projects.get(chat.projectId).then((project) =>
      this.startStage(chat, { stage: 'implement' }, prompt, {
        ...opts,
        mode: 'auto',
        protocolStage: 'implement',
        instructions: implementInstructions(project.config!.protocol.checkCommand.trim())
      })
    )
  }

  /** Moves the chat to the stage first (so the UI follows at once), and back if the turn can't start. */
  private async startStage(chat: ChatRecord, next: Partial<ChatProtocol>, prompt: string, opts: StartOptions): Promise<RunSummary> {
    const before = chat.protocol!
    await this.save(chat.id, (p) => Object.assign(p, next))
    try {
      return await this.deps.supervisor.start(chat.projectId, prompt, 'auto', { ...opts, chatId: chat.id })
    } catch (err) {
      await this.save(chat.id, (p) => Object.assign(p, { stage: before.stage, round: before.round }))
      throw err
    }
  }

  /** Merges with the ordinary /merge (same checks and messages), then files the report. */
  private async ship(projectId: string, chat: ChatRecord): Promise<ChatRecord> {
    const project = await this.deps.projects.get(projectId)
    const merged = await runChatCommand('merge', {
      project,
      chat,
      chats: this.chats,
      approvals: this.deps.approvals,
      fromProtocol: true,
      live: this.deps.supervisor.isChatLive(chat.id),
      stopDevServer: () => this.deps.stopDevServer?.(projectId, chat.id)
    })
    if (merged.notes.at(-1)?.ok !== true || merged.state !== 'merged') return merged
    await this.save(chat.id, (p) => (p.stage = 'shipped'))
    const turns = await this.deps.supervisor.getChat(projectId, chat.id)
    const latest = (await this.chats.get(chat.id))!
    const next = await this.chats.addNote(chat.id, { kind: 'protocol', ok: true, title: 'Shipped: protocol report', lines: protocolReport(latest, turns) })
    this.chats.emit('update', next)
    return next
  }

  /** Thinkerer runs the project's checks itself after an implement turn: zero agent tokens, and a result nobody has to take on trust. */
  private async runChecks(s: RunSummary): Promise<void> {
    const chatId = s.chatId ?? s.id
    const chat = await this.chats.get(chatId)
    if (!chat?.protocol || chat.protocol.stage !== 'implement' || chat.worktreeRemoved) return
    const project = await this.deps.projects.get(s.projectId)
    const command = project.config?.protocol.checkCommand.trim()
    if (!command) return
    const base: Omit<ProtocolChecks, 'status' | 'exitCode' | 'tail'> = { runId: s.id, command, at: new Date().toISOString() }
    if (!(await this.deps.approvals.isApproved(project.id, 'check', command))) {
      await this.save(chatId, (p) => (p.checks = { ...base, status: 'not-approved', exitCode: null, tail: [] }))
      return
    }
    this.checking.add(chatId)
    try {
      await this.save(chatId, (p) => (p.checks = { ...base, status: 'running', exitCode: null, tail: [] }))
      const lines: string[] = []
      const res = await runHook(command, chat.worktree?.path ?? project.path, worktreeEnv(project, chat), (l) => lines.push(l))
      const ok = res.code === 0 && !res.timedOut
      const tail = lines.filter((l) => l.trim()).slice(-CHECK_TAIL_LINES)
      await this.chats.addNote(chatId, {
        kind: 'checks',
        ok,
        title: ok ? 'Checks passed' : `Checks failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`})`,
        lines: [`$ ${command}`, ...lines.slice(-NOTE_LINES)]
      })
      await this.save(chatId, (p) => (p.checks = { ...base, status: ok ? 'passed' : 'failed', exitCode: res.code, tail }))
    } finally {
      this.checking.delete(chatId)
    }
  }

  private async save(chatId: string, fn: (p: ChatProtocol) => void): Promise<ChatRecord> {
    const next = await this.chats.update(chatId, (c) => c.protocol && fn(c.protocol))
    this.chats.emit('update', next)
    return next
  }
}

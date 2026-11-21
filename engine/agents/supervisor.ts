import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project, ProviderChoice, ProviderId, ProviderStatus, RunEvent, RunMode, RunRecord, RunSummary } from '../../shared/types'
import { Approvals } from '../approvals'
import { ATTACHMENT_ID, attachmentPath, removeAttachment } from '../attachments'
import { ChatStore, chatTitle, newChat } from '../chats'
import { createCheckpoint, diffSummary, recordAfter } from '../checkpoints'
import { responds } from '../devserver'
import { gitStatus } from '../git'
import type { ProjectService } from '../projects'
import { commitAll, currentBranch, headCommit } from '../worktrees'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { loadProjectInstructions } from './instructions'
import { DEFAULT_POLICY, DEFAULT_PREFERENCE, MAX_PARALLEL_RUNS } from './policy'
import { killTree, wireChild } from './process'
import { attachmentNote, buildInstructions, mergeClaude } from './prompt'
import { missingAdapter, rateLimitUntil, selectProvider } from './providerSelect'
import { newRunRecord, summarize, workingTurns, type ActiveRun, type StartOptions, type SupervisorEvents, type SupervisorOptions } from './runState'
import { RUN_ID, RunStore } from './runStore'
import { blockedCommand, type AgentAdapter, type RunPolicy } from './types'
import { chatDevices, prepareWorkspace, previewReady, resolveMcp, stageAttachments } from './workspace'

// Public surface of this module; the pieces live in the files above.
export { DEFAULT_POLICY, DEFAULT_PREFERENCE, MAX_PARALLEL_RUNS } from './policy'
export { attachmentNote } from './prompt'
export type { StartOptions, SupervisorEvents, SupervisorOptions } from './runState'

const MAX_EVENTS = 5000
const KILL_GRACE_MS = 3000

/**
 * Owns provider CLI processes. A run is one turn of a chat; a follow-up turn
 * resumes the provider session of the chat's latest turn, so the agent keeps the
 * conversation, and still gets its own checkpoint. Each chat works in its own Git
 * worktree and branch (set up by the project's setup hook, with its own ports),
 * and Thinkerer commits every turn's changes there. Chats that work in the
 * project folder (older chats, or a repo with no commits) can overlap; such runs
 * are recorded in `concurrentRunIds`, because their checkpoints and diffs can
 * then include each other's edits. Every run is recorded to <appData>/runs/<id>.json.
 */
export class AgentSupervisor extends EventEmitter<SupervisorEvents> {
  private readonly store: RunStore
  private readonly active = new Map<string, ActiveRun>() // keyed by runId
  private readonly starting = new Map<string, number>() // projectId → starts in flight
  private readonly startingChats = new Set<string>() // chatId → follow-up start in flight
  private readonly cooldownUntil = new Map<ProviderId, number>()
  private readonly adapters: Partial<Record<ProviderId, AgentAdapter>> = {}
  private readonly policy: RunPolicy
  private readonly worktreesDir: string
  private readonly approvals: Approvals
  readonly chats: ChatStore

  constructor(
    appDataDir: string,
    private readonly projects: ProjectService,
    private readonly opts: SupervisorOptions = {}
  ) {
    super()
    this.store = new RunStore(join(appDataDir, 'runs'))
    this.worktreesDir = join(appDataDir, 'worktrees')
    this.chats = opts.chats ?? new ChatStore(appDataDir)
    this.approvals = opts.approvals ?? new Approvals(appDataDir)
    this.policy = opts.policy ?? DEFAULT_POLICY
    for (const a of opts.adapters ?? [claudeAdapter, codexAdapter]) this.adapters[a.id] = a
  }

  async providers(): Promise<ProviderStatus[]> {
    return Promise.all(DEFAULT_PREFERENCE.map((id) => this.adapters[id]?.detect() ?? Promise.resolve(missingAdapter(id))))
  }

  /**
   * Validates, checkpoints and starts a run; resolves once the child process has
   * been spawned (or the run failed before that).
   */
  async start(projectId: string, prompt: string, requested: ProviderChoice, opts: StartOptions = {}): Promise<RunSummary> {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt is empty')
    if (prompt.length > 100_000) throw new Error('Prompt is too long')
    const mode: RunMode = opts.mode ?? 'auto'
    if (mode !== 'auto' && mode !== 'plan') throw new Error('Invalid mode')
    if (opts.attachments?.some((a) => !ATTACHMENT_ID.test(a.id))) throw new Error('Invalid attachment')
    const chatId = opts.chatId ?? null
    if (chatId !== null && !RUN_ID.test(chatId)) throw new Error('Invalid chat')
    if (chatId && this.startingChats.has(chatId)) throw new Error('This chat is already sending a message')
    const inFlight = this.starting.get(projectId) ?? 0
    if (this.activeRuns(projectId).length + inFlight >= MAX_PARALLEL_RUNS) {
      throw new Error(`This project already has ${MAX_PARALLEL_RUNS} agent runs in progress; stop one or wait for it to finish`)
    }
    this.starting.set(projectId, inFlight + 1)
    if (chatId) this.startingChats.add(chatId)
    let run: ActiveRun
    try {
      const project = await this.projects.get(projectId)
      if (project.status !== 'ok') throw new Error('Project folder is missing')
      const gitBefore = await gitStatus(project.path)
      if (!gitBefore) {
        throw new Error('This project is not a Git repository. Initialize Git so Thinkerer can checkpoint the folder before an agent edits it.')
      }
      const stored = chatId ? await this.chats.get(chatId) : null
      if (stored?.worktreeRemoved) throw new Error('This chat is finished and its worktree was removed; start a new chat')
      const chat = chatId ? await this.continuation(projectId, chatId) : null
      // A worktree needs a branch with a commit to start from.
      const wantsWorktree = chatId ? !!stored?.worktree || stored?.state === 'setting-up' : !!(await currentBranch(project.path)) && !!(await headCommit(project.path))
      const selected = selectProvider(await this.providers(), chat ? chat.provider : requested, this.cooldownUntil)
      const { provider, status } = selected
      const blocked = blockedCommand(this.adapters[provider]!, prompt)
      if (blocked) throw new Error(`/${blocked} isn't available in Thinkerer chats; it would disconnect this chat from its session. Start a new chat instead.`)
      const rationale = chat ? `Continuing this chat with ${this.adapters[provider]!.label}` : selected.rationale
      // Only runs in the same folder can see each other's edits.
      const others = wantsWorktree ? [] : this.activeRuns(projectId).filter((r) => !r.cwd || r.cwd === project.path)
      const id = randomUUID()
      const record = newRunRecord({
        id,
        projectId,
        projectPath: project.path,
        chatId: chatId ?? id,
        prompt,
        mode,
        protocolStage: opts.protocolStage,
        taskId: chat ? chat.taskId : (opts.taskId ?? null),
        attachments: opts.attachments ?? [],
        provider,
        selection: { requested, rationale },
        gitBefore,
        concurrentRunIds: others.map((r) => r.id)
      })
      const resumeSessionId = opts.freshSession ? null : (chat?.sessionId ?? null)
      run = { record, child: null, cancelRequested: false, killTimer: null, resumeSessionId, wantsWorktree, instructions: opts.instructions ?? '', claude: opts.claude ?? {} }
      if (!chatId) this.chats.emit('update', await this.chats.create({ ...newChat(id, projectId, chatTitle(prompt)), protocol: opts.protocol ?? null }))
      for (const other of others) {
        other.concurrentRunIds = [...(other.concurrentRunIds ?? []), record.id]
        this.emitUpdate(other)
      }
      this.active.set(record.id, run)
      this.addEvent(run, { kind: 'status', text: `Provider: ${this.adapters[provider]!.label}` })
      if (chat && opts.freshSession) {
        this.addEvent(run, { kind: 'status', text: 'Fresh session: the agent starts without the earlier conversation' })
      } else if (chat) {
        this.addEvent(run, {
          kind: 'status',
          text: chat.sessionId
            ? 'Continuing the conversation from the previous message'
            : 'The previous message has no session to resume, so the agent starts this one without the earlier conversation',
          meta: chat.sessionId ? undefined : { notice: true }
        })
      }
      await this.store.persist(record)
      this.emitUpdate(record)
      void this.launch(run, project, status)
    } finally {
      const left = (this.starting.get(projectId) ?? 1) - 1
      if (left > 0) this.starting.set(projectId, left)
      else this.starting.delete(projectId)
      if (chatId) this.startingChats.delete(chatId)
    }
    return summarize(run.record)
  }

  private async launch(run: ActiveRun, project: Project, status: ProviderStatus): Promise<void> {
    const record = run.record
    const adapter = this.adapters[record.provider]!
    try {
      if (record.taskId) this.opts.board?.runStarted(project.path, record.taskId, record.chatId ?? record.id, record.id)
      const ws = await prepareWorkspace(this.workspaceContext(), run, project)
      if (run.cancelRequested) return void (await this.finish(run, 'cancelled', null, null))
      record.cwd = ws.cwd
      if (ws.cwd !== project.path) record.gitBefore = await gitStatus(ws.cwd)
      await stageAttachments(record, this.store.inputsDir(record.id), ws.cwd)
      // Recovery point first: nothing the agent does can be unrecoverable.
      record.checkpoint = await createCheckpoint(ws.cwd, record.id, `Thinkerer: before run — ${record.prompt.slice(0, 72)}`)
      const dirty = record.gitBefore?.entries.length ?? 0
      this.addEvent(run, {
        kind: 'status',
        text: `Checkpoint saved${dirty ? ` (includes ${dirty} uncommitted change${dirty === 1 ? '' : 's'} already in the folder)` : ''}`
      })
      if (run.cancelRequested) return void (await this.finish(run, 'cancelled', null, null))

      // Devices are only handed to the mobile MCP server, so without MCP there is nothing to scope.
      const devices = await chatDevices(this.opts.mcp ? this.opts.devices : undefined, project, ws)
      for (const problem of devices?.problems ?? []) this.addEvent(run, { kind: 'status', text: problem })
      const { servers, secretEnv } = await resolveMcp(this.opts.mcp, project, run, ws, this.artifactsDir(record.id), devices?.ids)
      record.mcpServers = servers.map((s) => s.id)
      this.addEvent(run, { kind: 'status', text: `MCP tools: ${record.mcpServers.join(', ') || 'none'}` })
      // Read-only turns (plan, review) do no browser check worth starting a server and waiting 30 s for.
      const previewUp =
        servers.some((s) => s.id === 'playwright') && ws.previewUrl
          ? record.mode === 'plan'
            ? await responds(ws.previewUrl)
            : await previewReady(this.workspaceContext(), this.opts.devServers, run, project, ws, ws.previewUrl)
          : true
      if (record.mode === 'plan') this.addEvent(run, { kind: 'status', text: 'Plan mode: this message runs read-only; reply to carry the plan out' })
      const instr = await loadProjectInstructions(ws.cwd)
      record.instructionFiles = instr.files
      this.addEvent(run, { kind: 'status', text: `Instructions: ${instr.files.join(', ') || 'none'}` })

      const inv = adapter.buildInvocation({
        executable: status.executable!,
        cwd: ws.cwd,
        prompt: record.prompt + attachmentNote(record.attachments ?? []),
        resumeSessionId: run.resumeSessionId,
        policy: { ...this.policy, appendSystemPrompt: buildInstructions(this.policy.appendSystemPrompt, servers, ws, record.mode ?? 'auto', devices?.ids, run.instructions, instr.text, previewUp) },
        mcp: servers,
        secretEnv,
        mode: record.mode ?? 'auto',
        claude: mergeClaude(project.config!.agent.claude, run.claude)
      })
      if (run.cancelRequested) return void (await this.finish(run, 'cancelled', null, null))
      const child = spawn(inv.command, inv.args, {
        cwd: ws.cwd,
        env: { ...inv.env, ...ws.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so cancel can take down the whole tree.
        detached: process.platform !== 'win32'
      })
      run.child = child
      wireChild(run, adapter, {
        addEvent: (r, e) => this.addEvent(r, e),
        emitUpdate: (r) => this.emitUpdate(r),
        refreshArtifacts: (r) => this.refreshArtifacts(r),
        noteRateLimit: (usage) => this.cooldownUntil.set(adapter.id, rateLimitUntil(usage)),
        finish: (r, st, code, error) => this.finish(r, st, code, error)
      })
      child.stdin!.on('error', () => {}) // child may exit before reading stdin
      child.stdin!.end(inv.stdin)
      record.status = 'running'
      record.startedAt = new Date().toISOString()
      this.addEvent(run, { kind: 'status', text: `Started in ${ws.cwd}` })
      this.emitUpdate(record)
    } catch (err) {
      await this.finish(run, 'failed', null, (err as Error).message)
    }
  }

  private workspaceContext() {
    return { chats: this.chats, approvals: this.approvals, worktreesDir: this.worktreesDir, addEvent: this.addEvent.bind(this), emitUpdate: this.emitUpdate.bind(this) }
  }

  artifactsDir(runId: string): string {
    return this.store.artifactsDir(runId)
  }

  /** Image artifact as a data: URL for the renderer (no file paths cross IPC). */
  artifactDataUrl(runId: string, name: string): Promise<string> {
    return this.store.artifactDataUrl(runId, name)
  }

  /** A screenshot the user attached to the run's prompt, as a data: URL. */
  attachmentDataUrl(runId: string, id: string): Promise<string> {
    return this.store.attachmentDataUrl(runId, id)
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId)
    if (!run || run.cancelRequested) return !!run
    run.cancelRequested = true
    this.addEvent(run, { kind: 'status', text: 'Cancellation requested — stopping agent process' })
    killTree(run.child, 'SIGTERM')
    run.killTimer = setTimeout(() => killTree(run.child, 'SIGKILL'), KILL_GRACE_MS)
    return true
  }

  cancelAll(): void {
    for (const runId of this.active.keys()) this.cancel(runId)
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0
  }

  /** Live runs for a project, oldest first. */
  activeRuns(projectId: string): RunRecord[] {
    return [...this.active.values()].filter((r) => r.record.projectId === projectId).map((r) => r.record)
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const live = this.active.get(runId)
    if (live) return live.record
    return this.store.read(runId)
  }

  /** Most recent first. Runs interrupted by an app exit are reported as failed. */
  async listRuns(projectId: string, limit = 300): Promise<RunSummary[]> {
    const records = await this.store.readAll(projectId, (id) => this.active.get(id)?.record)
    return records.map(summarize).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
  }

  /** Every turn of a chat with its events, oldest first. */
  async getChat(projectId: string, chatId: string): Promise<RunRecord[]> {
    if (!RUN_ID.test(chatId)) throw new Error('Invalid chat')
    const turns = (await this.store.readAll(projectId, (id) => this.active.get(id)?.record)).filter((r) => (r.chatId ?? r.id) === chatId)
    return turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** The provider the chat's next turn runs with (the same rule as follow-ups); null for an empty chat. */
  async chatProvider(projectId: string, chatId: string): Promise<ProviderId | null> {
    return workingTurns(await this.getChat(projectId, chatId)).at(-1)?.provider ?? null
  }

  /** The provider CLI's own code-review command, if its adapter has one. */
  reviewCommand(provider: ProviderId): string | null {
    return this.adapters[provider]?.reviewCommand ?? null
  }

  /**
   * What a follow-up in this chat continues: the latest turn's provider, and its
   * session if it reported one. Review turns run in their own session, so the
   * implementer never resumes the reviewer's conversation.
   */
  private async continuation(projectId: string, chatId: string): Promise<{ provider: ProviderId; sessionId: string | null; taskId: string | null }> {
    const all = await this.getChat(projectId, chatId)
    if (!all.length) throw new Error('Chat not found')
    if (all.some((t) => this.active.has(t.id))) throw new Error('This chat is still working; wait for it to finish or stop it first')
    const turns = workingTurns(all)
    const last = turns[turns.length - 1]
    const resumable = turns.filter((t) => t.provider === last.provider && t.sessionId).at(-1)
    return { provider: last.provider, sessionId: resumable?.sessionId ?? null, taskId: turns[0].taskId }
  }

  private async refreshArtifacts(run: ActiveRun): Promise<void> {
    const artifacts = await this.store.scanArtifacts(run.record.id)
    if (artifacts.length !== run.record.artifacts.length) {
      run.record.artifacts = artifacts
      this.emitUpdate(run.record)
    }
  }

  private async finish(run: ActiveRun, status: RunRecord['status'], exitCode: number | null, error: string | null): Promise<void> {
    if (run.record.endedAt) return
    if (run.killTimer) clearTimeout(run.killTimer)
    run.record.endedAt = new Date().toISOString()
    run.record.status = status
    run.record.exitCode = exitCode
    run.record.error = error
    run.record.currentAction = null
    const cwd = run.record.cwd ?? run.record.projectPath
    for (const a of run.record.attachments ?? []) {
      await removeAttachment(run.record.projectPath, a.id).catch(() => {})
      if (cwd !== run.record.projectPath) await rm(attachmentPath(cwd, a.id), { force: true }).catch(() => {})
    }
    if (run.record.checkpoint) {
      try {
        run.record.afterCommit = await recordAfter(cwd, run.record.id)
        run.record.changes = await diffSummary(cwd, run.record.checkpoint.commit, run.record.afterCommit)
      } catch (err) {
        this.addEvent(run, { kind: 'error', text: `Could not record the run's changes: ${(err as Error).message}` })
      }
    }
    if (run.record.changes?.length && cwd !== run.record.projectPath) await this.commitTurn(run, cwd)
    run.record.gitAfter = await gitStatus(cwd)
    run.record.artifacts = await this.store.scanArtifacts(run.record.id)
    this.addEvent(run, { kind: status === 'failed' ? 'error' : 'status', text: error ?? `Run ${status}` })
    this.active.delete(run.record.id)
    await this.store.persist(run.record).catch(() => {})
    this.emitUpdate(run.record)
  }

  /** Commits the turn's changes on the chat branch. A failure (e.g. a pre-commit hook) is reported, not fatal. */
  private async commitTurn(run: ActiveRun, cwd: string): Promise<void> {
    const subject = chatTitle(run.record.prompt).slice(0, 72)
    try {
      run.record.commit = await commitAll(cwd, subject, `Thinkerer-Chat: ${run.record.chatId}\nThinkerer-Run: ${run.record.id}`)
      if (run.record.commit) this.addEvent(run, { kind: 'status', text: `Committed ${run.record.commit.slice(0, 7)} on this chat's branch` })
    } catch (err) {
      this.addEvent(run, { kind: 'error', text: `Could not commit this turn's changes: ${(err as Error).message.split('\n').slice(0, 6).join(' ')}` })
    }
  }

  /** Whether any turn of the chat is running or starting. */
  isChatLive(chatId: string): boolean {
    return this.startingChats.has(chatId) || [...this.active.values()].some((r) => r.record.chatId === chatId)
  }

  private addEvent(run: ActiveRun, e: Omit<RunEvent, 'at'>): void {
    const event: RunEvent = { at: new Date().toISOString(), ...e }
    if (run.record.events.length < MAX_EVENTS) run.record.events.push(event)
    this.emit('event', run.record.id, event)
  }

  private emitUpdate(record: RunRecord): void {
    this.emit('update', summarize(record))
  }
}

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ChatProtocol,
  ChatRecord,
  ClaudeRunConfig,
  Project,
  PromptAttachment,
  ProtocolTurnStage,
  ProviderChoice,
  ProviderId,
  ProviderStatus,
  RunArtifact,
  RunEvent,
  RunMode,
  RunRecord,
  RunSummary,
  UsageObservation
} from '../../shared/types'
import { Approvals } from '../approvals'
import { ATTACHMENT_ID, attachmentPath, attachmentRelPath, removeAttachment } from '../attachments'
import { ChatStore, chatTitle, newChat } from '../chats'
import { deviceScope, type ChatDevices } from '../chatDevices'
import { createCheckpoint, diffSummary, recordAfter } from '../checkpoints'
import { gitStatus } from '../git'
import type { McpRegistry, McpRunContext, ResolvedMcpServer } from '../mcp'
import type { ProjectService } from '../projects'
import { readJson, writeJson } from '../store'
import type { TaskStore } from '../tasks'
import {
  allocatePorts,
  commitAll,
  composeProjectName,
  createWorktree,
  currentBranch,
  headCommit,
  resolvePreviewUrl,
  runHook,
  worktreeEnv
} from '../worktrees'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import type { AgentAdapter, RunPolicy } from './types'

const MAX_EVENTS = 5000
const KILL_GRACE_MS = 3000
/** Parallel runs (chats) allowed per project. Each chat has its own worktree. */
export const MAX_PARALLEL_RUNS = 4
const RUN_ID = /^[0-9a-f-]{36}$/
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** Preference used by Auto when no comparable consumption signal is available. */
export const DEFAULT_PREFERENCE: ProviderId[] = ['claude', 'codex']

export const DEFAULT_POLICY: RunPolicy = {
  allowedCommands: [
    'npm run *',
    'npm test*',
    'npx tsc *',
    'npx vitest *',
    'npx playwright test*',
    'git status*',
    'git diff*',
    'git log*'
  ],
  appendSystemPrompt: [
    'You are running inside Thinkerer, a desktop app that supervises coding agents.',
    'Stay inside your working directory.',
    'Never push, deploy, publish, or purchase anything. Do not commit unless explicitly asked.',
    'If a command or file access is denied, say so instead of trying workarounds.',
    'Finish with a short summary of what you changed and how you verified it.'
  ].join(' ')
}

interface ActiveRun {
  record: RunRecord
  child: ChildProcess | null
  cancelRequested: boolean
  killTimer: NodeJS.Timeout | null
  /** Provider session this turn continues; null for a chat's first turn (or when it can't be resumed). */
  resumeSessionId: string | null
  /** A new chat gets a worktree; false in a repo with no commits (it works in the project folder). */
  wantsWorktree: boolean
  /** Extra system instructions for this turn (e.g. the protocol stage's). */
  instructions: string
  /** Claude options that override the project's for this turn. */
  claude: Partial<ClaudeRunConfig>
}

/** Where a turn runs and what it gets: the chat's worktree, ports and preview, or the project folder. */
interface Workspace {
  chat: ChatRecord | null
  cwd: string
  env: Record<string, string>
  previewUrl: string | null
}

export interface SupervisorOptions {
  adapters?: AgentAdapter[]
  policy?: RunPolicy
  tasks?: TaskStore
  /** MCP servers come from the registry; without it, runs get none. */
  mcp?: { registry: McpRegistry; context: () => Promise<Omit<McpRunContext, 'artifactsDir'>> }
  chats?: ChatStore
  approvals?: Approvals
  /** Each chat's own emulators; without it, the mobile server is not limited to a chat. */
  devices?: ChatDevices
}

export interface StartOptions {
  taskId?: string | null
  /** Preview screenshots already saved in the project (see engine/attachments). */
  attachments?: PromptAttachment[]
  /** Send this as a follow-up in an existing chat. It keeps that chat's provider and task. */
  chatId?: string | null
  /** 'plan' runs this message read-only. */
  mode?: RunMode
  /** Start a new provider session instead of resuming the chat's (e.g. an independent review). */
  freshSession?: boolean
  /** Extra system instructions for this turn only. */
  instructions?: string
  /** Claude options for this turn only (others come from the project). */
  claude?: Partial<ClaudeRunConfig>
  /** Recorded on the turn; review turns are never resumed by later turns. */
  protocolStage?: ProtocolTurnStage
  /** A new chat that follows the software protocol. */
  protocol?: ChatProtocol
}

export interface SupervisorEvents {
  event: [runId: string, event: RunEvent]
  update: [summary: RunSummary]
}

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
  private readonly runsDir: string
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
    this.runsDir = join(appDataDir, 'runs')
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
      const selected = await this.selectProvider(chat ? chat.provider : requested)
      const { provider, status } = selected
      const rationale = chat ? `Continuing this chat with ${this.adapters[provider]!.label}` : selected.rationale
      const now = new Date().toISOString()
      // Only runs in the same folder can see each other's edits.
      const others = wantsWorktree ? [] : this.activeRuns(projectId).filter((r) => !r.cwd || r.cwd === project.path)
      const id = randomUUID()
      const record: RunRecord = {
        id,
        projectId,
        projectPath: project.path,
        cwd: project.path,
        commit: null,
        chatId: chatId ?? id,
        sessionId: null,
        prompt,
        mode,
        ...(opts.protocolStage ? { protocolStage: opts.protocolStage } : {}),
        capabilities: null,
        taskId: chat ? chat.taskId : (opts.taskId ?? null),
        checkpoint: null,
        afterCommit: null,
        changes: null,
        mcpServers: [],
        artifacts: [],
        attachments: opts.attachments ?? [],
        provider,
        selection: { requested, rationale },
        status: 'queued',
        createdAt: now,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        error: null,
        resultText: null,
        currentAction: null,
        usage: null,
        permissionDenials: [],
        gitBefore,
        gitAfter: null,
        concurrentRunIds: others.map((r) => r.id),
        events: []
      }
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
      await this.persist(record)
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
      if (record.taskId && this.opts.tasks) {
        await this.opts.tasks.attachRun(project.path, record.taskId, record.id)
      }
      const ws = await this.prepareWorkspace(run, project)
      if (run.cancelRequested) return void (await this.finish(run, 'cancelled', null, null))
      record.cwd = ws.cwd
      if (ws.cwd !== project.path) record.gitBefore = await gitStatus(ws.cwd)
      for (const a of record.attachments ?? []) {
        // Keep a copy with the run, so the chat can still show it after the project copy is removed.
        await mkdir(this.inputsDir(record.id), { recursive: true })
        await copyFile(attachmentPath(project.path, a.id), join(this.inputsDir(record.id), `${a.id}.png`))
        // The agent reads it at the same relative path inside its worktree (an ignored folder, so it isn't committed).
        if (ws.cwd !== project.path) {
          await mkdir(join(ws.cwd, '.thinkerer', 'attachments'), { recursive: true })
          await writeFile(join(ws.cwd, '.thinkerer', 'attachments', '.gitignore'), '*\n')
          await copyFile(attachmentPath(project.path, a.id), attachmentPath(ws.cwd, a.id))
        }
      }
      // Recovery point first: nothing the agent does can be unrecoverable.
      record.checkpoint = await createCheckpoint(ws.cwd, record.id, `Thinkerer: before run — ${record.prompt.slice(0, 72)}`)
      const dirty = record.gitBefore?.entries.length ?? 0
      this.addEvent(run, {
        kind: 'status',
        text: `Checkpoint saved${dirty ? ` (includes ${dirty} uncommitted change${dirty === 1 ? '' : 's'} already in the folder)` : ''}`
      })
      if (run.cancelRequested) return void (await this.finish(run, 'cancelled', null, null))

      const devices = await this.chatDevices(project, ws)
      for (const problem of devices?.problems ?? []) this.addEvent(run, { kind: 'status', text: problem })
      const { servers, secretEnv } = await this.resolveMcp(project, record.id, ws, devices?.ids)
      record.mcpServers = servers.map((s) => s.id)
      this.addEvent(run, { kind: 'status', text: `MCP tools: ${record.mcpServers.join(', ') || 'none'}` })
      if (record.mode === 'plan') this.addEvent(run, { kind: 'status', text: 'Plan mode: this message runs read-only; reply to carry the plan out' })

      const inv = adapter.buildInvocation({
        executable: status.executable!,
        cwd: ws.cwd,
        prompt: record.prompt + attachmentNote(record.attachments ?? []),
        resumeSessionId: run.resumeSessionId,
        policy: { ...this.policy, appendSystemPrompt: this.instructions(servers, ws, record.mode ?? 'auto', devices?.ids, run.instructions) },
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
      this.wire(run, adapter)
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

  /**
   * The folder this turn runs in. A chat's first turn creates its worktree and
   * branch, reserves its ports and runs the project's setup hook; if setup
   * fails, the next message in the chat retries it.
   */
  private async prepareWorkspace(run: ActiveRun, project: Project): Promise<Workspace> {
    const chatId = run.record.chatId!
    let chat = await this.chats.get(chatId)
    const config = project.config!
    if (!chat) return { chat: null, cwd: project.path, env: {}, previewUrl: resolvePreviewUrl(config.website.previewUrl, []) }
    const save = async (fn: (c: ChatRecord) => void) => {
      chat = await this.chats.update(chatId, fn)
      this.chats.emit('update', chat)
      return chat
    }

    if (chat.state === 'setting-up') {
      if (!chat.worktree && !run.wantsWorktree) {
        await save((c) => (c.state = 'active'))
        await this.chats.addNote(chatId, {
          kind: 'info',
          ok: true,
          title: 'Working in the project folder',
          lines: ['This repository has no commit to start a worktree from, so this chat edits the project folder directly.']
        })
      } else {
        if (!chat.worktree) {
          run.record.currentAction = 'Creating the worktree…'
          this.emitUpdate(run.record)
          const wt = await createWorktree(project.path, join(this.worktreesDir, project.id), chatId, chat.title)
          await save((c) => {
            c.worktree = wt
            c.composeProject = composeProjectName(project, chatId)
          })
          const dirty = run.record.gitBefore?.entries.length ?? 0
          this.addEvent(run, {
            kind: 'status',
            text: `Worktree ready: branch ${wt.branch} from ${wt.base} (${wt.baseCommit.slice(0, 7)})${dirty ? `. ${dirty} uncommitted change${dirty === 1 ? '' : 's'} in the project folder ${dirty === 1 ? 'is' : 'are'} not included` : ''}`,
            meta: dirty ? { notice: true } : undefined
          })
        }
        const wanted = config.worktrees.ports
        if (chat.ports.length < wanted) {
          const ports = await allocatePorts(wanted - chat.ports.length, [...chat.ports, ...(await this.chats.takenPorts())])
          await save((c) => (c.ports = [...c.ports, ...ports]))
          this.addEvent(run, { kind: 'status', text: `Ports for this chat: ${chat.ports.map((p, i) => `THINKERER_PORT_${i + 1}=${p}`).join(', ')}` })
        }
        const setup = config.worktrees.setupCommand.trim()
        if (setup) await this.runSetup(run, project, chat, setup)
        await save((c) => (c.state = 'active'))
      }
    } else if (chat.state !== 'active' && !chat.worktreeRemoved) {
      // A new message in a merged or done chat is new work.
      await save((c) => {
        c.state = 'active'
        c.doneReason = null
        c.doneAt = null
      })
    }
    const cwd = chat.worktree?.path ?? project.path
    return { chat, cwd, env: worktreeEnv(project, chat), previewUrl: resolvePreviewUrl(config.website.previewUrl, chat.ports) }
  }

  private async runSetup(run: ActiveRun, project: Project, chat: ChatRecord, command: string): Promise<void> {
    if (!(await this.approvals.isApproved(project.id, 'setup', command))) {
      throw new Error('The worktree setup command has not been approved; send the message again to review it')
    }
    run.record.currentAction = 'Running the worktree setup command…'
    this.emitUpdate(run.record)
    this.addEvent(run, { kind: 'status', text: `Setting up the worktree: $ ${command}` })
    const lines: string[] = []
    const res = await runHook(command, chat.worktree!.path, worktreeEnv(project, chat), (line) => {
      lines.push(line)
      this.addEvent(run, { kind: 'log', text: line, meta: { hook: 'setup' } })
    })
    const ok = res.code === 0 && !res.timedOut
    await this.chats.addNote(chat.id, {
      kind: 'setup',
      ok,
      title: ok ? 'Worktree set up' : `Setup failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`})`,
      lines: [`$ ${command}`, ...lines]
    })
    this.chats.emit('update', (await this.chats.get(chat.id))!)
    if (!ok) throw new Error(`The worktree setup command failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`}); send another message to retry it`)
  }

  /**
   * The chat's own emulators, created on its first turn with the mobile server
   * enabled (a chat with a worktree; otherwise the project folder's). Null when
   * the mobile server is off for the project.
   */
  private async chatDevices(project: Project, ws: Workspace): Promise<{ ids: string[]; problems: string[] } | null> {
    if (!this.opts.devices || !this.opts.mcp || !project.config?.agent.enabledMcpServers.includes('mobile')) return null
    const chat = ws.chat?.worktree && !ws.chat.worktreeRemoved ? ws.chat : null
    const scope = deviceScope(project.id, chat?.id ?? null)
    try {
      return await this.opts.devices.ensure(scope, chat?.title ?? project.config?.name ?? 'Project')
    } catch (err) {
      return { ids: await this.opts.devices.ids(scope).catch(() => []), problems: [`This chat's emulators are unavailable: ${(err as Error).message}`] }
    }
  }

  private async resolveMcp(
    project: Project,
    runId: string,
    ws: Workspace,
    devices?: string[]
  ): Promise<{ servers: ResolvedMcpServer[]; secretEnv: Record<string, string> }> {
    if (!this.opts.mcp) return { servers: [], secretEnv: {} }
    const ctx = await this.opts.mcp.context()
    const provider = this.active.get(runId)?.record.provider
    return this.opts.mcp.registry.resolveForRun(project, { ...ctx, artifactsDir: this.artifactsDir(runId), cwd: ws.cwd, previewUrl: ws.previewUrl, provider, devices })
  }

  private instructions(servers: ResolvedMcpServer[], ws: Workspace, mode: RunMode, devices: string[] | undefined, extra: string): string {
    const lines = [this.policy.appendSystemPrompt]
    if (mode === 'plan') {
      lines.push(
        'This message is in plan mode: investigate read-only and reply with a concrete, step-by-step plan. Do not edit files or run commands that change anything.',
        'The user will reply in this chat to carry the plan out.'
      )
    }
    const wt = ws.chat?.worktree
    if (wt) {
      lines.push(
        `This chat has its own Git worktree on branch ${wt.branch} (created from ${wt.base}); other chats work in other worktrees.`,
        'Thinkerer commits your changes on this branch after each turn, so do not commit, push, or switch branches yourself.'
      )
      if (ws.chat!.ports.length) {
        lines.push(
          `Ports reserved for this worktree: ${ws.chat!.ports.map((p, i) => `THINKERER_PORT_${i + 1}=${p}`).join(', ')} (also in your environment, with COMPOSE_PROJECT_NAME=${ws.chat!.composeProject}). Use them instead of the project's default ports.`
        )
      }
    }
    const preview = ws.previewUrl
    if (servers.some((s) => s.id === 'playwright') && preview) {
      lines.push(
        `To check UI changes in a real browser, use the playwright MCP tools against ${preview} (served by the project's dev command, which the user starts from Thinkerer's preview; if it is not reachable, say so).`,
        'Navigation is limited to that origin. Take a screenshot (browser_take_screenshot) of the verified state; screenshots are saved with the run, not in the project.',
        'State clearly whether the browser check PASSED or FAILED.'
      )
    }
    // Emulators an agent starts must stay inside Thinkerer's Emulator panel: a desktop window
    // (Simulator.app, the emulator UI) steals focus and is not what the user asked for.
    lines.push(
      servers.some((s) => s.id === 'mobile')
        ? `Android emulators and iOS simulators run headless and show only in Thinkerer's Emulator panel. Start and drive them with the mobile MCP tools (mobile_boot boots headless). ${
            devices?.length
              ? `This chat has its own devices, which only it uses: ${devices.join(', ')}. The tools only accept those; other chats have their own.`
              : 'This chat has no device of its own yet; the user can create one in the Emulator panel.'
          }`
        : 'If you start an Android emulator or iOS simulator, boot it headless so it shows only in Thinkerer\'s Emulator panel: `xcrun simctl boot <udid>` or `emulator -avd <name> -no-window`.',
      'Never open a device window yourself: no `open -a Simulator`, Xcode, Android Studio, or `emulator` without `-no-window`.'
    )
    if (servers.some((s) => s.id === 'health')) lines.push('The health MCP server reports project health (git state, preview reachability).')
    if (extra) lines.push(extra)
    return lines.join(' ')
  }

  artifactsDir(runId: string): string {
    return join(this.runsDir, `${runId}-artifacts`)
  }

  private inputsDir(runId: string): string {
    return join(this.runsDir, `${runId}-inputs`)
  }

  /** Image artifact as a data: URL for the renderer (no file paths cross IPC). */
  async artifactDataUrl(runId: string, name: string): Promise<string> {
    if (!RUN_ID.test(runId) || !/^[\w.-]+$/.test(name)) throw new Error('Invalid artifact')
    const type = IMAGE_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()]
    if (!type) throw new Error('Unsupported artifact type')
    const data = await readFile(join(this.artifactsDir(runId), name))
    return `data:${type};base64,${data.toString('base64')}`
  }

  /** A screenshot the user attached to the run's prompt, as a data: URL. */
  async attachmentDataUrl(runId: string, id: string): Promise<string> {
    if (!RUN_ID.test(runId) || !ATTACHMENT_ID.test(id)) throw new Error('Invalid attachment')
    const data = await readFile(join(this.inputsDir(runId), `${id}.png`))
    return `data:image/png;base64,${data.toString('base64')}`
  }

  private async scanArtifacts(runId: string): Promise<RunArtifact[]> {
    try {
      const dir = this.artifactsDir(runId)
      const names = (await readdir(dir)).filter((n) => IMAGE_TYPES[n.slice(n.lastIndexOf('.')).toLowerCase()] && /^[\w.-]+$/.test(n))
      return names.sort().map((name) => ({ name, mediaType: IMAGE_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()], at: new Date().toISOString() }))
    } catch {
      return []
    }
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
    if (!RUN_ID.test(runId)) return null
    return readJson<RunRecord>(join(this.runsDir, `${runId}.json`))
  }

  /** Most recent first. Runs interrupted by an app exit are reported as failed. */
  async listRuns(projectId: string, limit = 300): Promise<RunSummary[]> {
    const records = await this.readRuns(projectId)
    return records.map(summarize).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
  }

  /** Every turn of a chat with its events, oldest first. */
  async getChat(projectId: string, chatId: string): Promise<RunRecord[]> {
    if (!RUN_ID.test(chatId)) throw new Error('Invalid chat')
    const turns = (await this.readRuns(projectId)).filter((r) => (r.chatId ?? r.id) === chatId)
    return turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Live runs come from memory (their files lag behind); the rest from disk. */
  private async readRuns(projectId: string): Promise<RunRecord[]> {
    let files: string[] = []
    try {
      files = (await readdir(this.runsDir)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: RunRecord[] = []
    for (const f of files) {
      const live = this.active.get(f.slice(0, -'.json'.length))
      if (live) {
        if (live.record.projectId === projectId) out.push(live.record)
        continue
      }
      const rec = await readJson<RunRecord>(join(this.runsDir, f)).catch(() => null)
      if (!rec || rec.projectId !== projectId) continue
      if (rec.status === 'running' || rec.status === 'queued') {
        rec.status = 'failed'
        rec.error = 'Thinkerer exited while this run was active'
        rec.endedAt ??= new Date().toISOString()
        await this.persist(rec)
      }
      out.push(rec)
    }
    return out
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
    const working = all.filter((t) => t.protocolStage !== 'review')
    const turns = working.length ? working : all
    const last = turns[turns.length - 1]
    const resumable = turns.filter((t) => t.provider === last.provider && t.sessionId).at(-1)
    return { provider: last.provider, sessionId: resumable?.sessionId ?? null, taskId: turns[0].taskId }
  }

  private async selectProvider(requested: ProviderChoice): Promise<{ provider: ProviderId; rationale: string; status: ProviderStatus }> {
    const statuses = await this.providers()
    const usable = (s: ProviderStatus) => s.installed && s.adapterAvailable && s.authenticated !== false
    const why = (s: ProviderStatus) =>
      !s.installed ? 'not installed' : !s.adapterAvailable ? 'no adapter in this build' : s.authenticated === false ? 'not logged in' : 'cooling down after a rate limit'

    if (requested !== 'auto') {
      const s = statuses.find((x) => x.id === requested)!
      if (!usable(s)) throw new Error(`${s.label} is unavailable: ${why(s)}`)
      return { provider: requested, rationale: 'manually selected', status: s }
    }

    const skipped: string[] = []
    for (const id of DEFAULT_PREFERENCE) {
      const s = statuses.find((x) => x.id === id)!
      const cooling = (this.cooldownUntil.get(id) ?? 0) > Date.now()
      if (usable(s) && !cooling) {
        const note = skipped.length ? `; skipped ${skipped.join(', ')}` : ''
        return {
          provider: id,
          rationale: `Auto: no comparable consumption signal across providers, using configured preference (${DEFAULT_PREFERENCE.join(' > ')})${note}`,
          status: s
        }
      }
      skipped.push(`${s.label} (${cooling ? 'cooling down after a rate limit' : why(s)})`)
    }
    throw new Error(`No usable agent provider: ${skipped.join('; ')}`)
  }

  private wire(run: ActiveRun, adapter: AgentAdapter): void {
    const child = run.child!
    const parser = adapter.createParser()
    let buffer = ''
    let stderrTail = ''
    let sawResult: { isError: boolean } | null = null

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        for (const u of parser.parseLine(line)) {
          if (u.currentAction) run.record.currentAction = u.currentAction
          if (u.sessionId) run.record.sessionId = u.sessionId
          if (u.capabilities) run.record.capabilities = u.capabilities
          if (u.usage) run.record.usage = mergeUsage(run.record.usage, u.usage)
          if (u.result) {
            sawResult = { isError: u.result.isError }
            run.record.resultText = u.result.text
            run.record.permissionDenials = u.result.denials
          }
          if (u.event) this.addEvent(run, u.event)
          if (u.event?.kind === 'tool-result' && run.record.mcpServers.includes('playwright')) void this.refreshArtifacts(run)
        }
        if (run.record.usage?.rateLimitStatus === 'rejected') this.noteRateLimit(adapter.id, run.record.usage)
        this.emitUpdate(run.record)
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
      this.addEvent(run, { kind: 'stderr', text: chunk })
    })
    child.on('error', (err) => {
      void this.finish(run, 'failed', null, `Could not start ${adapter.label}: ${err.message}`)
    })
    child.on('close', (code, signal) => {
      if (buffer.trim()) for (const u of parser.parseLine(buffer)) if (u.event) this.addEvent(run, u.event)
      if (run.cancelRequested) return void this.finish(run, 'cancelled', code, null)
      const result = sawResult as { isError: boolean } | null
      if (code === 0 && result && !result.isError) return void this.finish(run, 'succeeded', code, null)
      const reason = signal
        ? `Agent process killed by ${signal}`
        : result?.isError
          ? 'Agent reported an error'
          : `Agent exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''}`
      void this.finish(run, 'failed', code, reason)
    })
  }

  private async refreshArtifacts(run: ActiveRun): Promise<void> {
    const artifacts = await this.scanArtifacts(run.record.id)
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
    run.record.artifacts = await this.scanArtifacts(run.record.id)
    this.addEvent(run, { kind: status === 'failed' ? 'error' : 'status', text: error ?? `Run ${status}` })
    this.active.delete(run.record.id)
    await this.persist(run.record).catch(() => {})
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

  private noteRateLimit(id: ProviderId, usage: UsageObservation): void {
    const resets = Object.values(usage.windows ?? {}).map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : 0))
    const until = Math.max(Date.now() + 5 * 60_000, ...resets.filter((t) => t > Date.now()))
    this.cooldownUntil.set(id, until)
  }

  private addEvent(run: ActiveRun, e: Omit<RunEvent, 'at'>): void {
    const event: RunEvent = { at: new Date().toISOString(), ...e }
    if (run.record.events.length < MAX_EVENTS) run.record.events.push(event)
    this.emit('event', run.record.id, event)
  }

  private emitUpdate(record: RunRecord): void {
    this.emit('update', summarize(record))
  }

  private async persist(record: RunRecord): Promise<void> {
    await mkdir(this.runsDir, { recursive: true })
    await writeJson(join(this.runsDir, `${record.id}.json`), record)
  }
}

function missingAdapter(id: ProviderId): ProviderStatus {
  const label = id === 'claude' ? 'Claude Code' : 'Codex'
  return { id, label, installed: false, executable: null, version: null, authenticated: null, adapterAvailable: false, detail: 'No adapter registered', policy: '' }
}

/** Tells the agent where the user's preview screenshots are and what page they show. */
export function attachmentNote(attachments: PromptAttachment[]): string {
  if (!attachments.length) return ''
  const items = attachments.map((a, i) => {
    const lines = [`${i + 1}. Screenshot: ${attachmentRelPath(a.id)}`, a.device ? `   Device screen: ${a.device} (use the mobile MCP tools to interact with it)` : `   Page: ${a.url ?? 'unknown'}`]
    if (a.consoleErrors.length) lines.push('   Console errors:', ...a.consoleErrors.map((e) => `   - ${e.slice(0, 500)}`))
    return lines.join('\n')
  })
  return [
    '',
    '',
    '---',
    `The user attached ${attachments.length === 1 ? 'a screenshot' : 'screenshots'} of the site as they see it in Thinkerer's preview. Open each image file (path relative to the project root) to look at it before you start; do not edit or delete it.`,
    ...items
  ].join('\n')
}

function summarize(record: RunRecord): RunSummary {
  const { events: _events, ...rest } = record
  return rest
}

/** Per-turn Claude overrides; empty strings keep the project's value. */
function mergeClaude(base: ClaudeRunConfig, over: Partial<ClaudeRunConfig>): ClaudeRunConfig {
  return { model: over.model || base.model, effort: over.effort || base.effort, tools: over.tools ?? base.tools }
}

function mergeUsage(prev: UsageObservation | null, next: UsageObservation): UsageObservation {
  return { ...prev, ...next, windows: { ...prev?.windows, ...next.windows } }
}

function killTree(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

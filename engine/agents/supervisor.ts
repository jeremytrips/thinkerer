import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Project,
  PromptAttachment,
  ProviderChoice,
  ProviderId,
  ProviderStatus,
  RunArtifact,
  RunEvent,
  RunRecord,
  RunSummary,
  UsageObservation
} from '../../shared/types'
import { ATTACHMENT_ID, attachmentPath, attachmentRelPath, removeAttachment } from '../attachments'
import { createCheckpoint, diffSummary, recordAfter } from '../checkpoints'
import { gitStatus } from '../git'
import type { McpRegistry, McpRunContext, ResolvedMcpServer } from '../mcp'
import type { ProjectService } from '../projects'
import { readJson, writeJson } from '../store'
import type { TaskStore } from '../tasks'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import type { AgentAdapter, RunPolicy } from './types'

const MAX_EVENTS = 5000
const KILL_GRACE_MS = 3000
/** Parallel runs (chats) allowed per project. They share the project folder. */
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
    'Your working directory is the selected project; stay inside it.',
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
}

export interface SupervisorOptions {
  adapters?: AgentAdapter[]
  policy?: RunPolicy
  tasks?: TaskStore
  /** MCP servers come from the registry; without it, runs get none. */
  mcp?: { registry: McpRegistry; context: () => Promise<Omit<McpRunContext, 'artifactsDir'>> }
}

export interface StartOptions {
  taskId?: string | null
  /** Preview screenshots already saved in the project (see engine/attachments). */
  attachments?: PromptAttachment[]
  /** Send this as a follow-up in an existing chat. It keeps that chat's provider and task. */
  chatId?: string | null
}

export interface SupervisorEvents {
  event: [runId: string, event: RunEvent]
  update: [summary: RunSummary]
}

/**
 * Owns provider CLI processes. A run is one turn of a chat; a follow-up turn
 * resumes the provider session of the chat's latest turn, so the agent keeps the
 * conversation, and still gets its own checkpoint. Several runs may work in the same project folder
 * at once (up to MAX_PARALLEL_RUNS); runs that overlap in time are recorded in
 * `concurrentRunIds`, because their checkpoints and diffs can then include each
 * other's edits. Every run is recorded to <appData>/runs/<id>.json.
 */
export class AgentSupervisor extends EventEmitter<SupervisorEvents> {
  private readonly runsDir: string
  private readonly active = new Map<string, ActiveRun>() // keyed by runId
  private readonly starting = new Map<string, number>() // projectId → starts in flight
  private readonly startingChats = new Set<string>() // chatId → follow-up start in flight
  private readonly cooldownUntil = new Map<ProviderId, number>()
  private readonly adapters: Partial<Record<ProviderId, AgentAdapter>> = {}
  private readonly policy: RunPolicy

  constructor(
    appDataDir: string,
    private readonly projects: ProjectService,
    private readonly opts: SupervisorOptions = {}
  ) {
    super()
    this.runsDir = join(appDataDir, 'runs')
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
      const chat = chatId ? await this.continuation(projectId, chatId) : null
      const selected = await this.selectProvider(chat ? chat.provider : requested)
      const { provider, status } = selected
      const rationale = chat ? `Continuing this chat with ${this.adapters[provider]!.label}` : selected.rationale
      const now = new Date().toISOString()
      const others = this.activeRuns(projectId)
      const id = randomUUID()
      const record: RunRecord = {
        id,
        projectId,
        projectPath: project.path,
        chatId: chatId ?? id,
        sessionId: null,
        prompt,
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
      run = { record, child: null, cancelRequested: false, killTimer: null, resumeSessionId: chat?.sessionId ?? null }
      for (const other of others) {
        other.concurrentRunIds = [...(other.concurrentRunIds ?? []), record.id]
        this.emitUpdate(other)
      }
      this.active.set(record.id, run)
      this.addEvent(run, { kind: 'status', text: `Provider: ${this.adapters[provider]!.label}` })
      if (chat) {
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
      // Keep a copy with the run, so the chat can still show it after the project copy is removed.
      for (const a of record.attachments ?? []) {
        await mkdir(this.inputsDir(record.id), { recursive: true })
        await copyFile(attachmentPath(project.path, a.id), join(this.inputsDir(record.id), `${a.id}.png`))
      }
      // Recovery point first: nothing the agent does can be unrecoverable.
      record.checkpoint = await createCheckpoint(project.path, record.id, `Thinkerer: before run — ${record.prompt.slice(0, 72)}`)
      const dirty = record.gitBefore?.entries.length ?? 0
      this.addEvent(run, {
        kind: 'status',
        text: `Checkpoint saved${dirty ? ` (includes ${dirty} uncommitted change${dirty === 1 ? '' : 's'} already in the folder)` : ''}`
      })
      if (run.cancelRequested) return void (await this.finish(run, 'cancelled', null, null))

      const { servers, secretEnv } = await this.resolveMcp(project, record.id)
      record.mcpServers = servers.map((s) => s.id)
      this.addEvent(run, { kind: 'status', text: `MCP tools: ${record.mcpServers.join(', ') || 'none'}` })

      const inv = adapter.buildInvocation({
        executable: status.executable!,
        cwd: project.path,
        prompt: record.prompt + attachmentNote(record.attachments ?? []),
        resumeSessionId: run.resumeSessionId,
        policy: { ...this.policy, appendSystemPrompt: this.instructions(project, servers) },
        mcp: servers,
        secretEnv
      })
      if (run.cancelRequested) return void (await this.finish(run, 'cancelled', null, null))
      const child = spawn(inv.command, inv.args, {
        cwd: project.path,
        env: inv.env,
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
      this.addEvent(run, { kind: 'status', text: `Started in ${project.path}` })
      this.emitUpdate(record)
    } catch (err) {
      await this.finish(run, 'failed', null, (err as Error).message)
    }
  }

  private async resolveMcp(project: Project, runId: string): Promise<{ servers: ResolvedMcpServer[]; secretEnv: Record<string, string> }> {
    if (!this.opts.mcp) return { servers: [], secretEnv: {} }
    const ctx = await this.opts.mcp.context()
    return this.opts.mcp.registry.resolveForRun(project, { ...ctx, artifactsDir: this.artifactsDir(runId) })
  }

  private instructions(project: Project, servers: ResolvedMcpServer[]): string {
    const lines = [this.policy.appendSystemPrompt]
    const preview = project.config?.website.previewUrl
    if (servers.some((s) => s.id === 'playwright') && preview) {
      lines.push(
        `To check UI changes in a real browser, use the playwright MCP tools against ${preview} (served by the project's dev command, which the user starts from Thinkerer's Website tab; if it is not reachable, say so).`,
        'Navigation is limited to that origin. Take a screenshot (browser_take_screenshot) of the verified state; screenshots are saved with the run, not in the project.',
        'State clearly whether the browser check PASSED or FAILED.'
      )
    }
    if (servers.some((s) => s.id === 'health')) lines.push('The health MCP server reports project health (git state, preview reachability).')
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

  /** What a follow-up in this chat continues: the latest turn's provider, and its session if it reported one. */
  private async continuation(projectId: string, chatId: string): Promise<{ provider: ProviderId; sessionId: string | null; taskId: string | null }> {
    const turns = await this.getChat(projectId, chatId)
    if (!turns.length) throw new Error('Chat not found')
    if (turns.some((t) => this.active.has(t.id))) throw new Error('This chat is still working; wait for it to finish or stop it first')
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
    run.record.gitAfter = await gitStatus(run.record.projectPath)
    if (run.record.checkpoint) {
      try {
        run.record.afterCommit = await recordAfter(run.record.projectPath, run.record.id)
        run.record.changes = await diffSummary(run.record.projectPath, run.record.checkpoint.commit, run.record.afterCommit)
      } catch (err) {
        this.addEvent(run, { kind: 'error', text: `Could not record the run's changes: ${(err as Error).message}` })
      }
    }
    run.record.artifacts = await this.scanArtifacts(run.record.id)
    for (const a of run.record.attachments ?? []) await removeAttachment(run.record.projectPath, a.id).catch(() => {})
    this.addEvent(run, { kind: status === 'failed' ? 'error' : 'status', text: error ?? `Run ${status}` })
    this.active.delete(run.record.id)
    await this.persist(run.record).catch(() => {})
    this.emitUpdate(run.record)
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
    const lines = [`${i + 1}. Screenshot: ${attachmentRelPath(a.id)}`, `   Page: ${a.url ?? 'unknown'}`]
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

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderChoice, ProviderId, ProviderStatus, RunEvent, RunRecord, RunSummary, UsageObservation } from '../../shared/types'
import { gitStatus } from '../git'
import type { ProjectService } from '../projects'
import { readJson, writeJson } from '../store'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import type { AgentAdapter, RunPolicy } from './types'

const MAX_EVENTS = 5000
const KILL_GRACE_MS = 3000

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
}

export interface SupervisorEvents {
  event: [runId: string, event: RunEvent]
  update: [summary: RunSummary]
}

/**
 * Owns provider CLI processes. One modifying run per project at a time (spec
 * F2); every run is recorded to <appData>/runs/<id>.json.
 */
export class AgentSupervisor extends EventEmitter<SupervisorEvents> {
  private readonly runsDir: string
  private readonly active = new Map<string, ActiveRun>() // keyed by projectId
  private readonly cooldownUntil = new Map<ProviderId, number>()
  private readonly adapters: Partial<Record<ProviderId, AgentAdapter>> = {}
  private readonly policy: RunPolicy

  constructor(
    appDataDir: string,
    private readonly projects: ProjectService,
    opts: { adapters?: AgentAdapter[]; policy?: RunPolicy } = {}
  ) {
    super()
    this.runsDir = join(appDataDir, 'runs')
    this.policy = opts.policy ?? DEFAULT_POLICY
    for (const a of opts.adapters ?? [claudeAdapter, codexAdapter]) this.adapters[a.id] = a
  }

  async providers(): Promise<ProviderStatus[]> {
    return Promise.all(DEFAULT_PREFERENCE.map((id) => this.adapters[id]?.detect() ?? Promise.resolve(missingAdapter(id))))
  }

  /** Validates and starts a run; resolves once the child process has been spawned (or failed to). */
  async start(projectId: string, prompt: string, requested: ProviderChoice): Promise<RunSummary> {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt is empty')
    if (prompt.length > 100_000) throw new Error('Prompt is too long')
    if (this.active.has(projectId)) throw new Error('An agent run is already active for this project')
    const project = await this.projects.get(projectId)
    if (project.status !== 'ok') throw new Error('Project folder is missing')

    const { provider, rationale, status } = await this.selectProvider(requested)
    const adapter = this.adapters[provider]!
    const now = new Date().toISOString()
    const record: RunRecord = {
      id: randomUUID(),
      projectId,
      projectPath: project.path,
      prompt,
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
      gitBefore: null,
      gitAfter: null,
      events: []
    }
    const run: ActiveRun = { record, child: null, cancelRequested: false, killTimer: null }
    this.active.set(projectId, run)
    this.addEvent(run, { kind: 'status', text: `Provider: ${adapter.label}` })
    await this.persist(record)
    this.emitUpdate(record)

    try {
      record.gitBefore = await gitStatus(project.path)
      const inv = adapter.buildInvocation({ executable: status.executable!, cwd: project.path, prompt, policy: this.policy })
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
    return summarize(record)
  }

  cancel(projectId: string): boolean {
    const run = this.active.get(projectId)
    if (!run) return false
    run.cancelRequested = true
    this.addEvent(run, { kind: 'status', text: 'Cancellation requested — stopping agent process' })
    killTree(run.child, 'SIGTERM')
    run.killTimer = setTimeout(() => killTree(run.child, 'SIGKILL'), KILL_GRACE_MS)
    return true
  }

  cancelAll(): void {
    for (const projectId of this.active.keys()) this.cancel(projectId)
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0
  }

  activeRun(projectId: string): RunRecord | null {
    return this.active.get(projectId)?.record ?? null
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    for (const r of this.active.values()) if (r.record.id === runId) return r.record
    if (!/^[0-9a-f-]{36}$/.test(runId)) return null
    return readJson<RunRecord>(join(this.runsDir, `${runId}.json`))
  }

  /** Most recent first. Runs interrupted by an app exit are reported as failed. */
  async listRuns(projectId: string, limit = 50): Promise<RunSummary[]> {
    let files: string[] = []
    try {
      files = (await readdir(this.runsDir)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const activeIds = new Set([...this.active.values()].map((r) => r.record.id))
    const out: RunSummary[] = []
    for (const f of files) {
      const rec = await readJson<RunRecord>(join(this.runsDir, f)).catch(() => null)
      if (!rec || rec.projectId !== projectId) continue
      if (!activeIds.has(rec.id) && (rec.status === 'running' || rec.status === 'queued')) {
        rec.status = 'failed'
        rec.error = 'Thinkerer exited while this run was active'
        rec.endedAt ??= new Date().toISOString()
        await this.persist(rec)
      }
      out.push(summarize(rec))
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
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
          if (u.usage) run.record.usage = mergeUsage(run.record.usage, u.usage)
          if (u.result) {
            sawResult = { isError: u.result.isError }
            run.record.resultText = u.result.text
            run.record.permissionDenials = u.result.denials
          }
          if (u.event) this.addEvent(run, u.event)
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

  private async finish(run: ActiveRun, status: RunRecord['status'], exitCode: number | null, error: string | null): Promise<void> {
    if (run.record.endedAt) return
    if (run.killTimer) clearTimeout(run.killTimer)
    run.record.endedAt = new Date().toISOString()
    run.record.status = status
    run.record.exitCode = exitCode
    run.record.error = error
    run.record.currentAction = null
    run.record.gitAfter = await gitStatus(run.record.projectPath)
    this.addEvent(run, { kind: status === 'failed' ? 'error' : 'status', text: error ?? `Run ${status}` })
    this.active.delete(run.record.projectId)
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

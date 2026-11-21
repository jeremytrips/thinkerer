import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { DevLogLine, DevServerState, Project } from '../shared/types'
import { childEnv } from './agents/detect'
import { Approvals } from './approvals'
import { resolvePreviewUrl } from './worktrees'

const MAX_LOG_LINES = 2000
const KILL_GRACE_MS = 3000
const READY_POLL_MS = 1000
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

interface Server {
  state: DevServerState
  child: ChildProcess | null
  logs: DevLogLine[]
  poll: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
}

export interface DevServerEvents {
  log: [projectId: string, chatId: string | null, line: DevLogLine]
  state: [state: DevServerState]
}

/** Where a dev server runs: the project folder, or a chat's worktree with its own ports. */
export interface DevTarget {
  chatId: string | null
  cwd: string
  env: Record<string, string>
  /** Preview URL for this target (ports filled in); null when it has none. */
  url: string | null
}

export function projectTarget(project: Project): DevTarget {
  // The project folder has no reserved ports: {portN} needs a fallback ({port1:5174}) to give it a URL.
  return { chatId: null, cwd: project.path, env: {}, url: resolvePreviewUrl(project.config?.website.previewUrl ?? '', []) }
}

const scopeKey = (projectId: string, chatId: string | null) => (chatId ? `${projectId}:${chatId}` : projectId)

/**
 * Runs the project's configured dev command (Website Studio, spec F5), once for
 * the project folder and once per chat worktree. The command comes from
 * .thinkerer/project.json — which an agent can edit — so it only runs after the
 * user has approved that exact text.
 */
export class DevServerManager extends EventEmitter<DevServerEvents> {
  private readonly servers = new Map<string, Server>()
  private readonly approvals: Approvals

  constructor(appDataDir: string, approvals?: Approvals) {
    super()
    this.approvals = approvals ?? new Approvals(appDataDir)
  }

  async state(project: Project, target: DevTarget = projectTarget(project)): Promise<DevServerState> {
    const s = this.servers.get(scopeKey(project.id, target.chatId))
    const command = project.config?.website.devCommand || null
    const needsApproval = !!command && !(await this.isApproved(project.id, command))
    if (s && s.state.status !== 'stopped' && s.state.status !== 'exited') return { ...s.state, needsApproval: false }
    return {
      projectId: project.id,
      chatId: target.chatId,
      status: s?.state.status ?? 'stopped',
      command,
      url: target.url,
      pid: null,
      exitCode: s?.state.exitCode ?? null,
      startedAt: null,
      needsApproval
    }
  }

  logs(projectId: string, chatId: string | null = null): DevLogLine[] {
    return this.servers.get(scopeKey(projectId, chatId))?.logs ?? []
  }

  isApproved(projectId: string, command: string): Promise<boolean> {
    return this.approvals.isApproved(projectId, 'dev', command)
  }

  approve(projectId: string, command: string): Promise<void> {
    return this.approvals.approve(projectId, 'dev', command)
  }

  async start(project: Project, target: DevTarget = projectTarget(project)): Promise<DevServerState> {
    const command = project.config?.website.devCommand?.trim()
    const url = target.url
    const { chatId } = target
    const key = scopeKey(project.id, chatId)
    if (!command) throw new Error('Set a development command in Settings first')
    if (!(await this.isApproved(project.id, command))) throw new Error('This dev command has not been approved')
    const existing = this.servers.get(key)
    if (existing?.child) return existing.state

    const server: Server = existing ?? { state: null as unknown as DevServerState, child: null, logs: [], poll: null, killTimer: null }
    this.servers.set(key, server)
    const log = (stream: DevLogLine['stream'], text: string) => this.log(project.id, chatId, stream, text)
    if (url && (await responds(url))) {
      server.state = { projectId: project.id, chatId, status: 'external', command, url, pid: null, exitCode: null, startedAt: null, needsApproval: false }
      log('system', `${url} is already being served by another process; previewing it without starting the dev command.`)
      this.emit('state', server.state)
      return server.state
    }

    const shell = process.platform === 'win32' ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', command] } : { cmd: '/bin/sh', args: ['-c', command] }
    const child = spawn(shell.cmd, shell.args, {
      cwd: target.cwd,
      env: { ...childEnv(), ...target.env, BROWSER: 'none', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    server.child = child
    server.state = {
      projectId: project.id,
      chatId,
      status: 'starting',
      command,
      url,
      pid: child.pid ?? null,
      exitCode: null,
      startedAt: new Date().toISOString(),
      needsApproval: false
    }
    log('system', `$ ${command}${target.cwd !== project.path ? `   (in ${target.cwd})` : ''}`)
    this.emit('state', server.state)

    const pipe = (stream: 'stdout' | 'stderr') => {
      let buf = ''
      child[stream]!.setEncoding('utf8')
      child[stream]!.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const l of lines) log(stream, l)
      })
    }
    pipe('stdout')
    pipe('stderr')

    child.on('error', (err) => log('system', `Failed to start: ${err.message}`))
    child.on('close', (code, signal) => {
      if (server.poll) clearInterval(server.poll)
      if (server.killTimer) clearTimeout(server.killTimer)
      server.child = null
      server.poll = null
      const stopped = server.state.status === 'stopped'
      server.state = { ...server.state, status: stopped ? 'stopped' : 'exited', pid: null, exitCode: code }
      log('system', stopped ? 'Dev server stopped.' : `Dev server exited (${signal ?? `code ${code}`}).`)
      this.emit('state', server.state)
    })

    if (url) {
      server.poll = setInterval(async () => {
        if (server.state.status !== 'starting') return
        if (await responds(url)) {
          if (server.poll) clearInterval(server.poll)
          server.poll = null
          server.state = { ...server.state, status: 'running' }
          log('system', `Ready at ${url}`)
          this.emit('state', server.state)
        }
      }, READY_POLL_MS)
    }
    return server.state
  }

  /**
   * Makes sure the target's preview answers before an agent turn needs it:
   * starts the dev command if the user has approved it, then waits until it
   * is ready. False (never an error) when it can't: no command, not approved,
   * no URL, it exited, or it was not ready in time.
   */
  async ensureRunning(project: Project, target: DevTarget, timeoutMs = 30_000): Promise<boolean> {
    const command = project.config?.website.devCommand?.trim()
    if (!command || !target.url || !(await this.isApproved(project.id, command))) return false
    if (!(await this.start(project, target).catch(() => null))) return false
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const status = this.servers.get(scopeKey(project.id, target.chatId))?.state.status
      if (status === 'running' || status === 'external') return true
      if (status !== 'starting' || Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  stop(projectId: string, chatId: string | null = null): void {
    const server = this.servers.get(scopeKey(projectId, chatId))
    if (!server) return
    if (server.state.status === 'external') {
      server.state = { ...server.state, status: 'stopped' }
      this.emit('state', server.state)
      return
    }
    if (!server.child) return
    server.state = { ...server.state, status: 'stopped' }
    killGroup(server.child, 'SIGTERM')
    server.killTimer = setTimeout(() => server.child && killGroup(server.child, 'SIGKILL'), KILL_GRACE_MS)
  }

  /** Every server of a project: its folder's and all its chats'. */
  stopProject(projectId: string): void {
    for (const s of this.servers.values()) if (s.state?.projectId === projectId) this.stop(projectId, s.state.chatId)
  }

  stopAll(): void {
    for (const s of this.servers.values()) if (s.state) this.stop(s.state.projectId, s.state.chatId)
  }

  private log(projectId: string, chatId: string | null, stream: DevLogLine['stream'], text: string): void {
    const server = this.servers.get(scopeKey(projectId, chatId))
    if (!server) return
    const line: DevLogLine = { at: new Date().toISOString(), stream, text: text.replace(ANSI, '') }
    server.logs.push(line)
    if (server.logs.length > MAX_LOG_LINES) server.logs.splice(0, server.logs.length - MAX_LOG_LINES)
    this.emit('log', projectId, chatId, line)
  }
}

export async function responds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

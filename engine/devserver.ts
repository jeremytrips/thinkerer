import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { DevLogLine, DevServerState, Project } from '../shared/types'
import { childEnv } from './agents/detect'
import { readJson, writeJson } from './store'

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
  log: [projectId: string, line: DevLogLine]
  state: [state: DevServerState]
}

/**
 * Runs each project's configured dev command (Website Studio, spec F5). The
 * command comes from .thinkerer/project.json — which an agent can edit — so a
 * command only runs after the user has approved that exact text.
 */
export class DevServerManager extends EventEmitter<DevServerEvents> {
  private readonly servers = new Map<string, Server>()
  private readonly approvalsFile: string

  constructor(appDataDir: string) {
    super()
    this.approvalsFile = join(appDataDir, 'approved-dev-commands.json')
  }

  async state(project: Project): Promise<DevServerState> {
    const s = this.servers.get(project.id)
    const command = project.config?.website.devCommand || null
    const needsApproval = !!command && !(await this.isApproved(project.id, command))
    if (s && s.state.status !== 'stopped' && s.state.status !== 'exited') return { ...s.state, needsApproval: false }
    return {
      projectId: project.id,
      status: s?.state.status ?? 'stopped',
      command,
      url: project.config?.website.previewUrl || null,
      pid: null,
      exitCode: s?.state.exitCode ?? null,
      startedAt: null,
      needsApproval
    }
  }

  logs(projectId: string): DevLogLine[] {
    return this.servers.get(projectId)?.logs ?? []
  }

  async isApproved(projectId: string, command: string): Promise<boolean> {
    const approvals = (await readJson<Record<string, string>>(this.approvalsFile).catch(() => null)) ?? {}
    return approvals[projectId] === command
  }

  async approve(projectId: string, command: string): Promise<void> {
    const approvals = (await readJson<Record<string, string>>(this.approvalsFile).catch(() => null)) ?? {}
    approvals[projectId] = command
    await writeJson(this.approvalsFile, approvals)
  }

  async start(project: Project): Promise<DevServerState> {
    const command = project.config?.website.devCommand?.trim()
    const url = project.config?.website.previewUrl || null
    if (!command) throw new Error('Set a development command in Settings first')
    if (!(await this.isApproved(project.id, command))) throw new Error('This dev command has not been approved')
    const existing = this.servers.get(project.id)
    if (existing?.child) return existing.state

    const server: Server = existing ?? { state: null as unknown as DevServerState, child: null, logs: [], poll: null, killTimer: null }
    this.servers.set(project.id, server)
    if (url && (await responds(url))) {
      server.state = { projectId: project.id, status: 'external', command, url, pid: null, exitCode: null, startedAt: null, needsApproval: false }
      this.log(project.id, 'system', `${url} is already being served by another process; previewing it without starting the dev command.`)
      this.emit('state', server.state)
      return server.state
    }

    const shell = process.platform === 'win32' ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', command] } : { cmd: '/bin/sh', args: ['-c', command] }
    const child = spawn(shell.cmd, shell.args, {
      cwd: project.path,
      env: { ...childEnv(), BROWSER: 'none', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    server.child = child
    server.state = {
      projectId: project.id,
      status: 'starting',
      command,
      url,
      pid: child.pid ?? null,
      exitCode: null,
      startedAt: new Date().toISOString(),
      needsApproval: false
    }
    this.log(project.id, 'system', `$ ${command}`)
    this.emit('state', server.state)

    const pipe = (stream: 'stdout' | 'stderr') => {
      let buf = ''
      child[stream]!.setEncoding('utf8')
      child[stream]!.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const l of lines) this.log(project.id, stream, l)
      })
    }
    pipe('stdout')
    pipe('stderr')

    child.on('error', (err) => this.log(project.id, 'system', `Failed to start: ${err.message}`))
    child.on('close', (code, signal) => {
      if (server.poll) clearInterval(server.poll)
      if (server.killTimer) clearTimeout(server.killTimer)
      server.child = null
      server.poll = null
      const stopped = server.state.status === 'stopped'
      server.state = { ...server.state, status: stopped ? 'stopped' : 'exited', pid: null, exitCode: code }
      this.log(project.id, 'system', stopped ? 'Dev server stopped.' : `Dev server exited (${signal ?? `code ${code}`}).`)
      this.emit('state', server.state)
    })

    if (url) {
      server.poll = setInterval(async () => {
        if (server.state.status !== 'starting') return
        if (await responds(url)) {
          if (server.poll) clearInterval(server.poll)
          server.poll = null
          server.state = { ...server.state, status: 'running' }
          this.log(project.id, 'system', `Ready at ${url}`)
          this.emit('state', server.state)
        }
      }, READY_POLL_MS)
    }
    return server.state
  }

  stop(projectId: string): void {
    const server = this.servers.get(projectId)
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

  stopAll(): void {
    for (const id of this.servers.keys()) this.stop(id)
  }

  private log(projectId: string, stream: DevLogLine['stream'], text: string): void {
    const server = this.servers.get(projectId)
    if (!server) return
    const line: DevLogLine = { at: new Date().toISOString(), stream, text: text.replace(ANSI, '') }
    server.logs.push(line)
    if (server.logs.length > MAX_LOG_LINES) server.logs.splice(0, server.logs.length - MAX_LOG_LINES)
    this.emit('log', projectId, line)
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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevServerManager } from '../engine/devserver'
import type { DevServerState, Project } from '../shared/types'

let dir: string
beforeEach(() => (dir = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-dev-')))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

const project = (command: string, port: number): Project => ({
  id: 'p1',
  path: dir,
  addedAt: '',
  status: 'ok',
  config: {
    schemaVersion: 1,
    name: 'site',
    components: ['website'],
    target: 'web',
    website: { devCommand: command, previewUrl: `http://127.0.0.1:${port}` },
    agent: { provider: 'auto', enabledMcpServers: [], claude: { model: '', effort: '', tools: [] } },
    worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
    marketing: { enabled: true }
  }
})

function waitState(m: DevServerManager, status: DevServerState['status']): Promise<DevServerState> {
  return new Promise((resolve) => {
    const on = (s: DevServerState) => s.status === status && (m.off('state', on), resolve(s))
    m.on('state', on)
  })
}

describe('DevServerManager', () => {
  it('runs only an approved command, detects readiness, captures logs, and stops the process group', async () => {
    const port = await freePort()
    const cmd = `node -e "console.log('booting'); require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`
    const p = project(cmd, port)
    const m = new DevServerManager(dir)

    expect((await m.state(p)).needsApproval).toBe(true)
    await expect(m.start(p)).rejects.toThrow(/approved/)
    await m.approve(p.id, cmd)
    expect((await m.state(p)).needsApproval).toBe(false)

    const ready = waitState(m, 'running')
    await m.start(p)
    await ready
    expect(m.logs(p.id).map((l) => l.text)).toEqual(expect.arrayContaining(['booting']))

    const stopped = waitState(m, 'stopped')
    m.stop(p.id)
    await stopped
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()

    // Editing the command (e.g. by an agent) requires approval again.
    expect((await m.state(project(cmd + ' # changed', port))).needsApproval).toBe(true)
  }, 20_000)

  it('runs one server per chat worktree, each in its folder with its own port', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    // The same command everywhere; each worktree's port comes from its environment.
    const cmd = `node -e "require('http').createServer((q,s)=>s.end(require('fs').readFileSync('who.txt'))).listen(process.env.THINKERER_PORT_1)"`
    const p = project(cmd, 0)
    p.config!.website.previewUrl = 'http://127.0.0.1:{port1}'
    const m = new DevServerManager(dir)
    await m.approve(p.id, cmd)
    const targets = [
      { chatId: 'a', port: portA },
      { chatId: 'b', port: portB }
    ].map(({ chatId, port }) => {
      const cwd = join(dir, chatId)
      mkdirSync(cwd)
      writeFileSync(join(cwd, 'who.txt'), chatId)
      return { chatId, cwd, env: { THINKERER_PORT_1: String(port) }, url: `http://127.0.0.1:${port}` }
    })
    for (const t of targets) {
      const ready = new Promise<void>((resolve) => {
        const on = (s: DevServerState) => s.chatId === t.chatId && s.status === 'running' && (m.off('state', on), resolve())
        m.on('state', on)
      })
      await m.start(p, t)
      await ready
    }
    expect(await (await fetch(targets[0].url)).text()).toBe('a')
    expect(await (await fetch(targets[1].url)).text()).toBe('b')
    expect((await m.state(p, targets[1])).status).toBe('running')
    // The project folder has no server of its own, and no port for {port1}.
    expect(await m.state(p)).toMatchObject({ chatId: null, status: 'stopped', url: null })

    const stopped = new Promise<void>((resolve) => m.on('state', (s) => s.chatId === 'a' && s.status === 'stopped' && resolve()))
    m.stop(p.id, 'a')
    await stopped
    expect(await (await fetch(targets[1].url)).text()).toBe('b')
    m.stopProject(p.id)
  }, 20_000)

  it('previews an already-running server instead of starting another', async () => {
    const port = await freePort()
    const server = (await import('node:http')).createServer((_q, s) => s.end('x')).listen(port)
    try {
      const p = project('echo should-not-run', port)
      const m = new DevServerManager(dir)
      await m.approve(p.id, 'echo should-not-run')
      expect((await m.start(p)).status).toBe('external')
    } finally {
      server.close()
    }
  })
})

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
    agent: { provider: 'auto', enabledMcpServers: [] },
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

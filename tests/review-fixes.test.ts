import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpRegistry, type ResolvedMcpServer, type SecretStore } from '../engine/mcp'
import { checkMcpServer } from '../engine/mcpCheck'
import { findClaudeMcpServers } from '../engine/mcpImport'
import { androidTextChunks } from '../mcp/mobile-driver.mjs'
import type { Project } from '../shared/types'

let dir: string
beforeEach(() => (dir = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-review-')))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const importFrom = async (mcpServers: object) => {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers }))
  return (await findClaudeMcpServers(dir, join(dir, 'no-home'), ['playwright', 'health', 'mobile'])).map((f) => f.candidate)
}

describe('importing Claude Code MCP servers', () => {
  it('gives a server named like a built-in its own id instead of offering a replace that fails', async () => {
    const [c] = await importFrom({ playwright: { command: 'npx', args: ['@playwright/mcp'] } })
    expect(c.def.id).toBe('playwright-imported')
    expect(c.exists).toBe(false)
    expect(c.unsupported).toBeNull()
    expect(c.notes.join(' ')).toMatch(/built-in/)
  })

  it('explains env values that are only partly a variable, and starts from a default when one is given', async () => {
    const [c] = await importFrom({
      db: { command: 'db-mcp', env: { DB_URL: 'postgres://u@${HOST}/db', PORT: '${PORT:-5432}', API_TOKEN: '${TOKEN}', MODE: 'ro' } }
    })
    expect(c.unsupported).toBeNull()
    expect(c.def.env).toEqual({ MODE: 'ro' })
    expect(c.def.secretEnv).toEqual(['DB_URL', 'PORT', 'API_TOKEN'])
    expect(c.secretsMissing).toEqual(['DB_URL', 'API_TOKEN'])
    expect(c.secretsFound).toEqual(['PORT'])
    expect(c.notes.find((n) => n.startsWith('Set DB_URL'))).toContain('postgres://u@${HOST}/db')
    expect(c.notes.find((n) => n.startsWith('PORT'))).toContain('5432')
  })

  it('says clearly why a lower-case env var that needs a secret cannot be imported', async () => {
    const [c] = await importFrom({ svc: { command: 'svc', env: { api_token: '${TOKEN}' } } })
    expect(c.unsupported).toMatch(/"api_token".*upper-case.*API_TOKEN/)
  })
})

describe('Android text input', () => {
  it('types % literally and never sends a literal "%s" in one call', () => {
    expect(androidTextChunks('100% done')).toEqual(['100%%sdone'])
    expect(androidTextChunks('a b')).toEqual(['a%sb'])
    expect(androidTextChunks('printf %s')).toEqual(['printf%s%', 's'])
    expect(androidTextChunks('')).toEqual([])
  })
})

describe('MCP check of a legacy SSE server', () => {
  let server: Server
  let open = 0
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      server = createServer(handler)
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`))
    })
  const sse = (url: string): ResolvedMcpServer => ({ id: 's', transport: 'sse', command: '', args: [], env: {}, url, headers: {}, secretEnv: [] })
  const waitClosed = async () => {
    for (let i = 0; i < 50 && open > 0; i++) await new Promise((r) => setTimeout(r, 20))
    return open
  }

  it('times out and closes the stream when no endpoint event arrives', async () => {
    open = 0
    const url = await listen((req, res) => {
      open++
      req.on('close', () => open--)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': waiting\n\n')
    })
    const result = await checkMcpServer(sse(url), {}, { cwd: dir, env: process.env, timeoutMs: 300 })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/No answer/) })
    expect(await waitClosed()).toBe(0)
  })

  it('times out when the server never sends response headers', async () => {
    open = 0
    const url = await listen((req) => {
      open++
      req.on('close', () => open--)
    })
    const result = await checkMcpServer(sse(url), {}, { cwd: dir, env: process.env, timeoutMs: 300 })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/No answer/) })
    expect(await waitClosed()).toBe(0)
  })
})

describe('preview URLs with chat port placeholders', () => {
  const secrets: SecretStore = { get: async () => null, set: async () => {}, names: async () => [] }
  const project = (previewUrl: string) =>
    ({
      id: 'p1',
      path: '/work/site',
      addedAt: '',
      status: 'ok',
      config: { website: { devCommand: '', previewUrl }, agent: { enabledMcpServers: ['playwright'] } }
    }) as unknown as Project
  const ctx = { appRoot: '/app', node: { command: 'node', env: {} }, artifactsDir: '/tmp/a' }

  it('does not throw on an unfilled {portN} URL; Playwright is simply not available there', async () => {
    const reg = new McpRegistry(dir, secrets)
    const def = (await reg.get('playwright'))!
    expect(await reg.resolveOne(def, project('http://localhost:{port1}'), ctx)).toBeNull()
    expect(await reg.resolveOne(def, project('http://localhost:{port1}'), { ...ctx, previewUrl: null })).toBeNull()
    const filled = await reg.resolveOne(def, project('http://localhost:{port1}'), { ...ctx, previewUrl: 'http://localhost:4100' })
    expect(filled?.server.args).toContain('http://localhost:4100')
  })
})

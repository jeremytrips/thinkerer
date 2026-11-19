import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeMcpConfig } from '../engine/agents/claude'
import { codexMcpArgs } from '../engine/agents/codex'
import { McpRegistry, type ResolvedMcpServer, type SecretStore } from '../engine/mcp'
import type { Project } from '../shared/types'

class MemorySecrets implements SecretStore {
  data = new Map<string, string>()
  async get(s: string, n: string) { return this.data.get(`${s}/${n}`) ?? null }
  async set(s: string, n: string, v: string | null) { if (v === null) this.data.delete(`${s}/${n}`); else this.data.set(`${s}/${n}`, v) }
  async names(s: string) { return [...this.data.keys()].filter((k) => k.startsWith(`${s}/`)).map((k) => k.slice(s.length + 1)) }
}

let dir: string
let secrets: MemorySecrets
let reg: McpRegistry
const project = (enabled: string[], previewUrl = 'http://localhost:5174/'): Project => ({
  id: 'p1',
  path: '/work/site',
  addedAt: '',
  status: 'ok',
  config: {
    schemaVersion: 1,
    name: 'site',
    components: ['website'],
    target: 'web',
    website: { devCommand: 'npm run dev', previewUrl },
    agent: { provider: 'auto', enabledMcpServers: enabled },
    worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
    marketing: { enabled: true }
  }
})
const ctx = { appRoot: '/app', node: { command: '/usr/bin/node', env: {} }, artifactsDir: '/data/runs/r1-artifacts' }

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-mcp-')))
  secrets = new MemorySecrets()
  reg = new McpRegistry(dir, secrets)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('MCP registry', () => {
  it('lists built-ins and resolves only project-enabled servers with placeholders filled', async () => {
    expect((await reg.list()).map((s) => s.id)).toEqual(['playwright', 'health'])
    const { servers } = await reg.resolveForRun(project(['playwright']), ctx)
    expect(servers).toHaveLength(1)
    const pw = servers[0]
    expect(pw.command).toBe('/usr/bin/node')
    expect(pw.args).toEqual(expect.arrayContaining(['/app/mcp/playwright-launch.mjs', '/data/runs/r1-artifacts', '--headless', '--isolated', '--allowed-origins', 'http://localhost:5174']))
    expect(pw.args.join(' ')).not.toMatch(/\{\w+\}/)
  })

  it('explains why a server is excluded', async () => {
    const eff = await reg.effective(project(['playwright', 'health', 'ghost'], ''), 'claude')
    expect(eff.servers).toEqual([
      { id: 'playwright', label: 'Playwright browser', included: false, reason: expect.stringMatching(/preview URL/) },
      { id: 'health', label: 'Project health', included: true, reason: null },
      { id: 'ghost', label: 'ghost', included: false, reason: 'Not in the registry' }
    ])
  })

  it('stores custom servers without secrets and requires secrets before use', async () => {
    await reg.upsert({ id: 'notes', label: 'Notes', description: '', builtin: false, command: 'npx', args: ['notes-mcp'], env: { MODE: 'ro' }, secretEnv: ['NOTES_TOKEN'] })
    await expect(reg.upsert({ id: 'playwright', label: 'x', description: '', builtin: false, command: 'x', args: [], env: {}, secretEnv: [] })).rejects.toThrow(/built-in/)
    await expect(reg.upsert({ id: 'Bad Id', label: 'x', description: '', builtin: false, command: 'x', args: [], env: {}, secretEnv: [] })).rejects.toThrow(/id/)

    expect((await reg.effective(project(['notes']), 'codex')).servers[0]).toMatchObject({ included: false, reason: 'Missing secret: NOTES_TOKEN' })
    await reg.setSecret('notes', 'NOTES_TOKEN', 'tok-123')
    const { servers, secretEnv } = await reg.resolveForRun(project(['notes']), ctx)
    expect(servers[0]).toMatchObject({ id: 'notes', command: 'npx', env: { MODE: 'ro' }, secretEnv: ['NOTES_TOKEN'] })
    expect(secretEnv).toEqual({ NOTES_TOKEN: 'tok-123' })
    expect(JSON.stringify(await reg.list())).not.toContain('tok-123')
  })

  it('translates the same servers for both CLIs, keeping secrets out of argv', () => {
    const servers: ResolvedMcpServer[] = [
      { id: 'health', command: 'node', args: ['/app/mcp/thinkerer-health.mjs'], env: { THINKERER_PROJECT_ROOT: '/work/site' }, secretEnv: [] },
      { id: 'notes', command: 'npx', args: ['notes-mcp'], env: {}, secretEnv: ['NOTES_TOKEN'] }
    ]
    expect(claudeMcpConfig(servers)).toEqual({
      mcpServers: {
        health: { type: 'stdio', command: 'node', args: ['/app/mcp/thinkerer-health.mjs'], env: { THINKERER_PROJECT_ROOT: '/work/site' } },
        notes: { type: 'stdio', command: 'npx', args: ['notes-mcp'], env: { NOTES_TOKEN: '${NOTES_TOKEN}' } }
      }
    })
    const codex = codexMcpArgs(servers)
    expect(codex).toEqual([
      '-c', 'mcp_servers.health.command="node"',
      '-c', 'mcp_servers.health.args=["/app/mcp/thinkerer-health.mjs"]',
      '-c', 'mcp_servers.health.env={ "THINKERER_PROJECT_ROOT" = "/work/site" }',
      '-c', 'mcp_servers.health.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.notes.command="npx"',
      '-c', 'mcp_servers.notes.args=["notes-mcp"]',
      '-c', 'mcp_servers.notes.env={  }',
      '-c', 'mcp_servers.notes.env_vars=["NOTES_TOKEN"]',
      '-c', 'mcp_servers.notes.default_tools_approval_mode="approve"',
      '-c', 'shell_environment_policy.exclude=["NOTES_TOKEN"]'
    ])
  })
})

describe('thinkerer-health MCP server', () => {
  it('speaks MCP over stdio and reports project health', async () => {
    const child = spawn(process.execPath, [resolve(__dirname, '..', 'mcp', 'thinkerer-health.mjs')], {
      env: { ...process.env, THINKERER_PROJECT_ROOT: dir, THINKERER_PREVIEW_URL: 'http://127.0.0.1:1' }
    })
    const replies: Record<number, any> = {}
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) {
        const msg = JSON.parse(buf.slice(0, nl))
        replies[msg.id] = msg
      }
    })
    const send = (o: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
    send({ id: 3, method: 'tools/call', params: { name: 'project_health', arguments: {} } })
    send({ id: 4, method: 'nope' })
    const deadline = Date.now() + 10_000
    while (!replies[4] || !replies[3]) {
      if (Date.now() > deadline) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 20))
    }
    child.kill()
    expect(replies[1].result.serverInfo.name).toBe('thinkerer-health')
    expect(replies[2].result.tools.map((t: { name: string }) => t.name)).toEqual(['project_health'])
    const report = JSON.parse(replies[3].result.content[0].text)
    expect(report).toMatchObject({ projectRoot: dir, git: { error: 'not a git repository' }, preview: { reachable: false } })
    expect(replies[4].error.code).toBe(-32601)
  })
})

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeAdapter, parseClaudeLine } from '../engine/agents/claude'
import { DEFAULT_POLICY } from '../engine/agents/supervisor'
import { freeId, McpRegistry, type ResolvedMcpServer, type SecretStore } from '../engine/mcp'
import { checkMcpServer } from '../engine/mcpCheck'
import { findClaudeMcpServers } from '../engine/mcpImport'
import { resolvePreviewUrl } from '../engine/worktrees'
import { androidTextChunks } from '../mcp/mobile-driver.mjs'
import type { Project } from '../shared/types'
import { enqueue, modeAfterGiveBack, type Queued } from '../src/views/queue'

// Regression tests for the issues found in code review: MCP check robustness,
// plan mode staying read-only, built-in server ids, and MCP status notices.

class MemorySecrets implements SecretStore {
  data = new Map<string, string>()
  async get(s: string, n: string) { return this.data.get(`${s}/${n}`) ?? null }
  async set(s: string, n: string, v: string | null) { if (v === null) this.data.delete(`${s}/${n}`); else this.data.set(`${s}/${n}`, v) }
  async names(s: string) { return [...this.data.keys()].filter((k) => k.startsWith(`${s}/`)).map((k) => k.slice(s.length + 1)) }
}

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-review-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const project = (previewUrl: string, enabled: string[] = ['playwright']): Project => ({
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
    agent: { provider: 'auto', enabledMcpServers: enabled, claude: { model: '', effort: '', tools: [] } },
    worktrees: { setupCommand: '', teardownCommand: '', ports: 1 },
    protocol: { checkCommand: '', maxReviewRounds: 2, review: { model: '', effort: '' } },
    marketing: { enabled: true }
  }
})
const ctx = { appRoot: '/app', node: { command: '/usr/bin/node', env: {} }, artifactsDir: '/a' }

describe('Checking Playwright with a {portN} preview URL', () => {
  it('does not throw, and refuses to start the browser without a real origin', async () => {
    const reg = new McpRegistry(tmp, new MemorySecrets())
    const p = project('http://localhost:{port1}/')
    const def = (await reg.get('playwright'))!
    // What the MCP tab's Check does: the project folder has no chat ports.
    const previewUrl = resolvePreviewUrl(p.config!.website.previewUrl, [])
    expect(previewUrl).toBeNull()
    await expect(reg.resolveOne(def, p, { ...ctx, previewUrl })).resolves.toBeNull()
    // Even handed the raw template, it must not throw "Invalid URL" or start an unfenced browser.
    await expect(reg.resolveOne(def, p, ctx)).resolves.toBeNull()
    // Inside a chat the ports fill in and it works.
    const inChat = await reg.resolveOne(def, p, { ...ctx, previewUrl: resolvePreviewUrl(p.config!.website.previewUrl, [4321]) })
    expect(inChat?.server.args).toEqual(expect.arrayContaining(['--allowed-origins', 'http://localhost:4321']))
  })
})

describe('Checking an SSE server that misbehaves', () => {
  let server: Server
  let open: Set<IncomingMessage>
  let closed: number
  const start = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    open = new Set()
    closed = 0
    server = createServer((req, res) => {
      open.add(req)
      req.socket.on('close', () => (open.delete(req), closed++))
      handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`
  }
  afterEach(() => {
    server.closeAllConnections()
    return new Promise<void>((r) => server.close(() => r()))
  })
  const sse = (url: string): ResolvedMcpServer => ({ id: 's', transport: 'sse', command: '', args: [], env: {}, url, headers: {}, secretEnv: [] })
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20))
  }

  it('closes the stream when no endpoint event ever arrives', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n') // headers sent, but never an `endpoint` event
    })
    const res = await checkMcpServer(sse(url), {}, { cwd: tmp, env: process.env, timeoutMs: 300 })
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/No answer within/) })
    await waitFor(() => open.size === 0)
    expect(open.size).toBe(0)
    expect(closed).toBe(1)
  })

  it('times out a server that never sends headers, and closes the connection', async () => {
    const url = await start(() => {}) // accepts the GET, never answers
    const t0 = Date.now()
    const res = await checkMcpServer(sse(url), {}, { cwd: tmp, env: process.env, timeoutMs: 300 })
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/No answer within/) })
    expect(Date.now() - t0).toBeLessThan(3000)
    await waitFor(() => open.size === 0)
    expect(open.size).toBe(0)
  })

  it('fails fast when the stream closes before announcing an endpoint', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end()
    })
    const t0 = Date.now()
    const res = await checkMcpServer(sse(url), {}, { cwd: tmp, env: process.env, timeoutMs: 5000 })
    expect(res).toMatchObject({ ok: false, error: 'The server closed the event stream' })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('Claude plan mode stays read-only', () => {
  const mcp: ResolvedMcpServer[] = [{ id: 'mobile', transport: 'stdio', command: 'node', args: [], env: {}, url: '', headers: {}, secretEnv: [] }]
  const base = { executable: '/bin/claude', cwd: '/p', prompt: 'hi', policy: DEFAULT_POLICY, mcp, secretEnv: {} }
  const allowed = (args: string[]) => {
    const i = args.indexOf('--allowedTools')
    if (i < 0) return []
    const out: string[] = []
    for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k++) out.push(args[k])
    return out
  }

  it('pre-approves only read-only git commands and no MCP tools in plan mode', () => {
    const plan = allowed(claudeAdapter.buildInvocation({ ...base, mode: 'plan' }).args)
    // Read-only git a review (e.g. /code-review) needs to find the change; nothing that writes.
    expect(plan).toEqual(['git status*', 'git diff*', 'git log*', 'git show*', 'git merge-base*', 'git rev-parse*', 'git ls-files*'].map((c) => `Bash(${c})`))
  })

  it('denies git output-file flags in plan mode, which the read-only rules would otherwise allow', () => {
    const args = claudeAdapter.buildInvocation({ ...base, mode: 'plan' }).args
    const i = args.indexOf('--disallowedTools')
    expect(args[i + 1]).toBe('Bash(git *--output*)')
    expect(claudeAdapter.buildInvocation(base).args).not.toContain('--disallowedTools')
  })

  it('keeps the full approved list in auto mode', () => {
    const auto = allowed(claudeAdapter.buildInvocation(base).args)
    expect(auto).toEqual([...DEFAULT_POLICY.allowedCommands.map((c) => `Bash(${c})`), 'mcp__mobile'])
  })

  it('omits --allowedTools entirely when nothing is left to pre-approve', () => {
    const args = claudeAdapter.buildInvocation({ ...base, mode: 'plan', policy: { ...DEFAULT_POLICY, allowedCommands: ['npm run *'] } }).args
    expect(args).not.toContain('--allowedTools')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
  })
})

describe('MCP servers still starting at init', () => {
  it('only flags servers that actually failed', () => {
    const updates = parseClaudeLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        model: 'm',
        tools: [],
        mcp_servers: [
          { name: 'a', status: 'connected' },
          { name: 'b', status: 'pending' },
          { name: 'c', status: 'failed' },
          { name: 'd', status: 'needs-auth' }
        ]
      })
    )
    expect(updates.slice(1).map((u) => u.event?.text)).toEqual(['MCP server c did not connect (failed)', 'MCP server d did not connect (needs-auth)'])
  })
})

describe('Built-in server ids', () => {
  it('imports a Claude server named like a built-in under its own id', async () => {
    const repo = join(tmp, 'repo')
    const home = join(tmp, 'home')
    mkdirSync(repo)
    mkdirSync(home)
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } }))
    const reg = new McpRegistry(join(tmp, 'appdata'), new MemorySecrets())
    const ids = async () => (await reg.list()).map((s) => s.id)
    const [found] = await findClaudeMcpServers(repo, home, await ids())
    expect(found.candidate).toMatchObject({ name: 'playwright', exists: false, unsupported: null, def: { id: 'playwright-claude' } })
    // The import the dialog promises actually succeeds…
    await expect(reg.upsert(found.candidate.def)).resolves.toMatchObject({ id: 'playwright-claude' })
    // …and importing it again is a replacement of that same entry.
    const [again] = await findClaudeMcpServers(repo, home, await ids())
    expect(again.candidate).toMatchObject({ exists: true, def: { id: 'playwright-claude' } })
  })

  it('renames a user server shadowed by a new built-in so it can still be edited and removed', async () => {
    const appdata = join(tmp, 'appdata')
    mkdirSync(appdata)
    const file = join(appdata, 'mcp-registry.json')
    const mine = { id: 'mobile', label: 'My mobile', description: '', builtin: false, command: 'my-mobile-mcp', args: [], env: {}, secretEnv: ['MOBILE_TOKEN'] }
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, servers: [mine] }))
    const secrets = new MemorySecrets()
    await secrets.set('mobile', 'MOBILE_TOKEN', 't-1')
    const reg = new McpRegistry(appdata, secrets)

    const list = await reg.list()
    expect(list.map((s) => s.id)).toEqual(['playwright', 'health', 'mobile', 'mobile-custom'])
    const renamed = list.find((s) => s.id === 'mobile-custom')!
    expect(renamed).toMatchObject({ command: 'my-mobile-mcp', label: expect.stringMatching(/My mobile.*renamed from "mobile"/), secretsSet: ['MOBILE_TOKEN'] })
    expect(await secrets.get('mobile', 'MOBILE_TOKEN')).toBeNull()
    expect(await secrets.get('mobile-custom', 'MOBILE_TOKEN')).toBe('t-1')
    // Saved, so it stays renamed.
    expect(JSON.parse(readFileSync(file, 'utf8')).servers.map((s: { id: string }) => s.id)).toEqual(['mobile-custom'])
    // The built-in still answers to 'mobile'.
    expect((await reg.get('mobile'))?.builtin).toBe(true)
    await reg.remove('mobile-custom')
    expect((await reg.list()).map((s) => s.id)).toEqual(['playwright', 'health', 'mobile'])
  })

  it('finds a free id within the length limit', () => {
    expect(freeId('mobile-custom', new Set(['mobile-custom']))).toBe('mobile-custom-2')
    const long = 'a'.repeat(40)
    expect(freeId(long, new Set()).length).toBe(31)
    expect(freeId(long, new Set(['a'.repeat(31)]))).toBe('a'.repeat(29) + '-2')
  })
})

describe('Queued follow-ups and plan mode', () => {
  const shot = { id: 'c1' } as unknown as Queued['attachments'][number]
  it('merges messages of the same mode', () => {
    const first = enqueue(undefined, { text: 'plan the refactor', attachments: [], mode: 'plan' })
    expect(first).toEqual({ queued: { text: 'plan the refactor', attachments: [], mode: 'plan' } })
    const both = enqueue((first as { queued: Queued }).queued, { text: 'and the tests', attachments: [shot], mode: 'plan' })
    expect(both).toEqual({ queued: { text: 'plan the refactor\n\nand the tests', attachments: [shot], mode: 'plan' } })
  })

  it('refuses to merge a message of another mode, either way round', () => {
    const plan: Queued = { text: 'plan the refactor', attachments: [], mode: 'plan' }
    const auto: Queued = { text: 'also fix the typo', attachments: [], mode: 'auto' }
    expect(enqueue(plan, auto)).toEqual({ refused: expect.stringMatching(/"Plan only" message is already queued.*"Make changes"/) })
    expect(enqueue(auto, plan)).toEqual({ refused: expect.stringMatching(/"Make changes" message is already queued.*"Plan only"/) })
  })

  it('gives a failed plan message back in plan mode', () => {
    // submit() has already reset the composer to auto when the send fails.
    expect(modeAfterGiveBack('plan', 'auto')).toBe('plan')
    expect(modeAfterGiveBack('plan', undefined)).toBe('plan')
    expect(modeAfterGiveBack('auto', 'auto')).toBe('auto')
    // Merged into a draft that was set to plan: stays read-only.
    expect(modeAfterGiveBack('auto', 'plan')).toBe('plan')
  })
})

describe('Importing Claude Code env values', () => {
  const importFrom = async (mcpServers: object) => {
    writeFileSync(join(tmp, '.mcp.json'), JSON.stringify({ mcpServers }))
    return (await findClaudeMcpServers(tmp, join(tmp, 'no-home'), ['playwright', 'health', 'mobile'])).map((f) => f.candidate)
  }

  it('says why a server named like a built-in gets another id', async () => {
    const [c] = await importFrom({ playwright: { command: 'npx', args: ['@playwright/mcp'] } })
    expect(c.notes.join(' ')).toMatch(/"playwright" is a built-in server, so this is imported as "playwright-claude"/)
  })

  it('explains values that are only partly a variable, and starts from a default when one is given', async () => {
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

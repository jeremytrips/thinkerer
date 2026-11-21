import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeAdapter, claudeMcpConfig, parseClaudeLine } from '../engine/agents/claude'
import { codexAdapter, codexMcpArgs } from '../engine/agents/codex'
import { AgentSupervisor, DEFAULT_POLICY } from '../engine/agents/supervisor'
import type { AgentAdapter, InvocationOptions } from '../engine/agents/types'
import { McpRegistry, validateDef, type ResolvedMcpServer, type SecretStore } from '../engine/mcp'
import { checkMcpServer } from '../engine/mcpCheck'
import { findClaudeMcpServers, toServerId } from '../engine/mcpImport'
import { ProjectService } from '../engine/projects'
import type { McpServerDef, Project, RunSummary } from '../shared/types'

// Claude Code features surfaced in Thinkerer: run options (model, effort,
// optional tools, plan mode), the session capabilities Claude reports, and MCP
// management (remote servers, checking a server, importing Claude's own config).

class MemorySecrets implements SecretStore {
  data = new Map<string, string>()
  async get(s: string, n: string) { return this.data.get(`${s}/${n}`) ?? null }
  async set(s: string, n: string, v: string | null) { if (v === null) this.data.delete(`${s}/${n}`); else this.data.set(`${s}/${n}`, v) }
  async names(s: string) { return [...this.data.keys()].filter((k) => k.startsWith(`${s}/`)).map((k) => k.slice(s.length + 1)) }
}

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-claude-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const base = { executable: '/bin/claude', cwd: '/p', prompt: 'hi', policy: DEFAULT_POLICY, mcp: [], secretEnv: {} }

describe('Claude run options', () => {
  it('passes model, effort, optional tools and plan mode to the CLI', () => {
    const plain = claudeAdapter.buildInvocation(base).args
    expect(plain).not.toContain('--model')
    expect(plain).not.toContain('--effort')
    expect(plain[plain.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep,Bash')
    expect(plain[plain.indexOf('--permission-mode') + 1]).toBe('auto')

    const args = claudeAdapter.buildInvocation({ ...base, mode: 'plan', claude: { model: 'opus[1m]', effort: 'high', tools: ['Task', 'Skill', 'WebSearch'] } }).args
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'opus[1m]'])
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep,Bash,Task,Skill,WebSearch')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    // Still restricted, still nothing waiting for a prompt.
    expect(args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config', '--permission-prompts', 'none']))
  })

  it('runs Codex read-only in plan mode, for new and resumed sessions', () => {
    const fresh = codexAdapter.buildInvocation({ ...base, mode: 'plan' }).args
    expect(fresh.slice(fresh.indexOf('--sandbox'), fresh.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only'])
    const resumed = codexAdapter.buildInvocation({ ...base, mode: 'plan', resumeSessionId: 't1' }).args
    expect(resumed).toContain('sandbox_mode="read-only"')
    expect(codexAdapter.buildInvocation(base).args).toContain('workspace-write')
  })

  it('stores Claude options in the project config and rejects invalid ones', async () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo)
    const projects = new ProjectService(join(tmp, 'appdata'))
    const p = await projects.importFolder(repo)
    expect(p.config!.agent.claude).toEqual({ model: '', effort: '', tools: ['Task', 'Skill'] })
    const updated = await projects.updateConfig(p.id, { agent: { claude: { model: 'sonnet', effort: 'max', tools: ['WebSearch', 'Task'] } } })
    // Tools are kept in a stable order.
    expect(updated.config!.agent.claude).toEqual({ model: 'sonnet', effort: 'max', tools: ['Task', 'WebSearch'] })
    // Claude Code also accepts 'Agent' for the subagent tool; it is stored as 'Task'.
    const alias = await projects.updateConfig(p.id, { agent: { claude: { tools: ['Agent' as never, 'Skill'] } } })
    expect(alias.config!.agent.claude.tools).toEqual(['Task', 'Skill'])
    await expect(projects.updateConfig(p.id, { agent: { claude: { model: '--dangerously-skip-permissions' } } })).rejects.toThrow(/Model/)
    await expect(projects.updateConfig(p.id, { agent: { claude: { effort: 'ultra' as never } } })).rejects.toThrow(/effort/)
    await expect(projects.updateConfig(p.id, { agent: { claude: { tools: ['Bash' as never] } } })).rejects.toThrow(/tools/)
  })
})

describe('Claude session capabilities', () => {
  // Shape of a real `system/init` event from Claude Code 2.1.
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-opus-5-5',
    permissionMode: 'plan',
    claude_code_version: '2.1.330',
    tools: ['Read', 'Task', 'mcp__health__project_health'],
    mcp_servers: [{ name: 'health', status: 'connected' }, { name: 'notes', status: 'failed' }],
    slash_commands: ['compact', 'init', 'clear', 'model', 'doctor', 'code-review', '__remote', 'my-skill'],
    terminal_slash_commands: ['doctor'],
    skills: ['my-skill'],
    agents: ['Explore', 'general-purpose'],
    plugins: [{ name: 'p1', path: 'builtin' }]
  }

  it('records what the CLI reported and flags MCP servers that did not connect', () => {
    const [first, ...rest] = parseClaudeLine(JSON.stringify(init))
    expect(first.sessionId).toBe('s1')
    expect(first.event!.text).toMatch(/plan mode/)
    expect(first.capabilities).toEqual({
      model: 'claude-opus-5-5',
      version: '2.1.330',
      permissionMode: 'plan',
      tools: ['Read', 'Task', 'mcp__health__project_health'],
      mcpServers: [{ name: 'health', status: 'connected' }, { name: 'notes', status: 'failed' }],
      // Interactive-only, internal and Thinkerer-handled commands are left out.
      commands: ['compact', 'init', 'code-review', 'my-skill'],
      skills: ['my-skill'],
      agents: ['Explore', 'general-purpose'],
      plugins: ['p1']
    })
    expect(rest).toEqual([{ event: { kind: 'status', text: 'MCP server notes did not connect (failed)', meta: { notice: true } } }])
  })

  it('shows a plan-mode plan instead of reporting ExitPlanMode as a denial', () => {
    const updates = parseClaudeLine(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: '',
        permission_denials: [
          { tool_name: 'ExitPlanMode', tool_input: { plan: '1. Add the dialog\n2. Test it' } },
          { tool_name: 'Bash', tool_input: { command: 'curl x' } }
        ]
      })
    )
    const result = updates.find((u) => u.result)!
    expect(result.result!.text).toBe('1. Add the dialog\n2. Test it')
    expect(result.result!.denials).toEqual([{ tool: 'Bash', input: '{"command":"curl x"}' }])
  })

  it('records the mode and capabilities of a turn and gives the adapter the project options', async () => {
    const repo = join(tmp, 'repo')
    execFileSync('git', ['init', '-q', repo])
    const projects = new ProjectService(join(tmp, 'appdata'))
    const projectId = (await projects.importFolder(repo)).id
    await projects.updateConfig(projectId, { agent: { claude: { model: 'haiku' } } })
    const seen: InvocationOptions[] = []
    const fixture = join(__dirname, 'fixtures', 'stand-in-agent.mjs')
    const adapter: AgentAdapter = {
      id: 'claude',
      label: 'Stand-in',
      policySummary: 'test',
      detect: async () => ({ id: 'claude', label: 'Stand-in', installed: true, executable: process.execPath, version: 't', authenticated: true, adapterAvailable: true, detail: '', policy: 't' }),
      buildInvocation: (opts) => (seen.push(opts), { command: opts.executable, args: [fixture, 'ok'], stdin: opts.prompt, env: process.env }),
      createParser: () => ({ parseLine: parseClaudeLine })
    }
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [adapter] })
    const finished = new Promise<RunSummary>((r) => sup.on('update', (s) => s.endedAt && r(s)))
    await sup.start(projectId, 'how would you add a dialog?', 'claude', { mode: 'plan' })
    const final = await finished
    expect(final.mode).toBe('plan')
    expect(final.capabilities?.model).toBe('stand-in')
    expect(seen[0].mode).toBe('plan')
    expect(seen[0].claude).toEqual({ model: 'haiku', effort: '', tools: ['Task', 'Skill'] })
    expect(seen[0].policy.appendSystemPrompt).toMatch(/plan mode/)
    await expect(sup.start(projectId, 'x', 'claude', { mode: 'yolo' as never })).rejects.toThrow(/mode/)
  })
})

const project = (enabled: string[]): Project => ({
  id: 'p1',
  path: '/work/site',
  addedAt: '',
  status: 'ok',
  config: {
    schemaVersion: 1,
    name: 'site',
    components: ['website'],
    target: 'web',
    website: { devCommand: '', previewUrl: '' },
    agent: { provider: 'auto', enabledMcpServers: enabled, claude: { model: '', effort: '', tools: [] } },
    worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
    protocol: { checkCommand: '', maxReviewRounds: 2, review: { model: '', effort: '' } },
    marketing: { enabled: true }
  }
})
const remote = (over: Partial<McpServerDef>): McpServerDef => ({
  id: 'docs',
  label: 'Docs',
  description: '',
  builtin: false,
  transport: 'http',
  command: '',
  args: [],
  env: {},
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': 'web' },
  secretEnv: ['DOCS_TOKEN'],
  ...over
})

describe('Remote MCP servers', () => {
  it('validates URLs, headers and the secrets they reference', () => {
    expect(validateDef(remote({}))).toMatchObject({ transport: 'http', command: '', url: 'https://mcp.example.com/mcp' })
    expect(() => validateDef(remote({ url: 'file:///etc/passwd' }))).toThrow(/http/)
    expect(() => validateDef(remote({ secretEnv: [] }))).toThrow(/DOCS_TOKEN/)
    expect(() => validateDef(remote({ headers: { 'X-Evil': 'a\r\nHost: b' } }))).toThrow(/header/)
    // Old registry entries without a transport are stdio servers.
    expect(validateDef({ id: 'a', label: 'A', description: '', builtin: false, command: 'x', args: [], env: {}, secretEnv: [] }).transport).toBe('stdio')
  })

  it('translates remote servers for both CLIs without putting secrets in argv', () => {
    const servers: ResolvedMcpServer[] = [
      { id: 'docs', transport: 'http', command: '', args: [], env: {}, url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Key': '${DOCS_KEY}', 'X-Team': 'web' }, secretEnv: ['DOCS_TOKEN', 'DOCS_KEY'] }
    ]
    expect(claudeMcpConfig(servers).mcpServers.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headers: servers[0].headers })
    expect(codexMcpArgs(servers)).toEqual([
      '-c', 'mcp_servers.docs.url="https://mcp.example.com/mcp"',
      '-c', 'mcp_servers.docs.bearer_token_env_var="DOCS_TOKEN"',
      '-c', 'mcp_servers.docs.http_headers={ "X-Team" = "web" }',
      '-c', 'mcp_servers.docs.env_http_headers={ "X-Key" = "DOCS_KEY" }',
      '-c', 'mcp_servers.docs.default_tools_approval_mode="approve"',
      '-c', 'shell_environment_policy.exclude=["DOCS_TOKEN","DOCS_KEY"]'
    ])
  })

  it('leaves out servers a provider cannot use, with the reason', async () => {
    const secrets = new MemorySecrets()
    const reg = new McpRegistry(tmp, secrets)
    await reg.upsert(remote({ id: 'legacy', transport: 'sse' }))
    await reg.upsert(remote({ id: 'templ', headers: { 'X-Auth': 'token=${DOCS_TOKEN}' } }))
    await secrets.set('legacy', 'DOCS_TOKEN', 't')
    await secrets.set('templ', 'DOCS_TOKEN', 't')
    const p = project(['legacy', 'templ'])
    expect((await reg.effective(p, 'claude')).servers.map((s) => s.included)).toEqual([true, true])
    const codex = (await reg.effective(p, 'codex')).servers
    expect(codex.map((s) => s.included)).toEqual([false, false])
    expect(codex[0].reason).toMatch(/SSE/)
    expect((await reg.resolveForRun(p, { appRoot: '/app', node: { command: 'node', env: {} }, artifactsDir: '/a', provider: 'codex' })).servers).toEqual([])
    const forClaude = await reg.resolveForRun(p, { appRoot: '/app', node: { command: 'node', env: {} }, artifactsDir: '/a', provider: 'claude' })
    expect(forClaude.servers.map((s) => s.id)).toEqual(['legacy', 'templ'])
    expect(forClaude.secretEnv).toEqual({ DOCS_TOKEN: 't' })
  })
})

describe('Checking an MCP server', () => {
  it('lists the tools of a stdio server', async () => {
    const res = await checkMcpServer(
      { id: 'health', transport: 'stdio', command: process.execPath, args: [resolve(__dirname, '..', 'mcp', 'thinkerer-health.mjs')], env: { THINKERER_PROJECT_ROOT: tmp }, url: '', headers: {}, secretEnv: [] },
      {},
      { cwd: tmp, env: process.env }
    )
    expect(res).toMatchObject({ ok: true, serverInfo: expect.stringMatching(/^thinkerer-health/), error: null })
    expect(res.tools.map((t) => t.name)).toEqual(['project_health'])
  })

  it('reports a server that cannot start', async () => {
    const res = await checkMcpServer({ id: 'x', transport: 'stdio', command: join(tmp, 'missing'), args: [], env: {}, url: '', headers: {}, secretEnv: [] }, {}, { cwd: tmp, env: process.env, timeoutMs: 5000 })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/start|exited/)
  })

  describe('over streamable HTTP', () => {
    let server: Server
    let seenAuth: (string | undefined)[]
    beforeEach(async () => {
      seenAuth = []
      server = createServer((req, res) => {
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          seenAuth.push(req.headers.authorization)
          if (req.headers.authorization !== 'Bearer s3cret') return void res.writeHead(401).end()
          const msg = JSON.parse(body)
          if (!('id' in msg)) return void res.writeHead(202).end()
          const result =
            msg.method === 'initialize'
              ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '2.0' } }
              : { tools: [{ name: 'search_docs', description: 'Search' }] }
          // Reply as an SSE stream for tools/list, like many servers do.
          if (msg.method === 'tools/list') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' })
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`)
          } else {
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
          }
        })
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    })
    afterEach(() => new Promise<void>((r) => server.close(() => r())))

    it('connects with secret headers and lists tools', async () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
      const def: ResolvedMcpServer = { id: 'docs', transport: 'http', command: '', args: [], env: {}, url, headers: { Authorization: 'Bearer ${DOCS_TOKEN}' }, secretEnv: ['DOCS_TOKEN'] }
      const ok = await checkMcpServer(def, { DOCS_TOKEN: 's3cret' }, { cwd: tmp, env: process.env })
      expect(ok).toMatchObject({ ok: true, serverInfo: 'docs 2.0', tools: [{ name: 'search_docs', description: 'Search' }] })
      const denied = await checkMcpServer(def, { DOCS_TOKEN: 'wrong' }, { cwd: tmp, env: process.env })
      expect(denied).toMatchObject({ ok: false, error: expect.stringMatching(/401/) })
      expect(seenAuth).toContain('Bearer s3cret')
    })
  })
})

describe('Importing Claude Code MCP servers', () => {
  it('finds project and user servers and moves secret values out of the definition', async () => {
    const repo = join(tmp, 'repo')
    const home = join(tmp, 'home')
    mkdirSync(repo)
    mkdirSync(home)
    writeFileSync(
      join(repo, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          GitHub: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}', LOG_LEVEL: 'info' } },
          websock: { type: 'ws', url: 'ws://x' }
        }
      })
    )
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'Linear Docs': { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_123', 'X-Org': 'acme' } } },
        projects: { [repo]: { mcpServers: { notes: { command: 'notes-mcp', env: { NOTES_API_KEY: 'k-1' } } } } }
      })
    )
    const found = await findClaudeMcpServers(repo, home, ['notes'])
    const by = Object.fromEntries(found.map((f) => [f.candidate.name, f]))
    expect(Object.keys(by)).toEqual(['GitHub', 'websock', 'Linear Docs', 'notes'])

    expect(by.GitHub.candidate).toMatchObject({
      source: 'project',
      def: { id: 'github', transport: 'stdio', command: 'npx', env: { LOG_LEVEL: 'info' }, secretEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'] },
      secretsFound: [],
      secretsMissing: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      unsupported: null
    })
    expect(by.websock.candidate.unsupported).toMatch(/ws/)
    expect(by['Linear Docs'].candidate.def).toMatchObject({ id: 'linear-docs', transport: 'http', headers: { Authorization: 'Bearer ${LINEAR_DOCS_TOKEN}', 'X-Org': 'acme' } })
    expect(by['Linear Docs'].secrets).toEqual({ LINEAR_DOCS_TOKEN: 'lin_123' })
    expect(by.notes.candidate).toMatchObject({ source: 'user-project', exists: true, secretsFound: ['NOTES_API_KEY'] })
    // What goes to the renderer never contains a secret value.
    expect(JSON.stringify(found.map((f) => f.candidate))).not.toMatch(/lin_123|k-1/)
    // And it is accepted by the registry as is.
    const reg = new McpRegistry(join(tmp, 'appdata'), new MemorySecrets())
    await expect(reg.upsert(by['Linear Docs'].candidate.def)).resolves.toMatchObject({ id: 'linear-docs' })
  })

  it('turns any name into a valid server id', () => {
    expect(toServerId('My Server!')).toBe('my-server')
    expect(toServerId('42-things')).toBe('things')
    expect(toServerId('@@@')).toBe('server')
  })
})

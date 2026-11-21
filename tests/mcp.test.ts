import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeMcpConfig } from '../engine/agents/claude'
import { codexMcpArgs } from '../engine/agents/codex'
import { BoardService } from '../engine/board'
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
    agent: { provider: 'auto', enabledMcpServers: enabled, claude: { model: '', effort: '', tools: [] } },
    worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
    protocol: { checkCommand: '', maxReviewRounds: 2, review: { model: '', effort: '' } },
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
    expect((await reg.list()).map((s) => s.id)).toEqual(['playwright', 'health', 'mobile', 'board'])
    const { servers } = await reg.resolveForRun(project(['playwright']), ctx)
    expect(servers).toHaveLength(1)
    const pw = servers[0]
    expect(pw.command).toBe('/usr/bin/node')
    expect(pw.args).toEqual(expect.arrayContaining(['/app/mcp/playwright-launch.mjs', '/data/runs/r1-artifacts', '--headless', '--isolated', '--allowed-origins', 'http://localhost:5174']))
    expect(pw.args.join(' ')).not.toMatch(/\{\w+\}/)
  })

  it('resolves the mobile server with the run artifacts, project and preview', async () => {
    const { servers } = await reg.resolveForRun(project(['mobile']), { ...ctx, cwd: '/work/tree' })
    expect(servers).toEqual([
      {
        id: 'mobile',
        transport: 'stdio',
        command: '/usr/bin/node',
        args: ['/app/mcp/thinkerer-mobile.mjs'],
        env: { THINKERER_ARTIFACTS: '/data/runs/r1-artifacts', THINKERER_PROJECT_ROOT: '/work/tree', THINKERER_PREVIEW_URL: 'http://localhost:5174/' },
        url: '',
        headers: {},
        secretEnv: []
      }
    ])
    // A chat run limits the server to the chat's own devices (an empty list means none).
    const chat = await reg.resolveForRun(project(['mobile']), { ...ctx, devices: ['ios:AAA', 'android:Thinkerer_x'] })
    expect(chat.servers[0].env.THINKERER_DEVICES).toBe('ios:AAA,android:Thinkerer_x')
    expect((await reg.resolveForRun(project(['mobile']), { ...ctx, devices: [] })).servers[0].env.THINKERER_DEVICES).toBe('')
  })

  it('points the board server at the main project folder, not the chat worktree, with the chat and task', async () => {
    const { servers } = await reg.resolveForRun(project(['board']), { ...ctx, cwd: '/work/tree', chatId: 'chat-1', taskId: 'task-1' })
    expect(servers[0]).toMatchObject({
      id: 'board',
      command: '/usr/bin/node',
      args: ['--no-warnings', '/app/mcp/thinkerer-board.mjs'],
      env: { THINKERER_BOARD_ROOT: '/work/site', THINKERER_CHAT_ID: 'chat-1', THINKERER_TASK_ID: 'task-1' }
    })
    expect((await reg.resolveForRun(project(['board']), ctx)).servers[0].env).toMatchObject({ THINKERER_CHAT_ID: '', THINKERER_TASK_ID: '' })
  })

  it('runs the board server with Thinkerer’s own Node (it needs node:sqlite), the other scripts with node', async () => {
    const withApp = { ...ctx, appNode: { command: '/Apps/Thinkerer', env: { ELECTRON_RUN_AS_NODE: '1' } } }
    const { servers } = await reg.resolveForRun(project(['board', 'health']), withApp)
    expect(servers[0]).toMatchObject({ id: 'board', command: '/Apps/Thinkerer', env: { ELECTRON_RUN_AS_NODE: '1', THINKERER_BOARD_ROOT: '/work/site' } })
    expect(servers[1]).toMatchObject({ id: 'health', command: '/usr/bin/node' })
    expect(servers[1].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
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
      { id: 'health', transport: 'stdio', command: 'node', args: ['/app/mcp/thinkerer-health.mjs'], env: { THINKERER_PROJECT_ROOT: '/work/site' }, url: '', headers: {}, secretEnv: [] },
      { id: 'notes', transport: 'stdio', command: 'npx', args: ['notes-mcp'], env: {}, url: '', headers: {}, secretEnv: ['NOTES_TOKEN'] }
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

/** The parts of a JSON-RPC reply these tests read. */
interface RpcReply {
  id: number | null
  result?: { content?: { type: string; text: string }[]; isError?: boolean; serverInfo?: { name: string }; tools?: { name: string }[] }
  error?: { code: number; message: string }
}

/** A stdio MCP session: `call` sends one request and resolves with its reply. */
function mcpSession(script: string, env: Record<string, string>, runtime = process.execPath) {
  const child = spawn(runtime, ['--no-warnings', resolve(__dirname, '..', 'mcp', script)], { env: { ...process.env, ...env } })
  const waiting = new Map<number, (msg: RpcReply) => void>()
  let buf = ''
  let id = 0
  child.stdout.on('data', (d) => {
    buf += d
    for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) {
      const msg = JSON.parse(buf.slice(0, nl)) as RpcReply
      if (msg.id !== null) waiting.get(msg.id)?.(msg)
    }
  })
  const request = (method: string, params: object = {}) =>
    new Promise<RpcReply>((done, fail) => {
      const n = ++id
      const timer = setTimeout(() => fail(new Error(`timeout: ${method}`)), 10_000)
      waiting.set(n, (msg) => (clearTimeout(timer), done(msg)))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    })
  const tool = async (name: string, args: object = {}) => {
    const reply = await request('tools/call', { name, arguments: args })
    const text = reply.result?.content?.[0]?.text ?? ''
    const isError = reply.result?.isError === true
    return { isError, text, value: isError ? null : JSON.parse(text) }
  }
  return { request, tool, close: () => child.kill() }
}

describe('thinkerer-board MCP server', () => {
  it('lets an agent read its task and work the board, as itself, in the app’s board', async () => {
    const board = new BoardService(20)
    const task = board.create(dir, { kind: 'task', title: 'Wire the sensor', criteria: [{ text: 'reads 3.3 V', done: false }] })
    board.runStarted(dir, task.id, 'chat-1', 'run-1')
    const seen: string[] = []
    board.on('change', (p) => seen.push(p))
    const s = mcpSession('thinkerer-board.mjs', { THINKERER_BOARD_ROOT: dir, THINKERER_CHAT_ID: 'chat-1', THINKERER_TASK_ID: task.id })
    try {
      expect((await s.request('initialize', { protocolVersion: '2025-06-18' })).result?.serverInfo?.name).toBe('thinkerer-board')
      const tools = ((await s.request('tools/list')).result?.tools ?? []).map((t) => t.name)
      expect(tools).toEqual(['board_overview', 'board_list', 'board_get', 'board_current_task', 'board_create', 'board_update', 'board_check', 'board_archive', 'board_unarchive'])
      expect(tools.some((t: string) => /delete|remove/.test(t))).toBe(false)

      expect((await s.tool('board_current_task')).value).toMatchObject({ key: 'T-1', title: 'Wire the sensor', status: 'doing', criteria: ['1. [ ] reads 3.3 V'] })
      const epic = (await s.tool('board_create', { kind: 'epic', title: 'Sensor board', type: 'electronics', criteria: ['ERC clean'] })).value
      expect(epic).toMatchObject({ key: 'E-1', type: 'electronics', criteria: ['1. [ ] ERC clean'] })
      const follow = (await s.tool('board_create', { kind: 'task', title: 'Order parts', epic: 'E-1', blockedBy: ['T-1'] })).value
      expect(follow).toMatchObject({ key: 'T-2', epic: 'E-1', type: 'electronics', blockedBy: ['T-1'] })
      expect((await s.tool('board_check', { key: 'T-1', index: 1, done: true })).value.criteria).toEqual(['1. [x] reads 3.3 V'])
      expect((await s.tool('board_update', { key: 'T-1', epic: 'E-1', status: 'review' })).value).toMatchObject({ epic: 'E-1', status: 'review' })
      expect((await s.tool('board_archive', { key: 'T-2' })).value).toMatchObject({ key: 'T-2', archived: true })
      expect((await s.tool('board_list', { kind: 'task' })).value.map((t: { key: string }) => t.key)).toEqual(['T-1'])
      expect((await s.tool('board_list', { archived: true })).value.map((t: { key: string }) => t.key)).toEqual(['T-2'])
      const overview = (await s.tool('board_overview')).value
      expect(overview).toMatchObject({ epics: [{ key: 'E-1', progress: '0/1 tasks done' }], openTasks: ['T-1 [review] Wire the sensor (E-1)'], doneTasks: 0 })

      const bad = await s.tool('board_update', { key: 'T-1', status: 'shipped' })
      expect(bad).toMatchObject({ isError: true, text: expect.stringMatching(/Invalid task status/) })
      expect((await s.tool('board_get', { key: 'T-99' })).isError).toBe(true)
      expect((await s.tool('board_check', { key: 'T-1', index: 5, done: true })).text).toMatch(/index must be 1–1/)
      // Errors name fields as the agent knows them, and nothing is dropped silently.
      expect(await s.tool('board_create', { kind: 'task', title: 'Order the case', milestone: 'M-1' })).toMatchObject({ isError: true, text: "milestone can't be set on a task" })
      expect((await s.tool('board_update', { key: 'T-1', epic: 'E-1', status: 'review' })).isError).toBe(false)
      await s.tool('board_archive', { key: 'E-1' })
      expect((await s.tool('board_create', { kind: 'task', title: 'Late', epic: 'E-1' })).text).toMatch(/E-1 is archived; restore it first/)
    } finally {
      s.close()
    }
    // The app sees the agent's writes, attributed to its chat, and is told about them.
    const t1 = board.board(dir).tasks.find((t) => t.key === 'T-1')!
    expect(t1).toMatchObject({ status: 'review', criteria: [{ text: 'reads 3.3 V', done: true }] })
    expect(board.history(dir, 'T-1')[0].source).toBe('agent:chat-1')
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toContain(dir)
    board.close()
  })

  it('runs under Electron as Node, as the app launches it for agents', async () => {
    const electron = createRequire(__filename)('electron') as string
    const s = mcpSession('thinkerer-board.mjs', { ELECTRON_RUN_AS_NODE: '1', THINKERER_BOARD_ROOT: dir, THINKERER_CHAT_ID: 'chat-e' }, electron)
    try {
      expect((await s.tool('board_create', { kind: 'task', title: 'From Electron' })).value).toMatchObject({ key: 'T-1' })
    } finally {
      s.close()
    }
    const board = new BoardService()
    expect(board.board(dir).tasks.map((t) => t.title)).toEqual(['From Electron'])
    board.close()
  })

  it('says so when it runs outside Thinkerer', async () => {
    const s = mcpSession('thinkerer-board.mjs', { THINKERER_BOARD_ROOT: '' })
    try {
      expect((await s.tool('board_overview')).text).toMatch(/runs inside Thinkerer/)
    } finally {
      s.close()
    }
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

describe('thinkerer-mobile MCP server', () => {
  it('lists its tools, reports devices and rejects bad device ids', async () => {
    const child = spawn(process.execPath, [resolve(__dirname, '..', 'mcp', 'thinkerer-mobile.mjs')], {
      env: { ...process.env, THINKERER_ARTIFACTS: join(dir, 'art'), THINKERER_PROJECT_ROOT: dir }
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
    send({ id: 2, method: 'tools/list' })
    send({ id: 3, method: 'tools/call', params: { name: 'mobile_list_devices', arguments: {} } })
    send({ id: 4, method: 'tools/call', params: { name: 'mobile_tap', arguments: { device: 'windows:nope; rm -rf /', x: 1, y: 1 } } })
    send({ id: 5, method: 'tools/call', params: { name: 'mobile_launch_app', arguments: { device: 'android:x', app_id: 'a;b' } } })
    const deadline = Date.now() + 30_000
    while (![1, 2, 3, 4, 5].every((i) => replies[i])) {
      if (Date.now() > deadline) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 20))
    }
    child.kill()
    expect(replies[1].result.serverInfo.name).toBe('thinkerer-mobile')
    const names = replies[2].result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['mobile_list_devices', 'mobile_boot', 'mobile_screenshot', 'mobile_tap', 'mobile_swipe', 'mobile_type', 'mobile_describe_ui', 'mobile_open_url', 'mobile_install_app', 'mobile_launch_app']))
    expect(replies[2].result.tools.every((t: { inputSchema?: { type: string } }) => t.inputSchema?.type === 'object')).toBe(true)
    // Agents can only boot headless: no option to open a desktop window.
    const boot = replies[2].result.tools.find((t: { name: string }) => t.name === 'mobile_boot')
    expect(Object.keys(boot.inputSchema.properties)).toEqual(['device'])
    const listed = JSON.parse(replies[3].result.content[0].text)
    expect(listed.tools).toHaveProperty('android.available')
    expect(listed.tools).toHaveProperty('ios.available')
    expect(Array.isArray(listed.devices)).toBe(true)
    expect(replies[4].result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Invalid device id/) }] })
    expect(replies[5].result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Invalid app id/) }] })
  }, 40_000)

  it('only shows and drives the chat’s own devices when THINKERER_DEVICES is set', async () => {
    const child = spawn(process.execPath, [resolve(__dirname, '..', 'mcp', 'thinkerer-mobile.mjs')], {
      env: { ...process.env, THINKERER_ARTIFACTS: join(dir, 'art'), THINKERER_PROJECT_ROOT: dir, THINKERER_DEVICES: 'ios:00000000-0000-0000-0000-000000000000' }
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
    send({ id: 1, method: 'tools/call', params: { name: 'mobile_list_devices', arguments: {} } })
    send({ id: 2, method: 'tools/call', params: { name: 'mobile_shutdown', arguments: { device: 'android:Someone_elses' } } })
    const deadline = Date.now() + 30_000
    while (![1, 2].every((i) => replies[i])) {
      if (Date.now() > deadline) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 20))
    }
    child.kill()
    const listed = JSON.parse(replies[1].result.content[0].text)
    // Real devices on this machine never show up unless they are the chat's.
    expect(listed.devices.every((d: { id: string }) => d.id === 'ios:00000000-0000-0000-0000-000000000000')).toBe(true)
    expect(replies[2].result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not this chat's device/) }] })
  }, 40_000)
})

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeAdapter, parseClaudeLine } from '../engine/agents/claude'
import { AgentSupervisor, MAX_PARALLEL_RUNS } from '../engine/agents/supervisor'
import { blockedCommand, type AgentAdapter, type InvocationOptions } from '../engine/agents/types'
import { attachmentRelPath, saveAttachment } from '../engine/attachments'
import { restoreCheckpoint } from '../engine/checkpoints'
import { ChatDevices } from '../engine/chatDevices'
import { McpRegistry } from '../engine/mcp'
import { ProjectService } from '../engine/projects'
import { BoardService } from '../engine/board'
import type { ProviderId, RunSummary } from '../shared/types'

// Supervisor lifecycle tests use a stand-in process (tests/fixtures/stand-in-agent.mjs)
// that speaks the Claude stream-json format. Real CLI coverage: tests/claude.live.test.ts.

const FIXTURE = join(__dirname, 'fixtures', 'stand-in-agent.mjs')

/** In 'hang' mode each run writes its grandchild's pid to `${pidFile}.<n>` (n = 0, 1, …). */
function standIn(mode: 'ok' | 'hang', pidFile = '', seen?: InvocationOptions[], id: ProviderId = 'claude'): AgentAdapter {
  let n = 0
  return {
    id,
    label: 'Stand-in',
    policySummary: 'test',
    detect: async () => ({ id, label: 'Stand-in', installed: true, executable: process.execPath, version: 'test', authenticated: true, adapterAvailable: true, detail: '', policy: 'test' }),
    buildInvocation: (opts) => {
      seen?.push(opts)
      return { command: opts.executable, args: [FIXTURE, mode, pidFile && `${pidFile}.${n++}`], stdin: opts.prompt, env: process.env }
    },
    createParser: () => ({ parseLine: parseClaudeLine })
  }
}

let tmp: string
let repo: string
let projects: ProjectService
let projectId: string

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-sup-')))
  repo = join(tmp, 'repo')
  execFileSync('git', ['init', '-q', repo])
  projects = new ProjectService(join(tmp, 'appdata'))
  projectId = (await projects.importFolder(repo)).id
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function waitFor(sup: AgentSupervisor, pred: (s: RunSummary) => boolean): Promise<RunSummary> {
  return new Promise((resolve) => {
    const on = (s: RunSummary) => {
      if (pred(s)) {
        sup.off('update', on)
        resolve(s)
      }
    }
    sup.on('update', on)
  })
}

const done = (s: RunSummary) => !!s.endedAt

describe('AgentSupervisor', () => {
  // These repos have no commits, so there's nothing to start a worktree from: chats
  // work in the project folder (worktree chats: tests/worktrees.test.ts).
  it('runs in the project folder, records the run, and captures git changes', async () => {
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok')] })
    const finished = waitFor(sup, done)
    const started = await sup.start(projectId, 'hello from prompt', 'auto')
    expect(started.selection.rationale).toMatch(/configured preference/)
    const final = await finished

    expect(final.status).toBe('succeeded')
    expect(final.cwd).toBe(repo)
    expect(readFileSync(join(repo, 'made.txt'), 'utf8')).toBe('hello from prompt')
    expect((await sup.chats.get(final.id))).toMatchObject({ state: 'active', worktree: null, notes: [expect.objectContaining({ title: 'Working in the project folder' })] })
    expect(final.usage).toMatchObject({ inputTokens: 3, outputTokens: 5 })
    expect(final.gitAfter!.entries.map((e) => e.path)).toContain('made.txt')
    // Checkpoint before, exact changes after, and the run can be rolled back.
    expect(final.checkpoint?.id).toBe(final.id)
    expect(final.changes).toEqual([expect.objectContaining({ status: 'A', path: 'made.txt' })])
    await restoreCheckpoint(repo, final.checkpoint!.id)
    expect(existsSync(join(repo, 'made.txt'))).toBe(false)

    const persisted = await sup.getRun(final.id)
    expect(persisted!.events.some((e) => e.kind === 'tool-use')).toBe(true)
    // A new supervisor (as after an app restart) still sees the history.
    const history = await new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok')] }).listRuns(projectId)
    expect(history.map((r) => r.id)).toEqual([final.id])
  })

  it('runs chats in parallel, records the overlap, and cancels each process tree independently', async () => {
    const pidFile = join(tmp, 'grandchild.pid')
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('hang', pidFile)] })
    const first = await sup.start(projectId, 'first', 'claude')
    const second = await sup.start(projectId, 'second', 'claude')
    expect(sup.activeRuns(projectId).map((r) => r.id)).toEqual([first.id, second.id])
    expect(second.concurrentRunIds).toEqual([first.id])
    expect((await sup.getRun(first.id))!.concurrentRunIds).toEqual([second.id])

    // Starts racing each other still respect the cap.
    const extra = await Promise.allSettled([1, 2, 3].map((i) => sup.start(projectId, `extra ${i}`, 'claude')))
    expect(extra.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_PARALLEL_RUNS - 2)
    expect(extra.find((r) => r.status === 'rejected')).toMatchObject({ reason: { message: /already has 4 agent runs/ } })
    const pids = await Promise.all(
      [0, 1].map(async (i) => {
        while (!existsSync(`${pidFile}.${i}`)) await new Promise((r) => setTimeout(r, 20))
        return Number(readFileSync(`${pidFile}.${i}`, 'utf8'))
      })
    )

    // Stopping one chat leaves the other running.
    const firstDone = waitFor(sup, (s) => s.id === first.id && done(s))
    expect(sup.cancel(first.id)).toBe(true)
    expect((await firstDone).status).toBe('cancelled')
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(pids[0], 0)).toThrow() // first grandchild is gone too
    expect(() => process.kill(pids[1], 0)).not.toThrow()
    expect(sup.activeRuns(projectId).map((r) => r.id)).toContain(second.id)

    let left = sup.activeRuns(projectId).length
    const allDone = new Promise<void>((resolve) => sup.on('update', (s) => done(s) && --left === 0 && resolve()))
    sup.cancelAll()
    await allDone
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(pids[1], 0)).toThrow()
    expect(sup.hasActiveRuns()).toBe(false)
  })

  it('continues a chat: follow-ups resume the provider session and keep the chat, provider and task', async () => {
    const board = new BoardService()
    const task = board.create(repo, { kind: 'task', title: 'Chat task' })
    const seen: InvocationOptions[] = []
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok', '', seen)], board })
    let finished = waitFor(sup, done)
    const first = await sup.start(projectId, 'first message', 'auto', { taskId: task.id })
    const firstDone = await finished
    expect(first.chatId).toBe(first.id)
    expect(firstDone.sessionId).toMatch(/^session-\d+$/)
    expect(seen[0].resumeSessionId).toBeNull()

    finished = waitFor(sup, done)
    const second = await sup.start(projectId, 'follow-up', 'codex', { chatId: first.id })
    const secondDone = await finished
    expect(secondDone).toMatchObject({ chatId: first.id, provider: 'claude', taskId: task.id, status: 'succeeded' })
    // Both turns are linked to the task, under one chat.
    expect(board.board(repo).tasks[0]).toMatchObject({ status: 'doing', runIds: [first.id, second.id], chatIds: [first.id] })
    expect(secondDone.selection.rationale).toMatch(/Continuing this chat/)
    expect(seen[1].resumeSessionId).toBe(firstDone.sessionId)
    // Each turn is still its own checkpointed run.
    expect(secondDone.checkpoint?.id).toBe(second.id)

    const chat = await sup.getChat(projectId, first.id)
    expect(chat.map((r) => r.id)).toEqual([first.id, second.id])
    expect(chat[1].events.some((e) => /Continuing the conversation/.test(e.text))).toBe(true)
    // A chat with no turns, or an invalid id, is refused.
    await expect(sup.start(projectId, 'x', 'claude', { chatId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/Chat not found/)
    await expect(sup.start(projectId, 'x', 'claude', { chatId: '../x' })).rejects.toThrow(/Invalid chat/)
  })

  it('refuses a follow-up while the chat is still working', async () => {
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('hang', join(tmp, 'p'))] })
    const first = await sup.start(projectId, 'hang', 'claude')
    await expect(sup.start(projectId, 'more', 'claude', { chatId: first.id })).rejects.toThrow(/still working/)
    const finished = waitFor(sup, done)
    sup.cancel(first.id)
    await finished
  })

  it('refuses a manually selected provider that is unavailable instead of switching silently', async () => {
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok')] })
    await expect(sup.start(projectId, 'x', 'codex')).rejects.toThrow(/Codex is unavailable/)
  })

  it('refuses a slash command the provider blocks, without starting a run or a chat', async () => {
    const seen: InvocationOptions[] = []
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [{ ...standIn('ok', '', seen), blockedCommands: ['clear'] }] })
    await expect(sup.start(projectId, '  /clear', 'claude')).rejects.toThrow(/\/clear isn't available in Thinkerer chats/)
    await expect(sup.start(projectId, '/CLEAR now', 'claude')).rejects.toThrow(/isn't available/)
    expect(seen).toHaveLength(0)
    expect(await sup.listRuns(projectId)).toEqual([])
    // Mentioning the command is fine; only a message that starts with it is refused.
    const finished = waitFor(sup, done)
    await sup.start(projectId, 'explain what /clear does', 'claude')
    expect((await finished).status).toBe('succeeded')
    expect(blockedCommand({ blockedCommands: ['clear'] }, '/clearly')).toBeNull()
    expect(blockedCommand(claudeAdapter, '/clear')).toBe('clear')
    // Claude Code's aliases of /clear.
    expect(blockedCommand(claudeAdapter, '/reset')).toBe('reset')
    expect(blockedCommand(claudeAdapter, '/new task')).toBe('new')
    expect(blockedCommand(claudeAdapter, '/newsletter')).toBeNull()
  })

  it('marks runs interrupted by an app exit as failed', async () => {
    const appData = join(tmp, 'appdata')
    const sup = new AgentSupervisor(appData, projects, { adapters: [standIn('hang', join(tmp, 'p'))] })
    const running = waitFor(sup, (s) => s.status === 'running')
    const run = await sup.start(projectId, 'hang', 'claude')
    await running
    const afterCrash = await new AgentSupervisor(appData, projects).listRuns(projectId)
    expect(afterCrash[0]).toMatchObject({ id: run.id, status: 'failed', error: /exited/ })
    const finished = waitFor(sup, done)
    sup.cancel(run.id)
    await finished
  })

  it('refuses to run in a folder that is not a Git repository', async () => {
    const plain = join(tmp, 'plain')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(plain)
    const id = (await projects.importFolder(plain)).id
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok')] })
    await expect(sup.start(id, 'x', 'claude')).rejects.toThrow(/not a Git repository/)
  })

  it('links runs to tasks and gives the adapter the project-approved MCP servers', async () => {
    const board = new BoardService()
    const task = board.create(repo, { kind: 'task', title: 'Do the thing' })
    await projects.updateConfig(projectId, { agent: { enabledMcpServers: ['health'] } })
    const seen: InvocationOptions[] = []
    const registry = new McpRegistry(join(tmp, 'appdata'), { get: async () => null, set: async () => {}, names: async () => [] })
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, {
      adapters: [standIn('ok', '', seen)],
      board,
      mcp: { registry, context: async () => ({ appRoot: '/app', node: { command: 'node', env: {} } }) }
    })
    const finished = waitFor(sup, done)
    await sup.start(projectId, 'go', 'claude', { taskId: task.id })
    const final = await finished
    expect(final.taskId).toBe(task.id)
    expect(final.mcpServers).toEqual(['health'])
    expect(seen[0].mcp.map((s) => s.id)).toEqual(['health'])
    expect(seen[0].mcp[0].env.THINKERER_PROJECT_ROOT).toBe(repo)
    expect(seen[0].policy.appendSystemPrompt).toMatch(/health MCP server/)
    // No mobile server enabled: the agent is still told to keep emulators headless, inside Thinkerer.
    expect(seen[0].policy.appendSystemPrompt).toMatch(/emulator -avd <name> -no-window/)
    expect(seen[0].policy.appendSystemPrompt).toMatch(/Never open a device window yourself/)
    expect(board.board(repo).tasks[0]).toMatchObject({ status: 'doing', runIds: [final.id], chatIds: [final.id] })
    board.close()
  })

  it('tells the agent to skip the browser check when the preview is down, and starts it when it can', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_q, r) => r.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const up = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    // A port nothing listens on: bind one, read it, release it.
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const down = `http://127.0.0.1:${(probe.address() as { port: number }).port}`
    await new Promise((r) => probe.close(r))
    await projects.updateConfig(projectId, { agent: { enabledMcpServers: ['playwright'] } })
    const registry = new McpRegistry(join(tmp, 'appdata'), { get: async () => null, set: async () => {}, names: async () => [] })
    const mcp = { registry, context: async () => ({ appRoot: '/app', node: { command: 'node', env: {} } }) }
    const prompt = async (url: string, devServers?: { ensureRunning: () => Promise<boolean> }, mode: 'auto' | 'plan' = 'auto') => {
      await projects.updateConfig(projectId, { website: { previewUrl: url } })
      const seen: InvocationOptions[] = []
      const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok', '', seen)], mcp, devServers })
      const finished = waitFor(sup, done)
      await sup.start(projectId, 'go', 'claude', { mode })
      await finished
      expect(seen[0].mcp.map((s) => s.id)).toContain('playwright')
      return seen[0].policy.appendSystemPrompt
    }
    try {
      const skipped = await prompt(down)
      expect(skipped).toContain(`The preview at ${down} is not running, so skip the browser check`)
      expect(skipped).not.toContain('use the playwright MCP tools')

      let asked = 0
      // A read-only turn does not start (and wait for) a dev server.
      const planned = await prompt(down, { ensureRunning: async () => (asked++, true) }, 'plan')
      expect(asked).toBe(0)
      expect(planned).toContain('skip the browser check')

      const started = await prompt(down, { ensureRunning: async () => (asked++, true) })
      expect(asked).toBe(1)
      expect(started).toContain(`use the playwright MCP tools against ${down}`)

      const running = await prompt(up, { ensureRunning: async () => (asked++, false) })
      expect(asked).toBe(1) // already up: nothing started
      expect(running).toContain(`use the playwright MCP tools against ${up}`)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('hands the project’s AGENTS.md and CLAUDE.md to both providers and records which it gave', async () => {
    writeFileSync(join(repo, 'AGENTS.md'), 'Rule from AGENTS: always write tests.')
    writeFileSync(join(repo, 'CLAUDE.md'), '@AGENTS.md\n')
    for (const provider of ['claude', 'codex'] as const) {
      const seen: InvocationOptions[] = []
      const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok', '', seen, provider)] })
      const finished = waitFor(sup, done)
      await sup.start(projectId, 'go', provider)
      const final = await finished
      expect(final.provider).toBe(provider)
      expect(seen[0].policy.appendSystemPrompt).toContain('Rule from AGENTS: always write tests.')
      expect(seen[0].policy.appendSystemPrompt.match(/Rule from AGENTS/g)).toHaveLength(1)
      expect(final.instructionFiles).toEqual(['AGENTS.md', 'CLAUDE.md'])
    }
  })

  it('gives a run the chat’s own emulators and limits the mobile server to them', async () => {
    await projects.updateConfig(projectId, { agent: { enabledMcpServers: ['mobile'] } })
    const listed = [{ id: 'ios:BASE', platform: 'ios' as const, name: 'iPhone 17 Pro', kind: 'simulator' as const, state: 'shutdown' as const, detail: 'iOS 26.5', input: true }]
    const devices = new ChatDevices(join(tmp, 'appdata'), {
      list: async () => listed,
      available: () => ({ ios: true, android: false }),
      create: async () => {
        listed.push({ ...listed[0], id: 'ios:OWNED', name: 'Thinkerer · go' })
        return 'ios:OWNED'
      },
      remove: async () => true,
      isOwned: (d) => d.id === 'ios:OWNED'
    })
    const seen: InvocationOptions[] = []
    const registry = new McpRegistry(join(tmp, 'appdata'), { get: async () => null, set: async () => {}, names: async () => [] })
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, {
      adapters: [standIn('ok', '', seen)],
      devices,
      mcp: { registry, context: async () => ({ appRoot: '/app', node: { command: 'node', env: {} } }) }
    })
    const finished = waitFor(sup, done)
    await sup.start(projectId, 'go', 'claude')
    await finished
    expect(seen[0].mcp[0].env.THINKERER_DEVICES).toBe('ios:OWNED')
    expect(seen[0].policy.appendSystemPrompt).toMatch(/This chat has its own devices, which only it uses: ios:OWNED/)
  })

  it('hands preview screenshots to the agent without them reaching Git, and keeps a copy with the run', async () => {
    const id = await saveAttachment(repo, Buffer.from('fake png'))
    const attachment = { id, url: 'http://localhost:5174/pricing', consoleErrors: ['TypeError: x is undefined'], at: new Date().toISOString() }
    const seen: InvocationOptions[] = []
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok', '', seen)] })
    const finished = waitFor(sup, done)
    await sup.start(projectId, 'fix this', 'claude', { attachments: [attachment] })
    const final = await finished

    expect(final.status).toBe('succeeded')
    expect(final.prompt).toBe('fix this')
    expect(seen[0].prompt).toContain(`Screenshot: ${attachmentRelPath(id)}`)
    expect(seen[0].prompt).toContain('Page: http://localhost:5174/pricing')
    expect(seen[0].prompt).toContain('TypeError: x is undefined')
    expect(final.attachments).toEqual([attachment])
    // Ignored by Git: not part of the run's changes, and removed from the project afterwards.
    expect(final.changes!.map((c) => c.path)).toEqual(['made.txt'])
    expect(existsSync(join(repo, attachmentRelPath(id)))).toBe(false)
    expect(await sup.attachmentDataUrl(final.id, id)).toBe(`data:image/png;base64,${Buffer.from('fake png').toString('base64')}`)
    await expect(sup.start(projectId, 'x', 'claude', { attachments: [{ ...attachment, id: '../../etc/passwd' }] })).rejects.toThrow(/Invalid attachment/)
  })
})

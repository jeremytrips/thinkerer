import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeLine } from '../engine/agents/claude'
import { AgentSupervisor } from '../engine/agents/supervisor'
import type { AgentAdapter } from '../engine/agents/types'
import { ProjectService } from '../engine/projects'
import type { RunSummary } from '../shared/types'

// Supervisor lifecycle tests use a stand-in process (tests/fixtures/stand-in-agent.mjs)
// that speaks the Claude stream-json format. Real CLI coverage: tests/claude.live.test.ts.

const FIXTURE = join(__dirname, 'fixtures', 'stand-in-agent.mjs')

function standIn(mode: 'ok' | 'hang', pidFile = ''): AgentAdapter {
  return {
    id: 'claude',
    label: 'Stand-in',
    policySummary: 'test',
    detect: async () => ({ id: 'claude', label: 'Stand-in', installed: true, executable: process.execPath, version: 'test', authenticated: true, adapterAvailable: true, detail: '', policy: 'test' }),
    buildInvocation: ({ executable, prompt }) => ({ command: executable, args: [FIXTURE, mode, pidFile], stdin: prompt, env: process.env }),
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
  it('runs in the project folder, records the run, and captures git changes', async () => {
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok')] })
    const finished = waitFor(sup, done)
    const started = await sup.start(projectId, 'hello from prompt', 'auto')
    expect(started.selection.rationale).toMatch(/configured preference/)
    const final = await finished

    expect(final.status).toBe('succeeded')
    expect(readFileSync(join(repo, 'made.txt'), 'utf8')).toBe('hello from prompt')
    expect(final.usage).toMatchObject({ inputTokens: 3, outputTokens: 5 })
    expect(final.gitAfter!.entries.map((e) => e.path)).toContain('made.txt')

    const persisted = await sup.getRun(final.id)
    expect(persisted!.events.some((e) => e.kind === 'tool-use')).toBe(true)
    // A new supervisor (as after an app restart) still sees the history.
    const history = await new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok')] }).listRuns(projectId)
    expect(history.map((r) => r.id)).toEqual([final.id])
  })

  it('allows only one run per project and cancels the whole process tree', async () => {
    const pidFile = join(tmp, 'grandchild.pid')
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('hang', pidFile)] })
    const running = waitFor(sup, (s) => s.currentAction !== null)
    await sup.start(projectId, 'hang', 'claude')
    await running
    await expect(sup.start(projectId, 'second', 'claude')).rejects.toThrow(/already active/)

    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20))
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    const finished = waitFor(sup, done)
    expect(sup.cancel(projectId)).toBe(true)
    const final = await finished
    expect(final.status).toBe('cancelled')

    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(grandchild, 0)).toThrow() // grandchild is gone too
    expect(sup.hasActiveRuns()).toBe(false)
  })

  it('refuses a manually selected provider that is unavailable instead of switching silently', async () => {
    const sup = new AgentSupervisor(join(tmp, 'appdata'), projects, { adapters: [standIn('ok')] })
    await expect(sup.start(projectId, 'x', 'codex')).rejects.toThrow(/Codex is unavailable/)
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
    sup.cancel(projectId)
    await finished
  })
})

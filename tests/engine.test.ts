import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeAdapter, parseClaudeLine } from '../engine/agents/claude'
import { DEFAULT_POLICY } from '../engine/agents/supervisor'
import { listDir, readFilePreview } from '../engine/files'
import { gitStatus } from '../engine/git'
import { ProjectService } from '../engine/projects'

let tmp: string
let appData: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-test-')))
  appData = join(tmp, 'appdata')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function makeRepo(name = 'repo'): string {
  const dir = join(tmp, name)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { electron: '1' } }))
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  return dir
}

describe('ProjectService', () => {
  it('imports a folder, writes .thinkerer/project.json, and survives a restart', async () => {
    const repo = makeRepo()
    const imported = await new ProjectService(appData).importFolder(repo)
    expect(imported.status).toBe('ok')
    expect(imported.config).toMatchObject({ name: 'repo', target: 'electron', components: ['website'] })
    expect(imported.config!.website.devCommand).toBe('npm run dev')
    expect(existsSync(join(repo, '.thinkerer', 'project.json'))).toBe(true)

    // A fresh service instance reads only what is on disk — same as an app restart.
    const reopened = await new ProjectService(appData).list()
    expect(reopened.map((p) => p.id)).toEqual([imported.id])
  })

  it('does not duplicate a folder that is imported twice', async () => {
    const repo = makeRepo()
    const svc = new ProjectService(appData)
    const a = await svc.importFolder(repo)
    const b = await svc.importFolder(join(repo, '.'))
    expect(b.id).toBe(a.id)
    expect(await svc.list()).toHaveLength(1)
  })

  it('keeps an existing project.json on import', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.thinkerer'))
    writeFileSync(join(repo, '.thinkerer', 'project.json'), JSON.stringify({ schemaVersion: 1, name: 'Custom', target: 'web' }))
    const p = await new ProjectService(appData).importFolder(repo)
    expect(p.config!.name).toBe('Custom')
    expect(p.config!.target).toBe('web')
  })

  it('creates a new project folder but refuses to adopt an existing one', async () => {
    const svc = new ProjectService(appData)
    const p = await svc.create(tmp, 'fresh-site')
    expect(p.path).toBe(join(tmp, 'fresh-site'))
    expect(p.config!.name).toBe('fresh-site')
    await expect(svc.create(tmp, 'fresh-site')).rejects.toThrow()
    await expect(svc.create(tmp, '../escape')).rejects.toThrow(/valid folder name/)
  })

  it('validates settings updates', async () => {
    const svc = new ProjectService(appData)
    const p = await svc.importFolder(makeRepo())
    const updated = await svc.updateConfig(p.id, { name: 'Renamed', components: ['website', 'mobile'], agent: { provider: 'claude' } })
    expect(updated.config).toMatchObject({ name: 'Renamed', components: ['website', 'mobile'], agent: { provider: 'claude' } })
    await expect(svc.updateConfig(p.id, { website: { previewUrl: 'https://example.com' } })).rejects.toThrow(/local/)
    await expect(svc.updateConfig(p.id, { target: 'ios' as never })).rejects.toThrow(/target/)
  })

  it('reports a missing folder and removes without touching disk', async () => {
    const svc = new ProjectService(appData)
    const repo = makeRepo('gone')
    const p = await svc.importFolder(repo)
    const kept = makeRepo('kept')
    const q = await svc.importFolder(kept)
    rmSync(repo, { recursive: true })
    expect((await svc.get(p.id)).status).toBe('missing')
    await svc.remove(q.id)
    expect(existsSync(kept)).toBe(true)
    expect((await svc.list()).map((x) => x.id)).toEqual([p.id])
  })
})

describe('read-only file access', () => {
  it('lists directories (dirs first, .git hidden) and previews text', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.git'))
    const entries = await listDir(repo, '')
    expect(entries.map((e) => e.name)).toEqual(['src', 'package.json'])
    expect(await listDir(repo, 'src')).toEqual([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }])
    expect(await readFilePreview(repo, 'src/a.ts')).toMatchObject({ kind: 'text', text: 'export const a = 1\n' })
  })

  it('refuses paths and symlinks that escape the project', async () => {
    const repo = makeRepo()
    writeFileSync(join(tmp, 'secret.txt'), 'nope')
    symlinkSync(join(tmp, 'secret.txt'), join(repo, 'link.txt'))
    await expect(readFilePreview(repo, '../secret.txt')).rejects.toThrow(/outside/)
    await expect(readFilePreview(repo, join(tmp, 'secret.txt'))).rejects.toThrow(/relative/)
    await expect(readFilePreview(repo, 'link.txt')).rejects.toThrow(/outside/)
    await expect(listDir(repo, '..')).rejects.toThrow(/outside/)
  })

  it('does not return binary content', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'img.bin'), Buffer.from([1, 2, 0, 3]))
    expect(await readFilePreview(repo, 'img.bin')).toMatchObject({ kind: 'binary' })
  })
})

describe('git status', () => {
  it('returns null outside a repository and entries inside one', async () => {
    const repo = makeRepo()
    expect(await gitStatus(repo)).toBeNull()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    const status = await gitStatus(repo)
    expect(status!.branch).toBe('main')
    expect(status!.entries.map((e) => e.path).sort()).toEqual(['package.json', 'src/a.ts'])
  })
})

describe('Claude invocation', () => {
  it('runs in auto mode, restricted, with nobody to answer prompts', () => {
    const inv = claudeAdapter.buildInvocation({ executable: '/bin/claude', cwd: '/p', prompt: 'hi', policy: DEFAULT_POLICY, mcp: [], secretEnv: {} })
    expect(inv.args.join(' ')).toContain('--permission-mode auto')
    expect(inv.args.join(' ')).toContain('--permission-prompts none')
    expect(inv.args).toEqual(expect.arrayContaining(['-p', '--restricted', '--strict-mcp-config', 'Bash(npm run *)']))
  })
})

describe('Claude stream-json parsing', () => {
  it('maps CLI messages to run updates and reports only CLI-provided usage', () => {
    const tool = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] } }))
    expect(tool).toEqual([{ event: { kind: 'tool-use', text: 'Edit: src/a.ts', meta: { tool: 'Edit' } }, currentAction: 'Edit: src/a.ts' }])

    const limit = parseClaudeLine(
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.21, resetsAt: 1794936600 } } } })
    )
    expect(limit[0].usage).toEqual({ rateLimitStatus: 'allowed', windows: { five_hour: { utilization: 0.21, resetsAt: new Date(1794936600 * 1000).toISOString() } } })

    const result = parseClaudeLine(JSON.stringify({ type: 'result', is_error: false, result: 'Done', usage: { input_tokens: 4, output_tokens: 9 }, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'curl x' } }] }))
    expect(result[0].result).toEqual({ text: 'Done', isError: false, denials: [{ tool: 'Bash', input: '{"command":"curl x"}' }] })
    expect(result[0].usage).toMatchObject({ inputTokens: 4, outputTokens: 9 })

    expect(parseClaudeLine('not json')).toEqual([{ event: { kind: 'log', text: 'not json' } }])
    expect(parseClaudeLine(JSON.stringify({ type: 'stream_event' }))).toEqual([])
  })

  it('is never given a usage figure the CLI did not send', () => {
    const [r] = parseClaudeLine(JSON.stringify({ type: 'result', is_error: false, result: 'x' }))
    expect(r.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheCreationTokens: undefined })
  })
})


import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeLine } from '../engine/agents/claude'
import { AgentSupervisor } from '../engine/agents/supervisor'
import type { AgentAdapter } from '../engine/agents/types'
import { Approvals } from '../engine/approvals'
import { runChatCommand } from '../engine/chatCommands'
import { ProjectService } from '../engine/projects'
import { allocatePorts, resolvePreviewUrl, runHook, slugify } from '../engine/worktrees'
import type { ChatCommand, ChatRecord, RunSummary } from '../shared/types'

const FIXTURE = join(__dirname, 'fixtures', 'stand-in-agent.mjs')

/** Writes made.txt (the prompt) in its working directory, like the supervisor tests' stand-in. */
function standIn(mode: 'ok' | 'hang' = 'ok', pidFile = ''): AgentAdapter {
  let n = 0
  return {
    id: 'claude',
    label: 'Stand-in',
    policySummary: 'test',
    detect: async () => ({ id: 'claude', label: 'Stand-in', installed: true, executable: process.execPath, version: 'test', authenticated: true, adapterAvailable: true, detail: '', policy: 'test' }),
    buildInvocation: (opts) => ({ command: opts.executable, args: [FIXTURE, mode, pidFile && `${pidFile}.${n++}`], stdin: opts.prompt, env: process.env }),
    createParser: () => ({ parseLine: parseClaudeLine })
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string
let appData: string
let projects: ProjectService
let projectId: string
let approvals: Approvals
let sup: AgentSupervisor

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-wt-')))
  repo = join(tmp, 'repo')
  appData = join(tmp, 'appdata')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  projects = new ProjectService(appData)
  projectId = (await projects.importFolder(repo)).id
  // Commit Thinkerer's config so the project folder is clean (as /merge requires).
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'thinkerer config')
  approvals = new Approvals(appData)
  sup = new AgentSupervisor(appData, projects, { adapters: [standIn()], approvals })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function finished(pred: (s: RunSummary) => boolean = () => true): Promise<RunSummary> {
  return new Promise((resolve) => {
    const on = (s: RunSummary) => {
      if (s.endedAt && pred(s)) {
        sup.off('update', on)
        resolve(s)
      }
    }
    sup.on('update', on)
  })
}

async function chatTurn(prompt: string, chatId?: string): Promise<RunSummary> {
  const done = finished()
  await sup.start(projectId, prompt, 'claude', { chatId })
  return done
}

async function command(name: ChatCommand, chatId: string, stopped: string[] = []): Promise<ChatRecord> {
  return runChatCommand(name, {
    project: await projects.get(projectId),
    chat: (await sup.chats.get(chatId))!,
    chats: sup.chats,
    approvals,
    live: sup.isChatLive(chatId),
    stopDevServer: () => stopped.push(chatId)
  })
}

const lastNote = (c: ChatRecord) => c.notes.at(-1)!

describe('chat worktrees', () => {
  it('runs each chat in its own worktree and branch, and commits every turn there', async () => {
    const first = await chatTurn('Add made')
    expect(first.status).toBe('succeeded')
    const chat = (await sup.chats.get(first.id))!
    expect(chat.state).toBe('active')
    expect(chat.worktree).toMatchObject({ base: 'main', branch: `thinkerer/add-made-${first.id.slice(0, 8)}` })
    const wt = chat.worktree!.path
    expect(wt.startsWith(join(appData, 'worktrees', projectId))).toBe(true)
    expect(first.cwd).toBe(wt)

    // The agent's edit is in the worktree, committed on the chat branch; the project folder is untouched.
    expect(readFileSync(join(wt, 'made.txt'), 'utf8')).toBe('Add made')
    expect(existsSync(join(repo, 'made.txt'))).toBe(false)
    expect(first.commit).toBeTruthy()
    expect(git(repo, 'log', '-1', '--format=%s%n%b', chat.worktree!.branch)).toMatch(new RegExp(`^Add made\\n[\\s\\S]*Thinkerer-Chat: ${first.id}`))
    expect(git(wt, 'status', '--porcelain')).toBe('')
    expect(first.gitAfter!.entries).toEqual([])

    // A follow-up stays in the same worktree and adds a commit.
    const second = await chatTurn('Change made', first.id)
    expect(second.cwd).toBe(wt)
    expect(readFileSync(join(wt, 'made.txt'), 'utf8')).toBe('Change made')
    expect(git(repo, 'rev-list', '--count', `main..${chat.worktree!.branch}`)).toBe('2')
  })

  it('gives parallel chats separate worktrees, so their edits never overlap', async () => {
    const sup2 = new AgentSupervisor(appData, projects, { adapters: [standIn('hang', join(tmp, 'pid'))], approvals })
    const a = await sup2.start(projectId, 'first', 'claude')
    const b = await sup2.start(projectId, 'second', 'claude')
    expect(b.concurrentRunIds).toEqual([])
    const [ca, cb] = await Promise.all([sup2.chats.get(a.id), sup2.chats.get(b.id)])
    // Worktrees are created when each run launches; wait for both.
    while (!(await sup2.chats.get(a.id))?.worktree || !(await sup2.chats.get(b.id))?.worktree) await new Promise((r) => setTimeout(r, 20))
    expect([ca, cb].every(Boolean)).toBe(true)
    expect((await sup2.chats.get(a.id))!.worktree!.path).not.toBe((await sup2.chats.get(b.id))!.worktree!.path)
    let left = 2
    const allDone = new Promise<void>((resolve) => sup2.on('update', (s) => s.endedAt && --left === 0 && resolve()))
    sup2.cancelAll()
    await allDone
  })

  it('reserves ports and runs the approved setup hook with the worktree environment', async () => {
    const out = join(tmp, 'hook.txt')
    const setup = `printf '%s %s %s' "$THINKERER_PORT_1" "$COMPOSE_PROJECT_NAME" "$PWD" > '${out}'`
    await projects.updateConfig(projectId, { worktrees: { setupCommand: setup, ports: 2 } })

    // Not approved yet: the run fails before the agent starts, and the chat waits to retry setup.
    const refused = await chatTurn('Needs setup')
    expect(refused.status).toBe('failed')
    expect(refused.error).toMatch(/not been approved/)
    expect((await sup.chats.get(refused.id))!.state).toBe('setting-up')

    await approvals.approve(projectId, 'setup', setup)
    const retried = await chatTurn('Retry', refused.id)
    expect(retried.status).toBe('succeeded')
    const chat = (await sup.chats.get(refused.id))!
    expect(chat.state).toBe('active')
    expect(chat.ports).toHaveLength(2)
    expect(new Set(chat.ports).size).toBe(2)
    expect(chat.composeProject).toBe(`thinkerer-repo-${chat.id.slice(0, 8)}`)
    const [port, compose, cwd] = readFileSync(out, 'utf8').split(' ')
    expect(Number(port)).toBe(chat.ports[0])
    expect(compose).toBe(chat.composeProject)
    expect(realpathSync(cwd)).toBe(realpathSync(chat.worktree!.path))
    expect(lastNote(chat)).toMatchObject({ kind: 'setup', ok: true, title: 'Worktree set up' })
    // The agent gets the same ports.
    expect(readFileSync(join(chat.worktree!.path, 'agent-env.txt'), 'utf8')).toBe(`${chat.ports[0]} ${chat.composeProject}`)
  })

  it('reports a failing setup hook and keeps the chat in setup', async () => {
    const setup = 'echo boom >&2; exit 3'
    await projects.updateConfig(projectId, { worktrees: { setupCommand: setup } })
    await approvals.approve(projectId, 'setup', setup)
    const run = await chatTurn('Will fail')
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/setup command failed \(exit code 3\)/)
    const chat = (await sup.chats.get(run.id))!
    expect(chat.state).toBe('setting-up')
    expect(lastNote(chat)).toMatchObject({ kind: 'setup', ok: false, lines: expect.arrayContaining(['boom']) })
  })
})

describe('/merge, /cleanup, /done, /discard', () => {
  it('merges the chat branch into main, then cleans up the worktree with the teardown hook', async () => {
    const out = join(tmp, 'teardown.txt')
    const teardown = `printf '%s' "$COMPOSE_PROJECT_NAME" > '${out}'`
    await projects.updateConfig(projectId, { worktrees: { teardownCommand: teardown } })
    await approvals.approve(projectId, 'teardown', teardown)
    const run = await chatTurn('Feature')
    const wt = (await sup.chats.get(run.id))!.worktree!

    // Not merged yet: cleanup refuses and says why.
    let chat = await command('cleanup', run.id)
    expect(lastNote(chat)).toMatchObject({ ok: false, lines: expect.arrayContaining([expect.stringMatching(/1 commit on .* is not in main/)]) })
    expect(existsSync(wt.path)).toBe(true)

    chat = await command('merge', run.id)
    expect(lastNote(chat)).toMatchObject({ ok: true, title: 'Merged into main' })
    expect(chat.state).toBe('merged')
    expect(readFileSync(join(repo, 'made.txt'), 'utf8')).toBe('Feature')
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(`Merge ${wt.branch}: Feature`)

    const stopped: string[] = []
    chat = await command('cleanup', run.id, stopped)
    expect(lastNote(chat)).toMatchObject({ ok: true, title: 'Cleaned up — chat done' })
    expect(chat).toMatchObject({ state: 'done', doneReason: 'cleanup', worktreeRemoved: true })
    expect(stopped).toEqual([run.id])
    expect(readFileSync(out, 'utf8')).toBe(chat.composeProject)
    expect(existsSync(wt.path)).toBe(false)
    expect(git(repo, 'branch', '--list', wt.branch)).toBe('')
    // A finished chat takes no more messages.
    await expect(sup.start(projectId, 'more', 'claude', { chatId: run.id })).rejects.toThrow(/finished/)
  })

  it('never touches uncommitted work in the project folder: refuses overwrites, and reports conflicts without merging', async () => {
    const run = await chatTurn('Conflict')
    // Unrelated uncommitted edits don't block the merge; files it would overwrite do.
    writeFileSync(join(repo, 'README.md'), 'local edit\n')
    writeFileSync(join(repo, 'made.txt'), 'untracked local file\n')
    let chat = await command('merge', run.id)
    expect(lastNote(chat)).toMatchObject({ ok: false, title: 'Not merged', lines: expect.arrayContaining([expect.stringMatching(/Git refused/), expect.stringMatching(/made\.txt/)]) })
    expect(readFileSync(join(repo, 'made.txt'), 'utf8')).toBe('untracked local file\n')
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('local edit\n')

    // Main gains a conflicting made.txt: the dry run reports it and the folder keeps its uncommitted edit.
    git(repo, 'add', 'made.txt')
    git(repo, 'commit', '-qm', 'conflicting')
    chat = await command('merge', run.id)
    expect(lastNote(chat)).toMatchObject({ ok: false, title: 'Not merged: 1 conflicting file', lines: expect.arrayContaining(['  made.txt']) })
    expect(git(repo, 'status', '--porcelain')).toBe('M README.md')
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('local edit\n')
    expect(chat.state).toBe('active')

    // Once that's sorted, the merge goes through with the unrelated edit still in place.
    git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    writeFileSync(join(repo, 'README.md'), 'local edit\n')
    chat = await command('merge', run.id)
    expect(lastNote(chat)).toMatchObject({ ok: true })
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('local edit\n')
  })

  it('blocks cleanup on uncommitted work, unmerged side branches and leftover stashes', async () => {
    const run = await chatTurn('Work')
    await command('merge', run.id)
    const wt = (await sup.chats.get(run.id))!.worktree!

    writeFileSync(join(wt.path, 'scratch.txt'), 'x')
    let chat = await command('cleanup', run.id)
    expect(lastNote(chat).lines).toEqual(expect.arrayContaining([expect.stringMatching(/1 uncommitted change/), '  ?? scratch.txt']))

    git(wt.path, 'stash', '-u')
    chat = await command('cleanup', run.id)
    expect(lastNote(chat).lines).toEqual(expect.arrayContaining([expect.stringMatching(/1 stash entry/)]))
    git(wt.path, 'stash', 'drop')

    git(wt.path, 'branch', 'side-experiment')
    git(repo, 'commit', '--allow-empty', '-qm', 'main moves on')
    git(wt.path, 'checkout', '-q', 'side-experiment')
    git(wt.path, 'commit', '--allow-empty', '-qm', 'side work')
    git(wt.path, 'checkout', '-q', wt.branch)
    chat = await command('cleanup', run.id)
    expect(lastNote(chat).lines).toEqual(expect.arrayContaining([expect.stringMatching(/not merged into main/), '  side-experiment']))
    expect(chat.worktreeRemoved).toBe(false)

    git(repo, 'branch', '-D', 'side-experiment')
    // Another chat started meanwhile, with unmerged work on its own branch: that is its branch, not this chat's.
    const other = await chatTurn('Other work')
    const otherWt = (await sup.chats.get(other.id))!.worktree!
    git(otherWt.path, 'commit', '--allow-empty', '-qm', 'other chat work')
    chat = await command('cleanup', run.id)
    expect(lastNote(chat).lines.join('\n')).not.toContain(otherWt.branch)
    expect(chat.worktreeRemoved).toBe(true)
  })

  it('detects a branch merged outside Thinkerer, and /done files a chat without removing it', async () => {
    const run = await chatTurn('Elsewhere')
    const wt = (await sup.chats.get(run.id))!.worktree!
    const list = () => sup.chats.list(projectId, [], () => false)
    expect((await list()).find((c) => c.id === run.id)!.state).toBe('active')
    git(repo, 'merge', '-q', '--no-edit', wt.branch)
    expect((await list()).find((c) => c.id === run.id)!.state).toBe('merged')

    const chat = await command('done', run.id)
    expect(chat).toMatchObject({ state: 'done', doneReason: 'manual', worktreeRemoved: false })
    expect(existsSync(wt.path)).toBe(true)
    // A new message picks it up again.
    const next = await chatTurn('Again', run.id)
    expect(next.status).toBe('succeeded')
    expect((await sup.chats.get(run.id))!.state).toBe('active')
  })

  it('/discard deletes the worktree and its unmerged branch', async () => {
    const run = await chatTurn('Throwaway')
    const wt = (await sup.chats.get(run.id))!.worktree!
    writeFileSync(join(wt.path, 'dirty.txt'), 'x')
    const chat = await command('discard', run.id)
    expect(chat).toMatchObject({ state: 'done', doneReason: 'discarded', worktreeRemoved: true })
    expect(existsSync(wt.path)).toBe(false)
    expect(git(repo, 'branch', '--list', wt.branch)).toBe('')
    expect(existsSync(join(repo, 'made.txt'))).toBe(false)
  })
})

describe('worktree helpers', () => {
  it('fills {portN} in the preview URL, and refuses ports a folder does not have', () => {
    expect(resolvePreviewUrl('http://localhost:{port1}/app', [4100, 4200])).toBe('http://localhost:4100/app')
    expect(resolvePreviewUrl('http://localhost:{port2}', [4100, 4200])).toBe('http://localhost:4200')
    expect(resolvePreviewUrl('http://localhost:{port1}', [])).toBeNull()
    expect(resolvePreviewUrl('http://localhost:5173', [])).toBe('http://localhost:5173')
  })

  it('allocates distinct free ports, avoiding taken ones', async () => {
    const taken = await allocatePorts(3)
    expect(new Set(taken).size).toBe(3)
    const more = await allocatePorts(3, taken)
    expect(more.some((p) => taken.includes(p))).toBe(false)
  })

  it('slugs chat titles for branch names', () => {
    expect(slugify('Add a visible About dialog, and test it!')).toBe('add-a-visible-about-dialog-and')
    expect(slugify('???')).toBe('chat')
  })

  it('stops a hook that runs too long', async () => {
    const lines: string[] = []
    const res = await runHook('sleep 5', tmp, {}, (l) => lines.push(l), 200)
    expect(res.timedOut).toBe(true)
    expect(lines[0]).toMatch(/Timed out/)
  })

  it('validates worktree settings and {portN} preview URLs', async () => {
    await expect(projects.updateConfig(projectId, { worktrees: { ports: 11 } })).rejects.toThrow(/0 to 10/)
    await expect(projects.updateConfig(projectId, { website: { previewUrl: 'http://example.com:{port1}' } })).rejects.toThrow(/local/)
    const p = await projects.updateConfig(projectId, { website: { previewUrl: 'http://localhost:{port1}' }, worktrees: { ports: 1 } })
    expect(p.config!.website.previewUrl).toBe('http://localhost:{port1}')
    expect(p.config!.worktrees.ports).toBe(1)
  })
})

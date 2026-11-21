import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ChatRecord, ChatWorktree, Project } from '../shared/types'
import { childEnv } from './agents/detect'

// Every chat works in its own Git worktree and branch, outside the project
// folder (<appData>/worktrees/<projectId>/<name>), so parallel chats never see
// each other's edits and the project's own tools don't pick the copies up.

const exec = promisify(execFile)
export const HOOK_TIMEOUT_MS = 10 * 60_000
const KILL_GRACE_MS = 3000
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** Used for Thinkerer's commits when the user has no Git identity configured. */
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'Thinkerer',
  GIT_AUTHOR_EMAIL: 'thinkerer@localhost',
  GIT_COMMITTER_NAME: 'Thinkerer',
  GIT_COMMITTER_EMAIL: 'thinkerer@localhost'
}

export async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/** Runs git and reports failure instead of throwing. */
async function tryGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, args, env) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message }
  }
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '')
  return slug || 'chat'
}

export function worktreeName(chatId: string, title: string): string {
  return `${slugify(title)}-${chatId.slice(0, 8)}`
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return r.ok ? r.out.trim() || null : null
}

export async function headCommit(cwd: string): Promise<string | null> {
  const r = await tryGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.ok ? r.out.trim() || null : null
}

export async function localBranches(cwd: string): Promise<string[]> {
  return (await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean)
}

/** Branches checked out in a worktree other than `ownPath` (other chats' branches, the project folder's). */
export async function branchesInOtherWorktrees(projectPath: string, ownPath: string): Promise<string[]> {
  const r = await tryGit(projectPath, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const out: string[] = []
  for (const block of r.out.split(/\n\s*\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
    if (path && branch && resolve(path) !== resolve(ownPath)) out.push(branch)
  }
  return out
}

/**
 * Creates the chat's branch from the project's current branch and checks it out
 * in a new worktree. Uncommitted work in the project folder stays there.
 */
export async function createWorktree(projectPath: string, root: string, chatId: string, title: string): Promise<ChatWorktree> {
  const base = await currentBranch(projectPath)
  const baseCommit = await headCommit(projectPath)
  if (!base || !baseCommit) throw new Error('The project folder has no branch with a commit to start a worktree from')
  const name = worktreeName(chatId, title)
  const path = join(root, name)
  const branch = `thinkerer/${name}`
  const branchesAtStart = await localBranches(projectPath)
  await mkdir(dirname(path), { recursive: true })
  await git(projectPath, ['worktree', 'add', '-b', branch, path, baseCommit])
  return { path, branch, base, baseCommit, branchesAtStart }
}

/** The user's Git identity if they have one; otherwise Thinkerer's, so commits and merges still work. */
async function identityEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const email = await tryGit(cwd, ['config', 'user.email'])
  const name = await tryGit(cwd, ['config', 'user.name'])
  return email.ok && email.out.trim() && name.ok && name.out.trim() ? {} : FALLBACK_IDENTITY
}

/** Commits everything in the worktree (respecting .gitignore). Returns the commit, or null if nothing changed. */
export async function commitAll(cwd: string, subject: string, body?: string): Promise<string | null> {
  await git(cwd, ['add', '-A'])
  const staged = await tryGit(cwd, ['diff', '--cached', '--quiet'])
  if (staged.ok) return null
  await git(cwd, ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], await identityEnv(cwd))
  return (await headCommit(cwd))!
}

/** Commits on `branch` that `base` doesn't have. */
export async function commitsAhead(cwd: string, base: string, branch: string): Promise<number> {
  const r = await tryGit(cwd, ['rev-list', '--count', `${base}..${branch}`])
  return r.ok ? Number(r.out.trim()) || 0 : 0
}

export async function isMerged(cwd: string, branch: string, base: string): Promise<boolean> {
  return (await tryGit(cwd, ['merge-base', '--is-ancestor', branch, base])).ok
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await tryGit(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).ok
}

/** Stash entries made on this branch ("WIP on <branch>: …" / "On <branch>: …"). */
export async function stashesOn(cwd: string, branch: string): Promise<string[]> {
  const r = await tryGit(cwd, ['stash', 'list', '--format=%gs'])
  if (!r.ok) return []
  return r.out.split('\n').filter((l) => l.startsWith(`WIP on ${branch}:`) || l.startsWith(`On ${branch}:`))
}

/**
 * Merges the chat branch into the project folder's checked-out base branch.
 * A dry run (merge-tree, which touches no files) catches conflicts first, so the
 * folder is never left mid-merge, and its uncommitted changes are never at the
 * mercy of `merge --abort`. Git itself refuses a merge that would overwrite
 * uncommitted changes.
 */
export async function mergeBranch(
  projectPath: string,
  branch: string,
  message: string
): Promise<{ ok: true; commit: string } | { ok: false; conflicts: string[]; output: string }> {
  const dry = await tryGit(projectPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch])
  if (!dry.ok) {
    const conflicts = dry.out.split('\n').slice(1).filter(Boolean)
    // No file list: an older Git without merge-tree --write-tree; let the real merge decide.
    if (conflicts.length && /^[0-9a-f]{40,64}$/.test(dry.out.split('\n')[0])) return { ok: false, conflicts, output: '' }
  }
  const r = await tryGit(projectPath, ['merge', '--no-ff', '--no-edit', '-m', message, branch], await identityEnv(projectPath))
  if (r.ok) return { ok: true, commit: (await headCommit(projectPath))! }
  const started = (await tryGit(projectPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok
  const conflicts = started ? (await tryGit(projectPath, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean) : []
  if (started) await tryGit(projectPath, ['merge', '--abort'])
  return { ok: false, conflicts, output: r.out }
}

export async function removeWorktree(projectPath: string, wt: ChatWorktree, opts: { force?: boolean } = {}): Promise<void> {
  const removed = await tryGit(projectPath, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), wt.path])
  if (!removed.ok && !/is not a working tree/.test(removed.out)) throw new Error(`Could not remove the worktree: ${removed.out}`)
  await tryGit(projectPath, ['worktree', 'prune'])
  // Callers check the branch is merged (or the user confirmed discarding it) first.
  if (await branchExists(projectPath, wt.branch)) await git(projectPath, ['branch', '-D', wt.branch])
}

/** Free TCP ports on localhost, avoiding ones already given to other chats. */
export async function allocatePorts(count: number, taken: Iterable<number> = []): Promise<number[]> {
  const avoid = new Set(taken)
  const out: number[] = []
  for (let attempts = 0; out.length < count && attempts < count * 20; attempts++) {
    const port = await freePort()
    if (!avoid.has(port)) {
      avoid.add(port)
      out.push(port)
    }
  }
  if (out.length < count) throw new Error('Could not find enough free ports')
  return out
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('No port'))))
    })
  })
}

export function composeProjectName(project: Project, chatId: string): string {
  return `thinkerer-${slugify(project.config?.name ?? 'project').slice(0, 20)}-${chatId.slice(0, 8)}`
}

/** Environment for a chat's hooks, dev server and agent. */
export function worktreeEnv(project: Project, chat: ChatRecord): Record<string, string> {
  if (!chat.worktree) return {}
  const env: Record<string, string> = {
    THINKERER_WORKTREE: chat.worktree.path,
    THINKERER_PROJECT_ROOT: project.path,
    THINKERER_CHAT_ID: chat.id,
    THINKERER_BRANCH: chat.worktree.branch
  }
  if (chat.composeProject) env.COMPOSE_PROJECT_NAME = chat.composeProject
  chat.ports.forEach((p, i) => (env[`THINKERER_PORT_${i + 1}`] = String(p)))
  if (chat.ports.length) env.THINKERER_PORT = String(chat.ports[0])
  return env
}

const PORT_PLACEHOLDER = /\{port([1-9]|10)\}/g

/** Fills {portN} with the chat's ports; null if it uses a port the chat doesn't have (e.g. the project folder). */
export function resolvePreviewUrl(url: string, ports: number[]): string | null {
  if (!url) return null
  let missing = false
  const filled = url.replace(PORT_PLACEHOLDER, (_m, n: string) => {
    const p = ports[Number(n) - 1]
    if (p === undefined) missing = true
    return String(p ?? '')
  })
  return missing ? null : filled
}

/** Runs a project hook (setup/teardown) with a shell, streaming its output lines. */
export function runHook(
  command: string,
  cwd: string,
  env: Record<string, string>,
  onLine: (line: string) => void,
  timeoutMs = HOOK_TIMEOUT_MS
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', command] } : { cmd: '/bin/sh', args: ['-c', command] }
    const child = spawn(shell.cmd, shell.args, {
      cwd,
      env: { ...childEnv(), ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    let timedOut = false
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      onLine(`Timed out after ${Math.round(timeoutMs / 1000)}s; stopping.`)
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref()
    }, timeoutMs)
    for (const stream of [child.stdout!, child.stderr!]) {
      let buf = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const l of lines) onLine(l.replace(ANSI, ''))
      })
      stream.on('end', () => buf && onLine(buf.replace(ANSI, '')))
    }
    child.on('error', (err) => onLine(`Could not run the hook: ${err.message}`))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut })
    })
  })
}

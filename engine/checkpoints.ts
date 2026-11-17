import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Checkpoint, FileChange, RestorePreview } from '../shared/types'
import { resolveInside } from './paths'

const exec = promisify(execFile)

// Checkpoints are commits of the *entire* working tree (tracked, modified and
// untracked-but-not-ignored files), built through a throwaway index so the
// user's HEAD, branch, staging area and files are never touched. They live
// under refs/thinkerer/* — local refs that `git push` does not send by default.

const CHECKPOINT_NS = 'refs/thinkerer/checkpoints'
const AFTER_NS = 'refs/thinkerer/after'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_UNTRACKED = 20_000
const KEEP = 50
const MAX_DIFF_BYTES = 400 * 1024

// Checkpoint commits are internal; don't depend on the user's git identity.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Thinkerer',
  GIT_AUTHOR_EMAIL: 'thinkerer@localhost',
  GIT_COMMITTER_NAME: 'Thinkerer',
  GIT_COMMITTER_EMAIL: 'thinkerer@localhost'
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function head(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

/** Builds a tree (and optionally a commit) of the current working tree without touching the real index. */
async function snapshot(cwd: string, message?: string): Promise<{ tree: string; commit: string | null; head: string | null }> {
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).length
  if (untracked > MAX_UNTRACKED) {
    throw new Error(`${untracked} untracked files — add a .gitignore (e.g. for node_modules) before Thinkerer can checkpoint this project`)
  }
  const tmpIndex = join(tmpdir(), `thinkerer-index-${randomUUID()}`)
  try {
    // Start from a copy of the real index so git can reuse its stat cache.
    const realIndex = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
    await copyFile(realIndex, tmpIndex).catch(() => {})
    const env = { GIT_INDEX_FILE: tmpIndex }
    await git(cwd, ['add', '-A'], env)
    const tree = (await git(cwd, ['write-tree'], env)).trim()
    const parent = await head(cwd)
    let commit: string | null = null
    if (message) {
      commit = (await git(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], IDENTITY)).trim()
    }
    return { tree, commit, head: parent }
  } finally {
    await rm(tmpIndex, { force: true })
  }
}

export async function createCheckpoint(cwd: string, id: string, label: string): Promise<Checkpoint> {
  const snap = await snapshot(cwd, label)
  await git(cwd, ['update-ref', `${CHECKPOINT_NS}/${id}`, snap.commit!])
  await prune(cwd)
  return { id, commit: snap.commit!, head: snap.head, label, createdAt: new Date().toISOString() }
}

/** Records the post-run state so a run's diff stays stable after later edits. */
export async function recordAfter(cwd: string, id: string): Promise<string> {
  const snap = await snapshot(cwd, `Thinkerer: after run ${id}`)
  await git(cwd, ['update-ref', `${AFTER_NS}/${id}`, snap.commit!])
  return snap.commit!
}

export async function listCheckpoints(cwd: string): Promise<Checkpoint[]> {
  const out = await git(cwd, [
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname:lstrip=3)%00%(objectname)%00%(creatordate:iso-strict)%00%(subject)%00%(parent)',
    CHECKPOINT_NS
  ])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, commit, createdAt, label, parent] = line.split('\0')
      return { id, commit, createdAt, label, head: parent?.split(' ')[0] || null }
    })
}

async function checkpointCommit(cwd: string, id: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid checkpoint id')
  try {
    return (await git(cwd, ['rev-parse', '--verify', '-q', `${CHECKPOINT_NS}/${id}^{commit}`])).trim()
  } catch {
    throw new Error('Checkpoint not found')
  }
}

export async function diffSummary(cwd: string, from: string, to: string): Promise<FileChange[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(cwd, ['diff', '--no-color', '--name-status', '-z', '-M', from, to]),
    git(cwd, ['diff', '--no-color', '--numstat', '-z', '-M', from, to])
  ])
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  // numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0"
  const ns = numstat.split('\0')
  for (let i = 0; i < ns.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(ns[i])
    if (!m) continue
    let path = m[3]
    if (path === '') {
      path = ns[i + 2]
      i += 2
    }
    counts.set(path, { additions: m[1] === '-' ? null : Number(m[1]), deletions: m[2] === '-' ? null : Number(m[2]) })
  }
  const parts = nameStatus.split('\0').filter((p) => p !== '')
  const changes: FileChange[] = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]
    const code = status[0] as FileChange['status']
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++]
      const path = parts[i++]
      changes.push({ status: code, path, oldPath, ...(counts.get(path) ?? { additions: null, deletions: null }) })
    } else {
      const path = parts[i++]
      changes.push({ status: code, path, oldPath: null, ...(counts.get(path) ?? { additions: null, deletions: null }) })
    }
  }
  return changes
}

export async function fileDiff(cwd: string, from: string, to: string, path: string): Promise<string> {
  if (typeof path !== 'string' || path.includes('\0') || path.startsWith('-')) throw new Error('Invalid path')
  const out = await git(cwd, ['diff', '--no-color', '-M', from, to, '--', path])
  return out.length > MAX_DIFF_BYTES ? out.slice(0, MAX_DIFF_BYTES) + '\n… diff truncated …\n' : out
}

/** Diff of uncommitted work (vs HEAD), including untracked files. */
export async function workingChanges(cwd: string): Promise<FileChange[]> {
  const snap = await snapshot(cwd)
  return diffSummary(cwd, (await head(cwd)) ?? EMPTY_TREE, snap.tree)
}

export async function workingFileDiff(cwd: string, path: string): Promise<string> {
  const snap = await snapshot(cwd)
  return fileDiff(cwd, (await head(cwd)) ?? EMPTY_TREE, snap.tree, path)
}

export async function runDiff(cwd: string, runId: string): Promise<{ from: string; to: string }> {
  const from = await checkpointCommit(cwd, runId)
  const to = (await git(cwd, ['rev-parse', '--verify', '-q', `${AFTER_NS}/${runId}^{commit}`]).catch(() => '')).trim()
  if (!to) throw new Error('This run has no recorded end state')
  return { from, to }
}

export async function restorePreview(cwd: string, id: string): Promise<RestorePreview> {
  const commit = await checkpointCommit(cwd, id)
  const current = await snapshot(cwd)
  // Direction: current → checkpoint is what restoring will do to the working tree.
  const changes = await diffSummaryNoRenames(cwd, current.tree, commit)
  const parent = (await git(cwd, ['rev-parse', `${commit}^`]).catch(() => '')).trim() || null
  return {
    id,
    commit,
    changes,
    headMoved: parent !== current.head,
    currentHead: current.head,
    checkpointHead: parent
  }
}

/**
 * Make the working tree match the checkpoint. Takes a safety checkpoint of the
 * current state first, so a restore can itself be undone. HEAD, branch and the
 * staging area are not modified; ignored files are never touched.
 */
export async function restoreCheckpoint(cwd: string, id: string): Promise<{ safetyCheckpoint: Checkpoint; changes: FileChange[] }> {
  const preview = await restorePreview(cwd, id)
  const safetyCheckpoint = await createCheckpoint(cwd, `pre-restore-${Date.now()}`, `Thinkerer: before restoring ${id}`)
  const tmpIndex = join(tmpdir(), `thinkerer-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: tmpIndex }
    await git(cwd, ['read-tree', preview.commit], env)
    // Only write files that differ, so unchanged files keep their mtimes (no
    // spurious rebuilds/HMR for the whole tree).
    const toWrite = preview.changes.filter((c) => c.status !== 'D').map((c) => c.path)
    for (let i = 0; i < toWrite.length; i += 200) {
      await git(cwd, ['checkout-index', '-f', '--', ...toWrite.slice(i, i + 200)], env)
    }
  } finally {
    await rm(tmpIndex, { force: true })
  }
  // Files that exist now but not in the checkpoint ("D" in current → checkpoint).
  for (const c of preview.changes) {
    if (c.status === 'D') await unlink(await resolveInside(cwd, c.path)).catch(() => {})
  }
  return { safetyCheckpoint, changes: preview.changes }
}

async function diffSummaryNoRenames(cwd: string, from: string, to: string): Promise<FileChange[]> {
  const out = await git(cwd, ['diff', '--no-color', '--name-status', '-z', '--no-renames', from, to])
  const parts = out.split('\0').filter(Boolean)
  const changes: FileChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    changes.push({ status: parts[i][0] as FileChange['status'], path: parts[i + 1], oldPath: null, additions: null, deletions: null })
  }
  return changes
}

async function prune(cwd: string): Promise<void> {
  const all = await listCheckpoints(cwd)
  for (const old of all.slice(KEEP)) {
    await git(cwd, ['update-ref', '-d', `${CHECKPOINT_NS}/${old.id}`]).catch(() => {})
    await git(cwd, ['update-ref', '-d', `${AFTER_NS}/${old.id}`]).catch(() => {})
  }
}

export async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ['init', '-q'])
}

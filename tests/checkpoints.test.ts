import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCheckpoint, diffSummary, fileDiff, listCheckpoints, recordAfter, restoreCheckpoint, restorePreview, runDiff, workingChanges } from '../engine/checkpoints'

let repo: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const write = (p: string, s: string) => {
  mkdirSync(join(repo, p, '..'), { recursive: true })
  writeFileSync(join(repo, p), s)
}
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-cp-')))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  write('.gitignore', 'node_modules/\n')
  write('a.txt', 'one\n')
  write('keep.txt', 'unchanged\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('checkpoints', () => {
  it('captures uncommitted and untracked work without touching HEAD, index or files', async () => {
    write('a.txt', 'one\ndirty\n') // unstaged edit
    write('staged.txt', 'staged\n')
    git('add', 'staged.txt') // staged new file
    write('untracked.txt', 'new\n')
    const statusBefore = git('status', '--porcelain')
    const headBefore = git('rev-parse', 'HEAD')

    const cp = await createCheckpoint(repo, 'run-1', 'before run')

    expect(git('status', '--porcelain')).toBe(statusBefore)
    expect(git('rev-parse', 'HEAD')).toBe(headBefore)
    expect(cp.head).toBe(headBefore.trim())
    // The checkpoint tree really contains the dirty state.
    expect(git('show', `${cp.commit}:a.txt`)).toBe('one\ndirty\n')
    expect(git('show', `${cp.commit}:untracked.txt`)).toBe('new\n')
    expect(git('show', `${cp.commit}:staged.txt`)).toBe('staged\n')
    expect((await listCheckpoints(repo)).map((c) => c.id)).toEqual(['run-1'])
  })

  it('records exactly what a run changed, with diffs', async () => {
    write('a.txt', 'one\npre-existing\n') // dirty before the run: must NOT count as run change
    await createCheckpoint(repo, 'run-2', 'before')
    write('keep.txt', 'unchanged\nedited by agent\n')
    write('src/new.ts', 'export const x = 1\n')
    rmSync(join(repo, 'a.txt'))
    const after = await recordAfter(repo, 'run-2')

    const { from, to } = await runDiff(repo, 'run-2')
    expect(to).toBe(after)
    const changes = await diffSummary(repo, from, to)
    expect(changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(['A src/new.ts', 'D a.txt', 'M keep.txt'])
    expect(changes.find((c) => c.path === 'keep.txt')).toMatchObject({ additions: 1, deletions: 0 })
    expect(await fileDiff(repo, from, to, 'keep.txt')).toContain('+edited by agent')
  })

  it('previews and restores a checkpoint, and the restore itself is undoable', async () => {
    write('a.txt', 'one\nmine\n')
    await createCheckpoint(repo, 'run-3', 'before')
    const keepMtime = statSync(join(repo, 'keep.txt')).mtimeMs
    // Agent's work:
    write('a.txt', 'agent rewrote this\n')
    write('agent-file.txt', 'created\n')
    rmSync(join(repo, '.gitignore'))
    write('node_modules/pkg/index.js', 'ignored') // ignored before the run; must survive
    write('.gitignore', 'node_modules/\n')

    const preview = await restorePreview(repo, 'run-3')
    expect(preview.changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(['D agent-file.txt', 'M a.txt'])
    expect(preview.headMoved).toBe(false)

    const indexBefore = git('diff', '--cached', '--name-only')
    const res = await restoreCheckpoint(repo, 'run-3')
    expect(read('a.txt')).toBe('one\nmine\n') // the user's pre-run dirty edit is back
    expect(existsSync(join(repo, 'agent-file.txt'))).toBe(false)
    expect(existsSync(join(repo, 'node_modules/pkg/index.js'))).toBe(true)
    expect(statSync(join(repo, 'keep.txt')).mtimeMs).toBe(keepMtime) // untouched files not rewritten
    expect(git('diff', '--cached', '--name-only')).toBe(indexBefore)

    // Undo the restore via the safety checkpoint.
    await restoreCheckpoint(repo, res.safetyCheckpoint.id)
    expect(read('a.txt')).toBe('agent rewrote this\n')
    expect(read('agent-file.txt')).toBe('created\n')
  })

  it('works in a repository with no commits yet', async () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-cp-empty-')))
    try {
      execFileSync('git', ['init', '-q'], { cwd: fresh })
      writeFileSync(join(fresh, 'x.txt'), 'x\n')
      const cp = await createCheckpoint(fresh, 'first', 'before')
      expect(cp.head).toBeNull()
      writeFileSync(join(fresh, 'x.txt'), 'changed\n')
      expect((await workingChanges(fresh)).map((c) => c.path)).toEqual(['x.txt'])
      await restoreCheckpoint(fresh, 'first')
      expect(readFileSync(join(fresh, 'x.txt'), 'utf8')).toBe('x\n')
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('rejects unknown or malformed checkpoint ids', async () => {
    await expect(restorePreview(repo, 'nope')).rejects.toThrow(/not found/)
    await expect(restorePreview(repo, '../../HEAD')).rejects.toThrow(/Invalid/)
  })
})

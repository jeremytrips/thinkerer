import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProjectInstructions, MAX_INSTRUCTION_CHARS } from '../engine/agents/instructions'

let tmp: string
let root: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-instr-')))
  root = join(tmp, 'project')
  mkdirSync(root)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('loadProjectInstructions', () => {
  it('returns nothing when the project has no instruction files', async () => {
    expect(await loadProjectInstructions(root)).toEqual({ text: '', files: [] })
  })

  it('reads AGENTS.md on its own', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Rules\nUse tabs.\n')
    const r = await loadProjectInstructions(root)
    expect(r.files).toEqual(['AGENTS.md'])
    expect(r.text).toContain('Use tabs.')
  })

  it('follows CLAUDE.md imports without adding AGENTS.md twice', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'Shared rule.')
    writeFileSync(join(root, 'CLAUDE.md'), '@AGENTS.md\nClaude-only rule.\n@docs/extra.md\n')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'extra.md'), 'Extra rule.')
    const r = await loadProjectInstructions(root)
    expect(r.files).toEqual(['AGENTS.md', 'CLAUDE.md', 'docs/extra.md'])
    expect(r.text.match(/Shared rule\./g)).toHaveLength(1)
    expect(r.text).toContain('Claude-only rule.')
    expect(r.text).toContain('Extra rule.')
    expect(r.text).not.toContain('@AGENTS.md')
  })

  it('never reads outside the project, by path or through a symlink', async () => {
    writeFileSync(join(tmp, 'secret.md'), 'SECRET')
    writeFileSync(join(root, 'CLAUDE.md'), '@../secret.md\n@/etc/hosts\nok')
    symlinkSync(join(tmp, 'secret.md'), join(root, 'AGENTS.md'))
    const r = await loadProjectInstructions(root)
    expect(r.files).toEqual(['CLAUDE.md'])
    expect(r.text).not.toContain('SECRET')
    expect(r.text).toContain('ok')
  })

  it('caps the injected text', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(MAX_INSTRUCTION_CHARS * 2))
    const r = await loadProjectInstructions(root)
    expect(r.text.length).toBeLessThan(MAX_INSTRUCTION_CHARS + 200)
    expect(r.text).toMatch(/cut at/)
  })
})

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards docs/DESIGN.md: dark-first tokens in src/styles.css, both themes complete,
// and no colour literals outside the token blocks or inline in the renderer.

const root = resolve(__dirname, '..')
const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
const design = readFileSync(join(root, 'docs/DESIGN.md'), 'utf8')
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/

/** Returns the body of the first `{…}` block starting at `from`, matching braces. */
function block(source: string, from: number): { body: string; end: number } {
  const open = source.indexOf('{', from)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return { body: source.slice(open + 1, i), end: i + 1 }
  }
  throw new Error('unbalanced braces')
}

const rootStart = css.indexOf(':root')
const dark = block(css, rootStart)
const lightStart = css.indexOf('@media (prefers-color-scheme: light)')
const light = block(css, lightStart)
const defined = (body: string) => new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

/** Token names from the DESIGN.md token table; `--type-software` … `--type-other` expands to all type tokens. */
function designTokens(): string[] {
  const table = design.slice(design.indexOf('| Token |'), design.indexOf('Target sizes'))
  const names = new Set<string>()
  for (const line of table.split('\n').filter((l) => l.startsWith('| `'))) {
    const cell = line.split('|')[1]
    for (const m of cell.matchAll(/`(--[a-z0-9-]+)`(?:\s*\(\+\s*`-soft`\))?/g)) {
      names.add(m[1])
      if (m[0].includes('-soft')) for (const s of ['--ok', '--warn', '--danger']) names.add(`${s}-soft`)
    }
    if (cell.includes('--type-')) for (const t of ['software', 'firmware', 'electronics', 'mechanical', 'marketing', 'research', 'other']) names.add(`--type-${t}`)
  }
  return [...names]
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

describe('design tokens', () => {
  it('starts with :root and defines dark there', () => {
    expect(css.trimStart().startsWith(':root')).toBe(true)
    expect(dark.body).toMatch(/color-scheme:\s*dark/)
    expect(css).not.toContain('prefers-color-scheme: dark')
    expect(lightStart).toBeGreaterThan(dark.end - 1)
    expect(light.body).toMatch(/color-scheme:\s*light/)
  })

  it('defines every DESIGN.md token, with every colour token in both themes', () => {
    const tokens = designTokens()
    expect(tokens.length).toBeGreaterThan(20)
    const inDark = defined(dark.body)
    const inLight = defined(light.body)
    const themeAgnostic = new Set(['--radius', '--radius-control', '--radius-badge', '--mono'])
    for (const t of tokens) {
      expect(inDark.has(t), `${t} missing in :root`).toBe(true)
      if (!themeAgnostic.has(t)) expect(inLight.has(t), `${t} missing in light theme`).toBe(true)
    }
    // The light theme overrides only tokens that exist in the dark one.
    for (const t of inLight) expect(inDark.has(t), `${t} only in light theme`).toBe(true)
  })

  it('has no colour literals outside the token blocks', () => {
    const rest = css.slice(0, rootStart) + css.slice(dark.end, lightStart) + css.slice(light.end)
    const offenders = rest.split('\n').filter((l) => COLOUR.test(l) || /:\s*(?:white|black)\b/.test(l))
    expect(offenders).toEqual([])
  })

  it('has no inline colours in src/**/*.tsx', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(join(root, 'src'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // Any colour property counts unless its value is a literal `var(--…)` string: a bare
        // identifier (`color: tone`) could hold anything, so it is flagged too.
        const styled = /\b(?:color|background\w*|border\w*Color|fill|stroke)\s*[:=]\s*(?!\{?\s*['"`]var\(--)[^\s,;}]/.test(line)
        if (COLOUR.test(line) || styled) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

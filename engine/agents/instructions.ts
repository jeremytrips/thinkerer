import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Project instructions (AGENTS.md, CLAUDE.md), read by the engine itself and handed to every run,
 * so they reach the agent whatever the provider or its flags (`--restricted` skips Claude's own
 * discovery; Codex loads AGENTS.md only on its own terms).
 */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']
/** Total characters injected; the rest is cut with a note. */
export const MAX_INSTRUCTION_CHARS = 32_000
const MAX_IMPORT_DEPTH = 5
// Claude-style import: a line that is only `@path/to/file`.
const IMPORT = /^@(\S+)$/

export interface ProjectInstructions {
  text: string
  /** Files whose content was read, relative to the project root, in the order they were read. */
  files: string[]
}

export async function loadProjectInstructions(root: string): Promise<ProjectInstructions> {
  const base = await realpath(root).catch(() => resolve(root))
  const files: string[] = []
  const sections: string[] = []

  /** Real path inside the project, or null if it doesn't exist or escapes it (also through symlinks). */
  const inside = async (path: string): Promise<string | null> => {
    const real = await realpath(path).catch(() => null)
    if (!real) return null
    const rel = relative(base, real)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? real : null
  }

  /** False when the path isn't a readable file in the project; the caller keeps such a line as text. */
  const include = async (path: string, depth: number): Promise<boolean> => {
    const real = await inside(path)
    if (!real) return false
    const rel = relative(base, real)
    if (files.includes(rel)) return true
    const content = await readFile(real, 'utf8').catch(() => null)
    if (content === null) return false
    files.push(rel)
    const own: string[] = []
    let fenced = false
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (/^(```|~~~)/.test(trimmed)) fenced = !fenced
      // Inside a code fence, or not a file (`@types/node`), the line is just text.
      const m = fenced ? null : IMPORT.exec(trimmed)
      if (m && depth < MAX_IMPORT_DEPTH && (await include(resolve(dirname(real), m[1]), depth + 1))) continue
      own.push(line)
    }
    const body = own.join('\n').trim()
    if (body) sections.push(`--- ${rel} ---\n${body}`)
    return true
  }

  for (const name of INSTRUCTION_FILES) await include(join(base, name), 0)

  let text = sections.join('\n\n')
  if (text.length > MAX_INSTRUCTION_CHARS) text = `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n[… project instructions cut at ${MAX_INSTRUCTION_CHARS} characters]`
  return { text, files }
}

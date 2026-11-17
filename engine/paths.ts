import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolve a renderer-supplied relative path inside a project root, refusing
 * anything (including symlinks) that escapes the root.
 */
export async function resolveInside(root: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string' || relPath.includes('\0')) throw new Error('Invalid path')
  if (isAbsolute(relPath)) throw new Error('Path must be relative to the project root')
  const realRoot = await realpath(root)
  const candidate = resolve(realRoot, relPath)
  if (!isWithin(realRoot, candidate)) throw new Error('Path is outside the project')
  const real = await realpath(candidate)
  if (!isWithin(realRoot, real)) throw new Error('Path resolves outside the project')
  return real
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

export function toPosix(p: string): string {
  return p.split(sep).join('/')
}

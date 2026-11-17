import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { FileContent, FileEntry } from '../shared/types'
import { resolveInside, toPosix } from './paths'

// Read-only file access for the Files tab. There is deliberately no write API.

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store'])
export const MAX_PREVIEW_BYTES = 512 * 1024

export async function listDir(root: string, relPath: string): Promise<FileEntry[]> {
  const dir = await resolveInside(root, relPath || '.')
  const realRoot = await realpath(root)
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries: FileEntry[] = dirents
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => ({
      name: d.name,
      path: toPosix(relative(realRoot, join(dir, d.name))),
      kind: d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file'
    }))
  return entries.sort((a, b) =>
    a.kind === 'dir' && b.kind !== 'dir' ? -1 : b.kind === 'dir' && a.kind !== 'dir' ? 1 : a.name.localeCompare(b.name)
  )
}

export async function readFilePreview(root: string, relPath: string): Promise<FileContent> {
  const file = await resolveInside(root, relPath)
  const info = await lstat(file)
  if (!info.isFile()) throw new Error('Not a regular file')
  if (info.size > MAX_PREVIEW_BYTES) return { kind: 'too-large', path: relPath, size: info.size }
  const handle = await open(file, 'r')
  try {
    const buf = await handle.readFile()
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', path: relPath, size: info.size }
    return { kind: 'text', path: relPath, text: buf.toString('utf8'), size: info.size }
  } finally {
    await handle.close()
  }
}

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Screenshots the user sends to an agent from the preview. They live inside the
// project (<project>/.thinkerer/attachments/) so a run confined to the project
// folder can read them, and the folder ignores itself, so they never show up in
// Git, checkpoints, or run diffs.

const KEEP = 30
export const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function attachmentRelPath(id: string): string {
  return `.thinkerer/attachments/${id}.png`
}

export function attachmentPath(projectPath: string, id: string): string {
  if (!ATTACHMENT_ID.test(id)) throw new Error('Invalid attachment id')
  return join(projectPath, '.thinkerer', 'attachments', `${id}.png`)
}

export async function saveAttachment(projectPath: string, png: Buffer): Promise<string> {
  const dir = join(projectPath, '.thinkerer', 'attachments')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.gitignore'), '*\n')
  const id = randomUUID()
  await writeFile(attachmentPath(projectPath, id), png)
  await prune(dir)
  return id
}

export async function removeAttachment(projectPath: string, id: string): Promise<void> {
  await rm(attachmentPath(projectPath, id), { force: true })
}

/** Unsent captures pile up if the user discards drafts; keep the newest few. */
async function prune(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.png'))
  if (names.length <= KEEP) return
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })))
  dated.sort((a, b) => b.t - a.t)
  await Promise.all(dated.slice(KEEP).map(({ n }) => rm(join(dir, n), { force: true })))
}

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunArtifact, RunRecord } from '../../shared/types'
import { ATTACHMENT_ID } from '../attachments'
import { readJson, writeJson } from '../store'

export const RUN_ID = /^[0-9a-f-]{36}$/
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

const imageType = (name: string): string | undefined => IMAGE_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()]

/**
 * Runs on disk: <runsDir>/<id>.json, plus each run's artifacts (screenshots the
 * agent saved) and inputs (copies of the user's attachments). Ids and names are
 * validated before they reach a path, because they come from the renderer.
 */
export class RunStore {
  constructor(readonly runsDir: string) {}

  artifactsDir(runId: string): string {
    return join(this.runsDir, `${runId}-artifacts`)
  }

  inputsDir(runId: string): string {
    return join(this.runsDir, `${runId}-inputs`)
  }

  /** Image artifact as a data: URL for the renderer (no file paths cross IPC). */
  async artifactDataUrl(runId: string, name: string): Promise<string> {
    if (!RUN_ID.test(runId) || !/^[\w.-]+$/.test(name)) throw new Error('Invalid artifact')
    const type = imageType(name)
    if (!type) throw new Error('Unsupported artifact type')
    const data = await readFile(join(this.artifactsDir(runId), name))
    return `data:${type};base64,${data.toString('base64')}`
  }

  /** A screenshot the user attached to the run's prompt, as a data: URL. */
  async attachmentDataUrl(runId: string, id: string): Promise<string> {
    if (!RUN_ID.test(runId) || !ATTACHMENT_ID.test(id)) throw new Error('Invalid attachment')
    const data = await readFile(join(this.inputsDir(runId), `${id}.png`))
    return `data:image/png;base64,${data.toString('base64')}`
  }

  async scanArtifacts(runId: string): Promise<RunArtifact[]> {
    try {
      const dir = this.artifactsDir(runId)
      const names = (await readdir(dir)).filter((n) => imageType(n) && /^[\w.-]+$/.test(n))
      return names.sort().map((name) => ({ name, mediaType: imageType(name)!, at: new Date().toISOString() }))
    } catch {
      return []
    }
  }

  async read(runId: string): Promise<RunRecord | null> {
    if (!RUN_ID.test(runId)) return null
    return readJson<RunRecord>(join(this.runsDir, `${runId}.json`))
  }

  /** Live runs come from memory (their files lag behind); the rest from disk. Runs interrupted by an app exit are marked failed. */
  async readAll(projectId: string, live: (runId: string) => RunRecord | undefined): Promise<RunRecord[]> {
    let files: string[] = []
    try {
      files = (await readdir(this.runsDir)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: RunRecord[] = []
    for (const f of files) {
      const current = live(f.slice(0, -'.json'.length))
      if (current) {
        if (current.projectId === projectId) out.push(current)
        continue
      }
      const rec = await readJson<RunRecord>(join(this.runsDir, f)).catch(() => null)
      if (!rec || rec.projectId !== projectId) continue
      if (rec.status === 'running' || rec.status === 'queued') {
        rec.status = 'failed'
        rec.error = 'Thinkerer exited while this run was active'
        rec.endedAt ??= new Date().toISOString()
        await this.persist(rec)
      }
      out.push(rec)
    }
    return out
  }

  async persist(record: RunRecord): Promise<void> {
    await mkdir(this.runsDir, { recursive: true })
    await writeJson(join(this.runsDir, `${record.id}.json`), record)
  }
}

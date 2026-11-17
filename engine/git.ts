import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitStatus } from '../shared/types'

const exec = promisify(execFile)

/** Returns null when the folder is not inside a Git work tree (or git is unavailable). */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], {
      cwd,
      maxBuffer: 8 * 1024 * 1024
    })
    const lines = stdout.split('\n').filter(Boolean)
    let branch: string | null = null
    const entries: GitStatus['entries'] = []
    for (const line of lines) {
      if (line.startsWith('## ')) branch = line.slice(3).split('...')[0].replace(/^No commits yet on /, '')
      else entries.push({ code: line.slice(0, 2), path: line.slice(3) })
    }
    return { branch, entries }
  } catch {
    return null
  }
}

import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// GUI-launched apps on macOS get a minimal PATH, so also look in the usual
// install locations for CLIs (Docker Desktop's included, for worktree hooks).
const EXTRA_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local/bin'),
  join(homedir(), '.npm-global/bin'),
  join(homedir(), '.claude/local'),
  '/Applications/Docker.app/Contents/Resources/bin'
]

export function searchPath(): string {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const d of EXTRA_DIRS) if (!dirs.includes(d)) dirs.push(d)
  return dirs.join(delimiter)
}

export async function findExecutable(name: string): Promise<string | null> {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  for (const dir of searchPath().split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return null
}

/** Environment for provider CLIs: inherited, with a usable PATH and without nesting markers. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath() }
  // If Thinkerer itself was started from a Claude Code session, these would make
  // the child think it is nested inside that session.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: childEnv(), timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

import { join } from 'node:path'
import type { McpImportCandidate, McpServerDef, McpTransport } from '../shared/types'
import { BUILTIN_SERVERS, validateDef } from './mcp'
import { readJson } from './store'

// Finds the MCP servers already configured for Claude Code (project .mcp.json,
// and the user and per-project servers in ~/.claude.json) so they can be added
// to Thinkerer's registry. Read-only: Claude's files are never changed.
// Secret-looking values are split off: they go to Thinkerer's encrypted store
// on import and never reach the renderer.

export interface FoundServer {
  candidate: McpImportCandidate
  /** Secret values to store on import, by secret name. Main-process only. */
  secrets: Record<string, string>
}

type RawServer = {
  type?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
}

const SECRETISH = /TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|_PAT$|^PAT$/i
const SECRETISH_HEADER = /^(authorization|cookie|proxy-authorization)$|token|key|secret|auth/i
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g
/** A value that is nothing but one reference, e.g. "${TOKEN}" or "${PORT:-3000}". */
const WHOLE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/

export async function findClaudeMcpServers(projectPath: string, home: string, existingIds: string[]): Promise<FoundServer[]> {
  const found: FoundServer[] = []
  const add = (source: McpImportCandidate['source'], sourceLabel: string, servers: unknown) => {
    if (!servers || typeof servers !== 'object') return
    for (const [name, raw] of Object.entries(servers as Record<string, RawServer>)) {
      if (found.length >= 100) return
      found.push(convert(source, sourceLabel, name, raw ?? {}, existingIds))
    }
  }
  const projectFile = await readJson<{ mcpServers?: unknown }>(join(projectPath, '.mcp.json')).catch(() => null)
  add('project', '.mcp.json', projectFile?.mcpServers)
  const user = await readJson<{ mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }>(join(home, '.claude.json')).catch(() => null)
  add('user', '~/.claude.json (user)', user?.mcpServers)
  add('user-project', '~/.claude.json (this project)', user?.projects?.[projectPath]?.mcpServers)
  return found
}

export function toServerId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '')
  return (slug || 'server').slice(0, 31).replace(/-+$/, '')
}

const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1').slice(0, 64)

function convert(source: McpImportCandidate['source'], sourceLabel: string, name: string, raw: RawServer, existingIds: string[]): FoundServer {
  const secrets: Record<string, string> = {}
  const missing = new Set<string>()
  const notes: string[] = []
  // Built-in ids can't be replaced, so an import with the same name gets its own id.
  let id = toServerId(name)
  if (BUILTIN_SERVERS.some((b) => b.id === id)) {
    const builtin = id
    id = `${id.slice(0, 22)}-imported`
    notes.push(`"${builtin}" is a built-in server, so this is imported as "${id}"`)
  }
  const type = typeof raw.type === 'string' ? raw.type : typeof raw.url === 'string' ? 'http' : 'stdio'
  let unsupported: string | null = null
  const draft: McpServerDef = { id, label: name.slice(0, 100), description: `Imported from ${sourceLabel}`, builtin: false, command: '', args: [], env: {}, secretEnv: [] }

  if (type === 'stdio') {
    draft.transport = 'stdio'
    draft.command = typeof raw.command === 'string' ? raw.command : ''
    draft.args = Array.isArray(raw.args) ? raw.args.map(String) : []
    if (draft.args.some((a) => a.includes('${'))) unsupported = 'Its arguments use environment variables, which Thinkerer does not expand'
    for (const [key, value] of Object.entries((raw.env as Record<string, unknown>) ?? {})) {
      const v = String(value)
      const whole = v.match(WHOLE_REF)
      const fromShell = v.search(ENV_REF) >= 0
      if (!fromShell && !SECRETISH.test(key)) {
        draft.env[key] = v
        continue
      }
      // Secrets are stored and passed under their env var name, which must be upper-case.
      if (!ENV_KEY.test(key)) {
        unsupported = `Its env var "${key}" needs a secret value, but Thinkerer can only store secrets for upper-case names like ${envName(key)}`
        continue
      }
      draft.secretEnv.push(key)
      if (!fromShell) secrets[key] = v
      else if (whole?.[2] !== undefined) {
        // "${VAR:-default}": Claude falls back to the default, so start from it.
        secrets[key] = whole[2]
        notes.push(`${key} starts as its default "${whole[2]}"; change it in the MCP tab if your shell sets ${whole[1]}`)
      } else {
        // Claude fills this from your shell environment; in Thinkerer it becomes a secret you set once.
        missing.add(key)
        if (!whole) notes.push(`Set ${key} to the full value, not only the variable: ${v}`)
      }
    }
  } else if (type === 'http' || type === 'sse') {
    draft.transport = type as McpTransport
    draft.url = typeof raw.url === 'string' ? raw.url : ''
    if (draft.url.includes('${')) unsupported = 'Its URL uses environment variables, which Thinkerer does not expand'
    draft.headers = {}
    for (const [header, value] of Object.entries((raw.headers as Record<string, unknown>) ?? {})) {
      const v = String(value)
      if (v.includes('${')) {
        draft.headers[header] = v.replace(ENV_REF, (_m, ref: string) => {
          const n = envName(ref)
          missing.add(n)
          if (!draft.secretEnv.includes(n)) draft.secretEnv.push(n)
          return '${' + n + '}'
        })
      } else if (SECRETISH_HEADER.test(header)) {
        const bearer = v.match(/^Bearer\s+(.+)$/i)
        const n = envName(`${id}_${bearer ? 'token' : header}`)
        draft.secretEnv.push(n)
        secrets[n] = bearer ? bearer[1] : v
        draft.headers[header] = bearer ? 'Bearer ${' + n + '}' : '${' + n + '}'
      } else {
        draft.headers[header] = v
      }
    }
  } else {
    unsupported = `Thinkerer can't run "${type}" servers`
  }

  let def = draft
  if (!unsupported) {
    try {
      def = validateDef(draft)
    } catch (err) {
      unsupported = (err as Error).message
    }
  }
  return {
    candidate: {
      key: `${source}:${name}`,
      source,
      sourceLabel,
      name,
      def,
      secretsFound: Object.keys(secrets),
      secretsMissing: [...missing],
      exists: existingIds.includes(id),
      unsupported,
      notes
    },
    secrets
  }
}

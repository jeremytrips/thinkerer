import { join } from 'node:path'
import type { McpImportCandidate, McpServerDef, McpTransport } from '../shared/types'
import { validateDef } from './mcp'
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
  const id = toServerId(name)
  const secrets: Record<string, string> = {}
  const missing = new Set<string>()
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
      const refs = [...v.matchAll(ENV_REF)]
      if (refs.length) {
        // Claude fills this from your shell environment; in Thinkerer it becomes a secret you set once.
        draft.secretEnv.push(key)
        missing.add(key)
      } else if (SECRETISH.test(key)) {
        draft.secretEnv.push(key)
        secrets[key] = v
      } else {
        draft.env[key] = v
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
      unsupported
    },
    secrets
  }
}

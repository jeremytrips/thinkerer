import { join } from 'node:path'
import type { EffectiveMcp, McpServerDef, McpServerView, McpTransport, Project, ProviderId } from '../shared/types'
import { codexHeaderRef } from './agents/codex'
import { readJson, writeJson } from './store'

// One global registry of MCP servers (built-ins + user-added), with a
// per-project allowlist in .thinkerer/project.json (agent.enabledMcpServers).
// The same resolved servers are handed to every provider adapter, each of
// which translates them into its CLI's own config mechanism.

export interface SecretStore {
  get(serverId: string, name: string): Promise<string | null>
  set(serverId: string, name: string, value: string | null): Promise<void>
  names(serverId: string): Promise<string[]>
}

/** A server ready to launch for one run: placeholders filled, secrets as env var names. */
export interface ResolvedMcpServer {
  id: string
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  /** Remote servers only (empty for stdio). Header values may still contain ${SECRET} references. */
  url: string
  headers: Record<string, string>
  /** Secret env var names; values are supplied through the CLI process environment. */
  secretEnv: string[]
}

export interface McpRunContext {
  /** Directory with Thinkerer's bundled MCP scripts (mcp/) and node_modules. */
  appRoot: string
  /** Command used to run Node scripts. */
  node: { command: string; env: Record<string, string> }
  artifactsDir: string
  /** Where the agent works (a chat's worktree); defaults to the project folder. */
  cwd?: string
  /** Preview URL resolved for that worktree's ports; defaults to the configured one. */
  previewUrl?: string | null
  /** The provider the servers are for; servers it can't use are left out. */
  provider?: ProviderId
  /** The chat's own emulator ids; the mobile server accepts only these. Undefined: not limited. */
  devices?: string[]
}

const ID = /^[a-z][a-z0-9-]{0,30}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/
const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']
const SECRET_REF = /\$\{([A-Z_][A-Z0-9_]{0,63})\}/g

export const BUILTIN_SERVERS: McpServerDef[] = [
  {
    id: 'playwright',
    label: 'Playwright browser',
    description:
      'Headless Chromium the agent can drive (navigate, click, type, screenshot) — restricted to the project’s preview origin. Isolated in-memory profile per run; screenshots are saved with the run.',
    builtin: true,
    command: '{node}',
    args: [
      '{appRoot}/mcp/playwright-launch.mjs',
      '{artifacts}',
      '--headless',
      '--isolated',
      '--browser', 'chromium',
      '--ignore-roots',
      '--output-dir', '{artifacts}',
      '--allowed-origins', '{previewOrigin}'
    ],
    env: {},
    secretEnv: []
  },
  {
    id: 'health',
    label: 'Project health',
    description: 'Read-only demonstration server: reports Git branch, uncommitted files, Node version and whether the preview URL responds.',
    builtin: true,
    command: '{node}',
    args: ['{appRoot}/mcp/thinkerer-health.mjs'],
    env: { THINKERER_PROJECT_ROOT: '{project}', THINKERER_PREVIEW_URL: '{previewUrl}' },
    secretEnv: []
  },
  {
    id: 'mobile',
    label: 'Mobile emulators',
    description:
      'Real Android emulators (Android SDK) and iOS simulators (Xcode) on this machine: boot, screenshot, tap, swipe, type, read the UI tree, install and launch apps, open URLs. iOS input needs idb. Screenshots are saved with the run.',
    builtin: true,
    command: '{node}',
    args: ['{appRoot}/mcp/thinkerer-mobile.mjs'],
    env: { THINKERER_ARTIFACTS: '{artifacts}', THINKERER_PROJECT_ROOT: '{project}', THINKERER_PREVIEW_URL: '{previewUrl}' },
    secretEnv: []
  }
]

interface RegistryFile {
  schemaVersion: 1
  servers: McpServerDef[]
}

export class McpRegistry {
  private readonly file: string

  constructor(
    appDataDir: string,
    private readonly secrets: SecretStore
  ) {
    this.file = join(appDataDir, 'mcp-registry.json')
  }

  async list(): Promise<McpServerView[]> {
    const custom = (await this.read()).servers
    return Promise.all([...BUILTIN_SERVERS, ...custom].map(async (s) => ({ ...s, secretsSet: await this.secrets.names(s.id) })))
  }

  async get(id: string): Promise<McpServerDef | null> {
    return (await this.all()).find((s) => s.id === id) ?? null
  }

  /** Add or replace a user-defined server. Secrets are never stored here. */
  async upsert(def: McpServerDef): Promise<McpServerDef> {
    const clean = validateDef(def)
    if (isBuiltinId(clean.id)) throw new Error('That id belongs to a built-in server')
    const reg = await this.read()
    reg.servers = [...reg.servers.filter((s) => s.id !== clean.id), clean]
    await writeJson(this.file, reg)
    return clean
  }

  async remove(id: string): Promise<void> {
    if (isBuiltinId(id)) throw new Error('Built-in servers cannot be removed')
    const reg = await this.read()
    const def = reg.servers.find((s) => s.id === id)
    reg.servers = reg.servers.filter((s) => s.id !== id)
    await writeJson(this.file, reg)
    for (const name of def?.secretEnv ?? []) await this.secrets.set(id, name, null)
  }

  async setSecret(id: string, name: string, value: string | null): Promise<void> {
    const def = await this.get(id)
    if (!def || !def.secretEnv.includes(name)) throw new Error('Unknown secret for this server')
    if (value !== null && (typeof value !== 'string' || value.length > 8192)) throw new Error('Invalid secret value')
    await this.secrets.set(id, name, value)
  }

  /** What each provider will receive for this project, with reasons for anything left out. */
  async effective(project: Project, provider: ProviderId): Promise<EffectiveMcp> {
    const enabled = project.config?.agent.enabledMcpServers ?? []
    const servers = await Promise.all(
      enabled.map(async (id) => {
        const def = await this.get(id)
        if (!def) return { id, label: id, included: false, reason: 'Not in the registry' }
        const reason = await this.exclusionReason(def, project, provider)
        return { id, label: def.label, included: !reason, reason }
      })
    )
    return { provider, servers }
  }

  /** Servers to launch for one run, plus the secret values to place in the CLI's environment. */
  async resolveForRun(project: Project, ctx: McpRunContext): Promise<{ servers: ResolvedMcpServer[]; secretEnv: Record<string, string> }> {
    const servers: ResolvedMcpServer[] = []
    const secretEnv: Record<string, string> = {}
    for (const id of project.config?.agent.enabledMcpServers ?? []) {
      const def = await this.get(id)
      if (!def || (await this.exclusionReason(def, project, ctx.provider))) continue
      const one = await this.resolveOne(def, project, ctx)
      if (!one) continue
      servers.push(one.server)
      Object.assign(secretEnv, one.secretEnv)
    }
    return { servers, secretEnv }
  }

  /** One server ready to launch (placeholders filled), or null if it can't run in this context. */
  async resolveOne(def: McpServerDef, project: Project, ctx: McpRunContext): Promise<{ server: ResolvedMcpServer; secretEnv: Record<string, string> } | null> {
    const preview = ctx.previewUrl !== undefined ? (ctx.previewUrl ?? '') : (project.config?.website.previewUrl ?? '')
    // The browser is fenced to the preview origin; without a valid one it must not start.
    if (def.id === 'playwright' && !originOf(preview)) return null
    const vars: Record<string, string> = {
      appRoot: ctx.appRoot,
      artifacts: ctx.artifactsDir,
      project: ctx.cwd ?? project.path,
      previewUrl: preview,
      previewOrigin: originOf(preview)
    }
    const fill = (s: string) => s.replace(/\{(appRoot|artifacts|project|previewUrl|previewOrigin)\}/g, (_m, k: string) => vars[k])
    const transport = def.transport ?? 'stdio'
    const usesNode = def.command === '{node}'
    const secretEnv: Record<string, string> = {}
    for (const name of def.secretEnv) {
      const value = await this.secrets.get(def.id, name)
      if (value === null) return null
      secretEnv[name] = value
    }
    const env = transport === 'stdio' ? { ...(usesNode ? ctx.node.env : {}), ...Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, fill(v)])) } : {}
    // The chat's own emulators: the server refuses every other device.
    if (def.id === 'mobile' && def.builtin && ctx.devices) env.THINKERER_DEVICES = ctx.devices.join(',')
    return {
      server: {
        id: def.id,
        transport,
        command: transport === 'stdio' ? (usesNode ? ctx.node.command : def.command) : '',
        args: transport === 'stdio' ? def.args.map(fill) : [],
        env,
        url: transport === 'stdio' ? '' : (def.url ?? ''),
        headers: transport === 'stdio' ? {} : { ...(def.headers ?? {}) },
        secretEnv: def.secretEnv
      },
      secretEnv
    }
  }

  private async exclusionReason(def: McpServerDef, project: Project, provider?: ProviderId): Promise<string | null> {
    if (def.id === 'playwright' && !project.config?.website.previewUrl) return 'Set a preview URL — the browser is restricted to that origin'
    if (provider === 'codex' && def.transport === 'sse') return 'Codex supports stdio and streamable HTTP servers, not SSE'
    if (provider === 'codex' && Object.entries(def.headers ?? {}).some(([n, v]) => codexHeaderRef(n, v) === 'unsupported')) {
      return 'Codex can only use a secret as a whole header value or as "Authorization: Bearer ${NAME}"'
    }
    const set = await this.secrets.names(def.id)
    const missing = def.secretEnv.filter((n) => !set.includes(n))
    if (missing.length) return `Missing secret${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
    return null
  }

  private async all(): Promise<McpServerDef[]> {
    return [...BUILTIN_SERVERS, ...(await this.read()).servers]
  }

  private async read(): Promise<RegistryFile> {
    const raw = await readJson<Partial<RegistryFile>>(this.file).catch(() => null)
    const servers = Array.isArray(raw?.servers) ? raw.servers.flatMap((s) => { try { return [validateDef(s)] } catch { return [] } }) : []
    const reg: RegistryFile = { schemaVersion: 1, servers }
    if (servers.some((s) => isBuiltinId(s.id))) await this.renameShadowed(reg)
    return reg
  }

  /**
   * A user server saved before a built-in took its id (e.g. 'mobile') would be
   * hidden behind the built-in and impossible to edit or remove. Give it a free
   * id, move its secrets along and say so in its label, then save. Projects that
   * enabled the old id now get the built-in; the renamed server can be enabled again.
   */
  private async renameShadowed(reg: RegistryFile): Promise<void> {
    const taken = new Set([...BUILTIN_SERVERS, ...reg.servers].map((s) => s.id))
    for (const [i, def] of reg.servers.entries()) {
      if (!isBuiltinId(def.id)) continue
      const id = freeId(`${def.id}-custom`, taken)
      taken.add(id)
      for (const name of def.secretEnv) {
        const value = await this.secrets.get(def.id, name)
        if (value === null) continue
        await this.secrets.set(id, name, value)
        await this.secrets.set(def.id, name, null)
      }
      reg.servers[i] = { ...def, id, label: `${def.label} (renamed from "${def.id}", now a built-in id)`.slice(0, 100) }
    }
    await writeJson(this.file, reg)
  }
}

export function validateDef(def: McpServerDef): McpServerDef {
  if (!def || typeof def !== 'object') throw new Error('Invalid server')
  if (typeof def.id !== 'string' || !ID.test(def.id)) throw new Error('Server id must be lowercase letters, digits and dashes')
  if (typeof def.label !== 'string' || !def.label.trim() || def.label.length > 100) throw new Error('Label is required')
  const transport = def.transport ?? 'stdio'
  if (!TRANSPORTS.includes(transport)) throw new Error('Transport must be stdio, http or sse')
  const secretEnv = def.secretEnv ?? []
  if (!Array.isArray(secretEnv) || secretEnv.some((n) => typeof n !== 'string' || !ENV_NAME.test(n))) throw new Error('Secret names must look like ENV_VAR names')
  const base = {
    id: def.id,
    label: def.label.trim(),
    description: typeof def.description === 'string' ? def.description.slice(0, 500) : '',
    builtin: false,
    secretEnv: [...new Set(secretEnv)]
  }
  if (transport !== 'stdio') {
    let url: URL
    try {
      url = new URL(typeof def.url === 'string' ? def.url.trim() : '')
    } catch {
      throw new Error('A remote server needs a valid URL')
    }
    if (!/^https?:$/.test(url.protocol) || (def.url as string).length > 2000) throw new Error('The server URL must be http(s)')
    const headers = def.headers ?? {}
    if (typeof headers !== 'object' || Object.keys(headers).length > 30) throw new Error('Invalid headers')
    for (const [k, v] of Object.entries(headers)) {
      if (!HEADER_NAME.test(k) || typeof v !== 'string' || v.length > 4000 || /[\r\n]/.test(v)) throw new Error(`Invalid header ${k}`)
      for (const [, ref] of v.matchAll(SECRET_REF)) {
        if (!base.secretEnv.includes(ref)) throw new Error(`Header ${k} uses \${${ref}}; add ${ref} to the secrets`)
      }
    }
    return { ...base, transport, command: '', args: [], env: {}, url: url.toString(), headers: { ...headers } }
  }
  if (typeof def.command !== 'string' || !def.command.trim() || def.command.length > 500) throw new Error('Command is required')
  if (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string' || a.length > 2000) || def.args.length > 100) throw new Error('Invalid arguments')
  const env = def.env ?? {}
  if (typeof env !== 'object' || Object.entries(env).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== 'string')) throw new Error('Invalid environment')
  return { ...base, transport: 'stdio', command: def.command.trim(), args: def.args, env: { ...env } }
}

/** Origin of a preview URL, or '' when it is empty or not a valid URL (e.g. an unfilled {portN} template). */
function originOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export const isBuiltinId = (id: string) => BUILTIN_SERVERS.some((b) => b.id === id)

/** `base`, or `base-2`, `base-3`… — the first one not in `taken`, within the id length limit. */
export function freeId(base: string, taken: Set<string>): string {
  const fit = (stem: string, suffix: string) => stem.slice(0, 31 - suffix.length).replace(/-+$/, '') + suffix
  let id = fit(base, '')
  for (let n = 2; taken.has(id); n++) id = fit(base, `-${n}`)
  return id
}

import { join } from 'node:path'
import type { EffectiveMcp, McpServerDef, McpServerView, Project, ProviderId } from '../shared/types'
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
  command: string
  args: string[]
  env: Record<string, string>
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
}

const ID = /^[a-z][a-z0-9-]{0,30}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/

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
    if (BUILTIN_SERVERS.some((b) => b.id === clean.id)) throw new Error('That id belongs to a built-in server')
    const reg = await this.read()
    reg.servers = [...reg.servers.filter((s) => s.id !== clean.id), clean]
    await writeJson(this.file, reg)
    return clean
  }

  async remove(id: string): Promise<void> {
    if (BUILTIN_SERVERS.some((b) => b.id === id)) throw new Error('Built-in servers cannot be removed')
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
        const reason = await this.exclusionReason(def, project)
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
      if (!def || (await this.exclusionReason(def, project))) continue
      const preview = ctx.previewUrl !== undefined ? (ctx.previewUrl ?? '') : project.config!.website.previewUrl
      if (def.id === 'playwright' && !preview) continue
      const vars: Record<string, string> = {
        appRoot: ctx.appRoot,
        artifacts: ctx.artifactsDir,
        project: ctx.cwd ?? project.path,
        previewUrl: preview,
        previewOrigin: preview ? new URL(preview).origin : ''
      }
      const fill = (s: string) => s.replace(/\{(appRoot|artifacts|project|previewUrl|previewOrigin)\}/g, (_m, k: string) => vars[k])
      const usesNode = def.command === '{node}'
      servers.push({
        id: def.id,
        command: usesNode ? ctx.node.command : def.command,
        args: def.args.map(fill),
        env: { ...(usesNode ? ctx.node.env : {}), ...Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, fill(v)])) },
        secretEnv: def.secretEnv
      })
      for (const name of def.secretEnv) secretEnv[name] = (await this.secrets.get(def.id, name))!
    }
    return { servers, secretEnv }
  }

  private async exclusionReason(def: McpServerDef, project: Project): Promise<string | null> {
    if (def.id === 'playwright' && !project.config?.website.previewUrl) return 'Set a preview URL — the browser is restricted to that origin'
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
    return { schemaVersion: 1, servers }
  }
}

export function validateDef(def: McpServerDef): McpServerDef {
  if (!def || typeof def !== 'object') throw new Error('Invalid server')
  if (typeof def.id !== 'string' || !ID.test(def.id)) throw new Error('Server id must be lowercase letters, digits and dashes')
  if (typeof def.label !== 'string' || !def.label.trim() || def.label.length > 100) throw new Error('Label is required')
  if (typeof def.command !== 'string' || !def.command.trim() || def.command.length > 500) throw new Error('Command is required')
  if (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string' || a.length > 2000) || def.args.length > 100) throw new Error('Invalid arguments')
  const env = def.env ?? {}
  if (typeof env !== 'object' || Object.entries(env).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== 'string')) throw new Error('Invalid environment')
  const secretEnv = def.secretEnv ?? []
  if (!Array.isArray(secretEnv) || secretEnv.some((n) => typeof n !== 'string' || !ENV_NAME.test(n))) throw new Error('Secret names must look like ENV_VAR names')
  return {
    id: def.id,
    label: def.label.trim(),
    description: typeof def.description === 'string' ? def.description.slice(0, 500) : '',
    builtin: false,
    command: def.command.trim(),
    args: def.args,
    env: { ...env },
    secretEnv: [...new Set(secretEnv)]
  }
}

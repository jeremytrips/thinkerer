import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeOptionalTool, ClaudeRunConfig, Component, Effort, Project, ProjectConfig, ProjectConfigPatch, ProtocolConfig, ProviderChoice, Target } from '../shared/types'
import { readJson, writeJson } from './store'

const exec = promisify(execFile)

const COMPONENTS: Component[] = ['website', 'mobile', 'hardware']
const TARGETS: Target[] = ['web', 'electron']
const PROVIDERS: ProviderChoice[] = ['auto', 'claude', 'codex']
export const EFFORTS: Effort[] = ['', 'low', 'medium', 'high', 'xhigh', 'max']
// 'Task' is the subagent tool. Claude Code 2.1.330 accepts both 'Task' and 'Agent' in --tools and
// reports it as 'Task'; 'Agent' is accepted as an alias and stored as 'Task'.
export const CLAUDE_OPTIONAL_TOOLS: ClaudeOptionalTool[] = ['Task', 'Skill', 'WebSearch', 'NotebookEdit']
const canonicalTool = (t: unknown) => (t === 'Agent' ? 'Task' : t)
/** Subagents and skills stay inside the run's limits, so they're on by default; network tools are opt-in. */
export const DEFAULT_CLAUDE: ClaudeRunConfig = { model: '', effort: '', tools: ['Task', 'Skill'] }
/** A model alias (opus, sonnet…) or full name, optionally with a context suffix such as [1m]. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,99}(\[[0-9a-z]{1,10}\])?$/

function normalizeClaude(raw: Partial<ClaudeRunConfig> | undefined): ClaudeRunConfig {
  return {
    model: typeof raw?.model === 'string' && MODEL.test(raw.model) ? raw.model : DEFAULT_CLAUDE.model,
    effort: EFFORTS.includes(raw?.effort as Effort) ? (raw!.effort as Effort) : DEFAULT_CLAUDE.effort,
    tools: Array.isArray(raw?.tools) ? CLAUDE_OPTIONAL_TOOLS.filter((t) => raw!.tools!.map(canonicalTool).includes(t)) : [...DEFAULT_CLAUDE.tools]
  }
}

export const MAX_REVIEW_ROUNDS = 5
export const DEFAULT_REVIEW_ROUNDS = 2

function normalizeProtocol(raw: Partial<ProtocolConfig> | undefined): ProtocolConfig {
  const rounds = raw?.maxReviewRounds
  return {
    checkCommand: typeof raw?.checkCommand === 'string' ? raw.checkCommand : '',
    maxReviewRounds: Number.isInteger(rounds) ? Math.min(MAX_REVIEW_ROUNDS, Math.max(1, rounds!)) : DEFAULT_REVIEW_ROUNDS,
    review: {
      model: typeof raw?.review?.model === 'string' && MODEL.test(raw.review.model) ? raw.review.model : '',
      effort: EFFORTS.includes(raw?.review?.effort as Effort) ? (raw!.review!.effort as Effort) : ''
    }
  }
}

/** The project's own checks, when package.json has them; Thinkerer runs them after implement turns. */
function detectCheckCommand(scripts: Record<string, string> | undefined): string {
  const parts = [scripts?.typecheck && 'npm run typecheck', scripts?.test && 'npm test'].filter(Boolean)
  return parts.join(' && ')
}

interface IndexEntry {
  id: string
  path: string
  addedAt: string
}
interface ProjectsIndex {
  schemaVersion: 1
  projects: IndexEntry[]
}

export function configFile(projectPath: string): string {
  return join(projectPath, '.thinkerer', 'project.json')
}

/**
 * Registered projects live in <appData>/projects-index.json; each project's
 * non-secret configuration lives in its own folder at .thinkerer/project.json.
 * The folder on disk is the source of truth.
 */
export class ProjectService {
  private readonly indexFile: string

  constructor(appDataDir: string) {
    this.indexFile = join(appDataDir, 'projects-index.json')
  }

  async list(): Promise<Project[]> {
    const index = await this.readIndex()
    return Promise.all(index.projects.map((e) => this.hydrate(e)))
  }

  async get(id: string): Promise<Project> {
    const entry = (await this.readIndex()).projects.find((p) => p.id === id)
    if (!entry) throw new Error('Unknown project')
    return this.hydrate(entry)
  }

  /** Register an existing folder. Re-importing the same folder returns the existing project. */
  async importFolder(folder: string): Promise<Project> {
    const real = await realpath(folder)
    if (!(await stat(real)).isDirectory()) throw new Error('Not a folder')
    const index = await this.readIndex()
    const existing = index.projects.find((p) => p.path === real)
    if (existing) return this.hydrate(existing)

    if (!(await readJson(configFile(real)))) {
      await writeJson(configFile(real), await detectDefaults(real))
    }
    const entry: IndexEntry = { id: randomUUID(), path: real, addedAt: new Date().toISOString() }
    index.projects.push(entry)
    await this.writeIndex(index)
    return this.hydrate(entry)
  }

  /** Create a new, empty project folder `<parentDir>/<name>` and register it. */
  async create(parentDir: string, name: string): Promise<Project> {
    const folderName = name.trim()
    if (!folderName || folderName.length > 100 || /[/\\:\0]/.test(folderName) || folderName === '.' || folderName === '..') {
      throw new Error('Project name must be a valid folder name')
    }
    const folder = join(await realpath(parentDir), folderName)
    await mkdir(folder) // fails if it already exists — never adopt an existing folder silently
    const config = await detectDefaults(folder)
    config.name = folderName
    await writeJson(configFile(folder), config)
    try {
      await exec('git', ['init', '-q'], { cwd: folder })
    } catch {
      // Git is optional for Phase 0; checkpoints arrive in Phase 1.
    }
    return this.importFolder(folder)
  }

  async updateConfig(id: string, patch: ProjectConfigPatch): Promise<Project> {
    const project = await this.get(id)
    if (project.status === 'missing') throw new Error('Project folder is missing')
    const next = applyPatch(project.config ?? (await detectDefaults(project.path)), patch)
    await writeJson(configFile(project.path), next)
    return this.get(id)
  }

  /** Unregister only. The folder on disk is never touched. */
  async remove(id: string): Promise<void> {
    const index = await this.readIndex()
    index.projects = index.projects.filter((p) => p.id !== id)
    await this.writeIndex(index)
  }

  private async hydrate(entry: IndexEntry): Promise<Project> {
    try {
      if (!(await stat(entry.path)).isDirectory()) throw new Error('not a dir')
    } catch {
      return { ...entry, status: 'missing', config: null }
    }
    const raw = await readJson<Partial<ProjectConfig>>(configFile(entry.path)).catch(() => null)
    const config = normalizeConfig(raw, basename(entry.path))
    return { ...entry, status: 'ok', config }
  }

  private async readIndex(): Promise<ProjectsIndex> {
    return (await readJson<ProjectsIndex>(this.indexFile)) ?? { schemaVersion: 1, projects: [] }
  }

  private writeIndex(index: ProjectsIndex): Promise<void> {
    return writeJson(this.indexFile, index)
  }
}

async function detectDefaults(folder: string): Promise<ProjectConfig> {
  const pkg = await readJson<{
    name?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }>(join(folder, 'package.json')).catch(() => null)
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  let hasFiles = false
  try {
    hasFiles = (await readdir(folder)).some((n) => n !== '.git' && n !== '.thinkerer')
  } catch {
    // ignore
  }
  return {
    schemaVersion: 1,
    name: basename(folder),
    components: ['website'],
    target: 'electron' in deps ? 'electron' : 'web',
    website: {
      devCommand: pkg?.scripts?.dev ? 'npm run dev' : hasFiles ? '' : 'npm run dev',
      previewUrl: 'http://localhost:5173'
    },
    agent: { provider: 'auto', enabledMcpServers: [], claude: normalizeClaude(undefined) },
    worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
    protocol: { ...normalizeProtocol(undefined), checkCommand: detectCheckCommand(pkg?.scripts) },
    marketing: { enabled: true }
  }
}

export const MAX_WORKTREE_PORTS = 10

export function normalizeConfig(raw: Partial<ProjectConfig> | null, fallbackName: string): ProjectConfig {
  const r = raw ?? {}
  return {
    schemaVersion: 1,
    name: typeof r.name === 'string' && r.name.trim() ? r.name : fallbackName,
    components: Array.isArray(r.components) ? r.components.filter((c) => COMPONENTS.includes(c)) : ['website'],
    target: TARGETS.includes(r.target as Target) ? (r.target as Target) : 'web',
    website: {
      devCommand: typeof r.website?.devCommand === 'string' ? r.website.devCommand : '',
      previewUrl: typeof r.website?.previewUrl === 'string' ? r.website.previewUrl : 'http://localhost:5173'
    },
    agent: {
      provider: PROVIDERS.includes(r.agent?.provider as ProviderChoice) ? (r.agent!.provider as ProviderChoice) : 'auto',
      enabledMcpServers: Array.isArray(r.agent?.enabledMcpServers)
        ? r.agent!.enabledMcpServers.filter((s) => typeof s === 'string')
        : [],
      claude: normalizeClaude(r.agent?.claude)
    },
    worktrees: {
      setupCommand: typeof r.worktrees?.setupCommand === 'string' ? r.worktrees.setupCommand : '',
      teardownCommand: typeof r.worktrees?.teardownCommand === 'string' ? r.worktrees.teardownCommand : '',
      ports: Number.isInteger(r.worktrees?.ports) ? Math.min(MAX_WORKTREE_PORTS, Math.max(0, r.worktrees!.ports)) : 0
    },
    protocol: normalizeProtocol(r.protocol),
    marketing: { enabled: r.marketing?.enabled !== false }
  }
}

function applyPatch(config: ProjectConfig, patch: ProjectConfigPatch): ProjectConfig {
  const next = structuredClone(config)
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 100) throw new Error('Invalid name')
    next.name = patch.name.trim()
  }
  if (patch.components !== undefined) {
    if (!Array.isArray(patch.components) || patch.components.some((c) => !COMPONENTS.includes(c))) {
      throw new Error('Invalid components')
    }
    next.components = [...new Set(patch.components)]
  }
  if (patch.target !== undefined) {
    if (!TARGETS.includes(patch.target)) throw new Error('Invalid target')
    next.target = patch.target
  }
  if (patch.website?.devCommand !== undefined) {
    if (typeof patch.website.devCommand !== 'string' || patch.website.devCommand.length > 500) throw new Error('Invalid dev command')
    next.website.devCommand = patch.website.devCommand
  }
  if (patch.website?.previewUrl !== undefined) {
    const url = patch.website.previewUrl
    if (url !== '') {
      let parsed: URL
      try {
        // {portN} placeholders are filled per chat worktree; check the rest of the URL.
        parsed = new URL(url.replace(/\{port([1-9]|10)\}/g, '1'))
      } catch {
        throw new Error('Preview URL must be a valid URL')
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !/^https?:$/.test(parsed.protocol)) {
        throw new Error('Preview URL must be a local http(s) address')
      }
    }
    next.website.previewUrl = url
  }
  if (patch.agent?.provider !== undefined) {
    if (!PROVIDERS.includes(patch.agent.provider)) throw new Error('Invalid provider')
    next.agent.provider = patch.agent.provider
  }
  if (patch.agent?.enabledMcpServers !== undefined) {
    const ids = patch.agent.enabledMcpServers
    if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(id))) {
      throw new Error('Invalid MCP server list')
    }
    next.agent.enabledMcpServers = [...new Set(ids)]
  }
  const claude = patch.agent?.claude
  if (claude !== undefined) {
    if (!claude || typeof claude !== 'object') throw new Error('Invalid Claude options')
    if (claude.model !== undefined) {
      if (typeof claude.model !== 'string' || (claude.model !== '' && !MODEL.test(claude.model.trim()))) throw new Error('Model must be an alias like "opus" or a model name')
      next.agent.claude.model = claude.model.trim()
    }
    if (claude.effort !== undefined) {
      if (!EFFORTS.includes(claude.effort)) throw new Error('Invalid effort level')
      next.agent.claude.effort = claude.effort
    }
    if (claude.tools !== undefined) {
      const asked = Array.isArray(claude.tools) ? claude.tools.map(canonicalTool) : null
      if (!asked || asked.some((t) => !CLAUDE_OPTIONAL_TOOLS.includes(t as ClaudeOptionalTool))) throw new Error('Invalid Claude tools')
      next.agent.claude.tools = CLAUDE_OPTIONAL_TOOLS.filter((t) => asked.includes(t))
    }
  }
  for (const key of ['setupCommand', 'teardownCommand'] as const) {
    const v = patch.worktrees?.[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || v.length > 500) throw new Error(`Invalid ${key === 'setupCommand' ? 'setup' : 'teardown'} command`)
    next.worktrees[key] = v
  }
  if (patch.worktrees?.ports !== undefined) {
    const n = patch.worktrees.ports
    if (!Number.isInteger(n) || n < 0 || n > MAX_WORKTREE_PORTS) throw new Error(`Ports must be a whole number from 0 to ${MAX_WORKTREE_PORTS}`)
    next.worktrees.ports = n
  }
  const protocol = patch.protocol
  if (protocol !== undefined) {
    if (!protocol || typeof protocol !== 'object') throw new Error('Invalid protocol options')
    if (protocol.checkCommand !== undefined) {
      if (typeof protocol.checkCommand !== 'string' || protocol.checkCommand.length > 500) throw new Error('Invalid check command')
      next.protocol.checkCommand = protocol.checkCommand.trim()
    }
    if (protocol.maxReviewRounds !== undefined) {
      const n = protocol.maxReviewRounds
      if (!Number.isInteger(n) || n < 1 || n > MAX_REVIEW_ROUNDS) throw new Error(`Review rounds must be a whole number from 1 to ${MAX_REVIEW_ROUNDS}`)
      next.protocol.maxReviewRounds = n
    }
    const review = protocol.review
    if (review !== undefined) {
      if (!review || typeof review !== 'object') throw new Error('Invalid review options')
      if (review.model !== undefined) {
        if (typeof review.model !== 'string' || (review.model !== '' && !MODEL.test(review.model.trim()))) throw new Error('Review model must be an alias like "sonnet" or a model name')
        next.protocol.review.model = review.model.trim()
      }
      if (review.effort !== undefined) {
        if (!EFFORTS.includes(review.effort)) throw new Error('Invalid review effort level')
        next.protocol.review.effort = review.effort
      }
    }
  }
  return next
}

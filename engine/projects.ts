import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { Component, Project, ProjectConfig, ProjectConfigPatch, ProviderChoice, Target } from '../shared/types'
import { readJson, writeJson } from './store'

const exec = promisify(execFile)

const COMPONENTS: Component[] = ['website', 'mobile', 'hardware']
const TARGETS: Target[] = ['web', 'electron']
const PROVIDERS: ProviderChoice[] = ['auto', 'claude', 'codex']

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
    agent: { provider: 'auto', enabledMcpServers: [] },
    marketing: { enabled: true }
  }
}

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
        : []
    },
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
        parsed = new URL(url)
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
  return next
}

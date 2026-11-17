import type {
  AppInfo,
  FileContent,
  FileEntry,
  GitStatus,
  Project,
  ProjectConfigPatch,
  ProviderChoice,
  ProviderStatus,
  RunEvent,
  RunRecord,
  RunSummary
} from './types'

/** The complete privileged surface available to the renderer (window.thinkerer). */
export interface ThinkererApi {
  app: {
    info(): Promise<AppInfo>
    restart(): Promise<boolean>
  }
  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<Project>
    importFolder(): Promise<Project | null>
    create(name: string): Promise<Project | null>
    update(id: string, patch: ProjectConfigPatch): Promise<Project>
    remove(id: string): Promise<boolean>
    reveal(id: string): Promise<boolean>
  }
  files: {
    list(projectId: string, relPath: string): Promise<FileEntry[]>
    read(projectId: string, relPath: string): Promise<FileContent>
  }
  git: {
    status(projectId: string): Promise<GitStatus | null>
  }
  agents: {
    providers(): Promise<ProviderStatus[]>
  }
  runs: {
    start(projectId: string, prompt: string, provider: ProviderChoice): Promise<RunSummary>
    cancel(projectId: string): Promise<boolean>
    active(projectId: string): Promise<RunRecord | null>
    list(projectId: string): Promise<RunSummary[]>
    get(runId: string): Promise<RunRecord | null>
    onEvent(cb: (runId: string, event: RunEvent) => void): () => void
    onUpdate(cb: (summary: RunSummary) => void): () => void
  }
}

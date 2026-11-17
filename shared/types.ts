// Types shared by the engine (main process) and the renderer. The renderer only
// ever imports types from here; all behaviour lives behind the preload API.

export type Component = 'website' | 'mobile' | 'hardware'
export type Target = 'web' | 'electron'
export type ProviderId = 'claude' | 'codex'
export type ProviderChoice = 'auto' | ProviderId

export interface ProjectConfig {
  schemaVersion: 1
  name: string
  components: Component[]
  target: Target
  website: { devCommand: string; previewUrl: string }
  agent: { provider: ProviderChoice; enabledMcpServers: string[] }
  marketing: { enabled: boolean }
}

export interface Project {
  id: string
  path: string
  addedAt: string
  /** 'missing' when the registered folder no longer exists on disk. */
  status: 'ok' | 'missing'
  config: ProjectConfig | null
}

export interface ProjectConfigPatch {
  name?: string
  components?: Component[]
  target?: Target
  website?: { devCommand?: string; previewUrl?: string }
  agent?: { provider?: ProviderChoice }
}

export interface FileEntry {
  name: string
  /** Path relative to the project root, using '/' separators. */
  path: string
  kind: 'file' | 'dir' | 'symlink'
}

export type FileContent =
  | { kind: 'text'; path: string; text: string; size: number }
  | { kind: 'binary' | 'too-large'; path: string; size: number }

export interface GitStatus {
  branch: string | null
  /** Raw porcelain v1 lines, e.g. " M src/App.tsx". */
  entries: { code: string; path: string }[]
}

export interface ProviderStatus {
  id: ProviderId
  label: string
  installed: boolean
  executable: string | null
  version: string | null
  /** null when the CLI gives no reliable signal. */
  authenticated: boolean | null
  /** Whether Thinkerer has a working adapter for this CLI in this build. */
  adapterAvailable: boolean
  detail: string
  /** What runs with this provider are allowed to do (from the adapter). */
  policy: string
}

export type RunStatus = 'queued' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'cancelled'

export type RunEventKind = 'status' | 'text' | 'tool-use' | 'tool-result' | 'log' | 'stderr' | 'error' | 'result'

export interface RunEvent {
  at: string
  kind: RunEventKind
  text: string
  /** Tool name for tool-use events; is_error flag for tool results, etc. */
  meta?: Record<string, string | number | boolean | null>
}

/** Usage figures exactly as the provider CLI reported them. Absent = unavailable. */
export interface UsageObservation {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** Rate-limit window utilisation (0..1) reported by the CLI, keyed by window name. */
  windows?: Record<string, { utilization: number; resetsAt: string | null }>
  rateLimitStatus?: string
}

export interface RunRecord {
  id: string
  projectId: string
  projectPath: string
  prompt: string
  provider: ProviderId
  selection: { requested: ProviderChoice; rationale: string }
  status: RunStatus
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  exitCode: number | null
  error: string | null
  resultText: string | null
  currentAction: string | null
  usage: UsageObservation | null
  permissionDenials: { tool: string; input: string }[]
  gitBefore: GitStatus | null
  gitAfter: GitStatus | null
  events: RunEvent[]
}

export type RunSummary = Omit<RunRecord, 'events'>

export interface AppInfo {
  version: string
  isDev: boolean
  sourceRoot: string | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

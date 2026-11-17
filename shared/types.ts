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
  agent?: { provider?: ProviderChoice; enabledMcpServers?: string[] }
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

export interface Checkpoint {
  id: string
  commit: string
  /** HEAD at the time of the checkpoint (null in a repo with no commits). */
  head: string | null
  label: string
  createdAt: string
}

export interface FileChange {
  /** git status letter: Added, Modified, Deleted, Renamed, Copied, Type change */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  path: string
  oldPath: string | null
  additions: number | null
  deletions: number | null
}

/** Changes the working tree will undergo if the checkpoint is restored. */
export interface RestorePreview {
  id: string
  commit: string
  /** current → checkpoint: A = will be recreated, D = will be deleted, M = will be reverted. */
  changes: FileChange[]
  headMoved: boolean
  currentHead: string | null
  checkpointHead: string | null
}

export interface RunArtifact {
  name: string
  mediaType: string
  at: string
}

/** A screenshot of the user's preview, attached to a prompt so the agent sees what they see. */
export interface PromptAttachment {
  id: string
  /** Page shown in the preview when it was captured. */
  url: string | null
  /** Console errors the preview logged since that page loaded (most recent last). */
  consoleErrors: string[]
  at: string
}

export interface PreviewCapture extends PromptAttachment {
  dataUrl: string
}

export type TaskStatus = 'todo' | 'doing' | 'done'

export interface Task {
  id: string
  title: string
  notes: string
  status: TaskStatus
  runIds: string[]
  createdAt: string
  updatedAt: string
}

export interface McpServerDef {
  /** Lowercase id used as the server name in both CLIs' configs. */
  id: string
  label: string
  description: string
  builtin: boolean
  command: string
  args: string[]
  /** Non-secret environment. */
  env: Record<string, string>
  /** Names of secret env vars; values live in OS-protected storage, never in config files. */
  secretEnv: string[]
}

export interface McpServerView extends McpServerDef {
  /** Which secret values are stored (names only). */
  secretsSet: string[]
}

/** What a provider will actually receive for a project's enabled servers. */
export interface EffectiveMcp {
  provider: ProviderId
  servers: { id: string; label: string; included: boolean; reason: string | null }[]
}

export type DevServerStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'external'

export interface DevServerState {
  projectId: string
  status: DevServerStatus
  command: string | null
  url: string | null
  pid: number | null
  exitCode: number | null
  startedAt: string | null
  /** True when the configured command differs from the one the user last approved. */
  needsApproval: boolean
}

export interface DevLogLine {
  at: string
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface PreviewEvent {
  at: string
  kind: 'console' | 'navigation-blocked' | 'load-failed' | 'loaded' | 'navigated'
  level?: 'debug' | 'info' | 'warning' | 'error'
  text: string
  url?: string
}

export interface RunRecord {
  id: string
  projectId: string
  projectPath: string
  prompt: string
  taskId: string | null
  checkpoint: Checkpoint | null
  afterCommit: string | null
  /** Exact changes made during the run (checkpoint → end state); null if unavailable. */
  changes: FileChange[] | null
  mcpServers: string[]
  artifacts: RunArtifact[]
  /** Preview screenshots the user sent with the prompt. Absent on older runs. */
  attachments?: PromptAttachment[]
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
  /**
   * Other runs that were active in the same project while this one ran. When
   * non-empty, the checkpoint and changes may include their edits too. Absent
   * on runs recorded before parallel runs existed.
   */
  concurrentRunIds?: string[]
  events: RunEvent[]
}

export type RunSummary = Omit<RunRecord, 'events'>

export interface AppInfo {
  version: string
  isDev: boolean
  sourceRoot: string | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

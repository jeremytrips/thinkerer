// Types shared by the engine (main process) and the renderer. The renderer only
// ever imports types from here; all behaviour lives behind the preload API.

export type Component = 'website' | 'mobile' | 'hardware'
export type Target = 'web' | 'electron'
export type ProviderId = 'claude' | 'codex'
export type ProviderChoice = 'auto' | ProviderId

/** How a message runs: 'auto' edits and runs commands; 'plan' only investigates and proposes a plan (read-only). */
export type RunMode = 'auto' | 'plan'
export type Effort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** Claude Code built-in tools a project can opt into, on top of the file tools and Bash. */
export type ClaudeOptionalTool = 'Task' | 'Skill' | 'WebSearch' | 'NotebookEdit'

/** Claude Code options for a project's runs. Empty model/effort = the CLI's own default. */
export interface ClaudeRunConfig {
  model: string
  effort: Effort
  tools: ClaudeOptionalTool[]
}

export interface ProjectConfig {
  schemaVersion: 1
  name: string
  components: Component[]
  target: Target
  /** previewUrl may use {port1}…{portN}: the ports Thinkerer gives each chat's worktree. */
  website: { devCommand: string; previewUrl: string }
  agent: { provider: ProviderChoice; enabledMcpServers: string[]; claude: ClaudeRunConfig }
  /** Hooks run in every chat's worktree (e.g. docker compose up / down), and how many free ports it gets. */
  worktrees: WorktreeConfig
  marketing: { enabled: boolean }
}

export interface WorktreeConfig {
  setupCommand: string
  teardownCommand: string
  ports: number
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
  agent?: { provider?: ProviderChoice; enabledMcpServers?: string[]; claude?: Partial<ClaudeRunConfig> }
  worktrees?: Partial<WorktreeConfig>
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

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerDef {
  /** Lowercase id used as the server name in both CLIs' configs. */
  id: string
  label: string
  description: string
  builtin: boolean
  /** Absent on servers saved before remote servers existed: stdio. */
  transport?: McpTransport
  /** stdio: the program to start and its arguments (empty for remote servers). */
  command: string
  args: string[]
  /** Non-secret environment. */
  env: Record<string, string>
  /** http/sse: the server's URL. */
  url?: string
  /** http/sse: request headers. A value may reference a secret as ${NAME}, e.g. "Bearer ${API_TOKEN}". */
  headers?: Record<string, string>
  /** Names of secrets (env vars for stdio, ${NAME} in headers for remote); values live in OS-protected storage, never in config files. */
  secretEnv: string[]
}

/** An MCP server found in Claude Code's own configuration, offered for import. Never carries secret values. */
export interface McpImportCandidate {
  /** Opaque key to import it with. */
  key: string
  source: 'project' | 'user' | 'user-project'
  /** Where it was found, e.g. ".mcp.json" or "~/.claude.json". */
  sourceLabel: string
  name: string
  def: McpServerDef
  /** Secret values that will be copied into Thinkerer's encrypted store on import. */
  secretsFound: string[]
  /** Secrets referenced from your shell environment (${VAR}); set them after importing. */
  secretsMissing: string[]
  /** Set when a server with this id is already in the registry. */
  exists: boolean
  /** Set when Thinkerer can't run this server type. */
  unsupported: string | null
}

/** Result of connecting to a server and listing its tools. */
export interface McpCheckResult {
  ok: boolean
  serverInfo: string | null
  tools: { name: string; description: string }[]
  error: string | null
  ms: number
}

export interface McpServerView extends McpServerDef {
  /** Which secret values are stored (names only). */
  secretsSet: string[]
}

/** What a provider will actually receive for a project's enabled servers. */
/** What a provider CLI reported about its session when it started (Claude Code's init event). */
export interface AgentCapabilities {
  model: string | null
  version: string | null
  permissionMode: string | null
  tools: string[]
  /** MCP servers and their connection status (connected, failed, needs-auth, pending…). */
  mcpServers: { name: string; status: string }[]
  /** Slash commands usable in a message (interactive-only ones left out), skills included. */
  commands: string[]
  skills: string[]
  /** Subagents the Task tool can start. */
  agents: string[]
  plugins: string[]
}

export interface EffectiveMcp {
  provider: ProviderId
  servers: { id: string; label: string; included: boolean; reason: string | null }[]
}

export type DevServerStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'external'

export interface DevServerState {
  projectId: string
  /** The chat whose worktree this server runs in; null for the project folder. */
  chatId: string | null
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

/**
 * One turn of a chat: the user's message and the agent's work on it. A chat is
 * the runs sharing a chatId, oldest first; follow-ups resume the provider's
 * session so the agent keeps the conversation.
 */
export interface RunRecord {
  id: string
  projectId: string
  projectPath: string
  /** Where the agent worked: the chat's worktree, or the project folder. Absent on older runs (= projectPath). */
  cwd?: string
  /** Commit Thinkerer made on the chat branch with this turn's changes. */
  commit?: string | null
  /** The chat this turn belongs to (the id of its first turn). Absent on older runs: a chat of one. */
  chatId?: string
  /** The provider's own session/thread id, as reported by its CLI. Used to resume the chat. */
  sessionId?: string | null
  prompt: string
  /** 'plan' = read-only: the agent investigates and proposes a plan. Absent on older runs (= auto). */
  mode?: RunMode
  /** What the CLI reported about its session (tools, MCP status, commands…). Absent when it reports nothing. */
  capabilities?: AgentCapabilities | null
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

export type ChatState = 'setting-up' | 'active' | 'merged' | 'done'
export type ChatCommand = 'merge' | 'cleanup' | 'done' | 'discard'

/** A system message in a chat: hook output, or the result of a slash command. */
export interface ChatNote {
  at: string
  kind: 'setup' | 'teardown' | 'info' | ChatCommand
  ok: boolean
  title: string
  lines: string[]
}

export interface ChatWorktree {
  path: string
  branch: string
  /** Branch the worktree was created from, and its commit at that time. */
  base: string
  baseCommit: string
  /** Local branches that existed when the chat started (to spot new ones at cleanup). */
  branchesAtStart: string[]
}

/**
 * A conversation with an agent. Each chat works in its own Git worktree and
 * branch; Thinkerer commits every turn there. Chats from before worktrees, or in
 * a repo with no commits, work in the project folder (worktree: null).
 */
export interface ChatRecord {
  id: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
  state: ChatState
  doneReason: 'cleanup' | 'manual' | 'discarded' | null
  doneAt: string | null
  worktree: ChatWorktree | null
  /** True once /cleanup or /discard removed the worktree; the chat is then read-only. */
  worktreeRemoved: boolean
  ports: number[]
  composeProject: string | null
  notes: ChatNote[]
}

export interface AppInfo {
  version: string
  isDev: boolean
  sourceRoot: string | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

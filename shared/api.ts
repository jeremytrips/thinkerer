import type {
  AppInfo,
  ChatCommand,
  ChatRecord,
  Checkpoint,
  DevLogLine,
  DevServerState,
  EffectiveMcp,
  FileChange,
  FileContent,
  FileEntry,
  GitStatus,
  McpCheckResult,
  McpImportCandidate,
  McpServerDef,
  McpServerView,
  MobileDevice,
  MobileFrame,
  MobileToolStatus,
  PreviewCapture,
  PreviewEvent,
  Project,
  ProjectConfigPatch,
  ProviderChoice,
  ProviderStatus,
  RestorePreview,
  RunEvent,
  RunMode,
  RunRecord,
  RunSummary,
  Task,
  TaskStatus
} from './types'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

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
    init(projectId: string): Promise<boolean>
    workingChanges(projectId: string): Promise<FileChange[]>
    workingDiff(projectId: string, relPath: string): Promise<string>
    runDiff(projectId: string, runId: string, relPath: string): Promise<string>
  }
  checkpoints: {
    list(projectId: string): Promise<Checkpoint[]>
    preview(projectId: string, checkpointId: string): Promise<RestorePreview>
    restore(projectId: string, checkpointId: string): Promise<{ safetyCheckpoint: Checkpoint; changes: FileChange[] }>
  }
  tasks: {
    list(projectId: string): Promise<Task[]>
    create(projectId: string, title: string, notes?: string): Promise<Task>
    update(projectId: string, taskId: string, patch: { title?: string; notes?: string; status?: TaskStatus }): Promise<Task>
    remove(projectId: string, taskId: string): Promise<boolean>
  }
  mcp: {
    list(): Promise<McpServerView[]>
    upsert(def: McpServerDef): Promise<McpServerDef>
    remove(serverId: string): Promise<boolean>
    setSecret(serverId: string, name: string, value: string | null): Promise<boolean>
    effective(projectId: string): Promise<EffectiveMcp[]>
    /** Connects to a server as this project's agents would and lists its tools (no tool is called). */
    check(projectId: string, serverId: string): Promise<McpCheckResult>
    /** Servers configured for Claude Code itself (.mcp.json, ~/.claude.json), without secret values. */
    importCandidates(projectId: string): Promise<McpImportCandidate[]>
    /** Adds one of them to the registry (asks first); secret values go to encrypted storage. */
    import(projectId: string, key: string): Promise<McpServerDef>
  }
  /** chatId selects a chat's worktree (its own dev server, ports and preview); null is the project folder. */
  website: {
    state(projectId: string, chatId?: string | null): Promise<DevServerState>
    logs(projectId: string, chatId?: string | null): Promise<DevLogLine[]>
    start(projectId: string, chatId?: string | null): Promise<DevServerState>
    stop(projectId: string, chatId?: string | null): Promise<boolean>
    onLog(cb: (projectId: string, chatId: string | null, line: DevLogLine) => void): () => void
    onState(cb: (state: DevServerState) => void): () => void
  }
  preview: {
    show(projectId: string, chatId: string | null, bounds: Bounds): Promise<boolean>
    setBounds(bounds: Bounds): Promise<boolean>
    hide(): Promise<boolean>
    reload(): Promise<boolean>
    /** URL currently shown in this preview, or null if it isn't open. */
    url(projectId: string, chatId?: string | null): Promise<string | null>
    /** Loads a URL in the preview, subject to the same origin allowlist as clicks. */
    navigate(projectId: string, chatId: string | null, url: string): Promise<boolean>
    /** Screenshot of what the user sees, saved for attaching to the next prompt. */
    capture(projectId: string, chatId?: string | null): Promise<PreviewCapture>
    /** Deletes a capture that won't be sent. */
    discard(projectId: string, captureId: string): Promise<boolean>
    approve(projectId: string, chatId: string | null, url: string): Promise<boolean>
    onEvent(cb: (projectId: string, chatId: string | null, event: PreviewEvent) => void): () => void
  }
  /** Real Android emulators / iOS simulators. Coordinates are logical points (screen pixels ÷ frame.scale). */
  mobile: {
    status(): Promise<MobileToolStatus>
    list(): Promise<MobileDevice[]>
    /** Boots and waits until the device is usable; headless unless window is true. */
    boot(deviceId: string, window?: boolean): Promise<MobileDevice | null>
    shutdown(deviceId: string): Promise<boolean>
    frame(deviceId: string): Promise<MobileFrame>
    tap(deviceId: string, x: number, y: number, durationMs?: number): Promise<boolean>
    swipe(deviceId: string, x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<boolean>
    type(deviceId: string, text: string): Promise<boolean>
    key(deviceId: string, key: string): Promise<boolean>
    /** Opens the project's (or chat worktree's) preview URL on the device; returns the URL. */
    openPreview(deviceId: string, projectId: string, chatId: string | null): Promise<string>
    /** Screenshot of the device saved for attaching to the next prompt. */
    capture(projectId: string, deviceId: string): Promise<PreviewCapture>
  }
  agents: {
    providers(): Promise<ProviderStatus[]>
  }
  runs: {
    /** With a chatId, sends a follow-up in that chat (same provider and task; `provider` and `taskId` are ignored). */
    start(
      projectId: string,
      prompt: string,
      provider: ProviderChoice,
      taskId?: string | null,
      attachmentIds?: string[],
      chatId?: string | null,
      mode?: RunMode
    ): Promise<RunSummary>
    cancel(runId: string): Promise<boolean>
    /** Live runs for the project, oldest first. */
    active(projectId: string): Promise<RunRecord[]>
    list(projectId: string): Promise<RunSummary[]>
    get(runId: string): Promise<RunRecord | null>
    /** Every turn of a chat with its events, oldest first. */
    chat(projectId: string, chatId: string): Promise<RunRecord[]>
    artifact(runId: string, name: string): Promise<string>
    attachment(runId: string, attachmentId: string): Promise<string>
    onEvent(cb: (runId: string, event: RunEvent) => void): () => void
    onUpdate(cb: (summary: RunSummary) => void): () => void
  }
  chats: {
    /** Newest activity first; includes done chats and older run-only chats. */
    list(projectId: string): Promise<ChatRecord[]>
    get(projectId: string, chatId: string): Promise<ChatRecord>
    /** Runs /merge, /cleanup, /done or /discard; the outcome is added to the chat as a note. */
    command(projectId: string, chatId: string, name: ChatCommand): Promise<ChatRecord>
    /** Shows the chat's worktree in Finder. */
    reveal(projectId: string, chatId: string): Promise<boolean>
    onUpdate(cb: (chat: ChatRecord) => void): () => void
  }
}

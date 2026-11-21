import type {
  AppInfo,
  ChatCommand,
  ProtocolAction,
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
  ChatDevicesView,
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
  Board,
  BoardCreate,
  BoardHistoryEntry,
  BoardItem,
  BoardKind,
  BoardPatch,
  EpicRun
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
  /** The project board: milestones → epics → tasks. Items are addressed by id or key (T-12). */
  board: {
    get(projectId: string): Promise<Board>
    history(projectId: string, item: string): Promise<BoardHistoryEntry[]>
    create(projectId: string, input: BoardCreate): Promise<BoardItem>
    update(projectId: string, item: string, patch: BoardPatch): Promise<BoardItem>
    archive(projectId: string, item: string): Promise<BoardItem>
    unarchive(projectId: string, item: string): Promise<BoardItem>
    /** Only archived items can be deleted. */
    remove(projectId: string, item: string): Promise<boolean>
    reorder(projectId: string, kind: BoardKind, ids: string[]): Promise<boolean>
    /** Update an item and set the new order of its kind, saved together (a drag). */
    move(projectId: string, item: string, patch: BoardPatch, ids: string[]): Promise<BoardItem>
    /** The board of the project at this path changed (here, or by an agent through MCP). */
    onChange(cb: (projectPath: string) => void): () => void
  }
  /** An epic worked through task by task: one protocol chat per task, the next once the last is done. */
  epicRuns: {
    /** The project's current (or last) epic run, or null. */
    status(projectId: string): Promise<EpicRun | null>
    /** Starts running the epic, or resumes it if it is paused or waiting. */
    start(projectId: string, epic: string, provider: ProviderChoice): Promise<EpicRun>
    /** Stops opening new chats; chats already open are left as they are. */
    stop(projectId: string): Promise<EpicRun | null>
    onUpdate(cb: (run: EpicRun) => void): () => void
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
    /** The chat's own devices (chatId null: the project folder's) and the templates they can be copied from. */
    chatDevices(projectId: string, chatId: string | null): Promise<ChatDevicesView>
    /** Creates the chat's device for the template's platform: same hardware and OS, fresh data. */
    createChatDevice(projectId: string, chatId: string | null, templateId: string): Promise<MobileDevice>
    /** Shuts down and deletes one of the chat's devices. */
    deleteChatDevice(projectId: string, chatId: string | null, deviceId: string): Promise<boolean>
    /** Boots headless and waits until the device is usable. */
    boot(deviceId: string): Promise<MobileDevice | null>
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
      mode?: RunMode,
      /** Start a new chat that follows the software protocol (its first message is planned read-only). */
      protocol?: boolean
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
    /** Takes the next step of a protocol chat (approve the plan, review, fix, ship). */
    advance(projectId: string, chatId: string, action: ProtocolAction): Promise<ChatRecord>
    /** Shows the chat's worktree in Finder. */
    reveal(projectId: string, chatId: string): Promise<boolean>
    onUpdate(cb: (chat: ChatRecord) => void): () => void
  }
}

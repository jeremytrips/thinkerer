import type {
  AppInfo,
  Checkpoint,
  DevLogLine,
  DevServerState,
  EffectiveMcp,
  FileChange,
  FileContent,
  FileEntry,
  GitStatus,
  McpServerDef,
  McpServerView,
  PreviewCapture,
  PreviewEvent,
  Project,
  ProjectConfigPatch,
  ProviderChoice,
  ProviderStatus,
  RestorePreview,
  RunEvent,
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
  }
  website: {
    state(projectId: string): Promise<DevServerState>
    logs(projectId: string): Promise<DevLogLine[]>
    start(projectId: string): Promise<DevServerState>
    stop(projectId: string): Promise<boolean>
    onLog(cb: (projectId: string, line: DevLogLine) => void): () => void
    onState(cb: (state: DevServerState) => void): () => void
  }
  preview: {
    show(projectId: string, bounds: Bounds): Promise<boolean>
    setBounds(bounds: Bounds): Promise<boolean>
    hide(): Promise<boolean>
    reload(): Promise<boolean>
    /** URL currently shown in the project's preview, or null if it isn't open. */
    url(projectId: string): Promise<string | null>
    /** Loads a URL in the preview, subject to the same origin allowlist as clicks. */
    navigate(projectId: string, url: string): Promise<boolean>
    /** Screenshot of what the user sees, saved for attaching to the next prompt. */
    capture(projectId: string): Promise<PreviewCapture>
    /** Deletes a capture that won't be sent. */
    discard(projectId: string, captureId: string): Promise<boolean>
    approve(projectId: string, url: string): Promise<boolean>
    onEvent(cb: (projectId: string, event: PreviewEvent) => void): () => void
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
      chatId?: string | null
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
}

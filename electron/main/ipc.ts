import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AgentSupervisor } from '../../engine/agents/supervisor'
import type { Approvals } from '../../engine/approvals'
import { removeAttachment, saveAttachment } from '../../engine/attachments'
import { CHAT_COMMANDS, runChatCommand } from '../../engine/chatCommands'
import {
  fileDiff,
  initRepo,
  listCheckpoints,
  restoreCheckpoint,
  restorePreview,
  runDiff,
  workingChanges,
  workingFileDiff
} from '../../engine/checkpoints'
import { projectTarget, type DevServerManager, type DevTarget } from '../../engine/devserver'
import { listDir, readFilePreview } from '../../engine/files'
import { gitStatus } from '../../engine/git'
import { childEnv } from '../../engine/agents/detect'
import type { McpRegistry, McpRunContext } from '../../engine/mcp'
import { checkMcpServer } from '../../engine/mcpCheck'
import { findClaudeMcpServers } from '../../engine/mcpImport'
import { deviceId, mobile } from '../../engine/mobile'
import type { ProjectService } from '../../engine/projects'
import type { TaskStore } from '../../engine/tasks'
import { commitsAhead, resolvePreviewUrl, worktreeEnv } from '../../engine/worktrees'
import type {
  AppInfo,
  ChatCommand,
  McpServerDef,
  PreviewCapture,
  Project,
  ProjectConfigPatch,
  PromptAttachment,
  ProviderChoice,
  Result,
  RunMode,
  TaskStatus
} from '../../shared/types'
import type { PreviewManager, PreviewScope } from './preview'

interface Deps {
  projects: ProjectService
  supervisor: AgentSupervisor
  tasks: TaskStore
  mcp: McpRegistry
  /** Where bundled MCP scripts live and how to run Node, as agent runs get it. */
  mcpContext: () => Promise<Omit<McpRunContext, 'artifactsDir'>>
  devServers: DevServerManager
  approvals: Approvals
  preview: PreviewManager
  isDev: boolean
  getWindow: () => BrowserWindow | null
  rendererOrigin: () => string
  restart: () => void
}

const PROVIDERS: ProviderChoice[] = ['auto', 'claude', 'codex']
const MAX_ATTACHMENTS = 5

function str(v: unknown, name: string, max = 10_000): string {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${name}`)
  return v
}

function bounds(v: unknown): { x: number; y: number; width: number; height: number } {
  const b = v as Record<string, unknown>
  if (!b || !['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k] as number))) {
    throw new Error('Invalid bounds')
  }
  return { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
}

/**
 * The renderer's only route to privileged work. Every channel validates its
 * sender and arguments; there is no generic shell/filesystem channel. Actions
 * that run user-configured commands confirm through a native dialog in main,
 * which the renderer cannot fake.
 */
export function registerIpc(deps: Deps): void {
  const { projects, supervisor, tasks, mcp, devServers, approvals, preview } = deps
  const chats = supervisor.chats
  // Preview screenshots waiting to be sent with a prompt, keyed by attachment id.
  const captures = new Map<string, { projectId: string; attachment: PromptAttachment }>()

  function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T): void {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<T>> => {
      const win = deps.getWindow()
      const url = event.senderFrame?.url ?? ''
      if (!win || event.sender !== win.webContents || !url.startsWith(deps.rendererOrigin())) {
        return { ok: false, error: 'Unauthorized IPC sender' }
      }
      try {
        return { ok: true, value: await fn(...(args as A)) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  const send = (channel: string, ...args: unknown[]) => deps.getWindow()?.webContents.send(channel, ...args)

  const okProject = async (id: unknown): Promise<Project> => {
    const project = await projects.get(str(id, 'project id', 100))
    if (project.status !== 'ok') throw new Error('Project folder is missing')
    return project
  }
  const projectPath = async (id: unknown): Promise<string> => (await okProject(id)).path
  const chatIdOf = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : str(v, 'chat id', 100))

  /** Where a chat's dev server runs and what it previews; the project folder without a chat (or a worktree). */
  async function devTarget(project: Project, chatId: unknown): Promise<DevTarget> {
    const id = chatIdOf(chatId)
    if (!id) return projectTarget(project)
    const chat = await chats.require(project.id, id)
    if (!chat.worktree || chat.worktreeRemoved) return projectTarget(project)
    return {
      chatId: chat.id,
      cwd: chat.worktree.path,
      env: worktreeEnv(project, chat),
      url: resolvePreviewUrl(project.config?.website.previewUrl ?? '', chat.ports)
    }
  }
  const scopeOf = (projectId: unknown, chatId: unknown): PreviewScope => ({ projectId: str(projectId, 'project id', 100), chatId: chatIdOf(chatId) })

  /** The folder a run (or its checkpoint, which has the run's id) worked in. */
  async function runFolder(project: Project, runId: string): Promise<string> {
    const run = await supervisor.getRun(runId).catch(() => null)
    return run && run.projectId === project.id ? (run.cwd ?? run.projectPath) : project.path
  }

  /** Asks once per changed hook command; the engine refuses unapproved ones. */
  async function approveHook(project: Project, kind: 'setup' | 'teardown', where: string): Promise<void> {
    const command = project.config?.worktrees[kind === 'setup' ? 'setupCommand' : 'teardownCommand'].trim()
    if (!command || (await approvals.isApproved(project.id, kind, command))) return
    const ok = await confirm(
      kind === 'setup' ? 'Run this worktree setup command?' : 'Run this worktree teardown command?',
      `${command}\n\nin ${where}\n\nIt runs ${kind === 'setup' ? 'for every new chat' : 'whenever a chat worktree is removed'}, with your user permissions.`,
      'Run command'
    )
    if (!ok) throw new Error('Cancelled')
    await approvals.approve(project.id, kind, command)
  }

  async function confirm(message: string, detail: string, button: string): Promise<boolean> {
    const res = await dialog.showMessageBox(deps.getWindow()!, {
      type: 'question',
      buttons: ['Cancel', button],
      defaultId: 0,
      cancelId: 0,
      message,
      detail
    })
    return res.response === 1
  }

  // App
  handle('app:info', async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    isDev: deps.isDev,
    sourceRoot: app.isPackaged ? null : await realpath(app.getAppPath()).catch(() => null)
  }))
  handle('app:restart', () => {
    if (supervisor.hasActiveRuns()) throw new Error('Stop the active agent runs before restarting')
    setTimeout(deps.restart, 50) // let the reply reach the renderer first
    return true
  })

  // Projects
  handle('projects:list', () => projects.list())
  handle('projects:get', (id: unknown) => projects.get(str(id, 'project id', 100)))
  handle('projects:import', async () => {
    const res = await dialog.showOpenDialog(deps.getWindow()!, { title: 'Import project folder', properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    return projects.importFolder(res.filePaths[0])
  })
  handle('projects:create', async (name: unknown) => {
    const projectName = str(name, 'project name', 100)
    const res = await dialog.showOpenDialog(deps.getWindow()!, {
      title: `Choose where to create "${projectName}"`,
      buttonLabel: 'Create here',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    return projects.create(res.filePaths[0], projectName)
  })
  handle('projects:update', (id: unknown, patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings')
    return projects.updateConfig(str(id, 'project id', 100), patch as ProjectConfigPatch)
  })
  handle('projects:remove', async (id: unknown) => {
    const projectId = str(id, 'project id', 100)
    if (supervisor.activeRuns(projectId).length) throw new Error('Stop the active agent runs first')
    devServers.stopProject(projectId)
    await projects.remove(projectId)
    return true
  })
  handle('projects:reveal', async (id: unknown) => {
    shell.showItemInFolder(await projectPath(id))
    return true
  })

  // Files (read-only) and Git
  handle('files:list', async (id: unknown, rel: unknown) => listDir(await projectPath(id), str(rel, 'path', 4096)))
  handle('files:read', async (id: unknown, rel: unknown) => readFilePreview(await projectPath(id), str(rel, 'path', 4096)))
  handle('git:status', async (id: unknown) => gitStatus(await projectPath(id)))
  handle('git:init', async (id: unknown) => {
    const path = await projectPath(id)
    if (await gitStatus(path)) return true
    await initRepo(path)
    return true
  })
  handle('git:workingChanges', async (id: unknown) => workingChanges(await projectPath(id)))
  handle('git:workingDiff', async (id: unknown, rel: unknown) => workingFileDiff(await projectPath(id), str(rel, 'path', 4096)))
  handle('git:runDiff', async (id: unknown, runId: unknown, rel: unknown) => {
    const path = await runFolder(await okProject(id), str(runId, 'run id', 100))
    const { from, to } = await runDiff(path, str(runId, 'run id', 100))
    return fileDiff(path, from, to, str(rel, 'path', 4096))
  })

  // Checkpoints
  handle('checkpoints:list', async (id: unknown) => listCheckpoints(await projectPath(id)))
  handle('checkpoints:preview', async (id: unknown, cp: unknown) => {
    const checkpoint = str(cp, 'checkpoint id', 100)
    return restorePreview(await runFolder(await okProject(id), checkpoint), checkpoint)
  })
  handle('checkpoints:restore', async (id: unknown, cp: unknown) => {
    const project = await okProject(id)
    const checkpoint = str(cp, 'checkpoint id', 100)
    const folder = await runFolder(project, checkpoint)
    if (supervisor.activeRuns(project.id).some((r) => (r.cwd ?? r.projectPath) === folder)) {
      throw new Error('Stop the agent runs working in this folder before restoring')
    }
    return restoreCheckpoint(folder, checkpoint)
  })

  // Tasks
  handle('tasks:list', async (id: unknown) => tasks.list(await projectPath(id)))
  handle('tasks:create', async (id: unknown, title: unknown, notes: unknown) =>
    tasks.create(await projectPath(id), str(title, 'title', 300), notes === undefined ? '' : str(notes, 'notes', 10_000))
  )
  handle('tasks:update', async (id: unknown, taskId: unknown, patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid task update')
    return tasks.update(await projectPath(id), str(taskId, 'task id', 100), patch as { title?: string; notes?: string; status?: TaskStatus })
  })
  handle('tasks:remove', async (id: unknown, taskId: unknown) => {
    await tasks.remove(await projectPath(id), str(taskId, 'task id', 100))
    return true
  })

  // MCP registry
  handle('mcp:list', () => mcp.list())
  /** What a server will do, in words for a native confirmation. */
  const describeServer = (d: McpServerDef) =>
    d?.transport === 'http' || d?.transport === 'sse'
      ? `Agents in projects that enable it will connect to:\n\n${typeof d.url === 'string' ? d.url : ''}${Object.keys(d.headers ?? {}).length ? `\n\nHeaders: ${Object.keys(d.headers ?? {}).join(', ')}` : ''}`
      : `Agents in projects that enable it will start:\n\n${typeof d?.command === 'string' ? d.command : ''} ${Array.isArray(d?.args) ? d.args.join(' ') : ''}`
  handle('mcp:upsert', async (def: unknown) => {
    const d = def as McpServerDef
    const ok = await confirm(`Save MCP server "${typeof d?.label === 'string' ? d.label : '?'}"?`, describeServer(d), 'Save server')
    if (!ok) throw new Error('Cancelled')
    return mcp.upsert(d)
  })
  handle('mcp:check', async (id: unknown, serverId: unknown) => {
    const project = await okProject(id)
    const def = await mcp.get(str(serverId, 'server id', 40))
    if (!def) throw new Error('Unknown server')
    // Throwaway folder for anything the server writes (e.g. Playwright output); removed afterwards.
    const scratch = await mkdtemp(join(tmpdir(), 'thinkerer-mcp-check-'))
    try {
      const resolved = await mcp.resolveOne(def, project, { ...(await deps.mcpContext()), artifactsDir: scratch })
      if (!resolved) throw new Error(def.id === 'playwright' ? 'Set a preview URL first' : 'Set its secrets first')
      return await checkMcpServer(resolved.server, resolved.secretEnv, { cwd: project.path, env: childEnv() })
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  })
  const claudeServers = async (project: Project) => findClaudeMcpServers(project.path, homedir(), (await mcp.list()).map((s) => s.id))
  handle('mcp:importCandidates', async (id: unknown) => (await claudeServers(await okProject(id))).map((f) => f.candidate))
  handle('mcp:import', async (id: unknown, key: unknown) => {
    const project = await okProject(id)
    const found = (await claudeServers(project)).find((f) => f.candidate.key === str(key, 'server key', 300))
    if (!found) throw new Error('That server is no longer in the Claude Code configuration')
    const { candidate, secrets } = found
    if (candidate.unsupported) throw new Error(candidate.unsupported)
    const ok = await confirm(
      `Import MCP server "${candidate.name}" from ${candidate.sourceLabel}?`,
      `${describeServer(candidate.def)}${candidate.secretsFound.length ? `\n\nSecrets copied to encrypted storage: ${candidate.secretsFound.join(', ')}` : ''}${candidate.exists ? `\n\nThis replaces the server "${candidate.def.id}" already in the registry.` : ''}`,
      'Import server'
    )
    if (!ok) throw new Error('Cancelled')
    const saved = await mcp.upsert(candidate.def)
    for (const [name, value] of Object.entries(secrets)) await mcp.setSecret(saved.id, name, value)
    return saved
  })
  handle('mcp:remove', async (serverId: unknown) => {
    await mcp.remove(str(serverId, 'server id', 40))
    return true
  })
  handle('mcp:setSecret', async (serverId: unknown, name: unknown, value: unknown) => {
    await mcp.setSecret(str(serverId, 'server id', 40), str(name, 'secret name', 64), value === null ? null : str(value, 'secret', 8192))
    return true
  })
  handle('mcp:effective', async (id: unknown) => {
    const project = await okProject(id)
    return Promise.all((['claude', 'codex'] as const).map((p) => mcp.effective(project, p)))
  })

  // Website Studio
  handle('website:state', async (id: unknown, chatId: unknown) => {
    const project = await okProject(id)
    return devServers.state(project, await devTarget(project, chatId))
  })
  handle('website:logs', (id: unknown, chatId: unknown) => devServers.logs(str(id, 'project id', 100), chatIdOf(chatId)))
  handle('website:start', async (id: unknown, chatId: unknown) => {
    const project = await okProject(id)
    const target = await devTarget(project, chatId)
    const command = project.config?.website.devCommand?.trim()
    if (command && !(await devServers.isApproved(project.id, command))) {
      const ok = await confirm('Run this development command?', `${command}\n\nin ${target.cwd}\n\nIt runs with your user permissions.`, 'Run command')
      if (!ok) throw new Error('Cancelled')
      await devServers.approve(project.id, command)
    }
    return devServers.start(project, target)
  })
  handle('website:stop', (id: unknown, chatId: unknown) => {
    devServers.stop(str(id, 'project id', 100), chatIdOf(chatId))
    return true
  })
  handle('preview:show', async (id: unknown, chatId: unknown, b: unknown) => {
    const project = await okProject(id)
    const target = await devTarget(project, chatId)
    if (!target.url) throw new Error(project.config?.website.previewUrl ? 'This preview URL uses worktree ports; open it from a chat' : 'Set a preview URL in Settings first')
    preview.show({ projectId: project.id, chatId: target.chatId }, target.url, bounds(b))
    return true
  })
  handle('preview:bounds', (b: unknown) => {
    preview.setBounds(bounds(b))
    return true
  })
  handle('preview:hide', () => {
    preview.hide()
    return true
  })
  handle('preview:reload', () => {
    preview.reload()
    return true
  })
  handle('preview:url', (id: unknown, chatId: unknown) => preview.currentUrl(scopeOf(id, chatId)))
  handle('preview:navigate', (id: unknown, chatId: unknown, url: unknown) => {
    preview.navigate(scopeOf(id, chatId), str(url, 'url', 4096))
    return true
  })
  handle('preview:capture', async (id: unknown, chatId: unknown): Promise<PreviewCapture> => {
    const project = await okProject(id)
    const shot = await preview.capture(scopeOf(project.id, chatId))
    const attachment: PromptAttachment = {
      id: await saveAttachment(project.path, shot.png),
      url: shot.url || null,
      consoleErrors: shot.consoleErrors,
      at: new Date().toISOString()
    }
    captures.set(attachment.id, { projectId: project.id, attachment })
    return { ...attachment, dataUrl: `data:image/png;base64,${shot.png.toString('base64')}` }
  })
  handle('preview:discard', async (id: unknown, captureId: unknown) => {
    const project = await okProject(id)
    const key = str(captureId, 'capture id', 100)
    if (captures.get(key)?.projectId !== project.id) return false
    captures.delete(key)
    await removeAttachment(project.path, key)
    return true
  })
  handle('preview:approve', async (id: unknown, chatId: unknown, url: unknown) => {
    const scope = scopeOf(id, chatId)
    const target = str(url, 'url', 4096)
    const origin = new URL(target).origin
    const ok = await confirm('Allow the preview to open another site?', `${origin}\n\nThis origin will be allowed in this project's preview until Thinkerer restarts.`, 'Allow')
    if (!ok) return false
    preview.approveAndNavigate(scope, target)
    return true
  })

  // Mobile emulators and simulators (the same devices the agent's `mobile` MCP server drives)
  const coord = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw new Error(`Invalid ${name}`)
    return v
  }
  handle('mobile:status', () => mobile.status())
  handle('mobile:list', () => mobile.list())
  handle('mobile:boot', (id: unknown, window: unknown) => mobile.boot(deviceId(id), window === true))
  handle('mobile:shutdown', (id: unknown) => mobile.shutdown(deviceId(id)))
  handle('mobile:frame', (id: unknown) => mobile.frame(deviceId(id)))
  handle('mobile:tap', (id: unknown, x: unknown, y: unknown, ms: unknown) =>
    mobile.tap(deviceId(id), coord(x, 'x'), coord(y, 'y'), ms === undefined || ms === null ? 0 : Math.min(coord(ms, 'duration'), 10_000))
  )
  handle('mobile:swipe', (id: unknown, x1: unknown, y1: unknown, x2: unknown, y2: unknown, ms: unknown) =>
    mobile.swipe(deviceId(id), coord(x1, 'x1'), coord(y1, 'y1'), coord(x2, 'x2'), coord(y2, 'y2'), ms === undefined || ms === null ? 300 : Math.min(Math.max(coord(ms, 'duration'), 50), 10_000))
  )
  handle('mobile:type', (id: unknown, text: unknown) => mobile.type(deviceId(id), str(text, 'text', 5000)))
  handle('mobile:key', (id: unknown, key: unknown) => {
    const k = str(key, 'key', 30)
    if (!mobile.keys.includes(k)) throw new Error('Unknown key')
    return mobile.key(deviceId(id), k)
  })
  handle('mobile:openPreview', async (id: unknown, projectId: unknown, chatId: unknown) => {
    const project = await okProject(projectId)
    const url = (await devTarget(project, chatId)).url
    if (!url) throw new Error('This project has no preview URL')
    await mobile.openUrl(deviceId(id), url)
    return url
  })
  handle('mobile:capture', async (projectId: unknown, id: unknown): Promise<PreviewCapture> => {
    const project = await okProject(projectId)
    const dev = deviceId(id)
    const info = (await mobile.list()).find((d) => d.id === dev)
    const png = await mobile.png(dev)
    const attachment: PromptAttachment = {
      id: await saveAttachment(project.path, png),
      url: null,
      consoleErrors: [],
      at: new Date().toISOString(),
      device: `${info ? `${info.name}${info.detail ? `, ${info.detail}` : ''}` : dev} [${dev}]`
    }
    captures.set(attachment.id, { projectId: project.id, attachment })
    return { ...attachment, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })

  // Agent runs
  handle('agents:providers', () => supervisor.providers())
  handle('runs:start', async (id: unknown, prompt: unknown, provider: unknown, taskId: unknown, attachmentIds: unknown, chatId: unknown, mode: unknown) => {
    if (!PROVIDERS.includes(provider as ProviderChoice)) throw new Error('Invalid provider')
    if (mode !== undefined && mode !== null && mode !== 'auto' && mode !== 'plan') throw new Error('Invalid mode')
    const projectId = str(id, 'project id', 100)
    const ids = attachmentIds === undefined || attachmentIds === null ? [] : attachmentIds
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw new Error('Invalid attachments')
    // Only captures this window made for this project, so the renderer can't point a run at arbitrary files.
    const attachments = ids.map((a) => {
      const c = captures.get(str(a, 'attachment id', 100))
      if (!c || c.projectId !== projectId) throw new Error('Screenshot is no longer available; capture it again')
      return c.attachment
    })
    // A new chat (or one whose setup failed) runs the worktree setup hook first.
    const followUp = chatId ? await chats.get(str(chatId, 'chat id', 100)) : null
    if (!chatId || followUp?.state === 'setting-up') {
      const project = await okProject(projectId)
      await approveHook(project, 'setup', followUp?.worktree?.path ?? 'each new chat worktree')
    }
    const summary = await supervisor.start(projectId, str(prompt, 'prompt', 100_000), provider as ProviderChoice, {
      taskId: taskId ? str(taskId, 'task id', 100) : null,
      attachments,
      chatId: chatId ? str(chatId, 'chat id', 100) : null,
      mode: (mode as RunMode | null) ?? 'auto'
    })
    for (const a of attachments) captures.delete(a.id)
    return summary
  })
  handle('runs:cancel', (runId: unknown) => supervisor.cancel(str(runId, 'run id', 100)))
  handle('runs:active', (id: unknown) => supervisor.activeRuns(str(id, 'project id', 100)))
  handle('runs:list', (id: unknown) => supervisor.listRuns(str(id, 'project id', 100)))
  handle('runs:get', (runId: unknown) => supervisor.getRun(str(runId, 'run id', 100)))
  handle('runs:chat', (id: unknown, chatId: unknown) => supervisor.getChat(str(id, 'project id', 100), str(chatId, 'chat id', 100)))
  handle('runs:artifact', (runId: unknown, name: unknown) => supervisor.artifactDataUrl(str(runId, 'run id', 100), str(name, 'artifact', 200)))
  handle('runs:attachment', (runId: unknown, attachmentId: unknown) =>
    supervisor.attachmentDataUrl(str(runId, 'run id', 100), str(attachmentId, 'attachment id', 100))
  )

  // Chats
  handle('chats:list', async (id: unknown) => {
    const projectId = (await okProject(id)).id
    return chats.list(projectId, await supervisor.listRuns(projectId), (chatId) => supervisor.isChatLive(chatId))
  })
  handle('chats:get', async (id: unknown, chatId: unknown) => chats.require((await okProject(id)).id, str(chatId, 'chat id', 100)))
  handle('chats:command', async (id: unknown, chatId: unknown, name: unknown) => {
    if (!CHAT_COMMANDS.includes(name as ChatCommand)) throw new Error('Unknown command')
    const command = name as ChatCommand
    const project = await okProject(id)
    const chat = await chats.require(project.id, str(chatId, 'chat id', 100))
    const wt = chat.worktree && !chat.worktreeRemoved ? chat.worktree : null
    if (command === 'discard' && wt) {
      const ahead = await commitsAhead(project.path, wt.base, wt.branch)
      const ok = await confirm(
        'Discard this chat’s worktree?',
        `${wt.path}\n\nDeletes the worktree and the branch ${wt.branch}${ahead ? `, including ${ahead} commit${ahead === 1 ? '' : 's'} not in ${wt.base}` : ''}, and any uncommitted changes in it. This cannot be undone.`,
        'Discard'
      )
      if (!ok) throw new Error('Cancelled')
    }
    if ((command === 'cleanup' || command === 'discard') && wt) await approveHook(project, 'teardown', wt.path)
    return runChatCommand(command, {
      project,
      chat,
      chats,
      approvals,
      live: supervisor.isChatLive(chat.id),
      stopDevServer: () => devServers.stop(project.id, chat.id)
    })
  })
  handle('chats:reveal', async (id: unknown, chatId: unknown) => {
    const chat = await chats.require((await okProject(id)).id, str(chatId, 'chat id', 100))
    if (!chat.worktree || chat.worktreeRemoved) throw new Error('This chat has no worktree')
    shell.showItemInFolder(chat.worktree.path)
    return true
  })

  supervisor.on('event', (runId, event) => send('runs:event', runId, event))
  supervisor.on('update', (summary) => send('runs:update', summary))
  chats.on('update', (chat) => send('chats:update', chat))
  devServers.on('log', (projectId, chatId, line) => send('website:log', projectId, chatId, line))
  devServers.on('state', (state) => send('website:state', state))
}

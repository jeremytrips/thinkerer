import { realpath } from 'node:fs/promises'
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AgentSupervisor } from '../../engine/agents/supervisor'
import { removeAttachment, saveAttachment } from '../../engine/attachments'
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
import type { DevServerManager } from '../../engine/devserver'
import { listDir, readFilePreview } from '../../engine/files'
import { gitStatus } from '../../engine/git'
import type { McpRegistry } from '../../engine/mcp'
import type { ProjectService } from '../../engine/projects'
import type { TaskStore } from '../../engine/tasks'
import type {
  AppInfo,
  McpServerDef,
  PreviewCapture,
  Project,
  ProjectConfigPatch,
  PromptAttachment,
  ProviderChoice,
  Result,
  TaskStatus
} from '../../shared/types'
import type { PreviewManager } from './preview'

interface Deps {
  projects: ProjectService
  supervisor: AgentSupervisor
  tasks: TaskStore
  mcp: McpRegistry
  devServers: DevServerManager
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
  const { projects, supervisor, tasks, mcp, devServers, preview } = deps
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
    devServers.stop(projectId)
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
    const path = await projectPath(id)
    const { from, to } = await runDiff(path, str(runId, 'run id', 100))
    return fileDiff(path, from, to, str(rel, 'path', 4096))
  })

  // Checkpoints
  handle('checkpoints:list', async (id: unknown) => listCheckpoints(await projectPath(id)))
  handle('checkpoints:preview', async (id: unknown, cp: unknown) => restorePreview(await projectPath(id), str(cp, 'checkpoint id', 100)))
  handle('checkpoints:restore', async (id: unknown, cp: unknown) => {
    const projectId = str(id, 'project id', 100)
    if (supervisor.activeRuns(projectId).length) throw new Error('Stop all active agent runs before restoring')
    return restoreCheckpoint(await projectPath(projectId), str(cp, 'checkpoint id', 100))
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
  handle('mcp:upsert', async (def: unknown) => {
    const d = def as McpServerDef
    const ok = await confirm(
      `Save MCP server "${typeof d?.label === 'string' ? d.label : '?'}"?`,
      `Agents in projects that enable it will start:\n\n${typeof d?.command === 'string' ? d.command : ''} ${Array.isArray(d?.args) ? d.args.join(' ') : ''}`,
      'Save server'
    )
    if (!ok) throw new Error('Cancelled')
    return mcp.upsert(d)
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
  handle('website:state', async (id: unknown) => devServers.state(await okProject(id)))
  handle('website:logs', (id: unknown) => devServers.logs(str(id, 'project id', 100)))
  handle('website:start', async (id: unknown) => {
    const project = await okProject(id)
    const command = project.config?.website.devCommand?.trim()
    if (command && !(await devServers.isApproved(project.id, command))) {
      const ok = await confirm('Run this development command?', `${command}\n\nin ${project.path}\n\nIt runs with your user permissions.`, 'Run command')
      if (!ok) throw new Error('Cancelled')
      await devServers.approve(project.id, command)
    }
    return devServers.start(project)
  })
  handle('website:stop', (id: unknown) => {
    devServers.stop(str(id, 'project id', 100))
    return true
  })
  handle('preview:show', async (id: unknown, b: unknown) => {
    const project = await okProject(id)
    const url = project.config?.website.previewUrl
    if (!url) throw new Error('Set a preview URL in Settings first')
    preview.show(project.id, url, bounds(b))
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
  handle('preview:url', (id: unknown) => preview.currentUrl(str(id, 'project id', 100)))
  handle('preview:navigate', (id: unknown, url: unknown) => {
    preview.navigate(str(id, 'project id', 100), str(url, 'url', 4096))
    return true
  })
  handle('preview:capture', async (id: unknown): Promise<PreviewCapture> => {
    const project = await okProject(id)
    const shot = await preview.capture(project.id)
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
  handle('preview:approve', async (id: unknown, url: unknown) => {
    const projectId = str(id, 'project id', 100)
    const target = str(url, 'url', 4096)
    const origin = new URL(target).origin
    const ok = await confirm('Allow the preview to open another site?', `${origin}\n\nThis origin will be allowed in this project's preview until Thinkerer restarts.`, 'Allow')
    if (!ok) return false
    preview.approveAndNavigate(projectId, target)
    return true
  })

  // Agent runs
  handle('agents:providers', () => supervisor.providers())
  handle('runs:start', async (id: unknown, prompt: unknown, provider: unknown, taskId: unknown, attachmentIds: unknown, chatId: unknown) => {
    if (!PROVIDERS.includes(provider as ProviderChoice)) throw new Error('Invalid provider')
    const projectId = str(id, 'project id', 100)
    const ids = attachmentIds === undefined || attachmentIds === null ? [] : attachmentIds
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw new Error('Invalid attachments')
    // Only captures this window made for this project, so the renderer can't point a run at arbitrary files.
    const attachments = ids.map((a) => {
      const c = captures.get(str(a, 'attachment id', 100))
      if (!c || c.projectId !== projectId) throw new Error('Screenshot is no longer available; capture it again')
      return c.attachment
    })
    const summary = await supervisor.start(projectId, str(prompt, 'prompt', 100_000), provider as ProviderChoice, {
      taskId: taskId ? str(taskId, 'task id', 100) : null,
      attachments,
      chatId: chatId ? str(chatId, 'chat id', 100) : null
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

  supervisor.on('event', (runId, event) => send('runs:event', runId, event))
  supervisor.on('update', (summary) => send('runs:update', summary))
  devServers.on('log', (projectId, line) => send('website:log', projectId, line))
  devServers.on('state', (state) => send('website:state', state))
}

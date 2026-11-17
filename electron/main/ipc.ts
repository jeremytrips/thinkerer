import { realpath } from 'node:fs/promises'
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AgentSupervisor } from '../../engine/agents/supervisor'
import { listDir, readFilePreview } from '../../engine/files'
import { gitStatus } from '../../engine/git'
import type { ProjectService } from '../../engine/projects'
import type { AppInfo, ProjectConfigPatch, ProviderChoice, Result } from '../../shared/types'

interface Deps {
  projects: ProjectService
  supervisor: AgentSupervisor
  isDev: boolean
  getWindow: () => BrowserWindow | null
  rendererOrigin: () => string
  restart: () => void
}

const PROVIDERS: ProviderChoice[] = ['auto', 'claude', 'codex']

function str(v: unknown, name: string, max = 10_000): string {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${name}`)
  return v
}

/**
 * The renderer's only route to privileged work. Every channel validates its
 * sender and arguments; there is no generic shell/filesystem channel.
 */
export function registerIpc(deps: Deps): void {
  const { projects, supervisor } = deps

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

  const projectPath = async (id: unknown): Promise<string> => {
    const project = await projects.get(str(id, 'project id', 100))
    if (project.status !== 'ok') throw new Error('Project folder is missing')
    return project.path
  }

  handle('app:info', async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    isDev: deps.isDev,
    sourceRoot: app.isPackaged ? null : await realpath(app.getAppPath()).catch(() => null)
  }))
  handle('app:restart', () => {
    if (supervisor.hasActiveRuns()) throw new Error('Stop the active agent run before restarting')
    setTimeout(deps.restart, 50) // let the reply reach the renderer first
    return true
  })

  handle('projects:list', () => projects.list())
  handle('projects:get', (id: unknown) => projects.get(str(id, 'project id', 100)))
  handle('projects:import', async () => {
    const res = await dialog.showOpenDialog(deps.getWindow()!, {
      title: 'Import project folder',
      properties: ['openDirectory']
    })
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
    if (supervisor.activeRun(projectId)) throw new Error('Stop the active agent run first')
    await projects.remove(projectId)
    return true
  })
  handle('projects:reveal', async (id: unknown) => {
    shell.showItemInFolder(await projectPath(id))
    return true
  })

  handle('files:list', async (id: unknown, rel: unknown) => listDir(await projectPath(id), str(rel, 'path', 4096)))
  handle('files:read', async (id: unknown, rel: unknown) => readFilePreview(await projectPath(id), str(rel, 'path', 4096)))
  handle('git:status', async (id: unknown) => gitStatus(await projectPath(id)))

  handle('agents:providers', () => supervisor.providers())
  handle('runs:start', (id: unknown, prompt: unknown, provider: unknown) => {
    if (!PROVIDERS.includes(provider as ProviderChoice)) throw new Error('Invalid provider')
    return supervisor.start(str(id, 'project id', 100), str(prompt, 'prompt', 100_000), provider as ProviderChoice)
  })
  handle('runs:cancel', (id: unknown) => supervisor.cancel(str(id, 'project id', 100)))
  handle('runs:active', (id: unknown) => supervisor.activeRun(str(id, 'project id', 100)))
  handle('runs:list', (id: unknown) => supervisor.listRuns(str(id, 'project id', 100)))
  handle('runs:get', (runId: unknown) => supervisor.getRun(str(runId, 'run id', 100)))

  supervisor.on('event', (runId, event) => deps.getWindow()?.webContents.send('runs:event', runId, event))
  supervisor.on('update', (summary) => deps.getWindow()?.webContents.send('runs:update', summary))
}

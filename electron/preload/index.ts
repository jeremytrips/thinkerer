import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ThinkererApi } from '../../shared/api'
import type { Result, RunEvent, RunSummary } from '../../shared/types'

// Sandboxed preload: exposes a narrow, typed API and nothing else. No Node
// APIs and no raw ipcRenderer reach the renderer.

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!res.ok) throw new Error(res.error)
  return res.value
}

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ThinkererApi = {
  app: {
    info: () => call('app:info'),
    restart: () => call('app:restart')
  },
  projects: {
    list: () => call('projects:list'),
    get: (id) => call('projects:get', id),
    importFolder: () => call('projects:import'),
    create: (name) => call('projects:create', name),
    update: (id, patch) => call('projects:update', id, patch),
    remove: (id) => call('projects:remove', id),
    reveal: (id) => call('projects:reveal', id)
  },
  files: {
    list: (projectId, relPath) => call('files:list', projectId, relPath),
    read: (projectId, relPath) => call('files:read', projectId, relPath)
  },
  git: {
    status: (projectId) => call('git:status', projectId)
  },
  agents: {
    providers: () => call('agents:providers')
  },
  runs: {
    start: (projectId, prompt, provider) => call('runs:start', projectId, prompt, provider),
    cancel: (projectId) => call('runs:cancel', projectId),
    active: (projectId) => call('runs:active', projectId),
    list: (projectId) => call('runs:list', projectId),
    get: (runId) => call('runs:get', runId),
    onEvent: (cb) => subscribe<[string, RunEvent]>('runs:event', cb),
    onUpdate: (cb) => subscribe<[RunSummary]>('runs:update', cb)
  }
}

contextBridge.exposeInMainWorld('thinkerer', api)

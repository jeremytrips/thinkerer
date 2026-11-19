import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ThinkererApi } from '../../shared/api'
import type { ChatRecord, DevLogLine, DevServerState, PreviewEvent, Result, RunEvent, RunSummary } from '../../shared/types'

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
    status: (projectId) => call('git:status', projectId),
    init: (projectId) => call('git:init', projectId),
    workingChanges: (projectId) => call('git:workingChanges', projectId),
    workingDiff: (projectId, relPath) => call('git:workingDiff', projectId, relPath),
    runDiff: (projectId, runId, relPath) => call('git:runDiff', projectId, runId, relPath)
  },
  checkpoints: {
    list: (projectId) => call('checkpoints:list', projectId),
    preview: (projectId, id) => call('checkpoints:preview', projectId, id),
    restore: (projectId, id) => call('checkpoints:restore', projectId, id)
  },
  tasks: {
    list: (projectId) => call('tasks:list', projectId),
    create: (projectId, title, notes) => call('tasks:create', projectId, title, notes),
    update: (projectId, taskId, patch) => call('tasks:update', projectId, taskId, patch),
    remove: (projectId, taskId) => call('tasks:remove', projectId, taskId)
  },
  mcp: {
    list: () => call('mcp:list'),
    upsert: (def) => call('mcp:upsert', def),
    remove: (id) => call('mcp:remove', id),
    setSecret: (id, name, value) => call('mcp:setSecret', id, name, value),
    effective: (projectId) => call('mcp:effective', projectId)
  },
  website: {
    state: (projectId, chatId) => call('website:state', projectId, chatId ?? null),
    logs: (projectId, chatId) => call('website:logs', projectId, chatId ?? null),
    start: (projectId, chatId) => call('website:start', projectId, chatId ?? null),
    stop: (projectId, chatId) => call('website:stop', projectId, chatId ?? null),
    onLog: (cb) => subscribe<[string, string | null, DevLogLine]>('website:log', cb),
    onState: (cb) => subscribe<[DevServerState]>('website:state', cb)
  },
  preview: {
    show: (projectId, chatId, bounds) => call('preview:show', projectId, chatId, bounds),
    setBounds: (bounds) => call('preview:bounds', bounds),
    hide: () => call('preview:hide'),
    reload: () => call('preview:reload'),
    url: (projectId, chatId) => call('preview:url', projectId, chatId ?? null),
    navigate: (projectId, chatId, url) => call('preview:navigate', projectId, chatId, url),
    capture: (projectId, chatId) => call('preview:capture', projectId, chatId ?? null),
    discard: (projectId, captureId) => call('preview:discard', projectId, captureId),
    approve: (projectId, chatId, url) => call('preview:approve', projectId, chatId, url),
    onEvent: (cb) => subscribe<[string, string | null, PreviewEvent]>('preview:event', cb)
  },
  agents: {
    providers: () => call('agents:providers')
  },
  runs: {
    start: (projectId, prompt, provider, taskId, attachmentIds, chatId) =>
      call('runs:start', projectId, prompt, provider, taskId ?? null, attachmentIds ?? [], chatId ?? null),
    cancel: (runId) => call('runs:cancel', runId),
    active: (projectId) => call('runs:active', projectId),
    list: (projectId) => call('runs:list', projectId),
    get: (runId) => call('runs:get', runId),
    chat: (projectId, chatId) => call('runs:chat', projectId, chatId),
    artifact: (runId, name) => call('runs:artifact', runId, name),
    attachment: (runId, attachmentId) => call('runs:attachment', runId, attachmentId),
    onEvent: (cb) => subscribe<[string, RunEvent]>('runs:event', cb),
    onUpdate: (cb) => subscribe<[RunSummary]>('runs:update', cb)
  },
  chats: {
    list: (projectId) => call('chats:list', projectId),
    get: (projectId, chatId) => call('chats:get', projectId, chatId),
    command: (projectId, chatId, name) => call('chats:command', projectId, chatId, name),
    reveal: (projectId, chatId) => call('chats:reveal', projectId, chatId),
    onUpdate: (cb) => subscribe<[ChatRecord]>('chats:update', cb)
  }
}

contextBridge.exposeInMainWorld('thinkerer', api)

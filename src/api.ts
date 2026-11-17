import type { ThinkererApi } from '../shared/api'

declare global {
  interface Window {
    thinkerer?: ThinkererApi
  }
}

/**
 * True when the UI runs in a plain browser (Website Studio preview, or the
 * agent's Playwright browser) instead of the Electron window: there is no
 * privileged bridge, so desktop features are unavailable but the UI renders.
 */
export const browserPreview = !window.thinkerer

const unavailable = () => Promise.reject(new Error('Not available in the browser preview'))
const noop = () => () => {}

// Read-only calls resolve empty so screens render; actions reject.
const previewApi: ThinkererApi = {
  app: { info: async () => ({ version: 'preview', isDev: false, sourceRoot: null }), restart: unavailable },
  projects: { list: async () => [], get: unavailable, importFolder: unavailable, create: unavailable, update: unavailable, remove: unavailable, reveal: unavailable },
  files: { list: async () => [], read: unavailable },
  git: { status: async () => null, init: unavailable, workingChanges: async () => [], workingDiff: unavailable, runDiff: unavailable },
  checkpoints: { list: async () => [], preview: unavailable, restore: unavailable },
  tasks: { list: async () => [], create: unavailable, update: unavailable, remove: unavailable },
  mcp: { list: async () => [], upsert: unavailable, remove: unavailable, setSecret: unavailable, effective: async () => [] },
  website: { state: unavailable, logs: async () => [], start: unavailable, stop: unavailable, onLog: noop, onState: noop },
  preview: { show: unavailable, setBounds: unavailable, hide: async () => true, reload: unavailable, approve: unavailable, onEvent: noop },
  agents: { providers: async () => [] },
  runs: { start: unavailable, cancel: unavailable, active: async () => null, list: async () => [], get: async () => null, artifact: unavailable, onEvent: noop, onUpdate: noop }
}

export const api: ThinkererApi = window.thinkerer ?? previewApi

/** localStorage can be unavailable; UI state must survive without it. */
export function loadState<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveState(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
}

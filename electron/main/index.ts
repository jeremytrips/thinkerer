import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { findExecutable } from '../../engine/agents/detect'
import { scriptAdapter } from '../../engine/agents/script'
import { AgentSupervisor } from '../../engine/agents/supervisor'
import { ProtocolService } from '../../engine/protocol'
import { Approvals } from '../../engine/approvals'
import { ChatDevices } from '../../engine/chatDevices'
import { DevServerManager } from '../../engine/devserver'
import { McpRegistry } from '../../engine/mcp'
import { deviceTools } from '../../engine/mobile'
import { ProjectService } from '../../engine/projects'
import { TaskStore } from '../../engine/tasks'
import { registerIpc } from './ipc'
import { PreviewManager } from './preview'
import { SafeSecretStore } from './secrets'

/** Exit code that scripts/dev.mjs treats as "rebuild main/preload and relaunch". */
export const DEV_RESTART_EXIT_CODE = 75

app.setName('Thinkerer')
if (process.env.THINKERER_APP_DATA) app.setPath('userData', process.env.THINKERER_APP_DATA)

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const appData = app.getPath('userData')
const projects = new ProjectService(appData)
const tasks = new TaskStore()
const mcp = new McpRegistry(appData, new SafeSecretStore(appData))
const approvals = new Approvals(appData)
const devServers = new DevServerManager(appData, approvals)
// Each chat's own emulators (one per platform), copied from the user's devices.
const chatDevices = new ChatDevices(appData, deviceTools)
// End-to-end tests drive chats with a stand-in agent script; never in a packaged app.
const e2eAgent = !app.isPackaged ? process.env.THINKERER_E2E_AGENT : undefined
// Bundled MCP scripts live in the app root (mcp/, node_modules/).
const mcpContext = async (): Promise<{ appRoot: string; node: { command: string; env: Record<string, string> } }> => {
  const node = await findExecutable('node')
  return {
    appRoot: app.getAppPath(),
    node: node ? { command: node, env: {} } : { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
}
const supervisor = new AgentSupervisor(appData, projects, {
  adapters: e2eAgent ? [scriptAdapter(e2eAgent)] : undefined,
  tasks,
  approvals,
  mcp: { registry: mcp, context: mcpContext },
  devices: chatDevices,
  // A turn whose preview is down gets it started (approved dev command only) before the agent is told to check it.
  devServers
})
const protocol = new ProtocolService({ supervisor, projects, approvals, stopDevServer: (projectId, chatId) => devServers.stop(projectId, chatId) })
let mainWindow: BrowserWindow | null = null
const preview = new PreviewManager(
  () => mainWindow,
  (scope, event) => mainWindow?.webContents.send('preview:event', scope.projectId, scope.chatId, event)
)

function rendererOrigin(): string {
  return isDev ? new URL(process.env.ELECTRON_RENDERER_URL!).origin : 'file://'
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Thinkerer',
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  win.once('ready-to-show', () => win.show())

  // The renderer is an untrusted surface: no new windows, no navigating away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(rendererOrigin())) event.preventDefault()
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function installSessionPolicy(): void {
  const devSources = isDev ? ` ${rendererOrigin()} ${rendererOrigin().replace(/^http/, 'ws')}` : ''
  // Vite's React refresh preamble is an inline script, so dev needs 'unsafe-inline'.
  const scriptSrc = isDev ? `'self' 'unsafe-inline'${devSources}` : `'self'`
  const csp = `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${devSources}; object-src 'none'; base-uri 'none'; frame-src 'none'`
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}

app.whenReady().then(() => {
  installSessionPolicy()
  registerIpc({
    projects,
    supervisor,
    protocol,
    tasks,
    mcp,
    mcpContext,
    devServers,
    approvals,
    preview,
    chatDevices,
    isDev,
    getWindow: () => mainWindow,
    rendererOrigin,
    restart: () => {
      if (isDev && process.env.THINKERER_DEV_WRAPPER === '1') {
        app.exit(DEV_RESTART_EXIT_CODE)
      } else {
        app.relaunch()
        app.exit(0)
      }
    }
  })
  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('before-quit', () => {
  supervisor.cancelAll()
  devServers.stopAll()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

import { WebContentsView, session, type BrowserWindow } from 'electron'
import type { PreviewEvent } from '../../shared/types'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Embedded website preview (spec F5): a sandboxed WebContentsView with no
 * preload and no Node, its own session per project, and navigation limited to
 * the project's preview origin unless the user approves another origin.
 * It is a separate browser session from the agent's Playwright browser.
 */
export class PreviewManager {
  private view: WebContentsView | null = null
  private projectId: string | null = null
  private readonly allowed = new Map<string, Set<string>>() // projectId → origins

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly emit: (projectId: string, event: PreviewEvent) => void
  ) {}

  show(projectId: string, url: string, bounds: Bounds): void {
    const origin = new URL(url).origin
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Preview URL must be http(s)')
    const set = this.allowed.get(projectId) ?? new Set<string>()
    set.add(origin)
    this.allowed.set(projectId, set)

    if (!this.view || this.projectId !== projectId) {
      this.destroy()
      this.view = this.createView(projectId)
      this.projectId = projectId
      void this.view.webContents.loadURL(url)
    }
    const win = this.getWindow()
    if (win && !win.contentView.children.includes(this.view)) win.contentView.addChildView(this.view)
    this.view.setBounds(round(bounds))
  }

  setBounds(bounds: Bounds): void {
    this.view?.setBounds(round(bounds))
  }

  hide(): void {
    const win = this.getWindow()
    if (this.view && win?.contentView.children.includes(this.view)) win.contentView.removeChildView(this.view)
  }

  reload(): void {
    this.view?.webContents.reloadIgnoringCache()
  }

  navigate(url: string): void {
    if (!this.view || !this.projectId) return
    if (!this.isAllowed(this.projectId, url)) {
      this.emit(this.projectId, { at: now(), kind: 'navigation-blocked', text: `Blocked navigation to ${url}`, url })
      return
    }
    void this.view.webContents.loadURL(url)
  }

  /** The user approved an origin outside the preview origin for this session. */
  approveAndNavigate(projectId: string, url: string): void {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs can be opened in the preview')
    this.allowed.get(projectId)?.add(parsed.origin)
    if (this.projectId === projectId) void this.view?.webContents.loadURL(url)
  }

  destroy(): void {
    this.hide()
    this.view?.webContents.close()
    this.view = null
    this.projectId = null
  }

  private isAllowed(projectId: string, url: string): boolean {
    try {
      return this.allowed.get(projectId)?.has(new URL(url).origin) ?? false
    } catch {
      return false
    }
  }

  private createView(projectId: string): WebContentsView {
    const ses = session.fromPartition(`persist:thinkerer-preview-${projectId}`)
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, webSecurity: true }
    })
    const wc = view.webContents
    const guard = (event: { preventDefault: () => void; url: string; isMainFrame?: boolean }) => {
      if (event.isMainFrame === false) return
      if (!this.isAllowed(projectId, event.url)) {
        event.preventDefault()
        this.emit(projectId, { at: now(), kind: 'navigation-blocked', text: `Blocked navigation to ${event.url}`, url: event.url })
      }
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.setWindowOpenHandler(({ url }) => {
      this.emit(projectId, { at: now(), kind: 'navigation-blocked', text: `Blocked new window for ${url}`, url })
      return { action: 'deny' }
    })
    wc.on('console-message', (...args: unknown[]) => {
      // Electron ≥35 passes a details object; older versions pass (event, level, message).
      const d = args[0] as { level?: unknown; message?: unknown }
      const level = typeof d?.level === 'string' ? d.level : (['debug', 'info', 'warning', 'error'][args[1] as number] ?? 'info')
      const message = typeof d?.message === 'string' ? d.message : String(args[2] ?? '')
      this.emit(projectId, { at: now(), kind: 'console', level: level as PreviewEvent['level'], text: message })
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.emit(projectId, { at: now(), kind: 'load-failed', text: `${description} (${code})`, url })
    })
    wc.on('did-finish-load', () => this.emit(projectId, { at: now(), kind: 'loaded', text: 'Loaded', url: wc.getURL() }))
    return view
  }
}

function round(b: Bounds): Bounds {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) }
}

function now(): string {
  return new Date().toISOString()
}

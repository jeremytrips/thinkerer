import { WebContentsView, session, type BrowserWindow } from 'electron'
import type { PreviewEvent } from '../../shared/types'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** What a preview shows: the project folder's site, or one chat worktree's. */
export interface PreviewScope {
  projectId: string
  chatId: string | null
}

const key = (s: PreviewScope) => (s.chatId ? `${s.projectId}:${s.chatId}` : s.projectId)

/**
 * Embedded website preview (spec F5): a sandboxed WebContentsView with no
 * preload and no Node, its own session per project, and navigation limited to
 * the preview origin (per project folder or chat worktree, which have their own
 * ports) unless the user approves another origin.
 * It is a separate browser session from the agent's Playwright browser.
 */
export class PreviewManager {
  private view: WebContentsView | null = null
  private scope: PreviewScope | null = null
  private readonly allowed = new Map<string, Set<string>>() // scope key → origins
  /** Console errors since the current page loaded, sent along with a capture. */
  private errors: string[] = []

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly emit: (scope: PreviewScope, event: PreviewEvent) => void
  ) {}

  show(scope: PreviewScope, url: string, bounds: Bounds): void {
    const origin = new URL(url).origin
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Preview URL must be http(s)')
    const set = this.allowed.get(key(scope)) ?? new Set<string>()
    set.add(origin)
    this.allowed.set(key(scope), set)

    if (!this.view || !this.isOpen(scope)) {
      this.destroy()
      this.view = this.createView(scope)
      this.scope = scope
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

  navigate(scope: PreviewScope, url: string): void {
    if (!this.view || !this.isOpen(scope)) throw new Error('The preview is not open for this project')
    if (!this.isAllowed(scope, url)) {
      this.emit(scope, { at: now(), kind: 'navigation-blocked', text: `Blocked navigation to ${url}`, url })
      return
    }
    void this.view.webContents.loadURL(url)
  }

  currentUrl(scope: PreviewScope): string | null {
    return this.view && this.isOpen(scope) ? this.view.webContents.getURL() || null : null
  }

  /** What the user is looking at right now: the visible page as PNG, its URL, and recent console errors. */
  async capture(scope: PreviewScope): Promise<{ png: Buffer; url: string; consoleErrors: string[] }> {
    const win = this.getWindow()
    if (!this.view || !this.isOpen(scope) || !win?.contentView.children.includes(this.view)) {
      throw new Error('Open the preview first')
    }
    const image = await this.view.webContents.capturePage()
    if (image.isEmpty()) throw new Error('The preview has nothing to capture yet')
    return { png: image.toPNG(), url: this.view.webContents.getURL(), consoleErrors: this.errors.slice(-10) }
  }

  /** The user approved an origin outside the preview origin for this session. */
  approveAndNavigate(scope: PreviewScope, url: string): void {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs can be opened in the preview')
    this.allowed.get(key(scope))?.add(parsed.origin)
    if (this.isOpen(scope)) void this.view?.webContents.loadURL(url)
  }

  destroy(): void {
    this.hide()
    this.view?.webContents.close()
    this.view = null
    this.scope = null
    this.errors = []
  }

  private isOpen(scope: PreviewScope): boolean {
    return !!this.scope && key(this.scope) === key(scope)
  }

  private isAllowed(scope: PreviewScope, url: string): boolean {
    try {
      return this.allowed.get(key(scope))?.has(new URL(url).origin) ?? false
    } catch {
      return false
    }
  }

  private createView(scope: PreviewScope): WebContentsView {
    const ses = session.fromPartition(`persist:thinkerer-preview-${scope.projectId}`)
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, webSecurity: true }
    })
    const wc = view.webContents
    const guard = (event: { preventDefault: () => void; url: string; isMainFrame?: boolean }) => {
      if (event.isMainFrame === false) return
      if (!this.isAllowed(scope, event.url)) {
        event.preventDefault()
        this.emit(scope, { at: now(), kind: 'navigation-blocked', text: `Blocked navigation to ${event.url}`, url: event.url })
      }
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.setWindowOpenHandler(({ url }) => {
      this.emit(scope, { at: now(), kind: 'navigation-blocked', text: `Blocked new window for ${url}`, url })
      return { action: 'deny' }
    })
    wc.on('console-message', (...args: unknown[]) => {
      // Electron ≥35 passes a details object; older versions pass (event, level, message).
      const d = args[0] as { level?: unknown; message?: unknown }
      const level = typeof d?.level === 'string' ? d.level : (['debug', 'info', 'warning', 'error'][args[1] as number] ?? 'info')
      const message = typeof d?.message === 'string' ? d.message : String(args[2] ?? '')
      if (level === 'error') this.errors = [...this.errors.slice(-49), message]
      this.emit(scope, { at: now(), kind: 'console', level: level as PreviewEvent['level'], text: message })
    })
    // Only committed page loads reset the errors; blocked navigations leave the page (and its errors) in place.
    wc.on('did-navigate', () => {
      this.errors = []
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.emit(scope, { at: now(), kind: 'load-failed', text: `${description} (${code})`, url })
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.emit(scope, { at: now(), kind: 'navigated', text: `Navigated to ${url}`, url })
    })
    wc.on('did-finish-load', () => this.emit(scope, { at: now(), kind: 'loaded', text: 'Loaded', url: wc.getURL() }))
    return view
  }
}

function round(b: Bounds): Bounds {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) }
}

function now(): string {
  return new Date().toISOString()
}

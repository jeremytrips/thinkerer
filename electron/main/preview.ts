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

/** One chat's (or the project folder's) browser: its view and the console errors since its page loaded. */
interface Tab {
  scope: PreviewScope
  view: WebContentsView
  errors: string[]
}

/** Browsers kept alive at once; the least recently shown one is closed beyond this. */
const MAX_TABS = 6

/**
 * Embedded website preview (spec F5): one sandboxed WebContentsView per chat
 * (and one for the project folder), with no preload and no Node. Each has its
 * own session, so chats never share cookies or storage (localhost cookies
 * ignore the port, so worktree ports alone would not separate them).
 * Navigation is limited to the preview origin unless the user approves
 * another. Switching chats keeps each browser's page; they are separate from
 * the agent's Playwright browser.
 */
export class PreviewManager {
  /** Insertion order is recency: the last entry was shown most recently. */
  private readonly tabs = new Map<string, Tab>()
  private shown: string | null = null
  private readonly allowed = new Map<string, Set<string>>() // scope key → origins

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly emit: (scope: PreviewScope, event: PreviewEvent) => void
  ) {}

  show(scope: PreviewScope, url: string, bounds: Bounds): void {
    const origin = new URL(url).origin
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Preview URL must be http(s)')
    const k = key(scope)
    const set = this.allowed.get(k) ?? new Set<string>()
    set.add(origin)
    this.allowed.set(k, set)

    let tab = this.tabs.get(k)
    if (!tab) {
      tab = { scope, view: this.createView(scope), errors: [] }
      void tab.view.webContents.loadURL(url)
    }
    this.tabs.delete(k)
    this.tabs.set(k, tab)
    if (this.shown !== k) this.hide()
    this.shown = k
    const win = this.getWindow()
    if (win && !win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view)
    tab.view.setBounds(round(bounds))
    this.evict()
  }

  setBounds(bounds: Bounds): void {
    this.current()?.view.setBounds(round(bounds))
  }

  /** Takes the shown browser off screen; its page stays loaded for when the chat is shown again. */
  hide(): void {
    const win = this.getWindow()
    const view = this.current()?.view
    if (view && win?.contentView.children.includes(view)) win.contentView.removeChildView(view)
    this.shown = null
  }

  reload(): void {
    this.current()?.view.webContents.reloadIgnoringCache()
  }

  navigate(scope: PreviewScope, url: string): void {
    const tab = this.tabs.get(key(scope))
    if (!tab) throw new Error('The preview is not open for this chat')
    if (!this.isAllowed(scope, url)) {
      this.emit(scope, { at: now(), kind: 'navigation-blocked', text: `Blocked navigation to ${url}`, url })
      return
    }
    void tab.view.webContents.loadURL(url)
  }

  currentUrl(scope: PreviewScope): string | null {
    return this.tabs.get(key(scope))?.view.webContents.getURL() || null
  }

  /** What the user is looking at right now: the visible page as PNG, its URL, and recent console errors. */
  async capture(scope: PreviewScope): Promise<{ png: Buffer; url: string; consoleErrors: string[] }> {
    const win = this.getWindow()
    const tab = this.shown === key(scope) ? this.tabs.get(key(scope)) : undefined
    if (!tab || !win?.contentView.children.includes(tab.view)) throw new Error('Open the preview first')
    const image = await tab.view.webContents.capturePage()
    if (image.isEmpty()) throw new Error('The preview has nothing to capture yet')
    return { png: image.toPNG(), url: tab.view.webContents.getURL(), consoleErrors: tab.errors.slice(-10) }
  }

  /** The user approved an origin outside the preview origin for this session. */
  approveAndNavigate(scope: PreviewScope, url: string): void {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs can be opened in the preview')
    this.allowed.get(key(scope))?.add(parsed.origin)
    void this.tabs.get(key(scope))?.view.webContents.loadURL(url)
  }

  /** Closes a chat's browser for good and wipes its cookies and storage (its worktree is gone). */
  close(scope: PreviewScope): void {
    this.closeTab(key(scope))
    this.allowed.delete(key(scope))
    if (scope.chatId) void session.fromPartition(partition(scope)).clearStorageData().catch(() => {})
  }

  destroy(): void {
    for (const k of [...this.tabs.keys()]) this.closeTab(k)
  }

  private current(): Tab | undefined {
    return this.shown ? this.tabs.get(this.shown) : undefined
  }

  private closeTab(k: string): void {
    const tab = this.tabs.get(k)
    if (!tab) return
    if (this.shown === k) this.hide()
    this.tabs.delete(k)
    tab.view.webContents.close()
  }

  /** Keeps memory bounded: closes the least recently shown browsers (never the one on screen). */
  private evict(): void {
    for (const k of this.tabs.keys()) {
      if (this.tabs.size <= MAX_TABS) break
      if (k !== this.shown) this.closeTab(k)
    }
  }

  private isAllowed(scope: PreviewScope, url: string): boolean {
    try {
      return this.allowed.get(key(scope))?.has(new URL(url).origin) ?? false
    } catch {
      return false
    }
  }

  private createView(scope: PreviewScope): WebContentsView {
    const ses = session.fromPartition(partition(scope))
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, webSecurity: true }
    })
    const wc = view.webContents
    const tabOf = () => this.tabs.get(key(scope))
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
      const tab = tabOf()
      if (level === 'error' && tab) tab.errors = [...tab.errors.slice(-49), message]
      this.emit(scope, { at: now(), kind: 'console', level: level as PreviewEvent['level'], text: message })
    })
    // Only committed page loads reset the errors; blocked navigations leave the page (and its errors) in place.
    wc.on('did-navigate', () => {
      const tab = tabOf()
      if (tab) tab.errors = []
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

/** Each chat its own persistent session; the project folder keeps the one it always had. */
function partition(scope: PreviewScope): string {
  return scope.chatId ? `persist:thinkerer-preview-${scope.projectId}-${scope.chatId}` : `persist:thinkerer-preview-${scope.projectId}`
}

function round(b: Bounds): Bounds {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) }
}

function now(): string {
  return new Date().toISOString()
}

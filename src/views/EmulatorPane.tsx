import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import type { ChatDevicesView, MobileDevice, MobileFrame, MobilePlatform, MobileToolStatus, PreviewCapture, Project } from '../../shared/types'
import { api, errorMessage, loadState, saveState } from '../api'

interface Props {
  project: Project
  /** Chat whose own devices are shown (and whose preview "Open preview" loads); null is the project folder. */
  chatId?: string | null
  onCapture?: (capture: PreviewCapture) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const STATE_TONE: Record<MobileDevice['state'], string> = { booted: 'pill-succeeded', booting: 'pill-running', shutdown: 'pill-cancelled' }
const PLATFORM_NAME: Record<MobilePlatform, string> = { ios: 'iOS', android: 'Android' }

/**
 * The chat's own Android emulator / iOS simulator, shown live in the panel.
 * Clicks are taps, drags are swipes, the wheel scrolls. Each chat has its own
 * devices (copied from one of the user's), the same ones the agent drives
 * through the `mobile` MCP server.
 */
export function EmulatorPane({ project, chatId = null, onCapture }: Props) {
  const [status, setStatus] = useState<MobileToolStatus | null>(null)
  const [view, setView] = useState<ChatDevicesView | null>(null)
  const [selected, setSelected] = useState<string>(() => loadState('agent.emulator', ''))
  const [template, setTemplate] = useState('')
  const [frame, setFrame] = useState<MobileFrame | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const imgRef = useRef<HTMLImageElement>(null)
  const press = useRef<{ x: number; y: number; at: number } | null>(null)
  const wheel = useRef<{ dy: number; timer: number | null }>({ dy: 0, timer: null })

  const devices = view?.devices ?? null
  const device = devices?.find((d) => d.id === selected) ?? devices?.[0] ?? null
  // Platforms this chat has no device for yet, and the user's devices it can copy.
  const templates = (view?.templates ?? []).filter((t) => !devices?.some((d) => d.platform === t.platform))
  const chosen = templates.find((t) => t.id === template) ?? templates.find((t) => view?.defaults[t.platform] === t.id) ?? templates[0] ?? null
  const booted = device?.state === 'booted'
  const canInput = booted && device.input

  async function refresh() {
    try {
      setView(await api.mobile.chatDevices(project.id, chatId))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  useEffect(() => {
    api.mobile.status().then(setStatus, () => {})
    setView(null)
    void refresh()
    const t = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(t)
  }, [project.id, chatId])

  // Live view: fetch frames back to back while the device is booted.
  useEffect(() => {
    setFrame(null)
    if (!device || !booted) return
    let alive = true
    void (async () => {
      while (alive) {
        try {
          const f = await api.mobile.frame(device.id)
          if (!alive) break
          setFrame(f)
        } catch {
          await sleep(1500)
        }
        await sleep(document.hidden ? 1000 : 100)
      }
    })()
    return () => {
      alive = false
    }
  }, [device?.id, booted])

  function choose(id: string) {
    setSelected(id)
    saveState('agent.emulator', id)
  }

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  /** Screen position in logical points, accounting for object-fit: contain letterboxing. */
  function toPoints(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = imgRef.current
    if (!img || !frame) return null
    const r = img.getBoundingClientRect()
    const fit = Math.min(r.width / frame.width, r.height / frame.height)
    const w = frame.width * fit
    const h = frame.height * fit
    const left = r.left + (r.width - w) / 2
    const top = r.top + (r.height - h) / 2
    const fx = (clientX - left) / w
    const fy = (clientY - top) / h
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null
    return { x: (fx * frame.width) / frame.scale, y: (fy * frame.height) / frame.scale }
  }

  function send(fn: () => Promise<unknown>) {
    fn().catch((e) => setError(errorMessage(e)))
  }

  function onPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    if (!canInput || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    press.current = { x: e.clientX, y: e.clientY, at: performance.now() }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLImageElement>) {
    const start = press.current
    press.current = null
    if (!start || !device || !canInput) return
    const a = toPoints(start.x, start.y)
    const b = toPoints(e.clientX, e.clientY)
    if (!a) return
    const held = performance.now() - start.at
    if (!b || Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) {
      send(() => api.mobile.tap(device.id, a.x, a.y, held > 500 ? held : 0))
    } else {
      send(() => api.mobile.swipe(device.id, a.x, a.y, b.x, b.y, Math.min(Math.max(held, 80), 2000)))
    }
  }

  function onWheel(e: ReactWheelEvent<HTMLImageElement>) {
    if (!canInput || !device || !frame) return
    const w = wheel.current
    w.dy += e.deltaY
    if (w.timer) window.clearTimeout(w.timer)
    w.timer = window.setTimeout(() => {
      const ph = frame.height / frame.scale
      const pw = frame.width / frame.scale
      const dist = Math.max(-ph * 0.35, Math.min(ph * 0.35, w.dy * 0.8))
      w.dy = 0
      w.timer = null
      if (Math.abs(dist) > 4) send(() => api.mobile.swipe(device.id, pw / 2, ph / 2 + dist / 2, pw / 2, ph / 2 - dist / 2, 250))
    }, 120)
  }

  const noTools = status && !status.android.available && !status.ios.available

  return (
    <div className="preview-pane emulator-pane">
      <div className="preview-bar">
        {device && <span className={`pill ${STATE_TONE[device.state]}`}>{device.state === 'booted' ? 'Running' : device.state === 'booting' ? 'Booting…' : 'Off'}</span>}
        <select
          className="emulator-select"
          aria-label="Emulator device"
          value={device?.id ?? ''}
          onChange={(e) => choose(e.target.value)}
          disabled={!devices?.length}
        >
          {!devices?.length && <option value="">{devices ? 'No device for this chat yet' : 'Looking for devices…'}</option>}
          {devices?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.platform === 'ios' ? 'iOS' : 'Android'} · {d.name} ({d.detail}){d.state === 'booted' ? ' ●' : ''}
            </option>
          ))}
        </select>
        <div className="row preview-actions">
          {device && booted && onCapture && (
            <button
              className="small primary"
              disabled={!!busy || !frame}
              title="Attach a screenshot of this device screen to your next message"
              onClick={() => act('capture', async () => onCapture(await api.mobile.capture(project.id, device.id)))}
            >
              {busy === 'capture' ? 'Capturing…' : 'Send to agent'}
            </button>
          )}
          {device && booted && (
            <button
              className="small"
              disabled={!!busy}
              title="Open this project's preview URL on the device (localhost works on Android too)"
              onClick={() => act('open', () => api.mobile.openPreview(device.id, project.id, chatId))}
            >
              Open preview
            </button>
          )}
          {device && device.state !== 'shutdown' && (
            <button className="small" disabled={!!busy} onClick={() => act('shutdown', async () => (await api.mobile.shutdown(device.id), await refresh()))}>
              {busy === 'shutdown' ? 'Shutting down…' : 'Shut down'}
            </button>
          )}
          {device && device.state === 'shutdown' && (
            <button className="small primary" disabled={!!busy} onClick={() => act('boot', async () => (await api.mobile.boot(device.id), await refresh()))}>
              {busy === 'boot' ? 'Booting…' : 'Boot'}
            </button>
          )}
          {device && (
            <button
              className="small"
              disabled={!!busy}
              title="Delete this chat's device with its apps and data (your own devices are not touched)"
              onClick={() => act('delete', async () => (await api.mobile.deleteChatDevice(project.id, chatId, device.id), await refresh()))}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
      {chosen && (
        <div className="preview-bar emulator-create">
          <span className="small muted">{devices?.length ? 'Add a device for this chat:' : 'Create this chat’s device from:'}</span>
          <select className="emulator-select" aria-label="Device to copy" value={chosen.id} onChange={(e) => setTemplate(e.target.value)} disabled={!!busy}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {PLATFORM_NAME[t.platform]} · {t.name} ({t.detail})
              </option>
            ))}
          </select>
          <button
            className="small primary"
            disabled={!!busy}
            title="A new device with the same hardware and OS, with its own apps and data, used only by this chat"
            onClick={() =>
              act('create', async () => {
                const made = await api.mobile.createChatDevice(project.id, chatId, chosen.id)
                choose(made.id)
                await refresh()
              })
            }
          >
            {busy === 'create' ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}
      {error && <div className="banner banner-error preview-note">{error}</div>}
      {device?.platform === 'ios' && !device.input && (
        <p className="small muted preview-note">
          View only: iOS taps and typing need idb (fbidb.io). Install with{' '}
          <code>brew install facebook/fb/idb-companion &amp;&amp; pipx install fb-idb</code>, then restart Thinkerer.
        </p>
      )}
      <div className="preview-frame emulator-stage">
        {frame && booted ? (
          <img
            ref={imgRef}
            className={canInput ? 'emulator-screen interactive' : 'emulator-screen'}
            src={frame.dataUrl}
            alt={`${device.name} screen`}
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (press.current = null)}
            onWheel={onWheel}
          />
        ) : (
          <div className="preview-empty muted">
            {noTools ? (
              <>
                <div>No Android SDK or Xcode simulators found.</div>
                <div className="small">{status!.android.detail}</div>
                <div className="small">{status!.ios.detail}</div>
              </>
            ) : !devices ? (
              'Looking for emulators…'
            ) : !device && !view?.templates.length ? (
              'Create an Android Virtual Device in Android Studio, or an iOS simulator in Xcode. Each chat then gets its own copy.'
            ) : !device ? (
              <>
                <div>This chat has no device yet.</div>
                <div className="small">Create one above: same hardware and OS as the device you pick, with its own apps and data. The agent creates one on its first turn when the Mobile emulators MCP server is on.</div>
              </>
            ) : device.state === 'booted' ? (
              'Connecting to the screen…'
            ) : device.state === 'booting' || busy === 'boot' ? (
              `Booting ${device.name}… this can take a minute.`
            ) : (
              <>
                <div>{device.name} is off.</div>
                <div className="small">Boot it to see and use it here. It belongs to this chat; the agent can drive it too, with the Mobile emulators MCP server.</div>
              </>
            )}
          </div>
        )}
      </div>
      {device && booted && (
        <div className="preview-bar emulator-keys">
          {device.platform === 'android' && (
            <button className="small" disabled={!canInput} onClick={() => send(() => api.mobile.key(device.id, 'back'))} title="Back">
              ◀ Back
            </button>
          )}
          <button className="small" disabled={!canInput} onClick={() => send(() => api.mobile.key(device.id, 'home'))} title="Home">
            ● Home
          </button>
          {device.platform === 'android' && (
            <button className="small" disabled={!canInput} onClick={() => send(() => api.mobile.key(device.id, 'recents'))} title="Recent apps">
              ■ Recents
            </button>
          )}
          <form
            className="row emulator-type"
            onSubmit={(e) => {
              e.preventDefault()
              const value = text
              setText('')
              if (value) send(() => api.mobile.type(device.id, value))
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type into the focused field…"
              aria-label="Type into the device"
              disabled={!canInput}
            />
          </form>
          <button className="small" disabled={!canInput} onClick={() => send(() => api.mobile.key(device.id, 'enter'))} title="Press Enter on the device">
            ⏎ Enter
          </button>
        </div>
      )}
    </div>
  )
}

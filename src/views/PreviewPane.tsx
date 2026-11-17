import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DevServerState, PreviewCapture, Project } from '../../shared/types'
import { api, errorMessage } from '../api'
import { useOverlayOpen } from '../overlay'

const STATE_LABEL: Record<DevServerState['status'], string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  exited: 'Exited',
  external: 'Served externally'
}

export interface PreviewDevice {
  id: string
  label: string
  width: number
  height: number
}

interface Props {
  project: Project
  /** Shows "Send to agent" and receives the screenshot of what the user sees. */
  onCapture?: (capture: PreviewCapture) => void
  /** Steps the native view aside, e.g. while the user drags a divider across it. */
  suspended?: boolean
  /** Bumped by the parent to reload the page (e.g. after a run changed files). */
  reloadNonce?: number
  /** Renders the page in a screen of this size instead of filling the pane. */
  device?: PreviewDevice | null
}

/** The project's live website: dev server controls and the sandboxed native preview. */
export function PreviewPane({ project, onCapture, suspended = false, reloadNonce = 0, device = null }: Props) {
  const [state, setState] = useState<DevServerState | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const overlay = useOverlayOpen()
  const previewing = state?.status === 'running' || state?.status === 'external'
  const shown = previewing && !overlay && !suspended

  useEffect(() => {
    api.website.state(project.id).then(setState, (e) => setError(errorMessage(e)))
    api.preview.url(project.id).then((u) => u && setUrl(u), () => {})
    const offState = api.website.onState((s) => s.projectId === project.id && setState(s))
    const offPreview = api.preview.onEvent((id, e) => {
      if (id === project.id && (e.kind === 'loaded' || e.kind === 'navigated') && e.url) setUrl(e.url)
    })
    return () => {
      offState()
      offPreview()
    }
  }, [project.id])

  // Keep the native preview view glued to the frame element.
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!shown || !el) return
    const rect = () => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    api.preview.show(project.id, rect()).catch((e) => setError(errorMessage(e)))
    const ro = new ResizeObserver(() => void api.preview.setBounds(rect()))
    ro.observe(el)
    // A device screen keeps its size but moves when the pane around it resizes.
    if (device && outerRef.current) ro.observe(outerRef.current)
    const onResize = () => void api.preview.setBounds(rect())
    window.addEventListener('resize', onResize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      void api.preview.hide()
    }
  }, [shown, project.id, device?.id])

  useEffect(() => {
    if (reloadNonce && previewing) void api.preview.reload().catch(() => {})
  }, [reloadNonce])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (errorMessage(err) !== 'Cancelled') setError(errorMessage(err))
    }
  }

  async function capture() {
    setCapturing(true)
    await act(async () => onCapture?.(await api.preview.capture(project.id)))
    setCapturing(false)
  }

  const config = project.config!
  const running = state && (state.status === 'running' || state.status === 'starting' || state.status === 'external')
  const tone = previewing ? 'pill-succeeded' : state?.status === 'starting' ? 'pill-running' : state?.status === 'exited' ? 'pill-failed' : 'pill-cancelled'

  const empty = !shown && (
    <div className="preview-empty muted">
      {previewing
        ? overlay
          ? 'Preview hidden while a dialog is open.'
          : 'Preview resumes when you let go.'
        : state?.status === 'starting'
          ? 'Waiting for the dev server to respond…'
          : 'Start the dev server to preview the site here.'}
      {!previewing && (
        <div className="small">
          The preview is sandboxed and limited to {config.website.previewUrl ? new URL(config.website.previewUrl).origin : 'the preview URL'}.
        </div>
      )}
    </div>
  )

  return (
    <div className="preview-pane">
      <div className="preview-bar">
        {state && <span className={`pill ${tone}`}>{STATE_LABEL[state.status]}</span>}
        <span className="mono small ellipsis preview-url" title={url ?? config.website.previewUrl}>
          {previewing ? (url ?? config.website.previewUrl) : config.website.devCommand || 'no dev command'}
        </span>
        <div className="row preview-actions">
          {previewing && onCapture && (
            <button
              className="small primary"
              onClick={capture}
              disabled={capturing || !shown}
              title="Attach a screenshot of this page, its URL and recent console errors to your next message"
            >
              {capturing ? 'Capturing…' : 'Send to agent'}
            </button>
          )}
          {previewing && <button className="small" onClick={() => act(() => api.preview.reload())}>Reload</button>}
          {running ? (
            <button className="small" onClick={() => act(() => api.website.stop(project.id))}>
              {state?.status === 'external' ? 'Stop previewing' : 'Stop dev server'}
            </button>
          ) : (
            <button className="small" onClick={() => act(() => api.website.start(project.id))} disabled={!config.website.devCommand}>
              Start dev server
            </button>
          )}
        </div>
      </div>
      {state?.needsApproval && !running && (
        <p className="small muted preview-note">Starting will ask you to approve this command (first run, or it changed since you last approved it).</p>
      )}
      {error && <div className="banner banner-error preview-note">{error}</div>}
      <div className={device ? 'preview-frame preview-stage' : 'preview-frame'} ref={device ? outerRef : frameRef}>
        {device ? (
          <div className="preview-screen" ref={frameRef} style={{ width: device.width, height: device.height }} aria-label={`${device.label} screen`}>
            {empty}
          </div>
        ) : (
          empty
        )}
      </div>
    </div>
  )
}

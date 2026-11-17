import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DevLogLine, DevServerState, PreviewEvent, Project, RunRecord } from '../../shared/types'
import { api, errorMessage } from '../api'
import { ArtifactGallery } from './AgentTab'
import { StatusPill, relativeTime } from './RunBits'

type Panel = 'log' | 'console' | 'checks'

const STATE_LABEL: Record<DevServerState['status'], string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  exited: 'Exited',
  external: 'Served externally'
}

export function WebsiteTab({ project }: { project: Project }) {
  const [state, setState] = useState<DevServerState | null>(null)
  const [logs, setLogs] = useState<DevLogLine[]>([])
  const [events, setEvents] = useState<PreviewEvent[]>([])
  const [panel, setPanel] = useState<Panel>('log')
  const [check, setCheck] = useState<RunRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const logEnd = useRef<HTMLDivElement>(null)
  const previewing = state?.status === 'running' || state?.status === 'external'

  const loadCheck = useCallback(async () => {
    const runs = await api.runs.list(project.id)
    const latest = runs.find((r) => r.mcpServers?.includes('playwright') && r.endedAt)
    setCheck(latest ? await api.runs.get(latest.id) : null)
  }, [project.id])

  useEffect(() => {
    api.website.state(project.id).then(setState, (e) => setError(errorMessage(e)))
    api.website.logs(project.id).then(setLogs, () => {})
    void loadCheck()
    const offLog = api.website.onLog((id, line) => id === project.id && setLogs((cur) => [...cur.slice(-1999), line]))
    const offState = api.website.onState((s) => s.projectId === project.id && setState(s))
    const offPreview = api.preview.onEvent((id, e) => id === project.id && setEvents((cur) => [...cur.slice(-499), e]))
    const offRuns = api.runs.onUpdate((s) => s.projectId === project.id && s.endedAt && void loadCheck())
    return () => {
      offLog()
      offState()
      offPreview()
      offRuns()
    }
  }, [project.id, loadCheck])

  // Keep the native preview view glued to the placeholder element.
  useLayoutEffect(() => {
    const el = previewRef.current
    if (!previewing || !el) return
    const rect = () => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    api.preview.show(project.id, rect()).catch((e) => setError(errorMessage(e)))
    const ro = new ResizeObserver(() => void api.preview.setBounds(rect()))
    ro.observe(el)
    const onResize = () => void api.preview.setBounds(rect())
    window.addEventListener('resize', onResize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      void api.preview.hide()
    }
  }, [previewing, project.id])

  useEffect(() => {
    if (panel === 'log') logEnd.current?.scrollIntoView({ block: 'end' })
  }, [logs.length, panel])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (errorMessage(err) !== 'Cancelled') setError(errorMessage(err))
    }
  }

  const config = project.config!
  const running = state && (state.status === 'running' || state.status === 'starting' || state.status === 'external')
  const consoleErrors = events.filter((e) => e.kind === 'console' && e.level === 'error').length
  const verdict = check?.resultText ? (/\bFAIL(ED)?\b/.test(check.resultText) ? 'FAILED' : /\bPASS(ED)?\b/.test(check.resultText) ? 'PASSED' : null) : null
  const browserActions =
    check?.events.filter((e) => e.kind === 'tool-use' && (String(e.meta?.tool ?? '').startsWith('mcp__playwright__') || e.text.startsWith('MCP: playwright/'))) ?? []

  return (
    <section className="website">
      <div className="website-head">
        <div>
          <h1>Website</h1>
          <div className="row small">
            {state && <span className={`pill ${previewing ? 'pill-succeeded' : state.status === 'starting' ? 'pill-running' : state.status === 'exited' ? 'pill-failed' : 'pill-cancelled'}`}>{STATE_LABEL[state.status]}</span>}
            <span className="mono">{config.website.devCommand || 'no dev command'}</span>
            <span className="muted">→</span>
            <span className="mono">{config.website.previewUrl || 'no preview URL'}</span>
          </div>
        </div>
        <div className="row">
          {previewing && <button className="small" onClick={() => act(() => api.preview.reload())}>Reload preview</button>}
          {running ? (
            <button className="small" onClick={() => act(() => api.website.stop(project.id))}>{state?.status === 'external' ? 'Stop previewing' : 'Stop dev server'}</button>
          ) : (
            <button className="small primary" onClick={() => act(() => api.website.start(project.id))} disabled={!config.website.devCommand}>
              Start dev server
            </button>
          )}
        </div>
      </div>
      {state?.needsApproval && !running && (
        <p className="small muted">Starting will ask you to approve this command (first run, or it changed since you last approved it).</p>
      )}
      {error && <div className="banner banner-error">{error}</div>}

      <div className="preview-frame card" ref={previewing ? previewRef : undefined}>
        {!previewing && (
          <div className="preview-empty muted">
            {state?.status === 'starting' ? 'Waiting for the dev server to respond…' : 'Start the dev server to preview the site here.'}
            <div className="small">The preview is sandboxed and limited to {config.website.previewUrl ? new URL(config.website.previewUrl).origin : 'the preview URL'}.</div>
          </div>
        )}
      </div>

      <div className="website-panel card">
        <div className="row panel-tabs" role="tablist">
          <button role="tab" aria-selected={panel === 'log'} className={panel === 'log' ? 'tab active' : 'tab'} onClick={() => setPanel('log')}>Server log</button>
          <button role="tab" aria-selected={panel === 'console'} className={panel === 'console' ? 'tab active' : 'tab'} onClick={() => setPanel('console')}>
            Preview console {consoleErrors > 0 && <span className="pill pill-failed">{consoleErrors}</span>}
          </button>
          <button role="tab" aria-selected={panel === 'checks'} className={panel === 'checks' ? 'tab active' : 'tab'} onClick={() => setPanel('checks')}>Agent browser checks</button>
        </div>
        <div className="panel-body">
          {panel === 'log' && (
            <pre className="devlog">
              {logs.length === 0 ? <span className="muted">No output yet.</span> : logs.map((l, i) => <div key={i} className={`log-${l.stream}`}>{l.text}</div>)}
              <div ref={logEnd} />
            </pre>
          )}
          {panel === 'console' && (
            <ul className="console">
              {events.length === 0 && <li className="muted small">No preview events yet.</li>}
              {events.map((e, i) => (
                <li key={i} className={`console-${e.kind === 'console' ? e.level : e.kind}`}>
                  <span className="mono small">{e.text}</span>
                  {e.kind === 'navigation-blocked' && e.url && (
                    <button className="small" onClick={() => act(() => api.preview.approve(project.id, e.url!))}>Allow & open…</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {panel === 'checks' &&
            (!check ? (
              <p className="muted small">
                No agent run has used the Playwright browser yet. Enable <strong>Playwright browser</strong> in the MCP tab, start the dev server, and ask
                the agent to verify a change in the browser.
              </p>
            ) : (
              <div className="checks">
                <div className="row">
                  <StatusPill status={check.status} />
                  {verdict && <span className={`pill ${verdict === 'PASSED' ? 'pill-succeeded' : 'pill-failed'}`}>Browser check {verdict}</span>}
                  <span className="small muted">as reported by the agent · {relativeTime(check.createdAt)}</span>
                </div>
                <div className="small ellipsis">“{check.prompt}”</div>
                <h3>Observed browser actions ({browserActions.length})</h3>
                <ol className="mono small actions">
                  {browserActions.map((e, i) => <li key={i}>{String(e.meta?.tool ?? '').replace(/^mcp__playwright__/, '')} {e.text.replace(/^[^:]+:\s*/, '')}</li>)}
                </ol>
                {check.artifacts.length > 0 ? <ArtifactGallery runId={check.id} artifacts={check.artifacts} /> : <p className="small muted">No screenshots were taken.</p>}
              </div>
            ))}
        </div>
      </div>
    </section>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DevLogLine, PreviewEvent, Project, RunRecord } from '../../shared/types'
import { api, errorMessage } from '../api'
import { ArtifactGallery } from './AgentTab'
import { PreviewPane } from './PreviewPane'
import { StatusPill, relativeTime } from './RunBits'

type Panel = 'log' | 'console' | 'checks'

export function WebsiteTab({ project }: { project: Project }) {
  const [logs, setLogs] = useState<DevLogLine[]>([])
  const [events, setEvents] = useState<PreviewEvent[]>([])
  const [panel, setPanel] = useState<Panel>('log')
  const [check, setCheck] = useState<RunRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  const loadCheck = useCallback(async () => {
    const runs = await api.runs.list(project.id)
    const latest = runs.find((r) => r.mcpServers?.includes('playwright') && r.endedAt)
    setCheck(latest ? await api.runs.get(latest.id) : null)
  }, [project.id])

  useEffect(() => {
    api.website.logs(project.id).then(setLogs, () => {})
    void loadCheck()
    const offLog = api.website.onLog((id, line) => id === project.id && setLogs((cur) => [...cur.slice(-1999), line]))
    const offPreview = api.preview.onEvent((id, e) => id === project.id && setEvents((cur) => [...cur.slice(-499), e]))
    const offRuns = api.runs.onUpdate((s) => s.projectId === project.id && s.endedAt && void loadCheck())
    return () => {
      offLog()
      offPreview()
      offRuns()
    }
  }, [project.id, loadCheck])

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
  const consoleErrors = events.filter((e) => e.kind === 'console' && e.level === 'error').length
  const verdict = check?.resultText ? (/\bFAIL(ED)?\b/.test(check.resultText) ? 'FAILED' : /\bPASS(ED)?\b/.test(check.resultText) ? 'PASSED' : null) : null
  const browserActions =
    check?.events.filter((e) => e.kind === 'tool-use' && (String(e.meta?.tool ?? '').startsWith('mcp__playwright__') || e.text.startsWith('MCP: playwright/'))) ?? []

  return (
    <section className="website">
      <div className="website-head">
        <h1>Website</h1>
        <div className="row small">
          <span className="mono">{config.website.devCommand || 'no dev command'}</span>
          <span className="muted">→</span>
          <span className="mono">{config.website.previewUrl || 'no preview URL'}</span>
        </div>
      </div>
      {error && <div className="banner banner-error">{error}</div>}

      <div className="card website-preview">
        <PreviewPane project={project} />
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

import { useCallback, useEffect, useState } from 'react'
import type { EffectiveMcp, McpCheckResult, McpImportCandidate, McpServerView, McpTransport, Project } from '../../shared/types'
import { api, errorMessage } from '../api'

export function McpTab({ project, onChanged }: { project: Project; onChanged: () => Promise<void> }) {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [effective, setEffective] = useState<EffectiveMcp[]>([])
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [checks, setChecks] = useState<Record<string, McpCheckResult | 'checking'>>({})
  const saved = project.config!.agent.enabledMcpServers
  // Optimistic so the checkbox responds immediately; reverted if saving fails.
  const [enabled, setEnabled] = useState<string[]>(saved)
  useEffect(() => setEnabled(saved), [saved.join(',')])

  const refresh = useCallback(() => {
    api.mcp.list().then(setServers, (e) => setError(errorMessage(e)))
    api.mcp.effective(project.id).then(setEffective, () => {})
  }, [project.id])

  useEffect(refresh, [refresh, enabled.join(',')])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await onChanged()
      refresh()
    } catch (err) {
      if (errorMessage(err) !== 'Cancelled') setError(errorMessage(err))
    }
  }

  async function check(id: string) {
    setChecks((cur) => ({ ...cur, [id]: 'checking' }))
    try {
      const res = await api.mcp.check(project.id, id)
      setChecks((cur) => ({ ...cur, [id]: res }))
    } catch (err) {
      setChecks((cur) => ({ ...cur, [id]: { ok: false, serverInfo: null, tools: [], error: errorMessage(err), ms: 0 } }))
    }
  }

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...enabled, id] : enabled.filter((x) => x !== id)
    setEnabled(next)
    void act(async () => {
      try {
        await api.projects.update(project.id, { agent: { enabledMcpServers: next } })
      } catch (err) {
        setEnabled(saved)
        throw err
      }
    })
  }

  return (
    <section className="mcp">
      <h1>MCP tools</h1>
      <p className="muted">
        One registry for all projects. Enable servers per project; both Claude Code and Codex receive the same enabled servers.
        Changes take effect at the next agent run. Your own global CLI MCP configuration is never passed to agents, but you can import
        servers from it. Each turn’s Details show which servers actually connected.
      </p>
      {error && <div className="banner banner-error">{error}</div>}

      <div className="card">
        <h3>Effective tools for this project</h3>
        {effective.length === 0 || effective.every((e) => e.servers.length === 0) ? (
          <p className="muted small">No MCP servers enabled — agents run with none.</p>
        ) : (
          <table className="effective">
            <thead>
              <tr>
                <th>Server</th>
                {effective.map((e) => <th key={e.provider}>{e.provider === 'claude' ? 'Claude Code' : 'Codex'}</th>)}
              </tr>
            </thead>
            <tbody>
              {effective[0].servers.map((s, i) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  {effective.map((e) => {
                    const x = e.servers[i]
                    return <td key={e.provider} className={x.included ? 'ok-text' : 'muted'}>{x.included ? '✓ included' : `✗ ${x.reason}`}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="row space">
        <h3>Registry</h3>
        <div className="row">
          {!importing && <button className="small" onClick={() => setImporting(true)}>Import from Claude Code…</button>}
          {!adding && <button className="small" onClick={() => setAdding(true)}>Add server…</button>}
        </div>
      </div>
      {importing && <ImportServers projectId={project.id} onClose={() => setImporting(false)} onImport={(key) => act(() => api.mcp.import(project.id, key))} />}
      {adding && <AddServer onCancel={() => setAdding(false)} onSave={(def) => act(async () => { await api.mcp.upsert(def); setAdding(false) })} />}

      <ul className="mcp-list">
        {(servers ?? []).map((s) => (
          <li key={s.id} className="card mcp-server">
            <div className="row space">
              <label className="check">
                <input type="checkbox" checked={enabled.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                <strong>{s.label}</strong> <span className="badge">{s.builtin ? 'built-in' : 'custom'}</span>
                {s.transport && s.transport !== 'stdio' && <span className="badge">{s.transport === 'http' ? 'HTTP' : 'SSE'}</span>}
                <span className="mono small muted">{s.id}</span>
              </label>
              <div className="row">
                <button className="small" onClick={() => void check(s.id)} disabled={checks[s.id] === 'checking'} title="Connect and list its tools (no tool is called)">
                  {checks[s.id] === 'checking' ? 'Checking…' : 'Check'}
                </button>
                {!s.builtin && <button className="small link" onClick={() => act(() => api.mcp.remove(s.id))}>Remove</button>}
              </div>
            </div>
            {s.description && <p className="small muted">{s.description}</p>}
            {s.transport && s.transport !== 'stdio' ? (
              <div className="mono small cmd">
                {s.url}
                {Object.entries(s.headers ?? {}).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
              </div>
            ) : (
              <div className="mono small cmd">{s.command} {s.args.join(' ')}</div>
            )}
            {checks[s.id] && checks[s.id] !== 'checking' && <CheckResult result={checks[s.id] as McpCheckResult} />}
            {s.secretEnv.length > 0 && (
              <div className="secrets">
                {s.secretEnv.map((name) => (
                  <SecretField key={name} serverId={s.id} name={name} isSet={s.secretsSet.includes(name)} onDone={(fn) => act(fn)} />
                ))}
                <p className="small muted">Stored encrypted with your OS credential storage — never in the project or logs.</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function SecretField({ serverId, name, isSet, onDone }: { serverId: string; name: string; isSet: boolean; onDone: (fn: () => Promise<unknown>) => void }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="row secret"
      onSubmit={(e) => {
        e.preventDefault()
        if (value) onDone(() => api.mcp.setSecret(serverId, name, value).then(() => setValue('')))
      }}
    >
      <span className="mono small">{name}</span>
      <span className={`small ${isSet ? 'ok-text' : 'muted'}`}>{isSet ? 'set' : 'not set'}</span>
      <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={isSet ? 'Replace value' : 'Value'} aria-label={`Value for ${name}`} autoComplete="off" />
      <button type="submit" className="small" disabled={!value}>Save</button>
      {isSet && <button type="button" className="small link" onClick={() => onDone(() => api.mcp.setSecret(serverId, name, null))}>Clear</button>}
    </form>
  )
}

function CheckResult({ result }: { result: McpCheckResult }) {
  if (!result.ok) return <div className="banner banner-error small mcp-check">Could not connect: {result.error}</div>
  return (
    <details className="small mcp-check">
      <summary className="ok-text">
        ✓ Connected{result.serverInfo ? ` to ${result.serverInfo}` : ''} · {result.tools.length} tool{result.tools.length === 1 ? '' : 's'} · {result.ms} ms
      </summary>
      <ul className="mcp-tools">
        {result.tools.map((t) => (
          <li key={t.name}>
            <span className="mono">{t.name}</span> {t.description && <span className="muted">— {t.description}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

function ImportServers({ projectId, onClose, onImport }: { projectId: string; onClose: () => void; onImport: (key: string) => Promise<void> }) {
  const [found, setFound] = useState<McpImportCandidate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    api.mcp.importCandidates(projectId).then(setFound, (e) => setError(errorMessage(e)))
  }, [projectId])
  useEffect(load, [load])

  return (
    <div className="card form">
      <div className="row space">
        <h3>Import from Claude Code</h3>
        <button className="small" onClick={onClose}>Close</button>
      </div>
      <p className="small muted">
        Servers configured for Claude Code itself: this project’s <span className="mono">.mcp.json</span>, and your user and per-project servers
        in <span className="mono">~/.claude.json</span>. Claude’s files are only read. Secret-looking values (tokens, keys, auth headers) are
        moved into Thinkerer’s encrypted storage; values Claude takes from your shell (<span className="mono">{'${VAR}'}</span>) become secrets
        to set after importing. Servers that sign in with OAuth (<span className="mono">claude mcp login</span>) may not authenticate here.
      </p>
      {error && <div className="banner banner-error">{error}</div>}
      {!found ? (
        <p className="muted small">Looking…</p>
      ) : found.length === 0 ? (
        <p className="muted small">No MCP servers found in Claude Code’s configuration.</p>
      ) : (
        <ul className="import-list">
          {found.map((c) => (
            <li key={c.key}>
              <div className="row space">
                <span>
                  <strong>{c.name}</strong> <span className="badge">{c.def.transport === 'http' ? 'HTTP' : c.def.transport === 'sse' ? 'SSE' : 'stdio'}</span>{' '}
                  <span className="small muted">{c.sourceLabel}</span>
                </span>
                <button className="small" disabled={!!c.unsupported} onClick={() => void onImport(c.key).then(load)}>
                  {c.exists ? 'Replace' : 'Import'}
                </button>
              </div>
              <div className="mono small cmd">{c.def.transport === 'http' || c.def.transport === 'sse' ? c.def.url : `${c.def.command} ${c.def.args.join(' ')}`}</div>
              <div className="small muted">
                id <span className="mono">{c.def.id}</span>
                {c.secretsFound.length > 0 && <> · secrets copied: <span className="mono">{c.secretsFound.join(', ')}</span></>}
                {c.secretsMissing.length > 0 && <> · secrets to set: <span className="mono">{c.secretsMissing.join(', ')}</span></>}
                {c.exists && <> · already in the registry</>}
              </div>
              {c.notes.map((n) => (
                <div key={n} className="small muted">{n}</div>
              ))}
              {c.unsupported && <div className="small error-text">{c.unsupported}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean)
const pairs = (text: string, sep: string) => Object.fromEntries(lines(text).filter((l) => l.includes(sep)).map((l) => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + 1).trim()]))

function AddServer({ onCancel, onSave }: { onCancel: () => void; onSave: (def: McpServerView) => void }) {
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [secrets, setSecrets] = useState('')
  const remote = transport !== 'stdio'

  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          id: id.trim(),
          label,
          description,
          builtin: false,
          transport,
          command: remote ? '' : command,
          args: remote ? [] : lines(args),
          env: remote ? {} : pairs(env, '='),
          ...(remote ? { url: url.trim(), headers: pairs(headers, ':') } : {}),
          secretEnv: secrets.split(',').map((s) => s.trim()).filter(Boolean),
          secretsSet: []
        })
      }}
    >
      <h3>Add an MCP server</h3>
      <label>
        Type
        <select value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
          <option value="stdio">Local program (stdio)</option>
          <option value="http">Remote, streamable HTTP</option>
          <option value="sse">Remote, SSE (Claude Code only)</option>
        </select>
      </label>
      <label>Id <input className="mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="my-server" /></label>
      <label>Label <input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label>Description <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      {remote ? (
        <>
          <label>URL <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" /></label>
          <label>
            Headers (Name: value per line; use {'${SECRET}'} for secrets)
            <textarea className="mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder={'Authorization: Bearer ${API_TOKEN}'} />
          </label>
        </>
      ) : (
        <>
          <label>Command <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></label>
          <label>Arguments (one per line)<textarea className="mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} /></label>
          <label>Environment, non-secret (KEY=value per line)<textarea className="mono" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} /></label>
        </>
      )}
      <label>
        Secret names (comma-separated; values are set after saving)
        <input className="mono" value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder="API_TOKEN" />
        <span className="small muted">{remote ? 'Referenced in headers as ${NAME}.' : 'Passed to the server as environment variables.'}</span>
      </label>
      <div className="row">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={!id || !label || (remote ? !url : !command)}>Save server</button>
      </div>
    </form>
  )
}

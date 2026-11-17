import { useCallback, useEffect, useState } from 'react'
import type { EffectiveMcp, McpServerView, Project } from '../../shared/types'
import { api, errorMessage } from '../api'

export function McpTab({ project, onChanged }: { project: Project; onChanged: () => Promise<void> }) {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [effective, setEffective] = useState<EffectiveMcp[]>([])
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
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
        Changes take effect at the next agent run. Your own global CLI MCP configuration is never passed to agents.
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
        {!adding && <button className="small" onClick={() => setAdding(true)}>Add server…</button>}
      </div>
      {adding && <AddServer onCancel={() => setAdding(false)} onSave={(def) => act(async () => { await api.mcp.upsert(def); setAdding(false) })} />}

      <ul className="mcp-list">
        {(servers ?? []).map((s) => (
          <li key={s.id} className="card mcp-server">
            <div className="row space">
              <label className="check">
                <input type="checkbox" checked={enabled.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                <strong>{s.label}</strong> <span className="badge">{s.builtin ? 'built-in' : 'custom'}</span>
                <span className="mono small muted">{s.id}</span>
              </label>
              {!s.builtin && <button className="small link" onClick={() => act(() => api.mcp.remove(s.id))}>Remove</button>}
            </div>
            {s.description && <p className="small muted">{s.description}</p>}
            <div className="mono small cmd">{s.command} {s.args.join(' ')}</div>
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

function AddServer({ onCancel, onSave }: { onCancel: () => void; onSave: (def: McpServerView) => void }) {
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [secrets, setSecrets] = useState('')

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
          command,
          args: args.split('\n').map((a) => a.trim()).filter(Boolean),
          env: Object.fromEntries(
            env
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)])
          ),
          secretEnv: secrets.split(',').map((s) => s.trim()).filter(Boolean),
          secretsSet: []
        })
      }}
    >
      <h3>Add a stdio MCP server</h3>
      <label>Id <input className="mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="my-server" /></label>
      <label>Label <input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label>Description <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>Command <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></label>
      <label>Arguments (one per line)<textarea className="mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} /></label>
      <label>Environment, non-secret (KEY=value per line)<textarea className="mono" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} /></label>
      <label>Secret env var names (comma-separated; values are set after saving)<input className="mono" value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder="API_TOKEN" /></label>
      <div className="row">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={!id || !label || !command}>Save server</button>
      </div>
    </form>
  )
}

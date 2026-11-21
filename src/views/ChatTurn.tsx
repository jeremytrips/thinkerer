import { useState } from 'react'
import type { AgentCapabilities, AppInfo, RunEvent, RunRecord, RunStatus } from '../../shared/types'
import { api } from '../api'
import { ArtifactGallery, SentAttachments } from './RunMedia'
import { ChangeList } from './Changes'
import { Markdown } from './Markdown'
import { RestartButton } from './RestartButton'
import { Elapsed, EventLine, StatusPill, UsageView } from './RunBits'

export const LIVE: RunStatus[] = ['queued', 'running', 'awaiting-approval']
// Paths in Thinkerer's own repo that only take effect after a main-process restart.
const NEEDS_RESTART = /^(electron|engine|shared|mcp)\/|^package\.json$|^electron\.vite\.config\.ts$/

interface Props {
  turn: RunRecord
  projectId: string
  root: string
  /** Only the chat's latest turn offers retry and the restart/hot-reload notes. */
  isLast: boolean
  anyLive: boolean
  info: AppInfo | null
  isSelf: boolean
  taskTitle: string | null
  onRestore: (turn: RunRecord) => void
  onRetry: (turn: RunRecord) => void
  onCancel: (runId: string) => void
}

/** Supervisor bookkeeping (provider, checkpoint, process output) that belongs in the turn's details, not the conversation. */
const isDetail = (e: RunEvent) => (e.kind === 'status' && !e.meta?.notice) || e.kind === 'log' || e.kind === 'stderr' || e.kind === 'result'

/** One message from the user and everything the agent did for it. */
export function ChatTurn({ turn, projectId, root, isLast, anyLive, info, isSelf, taskTitle, onRestore, onRetry, onCancel }: Props) {
  const [showChanges, setShowChanges] = useState(false)
  const [retryAsk, setRetryAsk] = useState(false)
  const live = LIVE.includes(turn.status)
  const changes = turn.changes
  const conversation = turn.events.filter((e) => !isDetail(e))
  const details = turn.events.filter(isDetail)
  // Claude repeats its last message as the result; Codex's result is its last message. Show it only if it's new.
  const summary = turn.resultText?.trim() && !conversation.some((e) => e.kind === 'text' && e.text.trim() === turn.resultText!.trim()) ? turn.resultText : null
  const needsRestart = isSelf && changes?.some((c) => NEEDS_RESTART.test(c.path))
  const rendererChanged = isSelf && changes?.some((c) => c.path.startsWith('src/'))

  return (
    <article className="turn" aria-label={`Message: ${turn.prompt.slice(0, 80)}`}>
      <div className="bubble-user">
        {turn.mode === 'plan' && <span className="badge mode-badge" title="Read-only: the agent proposes a plan">Plan</span>}
        {turn.prompt}
        {(turn.attachments?.length ?? 0) > 0 && <SentAttachments runId={turn.id} attachments={turn.attachments!} />}
      </div>

      <div className="agent-reply">
        {conversation.map((e, i) =>
          e.kind === 'text' ? <Markdown key={i} text={root ? e.text.split(root + '/').join('') : e.text} /> : <EventLine key={i} event={e} root={root} />
        )}
        {summary && <Markdown text={summary} />}
        {turn.artifacts.length > 0 && <ArtifactGallery runId={turn.id} artifacts={turn.artifacts} />}

        {live ? (
          <div className="working">
            <span className="spinner" aria-hidden />
            <span className="ellipsis mono">{turn.currentAction ?? (turn.status === 'queued' ? 'Saving a checkpoint…' : 'Thinking…')}</span>
            {turn.startedAt && (
              <span className="muted small">
                <Elapsed startedAt={turn.startedAt} endedAt={turn.endedAt} />
              </span>
            )}
            <button type="button" className="small push-right" onClick={() => onCancel(turn.id)}>
              Stop
            </button>
          </div>
        ) : (
          <>
            {turn.error && <div className="ev ev-error">{turn.error}</div>}
            {turn.permissionDenials.length > 0 && (
              <details className="ev ev-result is-error">
                <summary>{turn.permissionDenials.length} action{turn.permissionDenials.length === 1 ? '' : 's'} denied by policy</summary>
                <ul className="mono small">
                  {turn.permissionDenials.map((d, i) => <li key={i}>{d.tool}: {d.input}</li>)}
                </ul>
              </details>
            )}
            <div className="turn-foot small">
              <StatusPill status={turn.status} />
              <span className="muted">
                <Elapsed startedAt={turn.startedAt} endedAt={turn.endedAt} />
              </span>
              {changes === null ? (
                <span className="muted">changes not recorded</span>
              ) : changes.length === 0 ? (
                <span className="muted">no files changed</span>
              ) : (
                <button type="button" className="link small" aria-expanded={showChanges} onClick={() => setShowChanges((v) => !v)}>
                  {changes.length} file{changes.length === 1 ? '' : 's'} changed {showChanges ? '▾' : '▸'}
                </button>
              )}
              {turn.checkpoint && (
                <button
                  type="button"
                  className="link small"
                  onClick={() => onRestore(turn)}
                  disabled={anyLive}
                  title={anyLive ? 'Stop or wait for the running chats first' : 'Put the folder back to how it was before this message'}
                >
                  Restore checkpoint…
                </button>
              )}
              {isLast && (turn.status === 'failed' || turn.status === 'cancelled') && !retryAsk && (
                <button type="button" className="link small" onClick={() => (changes?.length ? setRetryAsk(true) : onRetry(turn))}>
                  Retry
                </button>
              )}
            </div>
            {showChanges && changes && changes.length > 0 && (
              <div className="turn-changes">
                {(turn.concurrentRunIds?.length ?? 0) > 0 && (
                  <div className="banner banner-info small">
                    Ran alongside {turn.concurrentRunIds!.length} other chat{turn.concurrentRunIds!.length === 1 ? '' : 's'} in this folder, so
                    this list and its checkpoint may include their edits too.
                  </div>
                )}
                <ChangeList changes={changes} loadDiff={(path) => api.git.runDiff(projectId, turn.id, path)} />
              </div>
            )}
            {retryAsk && (
              <div className="banner banner-info">
                <p>
                  This message already changed {changes!.length} file{changes!.length === 1 ? '' : 's'}. Retrying won’t undo them.
                </p>
                <div className="row">
                  <button className="small" onClick={() => setRetryAsk(false)}>Cancel</button>
                  <button className="small" onClick={() => onRestore(turn)} disabled={anyLive}>Restore checkpoint first…</button>
                  <button className="small primary" onClick={() => (setRetryAsk(false), onRetry(turn))}>Retry on top</button>
                </div>
              </div>
            )}
            {isLast && needsRestart && (
              <div className="banner banner-info row space">
                <span>This changed Electron main/preload/engine code. Restart Thinkerer to load it.</span>
                <RestartButton info={info} label="Restart now" />
              </div>
            )}
            {isLast && rendererChanged && !needsRestart && <div className="banner banner-info small">UI changes were hot-reloaded into this window.</div>}
          </>
        )}

        <details className="turn-details small">
          <summary>Details</summary>
          <div className="run-meta">
            <span>{turn.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
            {turn.exitCode !== null && <span className="muted">· exit {turn.exitCode}</span>}
            <span className="muted">·</span>
            <UsageView usage={turn.usage} />
          </div>
          <div className="muted">
            {turn.selection.rationale}
            {taskTitle && <> · task: {taskTitle}</>}
          </div>
          {turn.capabilities && <SessionInfo caps={turn.capabilities} />}
          <div className="events">
            {details.filter((e) => e.kind !== 'result').map((e, i) => <EventLine key={i} event={e} root={root} />)}
          </div>
        </details>
      </div>
    </article>
  )
}

/** What the agent CLI reported for this session: model, tools, MCP connections, commands, subagents. */
function SessionInfo({ caps }: { caps: AgentCapabilities }) {
  const rows: [string, React.ReactNode][] = [
    ['Model', <span className="mono">{caps.model ?? 'unknown'}{caps.version ? ` · Claude Code ${caps.version}` : ''}{caps.permissionMode ? ` · ${caps.permissionMode} mode` : ''}</span>],
    ['Tools', <span className="mono">{caps.tools.join(', ') || 'none'}</span>],
    [
      'MCP',
      caps.mcpServers.length ? (
        <span>
          {caps.mcpServers.map((m, i) => (
            <span key={m.name} className={m.status === 'connected' ? 'ok-text' : 'error-text'}>
              {i > 0 && ', '}
              {m.name} {m.status === 'connected' ? '✓' : `✗ ${m.status}`}
            </span>
          ))}
        </span>
      ) : (
        <span className="muted">none</span>
      )
    ],
    ['Subagents', (caps.tools.includes('Task') || caps.tools.includes('Agent')) ? <span className="mono">{caps.agents.join(', ') || 'none'}</span> : <span className="muted">off (enable in Settings → Claude Code)</span>],
    ['Skills', caps.tools.includes('Skill') || caps.skills.length ? <span className="mono">{caps.skills.join(', ') || 'none'}</span> : <span className="muted">none</span>],
    ['Commands', <span className="mono">{caps.commands.map((c) => `/${c}`).join(' ') || 'none'}</span>]
  ]
  return (
    <dl className="session-info" aria-label="Agent session">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="muted">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { EffectiveMcp, PreviewCapture, ProviderChoice, ProviderId, ProviderStatus, RunMode, Task } from '../../shared/types'
import { SlashMenu, commandOf, type SlashItem } from './ChatBits'
import type { TabId } from './ProjectView'
import { providerState } from './ProviderList'

// The Agent tab's message box: attachments, slash menu, and the options for the
// next message (provider and task for a new chat, mode, MCP tools).

type McpServers = EffectiveMcp['servers']

interface Props {
  composerRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  setDraft: (text: string) => void
  onSubmit: () => void
  attachments: PreviewCapture[]
  onDetach: (capture: PreviewCapture) => void
  menu: SlashItem[]
  menuIndex: number
  setMenuIndex: Dispatch<SetStateAction<number>>
  onPick: (item: SlashItem) => void
  /** The open chat, or null for a new one. */
  chat: { provider: ProviderId; live: boolean } | null
  chatTask: string | null
  /** The chat's worktree was removed; nothing more can be sent. */
  finished: boolean
  /** Agents need Git; false while the folder isn't a repository. */
  noGit: boolean
  starting: boolean
  liveTurnId: string | null
  onStop: (runId: string) => void
  mode: RunMode
  setMode: (mode: RunMode) => void
  /** The new chat will follow the software protocol (only offered for a new chat). */
  useProtocol: boolean
  setUseProtocol: (on: boolean) => void
  /** The open chat follows the protocol, or the new one will: its stage decides how a message runs. */
  protocolChat: boolean
  /** The next message runs read-only (plan mode, or the protocol's plan stage). */
  planning: boolean
  providers: ProviderStatus[] | null
  choice: ProviderChoice
  setChoice: (choice: ProviderChoice) => void
  tasks: Task[]
  taskId: string
  setTaskId: (id: string) => void
  includedTools: McpServers
  excludedTools: McpServers
  onTab: (tab: TabId) => void
}

export function AgentComposer(p: Props) {
  const { draft, setDraft, menu, menuIndex, chat, finished, attachments } = p
  const active = menu[Math.min(menuIndex, menu.length - 1)]
  const placeholder = finished
    ? 'This chat is finished and its worktree was removed. Start a new chat to keep going.'
    : chat?.live
      ? 'Queue a follow-up for when the agent finishes…'
      : chat
        ? 'Reply to the agent, or type / for commands…'
        : attachments.length
          ? 'Describe what to change on this page…'
          : 'Describe a change, e.g. “Add a visible About dialog, and test that it opens.”'

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        p.onSubmit()
      }}
    >
      {attachments.length > 0 && (
        <ul className="composer-attachments" aria-label="Screenshots to send">
          {attachments.map((a) => (
            <li key={a.id} className="attachment-chip" title={[a.device ?? a.url, ...a.consoleErrors].filter(Boolean).join('\n')}>
              <img src={a.dataUrl} alt={a.device ? `Screenshot of ${a.device}` : `Preview screenshot of ${a.url ?? 'the site'}`} />
              <span className="small ellipsis">
                {a.device ? a.device.replace(/ \[.*\]$/, '') : a.url ? new URL(a.url).pathname : 'Preview'}
                {a.consoleErrors.length > 0 && <span className="error-text"> · {a.consoleErrors.length} console error{a.consoleErrors.length === 1 ? '' : 's'}</span>}
              </span>
              <button type="button" className="chat-tab-close" onClick={() => p.onDetach(a)} aria-label="Remove screenshot" title="Remove screenshot">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <SlashMenu items={menu} active={Math.min(menuIndex, menu.length - 1)} onPick={p.onPick} />
      <div className="composer-box">
        <textarea
          ref={p.composerRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            p.setMenuIndex(0)
          }}
          onKeyDown={(e) => {
            if (menu.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              p.setMenuIndex((i) => (Math.min(i, menu.length - 1) + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length)
              return
            }
            if (menu.length && e.key === 'Tab') {
              e.preventDefault()
              setDraft(active.kind === 'agent' ? `/${active.name} ` : `/${active.name}`)
              return
            }
            // Enter sends; Shift+Enter is a new line. Not while an IME is composing.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // An agent command typed out in full is sent as it is; a partial one is completed first.
              if (menu.length && !commandOf(draft) && (active.kind === 'thinkerer' || draft.trim() !== `/${active.name}`)) return p.onPick(active)
              p.onSubmit()
            }
          }}
          placeholder={placeholder}
          disabled={p.noGit || finished}
          rows={2}
          aria-label="Message to the agent"
        />
        <div className="composer-actions">
          {p.liveTurnId && (
            <button type="button" className="small danger" onClick={() => p.onStop(p.liveTurnId!)}>
              Stop
            </button>
          )}
          <button type="submit" className="primary small" disabled={!draft.trim() || p.starting || p.noGit || finished}>
            {p.starting ? 'Sending…' : commandOf(draft) ? 'Run' : chat?.live ? 'Queue' : p.planning ? 'Plan' : 'Send'}
          </button>
        </div>
      </div>
      <div className="row small composer-foot">
        {chat ? (
          <span className="muted">
            {chat.provider === 'claude' ? 'Claude Code' : 'Codex'}
            {p.chatTask && <> · task: {p.chatTask}</>}
          </span>
        ) : (
          <>
            <label className="inline">
              Provider
              <select value={p.choice} onChange={(e) => p.setChoice(e.target.value as ProviderChoice)}>
                <option value="auto">Auto</option>
                {(p.providers ?? []).map((s) => (
                  <option key={s.id} value={s.id} disabled={providerState(s).tone === 'off'}>
                    {s.label} {providerState(s).tone === 'ok' ? '' : `(${providerState(s).label.toLowerCase()})`}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Task
              <select value={p.taskId} onChange={(e) => p.setTaskId(e.target.value)}>
                <option value="">None</option>
                {p.tasks.filter((t) => t.status !== 'done').map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {!chat && (
          <label className="inline" title="Plan, then implement with tests, then an independent review, then ship. Thinkerer runs the checks and the merge itself.">
            <input type="checkbox" checked={p.useProtocol} onChange={(e) => p.setUseProtocol(e.target.checked)} />
            Software protocol
          </label>
        )}
        {!p.protocolChat && (
          <label className="inline" title="Plan: the agent only investigates (read-only) and proposes a plan; reply to carry it out">
            Mode
            <select value={p.mode} onChange={(e) => p.setMode(e.target.value as RunMode)} aria-label="Mode for the next message" disabled={finished}>
              <option value="auto">Make changes</option>
              <option value="plan">Plan only (read-only)</option>
            </select>
          </label>
        )}
        <button type="button" className="link small" onClick={() => p.onTab('mcp')} title="Tools this provider will receive">
          MCP tools: {p.includedTools.length ? p.includedTools.map((s) => s.id).join(', ') : 'none'}
          {p.excludedTools.length > 0 && ` (${p.excludedTools.length} unavailable)`}
        </button>
        <span className="muted push-right">Enter to send · Shift+Enter for a new line</span>
      </div>
    </form>
  )
}

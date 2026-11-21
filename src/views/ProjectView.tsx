import { useEffect, useRef, useState } from 'react'
import type { AppInfo, Project } from '../../shared/types'
import { AgentTab, type AgentPrefill } from './AgentTab'
import { PaletteButton } from './CommandPalette'
import { FilesTab } from './FilesTab'
import { McpTab } from './McpTab'
import { Overview } from './Overview'
import { Placeholder } from './Placeholder'
import { RestartButton } from './RestartButton'
import { SettingsTab } from './SettingsTab'
import { TasksTab } from './TasksTab'
import { taskPrompt } from './boardModel'
import { WebsiteTab } from './WebsiteTab'

export type TabId = 'overview' | 'agent' | 'website' | 'tasks' | 'files' | 'mcp' | 'marketing' | 'settings'

export const TABS: { id: TabId; label: string; later?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'agent', label: 'Agent' },
  { id: 'website', label: 'Website' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'files', label: 'Files' },
  { id: 'mcp', label: 'MCP' },
  { id: 'marketing', label: 'Marketing', later: true },
  { id: 'settings', label: 'Settings' }
]

interface Props {
  project: Project
  info: AppInfo | null
  tab: TabId
  onTab: (tab: TabId) => void
  onBack: () => void
  onChanged: () => Promise<void>
  /** Changes when the command palette asks for a new chat (0: never). */
  newChat: number
  onPalette: () => void
}

export function ProjectView({ project, info, tab, onTab, onBack, onChanged, newChat, onPalette }: Props) {
  const isSelf = !!info?.sourceRoot && info.sourceRoot === project.path
  const [prefill, setPrefill] = useState<AgentPrefill | null>(null)
  // Only a request made while this view is shown counts, not one left over from before it mounted.
  const seenNewChat = useRef(newChat)
  useEffect(() => {
    if (newChat === seenNewChat.current) return
    seenNewChat.current = newChat
    setPrefill({ prompt: '', taskId: '', nonce: newChat })
    onTab('agent')
  }, [newChat])
  return (
    <div className="project">
      <nav className="topbar" aria-label="Project">
        <button className="link back" onClick={onBack}>← Projects</button>
        <div className="topbar-project">
          <div className="topbar-name">{project.config?.name}</div>
          <div className="row">
            {project.config?.components.map((c) => <span key={c} className="badge">{c}</span>)}
            <span className="badge">{project.config?.target}</span>
          </div>
        </div>
        <ul className="tabs" role="tablist">
          {TABS.map((t) => (
            <li key={t.id}>
              <button role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => onTab(t.id)}>
                {t.label}
                {t.later && <span className="tab-later">soon</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="topbar-foot">
          <PaletteButton onClick={onPalette} />
          <RestartButton info={info} />
        </div>
      </nav>
      <main className="content" key={project.id}>
        {project.status === 'missing' || !project.config ? (
          <div className="banner banner-error">The folder {project.path} no longer exists.</div>
        ) : tab === 'overview' ? (
          <Overview project={project} isSelf={isSelf} onTab={onTab} />
        ) : tab === 'agent' ? (
          <AgentTab project={project} info={info} isSelf={isSelf} onTab={onTab} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />
        ) : tab === 'files' ? (
          <FilesTab project={project} />
        ) : tab === 'website' ? (
          <WebsiteTab project={project} />
        ) : tab === 'tasks' ? (
          <TasksTab
            project={project}
            onStartChat={(task) => {
              setPrefill({ prompt: taskPrompt(task), taskId: task.id, nonce: Date.now() })
              onTab('agent')
            }}
            onOpenChat={(chatId) => {
              setPrefill({ prompt: '', taskId: '', chatId, nonce: Date.now() })
              onTab('agent')
            }}
          />
        ) : tab === 'mcp' ? (
          <McpTab project={project} onChanged={onChanged} />
        ) : tab === 'settings' ? (
          <SettingsTab project={project} onChanged={onChanged} onRemoved={onBack} />
        ) : (
          <Placeholder tab={tab} />
        )}
      </main>
    </div>
  )
}

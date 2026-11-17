import type { AppInfo, Project } from '../../shared/types'
import { AgentTab } from './AgentTab'
import { FilesTab } from './FilesTab'
import { Overview } from './Overview'
import { Placeholder } from './Placeholder'
import { RestartButton } from './RestartButton'
import { SettingsTab } from './SettingsTab'

export type TabId = 'overview' | 'agent' | 'website' | 'tasks' | 'files' | 'mcp' | 'marketing' | 'settings'

const TABS: { id: TabId; label: string; later?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'agent', label: 'Agent' },
  { id: 'website', label: 'Website', later: true },
  { id: 'tasks', label: 'Tasks', later: true },
  { id: 'files', label: 'Files' },
  { id: 'mcp', label: 'MCP', later: true },
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
}

export function ProjectView({ project, info, tab, onTab, onBack, onChanged }: Props) {
  const isSelf = !!info?.sourceRoot && info.sourceRoot === project.path
  return (
    <div className="project">
      <nav className="sidebar" aria-label="Project">
        <button className="link back" onClick={onBack}>← Projects</button>
        <div className="sidebar-project">
          <div className="sidebar-name">{project.config?.name}</div>
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
        <div className="sidebar-foot">
          <RestartButton info={info} />
        </div>
      </nav>
      <main className="content" key={project.id}>
        {project.status === 'missing' || !project.config ? (
          <div className="banner banner-error">The folder {project.path} no longer exists.</div>
        ) : tab === 'overview' ? (
          <Overview project={project} isSelf={isSelf} onTab={onTab} />
        ) : tab === 'agent' ? (
          <AgentTab project={project} info={info} isSelf={isSelf} />
        ) : tab === 'files' ? (
          <FilesTab project={project} />
        ) : tab === 'settings' ? (
          <SettingsTab project={project} onChanged={onChanged} onRemoved={onBack} />
        ) : (
          <Placeholder tab={tab} />
        )}
      </main>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, Project } from '../shared/types'
import { api, errorMessage, loadState, saveState } from './api'
import { paletteSourceItems } from './palette'
import { appPaletteItems } from './paletteModel'
import { CommandPalette } from './views/CommandPalette'
import { Home } from './views/Home'
import { ProjectView, TABS, type TabId } from './views/ProjectView'

type Route = { view: 'home' } | { view: 'project'; id: string; tab: TabId }

const ROUTE_KEY = 'thinkerer.route'

export function App() {
  const [route, setRoute] = useState<Route>(() => loadState<Route>(ROUTE_KEY, { view: 'home' }))
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  // Bumped by the palette's "New chat"; the project view opens the Agent tab on a new chat.
  const [newChat, setNewChat] = useState(0)

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.projects.list())
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    api.app.info().then(setInfo, () => {})
  }, [refresh])

  useEffect(() => saveState(ROUTE_KEY, route), [route])

  // ⌘K (Ctrl+K off macOS) toggles the palette from anywhere in the window, text fields included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const project = route.view === 'project' ? projects?.find((p) => p.id === route.id) : undefined
  // A remembered project may have been removed since the last session.
  useEffect(() => {
    if (route.view === 'project' && projects && !project) setRoute({ view: 'home' })
  }, [route, projects, project])

  const paletteItems = () => [
    ...appPaletteItems({
      projects: (projects ?? []).map((p) => ({ id: p.id, name: p.config?.name ?? p.path, path: p.path })),
      current: project ? { projectId: project.id, tab: route.view === 'project' ? route.tab : 'overview', hasConfig: !!project.config && project.status !== 'missing' } : null,
      tabs: TABS,
      openProject: (id) => setRoute({ view: 'project', id, tab: 'overview' }),
      openHome: () => setRoute({ view: 'home' }),
      openTab: (tab) => project && setRoute({ view: 'project', id: project.id, tab }),
      newChat: () => setNewChat(Date.now())
    }),
    ...paletteSourceItems()
  ]

  return (
    <div className="app">
      {palette && <CommandPalette items={paletteItems()} onClose={() => setPalette(false)} />}
      {error && (
        <div className="banner banner-error" role="alert">
          {error} <button className="link" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {route.view === 'project' && project ? (
        <ProjectView
          project={project}
          info={info}
          tab={route.tab}
          onTab={(tab) => setRoute({ view: 'project', id: project.id, tab })}
          onBack={() => setRoute({ view: 'home' })}
          onChanged={refresh}
          newChat={newChat}
          onPalette={() => setPalette(true)}
        />
      ) : (
        <Home
          projects={projects}
          info={info}
          onOpen={(id) => setRoute({ view: 'project', id, tab: 'overview' })}
          onChanged={refresh}
          onPalette={() => setPalette(true)}
        />
      )}
    </div>
  )
}

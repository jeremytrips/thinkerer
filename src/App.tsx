import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, Project } from '../shared/types'
import { api, errorMessage, loadState, saveState } from './api'
import { Home } from './views/Home'
import { ProjectView, type TabId } from './views/ProjectView'

type Route = { view: 'home' } | { view: 'project'; id: string; tab: TabId }

const ROUTE_KEY = 'thinkerer.route'

export function App() {
  const [route, setRoute] = useState<Route>(() => loadState<Route>(ROUTE_KEY, { view: 'home' }))
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const project = route.view === 'project' ? projects?.find((p) => p.id === route.id) : undefined
  // A remembered project may have been removed since the last session.
  useEffect(() => {
    if (route.view === 'project' && projects && !project) setRoute({ view: 'home' })
  }, [route, projects, project])

  return (
    <div className="app">
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
        />
      ) : (
        <Home
          projects={projects}
          info={info}
          onOpen={(id) => setRoute({ view: 'project', id, tab: 'overview' })}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

import type { EpicRunService } from '../../engine/epicRuns'
import type { Project, ProviderChoice } from '../../shared/types'
import { str } from './validate'

type Handle = <A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T) => void

const PROVIDERS: ProviderChoice[] = ['auto', 'claude', 'codex']

/** Running an epic task by task: start (or resume), stop, and the current run. */
export function registerEpicRunIpc(deps: {
  handle: Handle
  epicRuns: EpicRunService
  okProject: (id: unknown) => Promise<Project>
  /** The setup hook is approved up front: later chats of the run start without the user at hand. */
  approveSetup: (project: Project) => Promise<void>
  send: (channel: string, ...args: unknown[]) => void
}): void {
  const { handle, epicRuns, okProject, approveSetup, send } = deps

  handle('epicRuns:status', async (id: unknown) => epicRuns.status((await okProject(id)).id))
  handle('epicRuns:start', async (id: unknown, epic: unknown, provider: unknown) => {
    if (!PROVIDERS.includes(provider as ProviderChoice)) throw new Error('Invalid provider')
    const project = await okProject(id)
    const ref = str(epic, 'epic', 100)
    // Refusals first: never ask to approve a command for a run that won't start.
    await epicRuns.check(project.id, ref)
    await approveSetup(project)
    return epicRuns.start(project.id, ref, provider as ProviderChoice)
  })
  handle('epicRuns:stop', async (id: unknown) => epicRuns.stop((await okProject(id)).id))

  epicRuns.on('update', (run) => send('epicRuns:update', run))
}

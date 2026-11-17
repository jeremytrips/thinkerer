import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Task, TaskStatus } from '../shared/types'
import { readJson, writeJson } from './store'

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done']

interface TasksFile {
  schemaVersion: 1
  tasks: Task[]
}

/** Simple per-project board stored in <project>/.thinkerer/tasks.json (spec §6). */
export class TaskStore {
  // Serialize writes per project so concurrent updates can't lose each other.
  private readonly queues = new Map<string, Promise<unknown>>()

  list(projectPath: string): Promise<Task[]> {
    return this.read(projectPath).then((f) => f.tasks)
  }

  async create(projectPath: string, title: string, notes = ''): Promise<Task> {
    const cleanTitle = validTitle(title)
    if (typeof notes !== 'string' || notes.length > 10_000) throw new Error('Invalid notes')
    return this.mutate(projectPath, (f) => {
      const now = new Date().toISOString()
      const task: Task = { id: randomUUID(), title: cleanTitle, notes, status: 'todo', runIds: [], createdAt: now, updatedAt: now }
      f.tasks.push(task)
      return task
    })
  }

  update(projectPath: string, id: string, patch: { title?: string; notes?: string; status?: TaskStatus }): Promise<Task> {
    return this.mutate(projectPath, (f) => {
      const task = f.tasks.find((t) => t.id === id)
      if (!task) throw new Error('Unknown task')
      if (patch.title !== undefined) task.title = validTitle(patch.title)
      if (patch.notes !== undefined) {
        if (typeof patch.notes !== 'string' || patch.notes.length > 10_000) throw new Error('Invalid notes')
        task.notes = patch.notes
      }
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw new Error('Invalid status')
        task.status = patch.status
      }
      task.updatedAt = new Date().toISOString()
      return task
    })
  }

  remove(projectPath: string, id: string): Promise<void> {
    return this.mutate(projectPath, (f) => {
      f.tasks = f.tasks.filter((t) => t.id !== id)
    })
  }

  /** Links a run to a task and moves a to-do task to In progress. */
  attachRun(projectPath: string, id: string, runId: string): Promise<Task> {
    return this.mutate(projectPath, (f) => {
      const task = f.tasks.find((t) => t.id === id)
      if (!task) throw new Error('Unknown task')
      if (!task.runIds.includes(runId)) task.runIds.push(runId)
      if (task.status === 'todo') task.status = 'doing'
      task.updatedAt = new Date().toISOString()
      return task
    })
  }

  private async read(projectPath: string): Promise<TasksFile> {
    const raw = await readJson<Partial<TasksFile>>(file(projectPath)).catch(() => null)
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks.filter(isTask) : []
    return { schemaVersion: 1, tasks }
  }

  private mutate<T>(projectPath: string, fn: (f: TasksFile) => T): Promise<T> {
    const prev = this.queues.get(projectPath) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(async () => {
      const f = await this.read(projectPath)
      const result = fn(f)
      await writeJson(file(projectPath), f)
      return result
    })
    this.queues.set(projectPath, next)
    return next
  }
}

function file(projectPath: string): string {
  return join(projectPath, '.thinkerer', 'tasks.json')
}

function validTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim() || title.length > 300) throw new Error('Task title must be 1–300 characters')
  return title.trim()
}

function isTask(t: unknown): t is Task {
  const x = t as Task
  return !!x && typeof x.id === 'string' && typeof x.title === 'string' && STATUSES.includes(x.status) && Array.isArray(x.runIds)
}

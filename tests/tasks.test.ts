import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from '../engine/tasks'

let dir: string
beforeEach(() => (dir = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-tasks-')))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('TaskStore', () => {
  it('creates, updates, attaches runs and persists to .thinkerer/tasks.json', async () => {
    const store = new TaskStore()
    const t = await store.create(dir, '  Add About dialog  ', 'with a test')
    expect(t).toMatchObject({ title: 'Add About dialog', status: 'todo', runIds: [] })
    const attached = await store.attachRun(dir, t.id, 'run-1')
    expect(attached).toMatchObject({ status: 'doing', runIds: ['run-1'] })
    await store.update(dir, t.id, { status: 'done' })
    const onDisk = JSON.parse(readFileSync(join(dir, '.thinkerer', 'tasks.json'), 'utf8'))
    expect(onDisk.tasks[0]).toMatchObject({ status: 'done', runIds: ['run-1'] })
    expect(await new TaskStore().list(dir)).toHaveLength(1)
    await store.remove(dir, t.id)
    expect(await store.list(dir)).toEqual([])
  })

  it('does not lose concurrent writes', async () => {
    const store = new TaskStore()
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.create(dir, `task ${i}`)))
    expect(await store.list(dir)).toHaveLength(20)
  })

  it('validates input', async () => {
    const store = new TaskStore()
    await expect(store.create(dir, '   ')).rejects.toThrow(/title/)
    const t = await store.create(dir, 'x')
    await expect(store.update(dir, t.id, { status: 'blocked' as never })).rejects.toThrow(/status/)
    await expect(store.update(dir, 'missing', { title: 'y' })).rejects.toThrow(/Unknown/)
  })
})

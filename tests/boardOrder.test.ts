import { describe, expect, it } from 'vitest'
import { epicProgress, epicTaskPrompt, nextReadyTask, openEpicTasks, outsideBlockers } from '../shared/boardOrder'
import type { Board, Epic, Task } from '../shared/types'

// Which task an epic run starts next: plan order, skipping done and archived tasks, never a blocked one.

const base = { createdAt: '', updatedAt: '', archivedAt: null as string | null }
const epic = (id: string, extra: Partial<Epic> = {}): Epic => ({ ...base, kind: 'epic', id, key: id.toUpperCase(), title: `Epic ${id}`, position: 0, description: '', type: 'software', milestoneId: null, status: 'todo', criteria: [], ...extra })
let pos = 0
const task = (id: string, epicId: string | null, extra: Partial<Task> = {}): Task => ({
  ...base,
  kind: 'task',
  id,
  key: id.toUpperCase(),
  title: `Task ${id}`,
  position: pos++,
  notes: '',
  type: 'software',
  epicId,
  status: 'todo',
  priority: 'none',
  labels: [],
  criteria: [],
  blockedBy: [],
  chatIds: [],
  runIds: [],
  doneAt: null,
  ...extra
})
const board = (tasks: Task[], epics: Epic[] = [epic('e1'), epic('e2')]): Board => ({ milestones: [], epics, tasks })

describe('epic run order', () => {
  it('takes the open tasks in plan order, skipping done, archived and other epics’ tasks', () => {
    const b = board([
      task('t3', 'e1', { position: 30 }),
      task('t1', 'e1', { position: 10, status: 'done' }),
      task('t2', 'e1', { position: 20, archivedAt: '2026-01-01' }),
      task('t4', 'e1', { position: 25, status: 'doing' }),
      task('t5', 'e2', { position: 1 }),
      task('t6', null, { position: 2 })
    ])
    expect(openEpicTasks(b, 'e1').map((t) => t.id)).toEqual(['t4', 't3'])
    expect(nextReadyTask(b, 'e1')?.id).toBe('t4')
    // Archived tasks don't count towards progress.
    expect(epicProgress(b, 'e1')).toEqual({ done: 1, total: 3 })
  })

  it('waits for a blocker inside the epic, and starts the task once it is done', () => {
    const first = task('a', 'e1', { position: 2 })
    const second = task('b', 'e1', { position: 1, blockedBy: ['a'] })
    expect(nextReadyTask(board([first, second]), 'e1')?.id).toBe('a')
    expect(nextReadyTask(board([{ ...first, status: 'done' }, second]), 'e1')?.id).toBe('b')
    expect(outsideBlockers(board([first, second]), 'e1')).toEqual([])
  })

  it('has nothing ready when every open task waits on a task outside the epic, and names it', () => {
    const outside = task('x', 'e2')
    const b = board([outside, task('a', 'e1', { blockedBy: ['x'] }), task('b', 'e1', { blockedBy: ['a'] })])
    expect(nextReadyTask(b, 'e1')).toBeNull()
    expect(outsideBlockers(b, 'e1').map((t) => t.key)).toEqual(['X'])
    // An archived blocker no longer holds anything up.
    expect(nextReadyTask(board([{ ...outside, archivedAt: 'now' }, task('a', 'e1', { blockedBy: ['x'] })]), 'e1')?.id).toBe('a')
  })

  it('has nothing for an empty epic', () => {
    const b = board([task('t', 'e2')])
    expect(openEpicTasks(b, 'e1')).toEqual([])
    expect(nextReadyTask(b, 'e1')).toBeNull()
    expect(epicProgress(b, 'e1')).toEqual({ done: 0, total: 0 })
  })

  it('tells the agent which epic the task belongs to', () => {
    const p = epicTaskPrompt(epic('e1'), task('t', 'e1', { notes: 'Some notes', criteria: [{ text: 'It works', done: false }] }))
    expect(p).toMatch(/^T: Task t\n\nSome notes\n\nDone when:\n- \[ \] It works\n\nPart of epic E1: Epic e1\. /)
  })
})

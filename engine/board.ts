import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { boardFile, openBoard, v1TasksFile, type BoardDb, type ChatEvent } from '../mcp/board/store.mjs'
import type { Board, BoardCreate, BoardHistoryEntry, BoardItem, BoardKind, BoardPatch, ChatRecord, Task } from '../shared/types'
import type { ChatStore } from './chats'

export interface BoardEvents {
  /** The board of this project changed (in the app, or by an agent through the MCP server). */
  change: [projectPath: string]
}

/**
 * The project boards for the app (storage: mcp/board/store.mjs). One connection per
 * project, always at the main project folder, never a chat worktree, so the app and
 * every chat's agent share one board. Writes made by the thinkerer-board MCP server
 * (another process) are noticed by polling SQLite's data_version, and re-emitted.
 * Reading never creates a board: a project gets its database on its first write.
 */
export class BoardService extends EventEmitter<BoardEvents> {
  private readonly open = new Map<string, { db: BoardDb; version: number }>()
  /** Projects read while they had no board: an agent's first write creates one, which is announced. */
  private readonly waiting = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  /** Chat updates are applied one at a time, in order. */
  private following: Promise<void> = Promise.resolve()

  constructor(private readonly pollMs = 1000) {
    super()
  }

  board(projectPath: string): Board {
    return this.existing(projectPath)?.board() ?? { milestones: [], epics: [], tasks: [] }
  }

  history(projectPath: string, ref: string): BoardHistoryEntry[] {
    return this.existing(projectPath)?.history(ref) ?? []
  }

  create(projectPath: string, input: BoardCreate): BoardItem {
    return this.write(projectPath, (db) => db.create(input, 'user'))
  }

  update(projectPath: string, ref: string, patch: BoardPatch): BoardItem {
    return this.write(projectPath, (db) => db.update(ref, patch, 'user'))
  }

  archive(projectPath: string, ref: string): BoardItem {
    return this.write(projectPath, (db) => db.archive(ref, 'user'))
  }

  unarchive(projectPath: string, ref: string): BoardItem {
    return this.write(projectPath, (db) => db.unarchive(ref, 'user'))
  }

  remove(projectPath: string, ref: string): true {
    return this.write(projectPath, (db) => db.remove(ref))
  }

  reorder(projectPath: string, kind: BoardKind, ids: string[]): true {
    return this.write(projectPath, (db) => db.reorder(kind, ids))
  }

  /** A change and the new order of its kind, saved together (a drag in the Tasks tab). */
  move(projectPath: string, ref: string, patch: BoardPatch, ids: string[]): BoardItem {
    return this.write(projectPath, (db) => db.move(ref, patch, ids, 'user'))
  }

  /**
   * A chat turn started on a task: links the chat and run, and moves a to-do task to
   * In progress. Never throws: a removed task must not fail the agent run.
   */
  runStarted(projectPath: string, taskId: string, chatId: string, runId: string): Task | null {
    try {
      const db = this.existing(projectPath)
      if (!db) return null
      const { task, changed } = db.chatEvent(taskId, 'run', { chatId, runId })
      if (changed) this.changed(projectPath)
      return task
    } catch {
      return null
    }
  }

  /** Moves the tasks of a chat along as the chat goes to review, is merged or shipped, or is discarded. */
  followChats(chats: ChatStore, projectPathOf: (projectId: string) => Promise<string | null>): void {
    chats.on('update', (chat) => {
      this.following = this.following.then(() => this.chatUpdated(chat, chats, projectPathOf)).catch(() => {})
    })
  }

  /** Resolves once tasks have caught up with the chat updates seen so far. */
  settled(): Promise<void> {
    return this.following
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const { db } of this.open.values()) db.close()
    this.open.clear()
    this.waiting.clear()
  }

  private async chatUpdated(chat: ChatRecord, chats: ChatStore, projectPathOf: (projectId: string) => Promise<string | null>): Promise<void> {
    const event = chatEventOf(chat)
    if (!event) return
    const path = await projectPathOf(chat.projectId)
    // Never create a board just to follow a chat: without one, no task is linked.
    if (!path || !existsSync(boardFile(path))) return
    const db = this.db(path)
    const taskIds = db.tasksOfChat(chat.id)
    let changed = false
    for (const id of taskIds) {
      let otherActive = false
      if (event === 'discarded') {
        const others = (db.get(id) as Task | null)?.chatIds.filter((c) => c !== chat.id) ?? []
        for (const c of others) {
          const state = (await chats.get(c))?.state
          if (state === 'active' || state === 'setting-up') otherActive = true
        }
      }
      if (db.chatEvent(id, event, { chatId: chat.id, otherActive }).changed) changed = true
    }
    // Chats are updated often; only a real change should make every open view reload the board.
    if (changed) this.changed(path)
  }

  /** The project's board if it has one (or an old tasks.json to import), else null, never creating one. */
  private existing(projectPath: string): BoardDb | null {
    if (this.open.has(projectPath) || existsSync(boardFile(projectPath)) || existsSync(v1TasksFile(projectPath))) {
      this.waiting.delete(projectPath)
      return this.db(projectPath)
    }
    this.waiting.add(projectPath)
    this.startPolling()
    return null
  }

  private db(projectPath: string): BoardDb {
    this.waiting.delete(projectPath)
    let entry = this.open.get(projectPath)
    if (!entry) {
      const db = openBoard(projectPath)
      entry = { db, version: db.dataVersion() }
      this.open.set(projectPath, entry)
    }
    this.startPolling()
    return entry.db
  }

  private startPolling(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), this.pollMs)
    this.timer.unref()
  }

  private write<T>(projectPath: string, fn: (db: BoardDb) => T): T {
    const result = fn(this.db(projectPath))
    this.changed(projectPath)
    return result
  }

  private changed(projectPath: string): void {
    const entry = this.open.get(projectPath)
    if (entry) entry.version = entry.db.dataVersion()
    this.notify(projectPath)
  }

  /**
   * Listeners can fail (sending to a window that was closed): that must neither fail a write
   * that was saved nor be taken for a broken database.
   */
  private notify(projectPath: string): void {
    // One by one: emit() would stop at the first listener that throws.
    for (const listener of this.listeners('change')) {
      try {
        listener(projectPath)
      } catch {
        // The listener's problem; the board is fine.
      }
    }
  }

  private poll(): void {
    for (const path of this.waiting) {
      if (!existsSync(boardFile(path))) continue
      this.waiting.delete(path)
      this.notify(path)
    }
    for (const [path, entry] of this.open) {
      let version: number
      try {
        version = entry.db.dataVersion()
      } catch {
        // The folder may be gone (project moved); its board reopens on next use.
        this.open.delete(path)
        try {
          entry.db.close()
        } catch {
          // Already unusable.
        }
        continue
      }
      if (version === entry.version) continue
      entry.version = version
      this.notify(path)
    }
  }
}

/** What a chat's current state means for its task, if anything. */
export function chatEventOf(chat: ChatRecord): ChatEvent | null {
  if (chat.doneReason === 'discarded') return 'discarded'
  // Only a real merge or ship. /cleanup also finishes chats that never committed anything, and a
  // chat that did merge already applied 'merged' when its state became 'merged'.
  if (chat.state === 'merged' || chat.protocol?.stage === 'shipped') return 'merged'
  if (chat.protocol?.stage === 'review') return 'review'
  return null
}

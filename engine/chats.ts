import { EventEmitter } from 'node:events'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatNote, ChatRecord, RunSummary } from '../shared/types'
import { readJson, writeJson } from './store'
import { branchExists, commitsAhead, isMerged } from './worktrees'

const CHAT_ID = /^[0-9a-f-]{36}$/
const MAX_NOTES = 200
const MAX_NOTE_LINES = 400

export interface ChatStoreEvents {
  update: [chat: ChatRecord]
}

/** Chat records at <appData>/chats/<chatId>.json. A chat's id is its first turn's run id. */
export class ChatStore extends EventEmitter<ChatStoreEvents> {
  private readonly dir: string
  /** Serializes writes per chat so concurrent updates don't drop each other's changes. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(appDataDir: string) {
    super()
    this.dir = join(appDataDir, 'chats')
  }

  async get(chatId: string): Promise<ChatRecord | null> {
    if (!CHAT_ID.test(chatId)) return null
    return readJson<ChatRecord>(join(this.dir, `${chatId}.json`)).catch(() => null)
  }

  async require(projectId: string, chatId: string): Promise<ChatRecord> {
    const chat = await this.get(chatId)
    if (!chat || chat.projectId !== projectId) throw new Error('Chat not found')
    return chat
  }

  async create(chat: ChatRecord): Promise<ChatRecord> {
    await this.write(chat)
    return chat
  }

  /** Applies `fn` to the latest stored record and saves it. */
  update(chatId: string, fn: (chat: ChatRecord) => void): Promise<ChatRecord> {
    const prev = this.locks.get(chatId) ?? Promise.resolve()
    const next = prev.then(async () => {
      const chat = await this.get(chatId)
      if (!chat) throw new Error('Chat not found')
      fn(chat)
      chat.updatedAt = new Date().toISOString()
      await this.write(chat)
      return chat
    })
    this.locks.set(chatId, next.catch(() => {}))
    return next
  }

  addNote(chatId: string, note: Omit<ChatNote, 'at'>): Promise<ChatRecord> {
    return this.update(chatId, (c) => {
      c.notes = [...c.notes, { at: new Date().toISOString(), ...note, lines: note.lines.slice(-MAX_NOTE_LINES) }].slice(-MAX_NOTES)
    })
  }

  /**
   * The project's chats, newest activity first. Runs from before chat records
   * existed show up as finished chats in the project folder. An active chat
   * whose branch has landed on its base becomes 'merged' (and back, if it gains
   * new commits).
   */
  async list(projectId: string, runs: RunSummary[], isLive: (chatId: string) => boolean): Promise<ChatRecord[]> {
    const stored = new Map<string, ChatRecord>()
    for (const c of await this.all()) if (c.projectId === projectId) stored.set(c.id, c)
    const lastActivity = new Map<string, string>()
    const legacy = new Map<string, RunSummary[]>()
    for (const r of runs) {
      const id = r.chatId ?? r.id
      if ((lastActivity.get(id) ?? '') < r.createdAt) lastActivity.set(id, r.createdAt)
      if (!stored.has(id)) legacy.set(id, [...(legacy.get(id) ?? []), r])
    }
    for (const [id, turns] of legacy) stored.set(id, legacyChat(id, projectId, turns))

    const out: ChatRecord[] = []
    for (const chat of stored.values()) out.push(legacy.has(chat.id) ? chat : await this.refreshMerged(chat, isLive(chat.id)))
    const at = (c: ChatRecord) => [lastActivity.get(c.id) ?? '', c.updatedAt].sort().at(-1)!
    return out.sort((a, b) => at(b).localeCompare(at(a)))
  }

  /** Ports held by chats whose worktree still exists (any project). */
  async takenPorts(): Promise<number[]> {
    return (await this.all()).filter((c) => c.worktree && !c.worktreeRemoved).flatMap((c) => c.ports)
  }

  async refreshMerged(chat: ChatRecord, live: boolean): Promise<ChatRecord> {
    const wt = chat.worktree
    if (!wt || chat.worktreeRemoved || live || (chat.state !== 'active' && chat.state !== 'merged')) return chat
    if (!(await branchExists(wt.path, wt.branch))) return chat
    const landed = (await commitsAhead(wt.path, wt.baseCommit, wt.branch)) > 0 && (await isMerged(wt.path, wt.branch, wt.base))
    const state = landed ? 'merged' : 'active'
    if (state === chat.state) return chat
    const next = await this.update(chat.id, (c) => (c.state = state))
    this.emit('update', next)
    return next
  }

  private async all(): Promise<ChatRecord[]> {
    let files: string[]
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: ChatRecord[] = []
    for (const f of files) {
      const c = await readJson<ChatRecord>(join(this.dir, f)).catch(() => null)
      if (c) out.push(c)
    }
    return out
  }

  private async write(chat: ChatRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeJson(join(this.dir, `${chat.id}.json`), chat)
  }
}

export function newChat(id: string, projectId: string, title: string): ChatRecord {
  const now = new Date().toISOString()
  return {
    id,
    projectId,
    title,
    createdAt: now,
    updatedAt: now,
    state: 'setting-up',
    doneReason: null,
    doneAt: null,
    worktree: null,
    worktreeRemoved: false,
    ports: [],
    composeProject: null,
    notes: []
  }
}

export function chatTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0].trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || 'Chat'
}

/** A chat from before worktrees: its runs worked in the project folder. Listed as done, but it can continue. */
function legacyChat(id: string, projectId: string, turns: RunSummary[]): ChatRecord {
  const sorted = [...turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const chat = newChat(id, projectId, chatTitle(sorted[0].prompt))
  const live = sorted.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'awaiting-approval')
  return { ...chat, createdAt: sorted[0].createdAt, updatedAt: sorted.at(-1)!.createdAt, state: live ? 'active' : 'done' }
}

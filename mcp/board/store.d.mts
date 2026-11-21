// Types for store.mjs (plain JS so the MCP server runs without a build).
import type {
  Board,
  BoardCreate,
  BoardHistoryEntry,
  BoardItem,
  BoardKind,
  BoardPatch,
  BoardSource,
  EpicStatus,
  MilestoneStatus,
  Task,
  TaskPriority,
  TaskStatus,
  WorkType
} from '../../shared/types'

export declare const WORK_TYPES: WorkType[]
export declare const TASK_STATUSES: TaskStatus[]
export declare const EPIC_STATUSES: EpicStatus[]
export declare const MILESTONE_STATUSES: MilestoneStatus[]
export declare const PRIORITIES: TaskPriority[]

export type ChatEvent = 'run' | 'review' | 'merged' | 'discarded'

export declare function boardFile(projectRoot: string): string
export declare function v1TasksFile(projectRoot: string): string
export declare function openBoard(projectRoot: string): BoardDb

export declare class BoardDb {
  constructor(projectRoot: string)
  close(): void
  dataVersion(): number
  board(): Board
  get(ref: string): BoardItem | null
  history(ref: string): BoardHistoryEntry[]
  create(input: BoardCreate, source?: BoardSource): BoardItem
  update(ref: string, patch: BoardPatch, source?: BoardSource): BoardItem
  archive(ref: string, source?: BoardSource): BoardItem
  unarchive(ref: string, source?: BoardSource): BoardItem
  remove(ref: string): true
  reorder(kind: BoardKind, ids: string[]): true
  move(ref: string, patch: BoardPatch, ids: string[], source?: BoardSource): BoardItem
  tasksOfChat(chatId: string): string[]
  chatEvent(
    ref: string,
    event: ChatEvent,
    opts?: { chatId?: string | null; runId?: string | null; otherActive?: boolean }
  ): { task: Task | null; changed: boolean }
}

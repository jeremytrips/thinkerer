import type { ChildProcess } from 'node:child_process'
import type {
  ChatProtocol,
  GitStatus,
  ProviderId,
  ChatRecord,
  ClaudeRunConfig,
  PromptAttachment,
  ProtocolTurnStage,
  RunEvent,
  RunMode,
  RunRecord,
  RunSummary
} from '../../shared/types'
import type { Approvals } from '../approvals'
import type { BoardService } from '../board'
import type { ChatStore } from '../chats'
import type { ChatDevices } from '../chatDevices'
import type { DevServerManager } from '../devserver'
import type { McpRegistry, McpRunContext } from '../mcp'
import type { AgentAdapter, RunPolicy } from './types'

export interface ActiveRun {
  record: RunRecord
  child: ChildProcess | null
  cancelRequested: boolean
  killTimer: NodeJS.Timeout | null
  /** Provider session this turn continues; null for a chat's first turn (or when it can't be resumed). */
  resumeSessionId: string | null
  /** A new chat gets a worktree; false in a repo with no commits (it works in the project folder). */
  wantsWorktree: boolean
  /** Extra system instructions for this turn (e.g. the protocol stage's). */
  instructions: string
  /** Claude options that override the project's for this turn. */
  claude: Partial<ClaudeRunConfig>
}

/** Where a turn runs and what it gets: the chat's worktree, ports and preview, or the project folder. */
export interface Workspace {
  chat: ChatRecord | null
  cwd: string
  env: Record<string, string>
  previewUrl: string | null
}

/** How the extracted helpers report progress on a run, through the supervisor. */
export interface RunReporter {
  addEvent(run: ActiveRun, e: Omit<RunEvent, 'at'>): void
  emitUpdate(record: RunRecord): void
}

export interface SupervisorOptions {
  adapters?: AgentAdapter[]
  policy?: RunPolicy
  /** The project boards: a run on a task links its chat and moves the task along. */
  board?: BoardService
  /** MCP servers come from the registry; without it, runs get none. */
  mcp?: { registry: McpRegistry; context: () => Promise<Omit<McpRunContext, 'artifactsDir'>> }
  chats?: ChatStore
  approvals?: Approvals
  /** Each chat's own emulators; without it, the mobile server is not limited to a chat. */
  devices?: ChatDevices
  /** Starts a turn's preview when it is down; without it, a down preview only changes the instructions. */
  devServers?: Pick<DevServerManager, 'ensureRunning'>
}

export interface StartOptions {
  taskId?: string | null
  /** Preview screenshots already saved in the project (see engine/attachments). */
  attachments?: PromptAttachment[]
  /** Send this as a follow-up in an existing chat. It keeps that chat's provider and task. */
  chatId?: string | null
  /** 'plan' runs this message read-only. */
  mode?: RunMode
  /** Start a new provider session instead of resuming the chat's (e.g. an independent review). */
  freshSession?: boolean
  /** Extra system instructions for this turn only. */
  instructions?: string
  /** Claude options for this turn only (others come from the project). */
  claude?: Partial<ClaudeRunConfig>
  /** Recorded on the turn; review turns are never resumed by later turns. */
  protocolStage?: ProtocolTurnStage
  /** A new chat that follows the software protocol. */
  protocol?: ChatProtocol
}

export interface SupervisorEvents {
  event: [runId: string, event: RunEvent]
  update: [summary: RunSummary]
}

/** A queued run's record: everything later steps fill in starts empty. */
export function newRunRecord(f: {
  id: string
  projectId: string
  projectPath: string
  chatId: string
  prompt: string
  mode: RunMode
  protocolStage?: ProtocolTurnStage
  taskId: string | null
  attachments: PromptAttachment[]
  provider: ProviderId
  selection: RunRecord['selection']
  gitBefore: GitStatus
  concurrentRunIds: string[]
}): RunRecord {
  return {
    id: f.id,
    projectId: f.projectId,
    projectPath: f.projectPath,
    cwd: f.projectPath,
    commit: null,
    chatId: f.chatId,
    sessionId: null,
    prompt: f.prompt,
    mode: f.mode,
    ...(f.protocolStage ? { protocolStage: f.protocolStage } : {}),
    capabilities: null,
    taskId: f.taskId,
    checkpoint: null,
    afterCommit: null,
    changes: null,
    mcpServers: [],
    artifacts: [],
    attachments: f.attachments,
    provider: f.provider,
    selection: f.selection,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    exitCode: null,
    error: null,
    resultText: null,
    currentAction: null,
    usage: null,
    permissionDenials: [],
    gitBefore: f.gitBefore,
    gitAfter: null,
    concurrentRunIds: f.concurrentRunIds,
    events: []
  }
}

/** A chat's turns that later turns continue from: review turns run in their own session and never count. */
export function workingTurns<T extends { protocolStage?: string }>(all: T[]): T[] {
  const working = all.filter((t) => t.protocolStage !== 'review')
  return working.length ? working : all
}

export function summarize(record: RunRecord): RunSummary {
  const { events: _events, ...rest } = record
  return rest
}

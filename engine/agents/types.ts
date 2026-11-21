import type { AgentCapabilities, ClaudeRunConfig, ProviderId, ProviderStatus, RunEvent, RunMode, UsageObservation } from '../../shared/types'
import type { ResolvedMcpServer } from '../mcp'

export interface Invocation {
  command: string
  args: string[]
  /** Prompt is sent on stdin so it can never be parsed as a CLI flag. */
  stdin: string
  env: NodeJS.ProcessEnv
}

export interface ParsedUpdate {
  event?: Omit<RunEvent, 'at'>
  currentAction?: string
  /** The CLI's session/thread id, for resuming the conversation in the next turn. */
  sessionId?: string
  usage?: UsageObservation
  /** What the CLI reported about its session when it started. */
  capabilities?: AgentCapabilities
  result?: { text: string; isError: boolean; denials: { tool: string; input: string }[] }
}

/** Turns one line of the CLI's machine-readable stdout into zero or more updates. */
export interface StreamParser {
  parseLine(line: string): ParsedUpdate[]
}

export interface RunPolicy {
  /** Shell commands the agent may run without approval (CLI-specific pattern syntax). */
  allowedCommands: string[]
  appendSystemPrompt: string
}

export interface InvocationOptions {
  executable: string
  cwd: string
  prompt: string
  /** Continue this provider session (a follow-up in a chat) instead of starting a new one. */
  resumeSessionId?: string | null
  policy: RunPolicy
  /** The project's approved MCP servers — identical for every provider (spec F4). */
  mcp: ResolvedMcpServer[]
  /** Secret values for those servers, passed via the CLI's environment, never argv. */
  secretEnv: Record<string, string>
  /** 'plan' runs read-only. Defaults to 'auto'. */
  mode?: RunMode
  /** The project's Claude Code options (model, effort, extra tools); other adapters ignore them. */
  claude?: ClaudeRunConfig
}

/** Every provider CLI is integrated through this interface (spec F2). */
export interface AgentAdapter {
  id: ProviderId
  label: string
  /** Plain-language description of what this provider's runs may do, shown in the UI. */
  policySummary: string
  /**
   * Slash commands (without the slash) Thinkerer refuses to send, because they would break
   * what Thinkerer tracks: Claude's /clear (and its aliases) drops the chat's session, and with it the task link.
   */
  blockedCommands?: string[]
  detect(): Promise<ProviderStatus>
  buildInvocation(opts: InvocationOptions): Invocation
  createParser(): StreamParser
}

/** The blocked slash command a message starts with (`/clear`, `/clear now`…), or null. */
export function blockedCommand(adapter: Pick<AgentAdapter, 'blockedCommands'>, prompt: string): string | null {
  const name = /^\s*\/([\w:-]+)(?:\s|$)/.exec(prompt)?.[1].toLowerCase()
  return name && adapter.blockedCommands?.includes(name) ? name : null
}

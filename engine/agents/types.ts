import type { ProviderId, ProviderStatus, RunEvent, UsageObservation } from '../../shared/types'

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
  usage?: UsageObservation
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

/** Every provider CLI is integrated through this interface (spec F2). */
export interface AgentAdapter {
  id: ProviderId
  label: string
  /** Plain-language description of what this provider's runs may do, shown in the UI. */
  policySummary: string
  detect(): Promise<ProviderStatus>
  buildInvocation(opts: { executable: string; cwd: string; prompt: string; policy: RunPolicy }): Invocation
  createParser(): StreamParser
}

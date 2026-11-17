import type { ProviderStatus, UsageObservation } from '../../shared/types'
import { childEnv, findExecutable, run } from './detect'
import type { AgentAdapter, ParsedUpdate, StreamParser } from './types'

// File tools the agent gets. `--restricted` confines them to the working
// directory; Bash is re-enabled explicitly and limited by `--allowedTools`.
const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']

export const CLAUDE_POLICY_SUMMARY =
  'Restricted mode: file reads and writes confined to the project folder; shell limited to the approved commands (npm scripts, tsc, vitest, Playwright tests, read-only git) — anything else is denied automatically. No MCP servers; your Claude settings files are not loaded.'

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',
  policySummary: CLAUDE_POLICY_SUMMARY,

  async detect(): Promise<ProviderStatus> {
    const base = { id: 'claude' as const, label: 'Claude Code', adapterAvailable: true, policy: CLAUDE_POLICY_SUMMARY }
    const executable = await findExecutable('claude')
    if (!executable) {
      return { ...base, installed: false, executable: null, version: null, authenticated: null, detail: 'claude CLI not found on PATH' }
    }
    const version = await run(executable, ['--version'])
    const auth = await run(executable, ['auth', 'status'])
    let authenticated: boolean | null = null
    let detail = 'Installed'
    try {
      const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string }
      if (typeof parsed.loggedIn === 'boolean') authenticated = parsed.loggedIn
      detail = parsed.loggedIn ? `Logged in (${parsed.authMethod ?? 'unknown method'})` : 'Not logged in — run `claude` in a terminal and log in'
    } catch {
      detail = 'Installed; login status unavailable'
    }
    return { ...base, installed: true, executable, version: version.code === 0 ? version.stdout.trim() : null, authenticated, detail }
  },

  buildInvocation({ executable, prompt, policy }) {
    return {
      command: executable,
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--restricted',
        '--tools', TOOLS.join(','),
        '--allowedTools', ...policy.allowedCommands.map((c) => `Bash(${c})`),
        '--permission-mode', 'acceptEdits',
        // Nothing can answer a prompt in Phase 0, so anything not allowed is denied.
        '--permission-prompts', 'none',
        // Only Thinkerer-approved MCP servers (none yet) — never the user's global ones.
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
        '--append-system-prompt', `${policy.appendSystemPrompt} Shell commands outside the approved list are denied automatically.`
      ],
      stdin: prompt,
      env: childEnv()
    }
  },

  createParser(): StreamParser {
    return { parseLine: parseClaudeLine }
  }
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean }

export function parseClaudeLine(line: string): ParsedUpdate[] {
  let msg: Record<string, any>
  try {
    msg = JSON.parse(line)
  } catch {
    return line.trim() ? [{ event: { kind: 'log', text: line } }] : []
  }
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        return [{ event: { kind: 'status', text: `Session started · model ${msg.model ?? 'unknown'}`, meta: { model: msg.model ?? null } } }]
      }
      return []
    case 'assistant':
      return ((msg.message?.content ?? []) as Block[]).flatMap((b): ParsedUpdate[] => {
        if (b.type === 'text' && b.text?.trim()) return [{ event: { kind: 'text', text: b.text } }]
        if (b.type === 'tool_use') {
          const summary = summarizeToolInput(b.name ?? 'tool', b.input ?? {})
          return [{ event: { kind: 'tool-use', text: summary, meta: { tool: b.name ?? 'tool' } }, currentAction: summary }]
        }
        return []
      })
    case 'user':
      return ((msg.message?.content ?? []) as Block[])
        .filter((b) => b && b.type === 'tool_result')
        .map((b) => ({ event: { kind: 'tool-result' as const, text: truncate(contentText(b.content), 4000), meta: { isError: !!b.is_error } } }))
    case 'rate_limit_event':
      return [{ usage: rateLimitUsage(msg.rate_limit_info) }]
    case 'result': {
      const u = msg.usage ?? {}
      const usage: UsageObservation = {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheCreationTokens: num(u.cache_creation_input_tokens)
      }
      const denials = Array.isArray(msg.permission_denials)
        ? msg.permission_denials.map((d: any) => ({ tool: String(d.tool_name), input: truncate(JSON.stringify(d.tool_input ?? {}), 500) }))
        : []
      const text = typeof msg.result === 'string' ? msg.result : (msg.subtype ?? 'finished')
      return [{ usage, result: { text, isError: !!msg.is_error, denials }, event: { kind: 'result', text, meta: { isError: !!msg.is_error } } }]
    }
    default:
      return []
  }
}

function rateLimitUsage(info: any): UsageObservation {
  const windows: NonNullable<UsageObservation['windows']> = {}
  for (const [name, w] of Object.entries<any>(info?.unifiedWindows ?? {})) {
    if (typeof w?.utilization === 'number') {
      windows[name] = { utilization: w.utilization, resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null }
    }
  }
  return { windows, rateLimitStatus: typeof info?.status === 'string' ? info.status : undefined }
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.description
  return pick ? `${name}: ${truncate(String(pick), 200)}` : name
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  return ''
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `… [${s.length - max} more chars]` : s
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

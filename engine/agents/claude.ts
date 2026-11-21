import type { AgentCapabilities, ProviderStatus, UsageObservation } from '../../shared/types'
import { childEnv, findExecutable, run } from './detect'
import type { ResolvedMcpServer } from '../mcp'
import type { AgentAdapter, ParsedUpdate, StreamParser } from './types'

// File tools the agent gets. `--restricted` confines them to the working
// directory; Bash is re-enabled explicitly. `--allowedTools` pre-approves the
// policy's commands, and auto mode's classifier decides on anything else.
// Projects can add optional built-ins (subagents, skills, web, notebooks).
const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']

export const CLAUDE_POLICY_SUMMARY =
  'Restricted mode: file reads and writes confined to the project folder; auto mode: the approved commands (npm scripts, tsc, vitest, Playwright tests, read-only git) always run, and the Claude safety classifier approves or denies any other shell command; nothing waits for a prompt. Plan mode messages are read-only. Optional tools (subagents, skills, web search, notebooks) only as enabled in the project’s settings. MCP: only the servers enabled for this project in Thinkerer; your own Claude MCP servers and settings files are not loaded.'

/** Commands that only make sense in Claude's interactive terminal, or that Thinkerer handles itself (model, effort, MCP, /clear would break the chat's session). */
const NOT_IN_CHATS = new Set(['clear', 'config', 'model', 'effort', 'fast', 'mcp', 'agents', 'output-style', 'rename', 'color', 'focus', 'heapdump', 'doctor', 'import', 'reload-plugins', 'reload-skills', 'auto-mode-setup', 'fewer-permission-prompts', 'update-config', 'team-onboarding'])

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

  buildInvocation({ executable, prompt, resumeSessionId, policy, mcp, secretEnv, mode = 'auto', claude }) {
    const tools = [...TOOLS, ...(claude?.tools ?? [])]
    return {
      command: executable,
      args: [
        '-p',
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        '--output-format', 'stream-json',
        '--verbose',
        '--restricted',
        ...(claude?.model ? ['--model', claude.model] : []),
        ...(claude?.effort ? ['--effort', claude.effort] : []),
        '--tools', tools.join(','),
        '--allowedTools', ...policy.allowedCommands.map((c) => `Bash(${c})`), ...mcp.map((s) => `mcp__${s.id}`),
        // Plan mode: read-only investigation; the user's next message carries the plan out.
        '--permission-mode', mode === 'plan' ? 'plan' : 'auto',
        // Nothing can answer a prompt, so anything auto mode would ask about is denied.
        '--permission-prompts', 'none',
        // Only the project's Thinkerer-approved MCP servers — never the user's global ones.
        '--strict-mcp-config', '--mcp-config', JSON.stringify(claudeMcpConfig(mcp)),
        '--append-system-prompt', `${policy.appendSystemPrompt} Shell commands outside the approved list are checked by an automatic classifier and may be denied.`
      ],
      stdin: prompt,
      env: { ...childEnv(), ...secretEnv }
    }
  },

  createParser(): StreamParser {
    return { parseLine: parseClaudeLine }
  }
}

/** Secrets are referenced as ${NAME}; Claude expands them from its own environment (env for stdio, headers for remote servers). */
export function claudeMcpConfig(servers: ResolvedMcpServer[]) {
  return {
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.id,
        s.transport === 'stdio'
          ? {
              type: 'stdio',
              command: s.command,
              args: s.args,
              env: { ...s.env, ...Object.fromEntries(s.secretEnv.map((n) => [n, '${' + n + '}'])) }
            }
          : { type: s.transport, url: s.url, headers: s.headers }
      ])
    )
  }
}

/** The session details from Claude's init event. */
export function claudeCapabilities(msg: Record<string, any>): AgentCapabilities {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const terminalOnly = new Set(strings(msg.terminal_slash_commands))
  return {
    model: typeof msg.model === 'string' ? msg.model : null,
    version: typeof msg.claude_code_version === 'string' ? msg.claude_code_version : null,
    permissionMode: typeof msg.permissionMode === 'string' ? msg.permissionMode : null,
    tools: strings(msg.tools),
    mcpServers: (Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [])
      .filter((m: any) => typeof m?.name === 'string')
      .map((m: any) => ({ name: m.name, status: typeof m.status === 'string' ? m.status : 'unknown' })),
    commands: strings(msg.slash_commands).filter((c) => !terminalOnly.has(c) && !NOT_IN_CHATS.has(c) && !c.startsWith('_')),
    skills: strings(msg.skills),
    agents: strings(msg.agents),
    plugins: (Array.isArray(msg.plugins) ? msg.plugins : []).map((p: any) => (typeof p?.name === 'string' ? p.name : null)).filter(Boolean)
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
        const capabilities = claudeCapabilities(msg)
        const mode = capabilities.permissionMode === 'plan' ? ' · plan mode (read-only)' : ''
        return [
          {
            sessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined,
            capabilities,
            event: { kind: 'status', text: `Session started · model ${msg.model ?? 'unknown'}${mode}`, meta: { model: msg.model ?? null } }
          },
          // A server that didn't connect is easy to miss and explains missing tools, so say so in the conversation.
          ...capabilities.mcpServers
            .filter((m) => m.status !== 'connected')
            .map((m): ParsedUpdate => ({ event: { kind: 'status', text: `MCP server ${m.name} did not connect (${m.status})`, meta: { notice: true } } }))
        ]
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
      const all: any[] = Array.isArray(msg.permission_denials) ? msg.permission_denials : []
      // In plan mode, leaving plan mode needs a person's approval; that is the user's next message, not a policy denial.
      const plans = all.filter((d) => d?.tool_name === 'ExitPlanMode')
      const denials = all
        .filter((d) => d?.tool_name !== 'ExitPlanMode')
        .map((d: any) => ({ tool: String(d.tool_name), input: truncate(JSON.stringify(d.tool_input ?? {}), 500) }))
      const plan = plans.map((d) => d.tool_input?.plan).find((p): p is string => typeof p === 'string' && !!p.trim())
      const text = typeof msg.result === 'string' && msg.result.trim() ? msg.result : (plan ?? msg.subtype ?? 'finished')
      return [
        ...(plan && plan !== text ? [{ event: { kind: 'text' as const, text: plan } }] : []),
        { usage, result: { text, isError: !!msg.is_error, denials }, event: { kind: 'result', text, meta: { isError: !!msg.is_error } } }
      ]
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
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.element ?? input.filename ?? input.key ?? input.text ?? input.description
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

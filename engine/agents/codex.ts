import type { ProviderStatus } from '../../shared/types'
import { childEnv, findExecutable, run } from './detect'
import type { ResolvedMcpServer } from '../mcp'
import type { AgentAdapter, ParsedUpdate, StreamParser } from './types'

// Codex tools that reach beyond the project and Thinkerer's approved tool catalog. ChatGPT connectors ("apps") in particular could reach the user's
// connected accounts.
const DISABLED_FEATURES = ['apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'hooks']

export const CODEX_POLICY_SUMMARY =
  'OS sandbox (workspace-write): writes limited to the project folder and temp directories, no network, no approval escalation. Reads are not confined by the sandbox. MCP: only the servers enabled for this project in Thinkerer. Connectors, plugins, built-in browser/computer use, web search and your ~/.codex config are disabled for runs.'

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  label: 'Codex',
  policySummary: CODEX_POLICY_SUMMARY,

  async detect(): Promise<ProviderStatus> {
    const base = { id: 'codex' as const, label: 'Codex', adapterAvailable: true, policy: CODEX_POLICY_SUMMARY }
    const executable = await findExecutable('codex')
    if (!executable) {
      return { ...base, installed: false, executable: null, version: null, authenticated: null, detail: 'codex CLI not found on PATH' }
    }
    const version = await run(executable, ['--version'])
    const login = await run(executable, ['login', 'status'])
    return {
      ...base,
      installed: true,
      executable,
      version: version.code === 0 ? version.stdout.trim() : null,
      ...parseLoginStatus(login.code, login.stdout + login.stderr)
    }
  },

  buildInvocation({ executable, cwd, prompt, resumeSessionId, policy, mcp, secretEnv }) {
    // `exec resume` has no --cd/--sandbox flags: it runs in the spawn cwd (the project) and takes the sandbox as config.
    const start = resumeSessionId
      ? ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"']
      : ['exec', '--json', '--cd', cwd, '--sandbox', 'workspace-write']
    return {
      command: executable,
      args: [
        ...start,
        '-c', 'approval_policy="never"',
        '-c', 'sandbox_workspace_write.network_access=false',
        '-c', 'web_search="disabled"',
        '-c', `developer_instructions=${JSON.stringify(policy.appendSystemPrompt)}`,
        ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
        ...codexMcpArgs(mcp),
        // Never inherit the user's MCP servers, profiles, or exec-policy rules.
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        ...(resumeSessionId ? [resumeSessionId] : []),
        '-' // read the prompt from stdin
      ],
      stdin: prompt,
      env: { ...childEnv(), ...secretEnv }
    }
  },

  createParser(): StreamParser {
    return createCodexParser()
  }
}

/**
 * MCP servers as `-c mcp_servers.<id>.*` overrides (values are TOML; JSON
 * strings/arrays are valid TOML). Secrets are forwarded by name from Codex's own
 * environment via `env_vars`, and kept out of the agent's shell environment.
 */
export function codexMcpArgs(servers: ResolvedMcpServer[]): string[] {
  const args: string[] = []
  const secrets: string[] = []
  for (const s of servers) {
    const k = `mcp_servers.${s.id}`
    const env = Object.entries(s.env).map(([n, v]) => `${JSON.stringify(n)} = ${JSON.stringify(v)}`).join(', ')
    args.push('-c', `${k}.command=${JSON.stringify(s.command)}`)
    args.push('-c', `${k}.args=${JSON.stringify(s.args)}`)
    args.push('-c', `${k}.env={ ${env} }`)
    if (s.secretEnv.length) args.push('-c', `${k}.env_vars=${JSON.stringify(s.secretEnv)}`)
    // Exec mode can't answer tool approval prompts; these servers are pre-approved by the user.
    args.push('-c', `${k}.default_tools_approval_mode="approve"`)
    secrets.push(...s.secretEnv)
  }
  if (secrets.length) args.push('-c', `shell_environment_policy.exclude=${JSON.stringify([...new Set(secrets)])}`)
  return args
}

export function parseLoginStatus(code: number, output: string): Pick<ProviderStatus, 'authenticated' | 'detail'> {
  const text = output.trim()
  if (/not logged in/i.test(text)) return { authenticated: false, detail: 'Not logged in — run `codex login` in a terminal' }
  if (code === 0 && /logged in/i.test(text)) {
    // Never echo the status line itself: for API-key logins it includes part of the key.
    const method = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : 'unknown method'
    return { authenticated: true, detail: `Logged in (${method})` }
  }
  return { authenticated: null, detail: 'Installed; login status unavailable' }
}

type Item = {
  id?: string
  type?: string
  text?: string
  message?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  changes?: { path?: string; kind?: string }[]
  server?: string
  tool?: string
  query?: string
  error?: { message?: string } | null
  result?: { content?: { type?: string; text?: string }[] } | null
}

const RATE_LIMIT = /rate.?limit|usage limit|quota|429/i

/** Stateful: the final agent message becomes the run's result text. */
export function createCodexParser(): StreamParser {
  let lastMessage: string | null = null
  const denials: { tool: string; input: string }[] = []

  return {
    parseLine(line: string): ParsedUpdate[] {
      let msg: Record<string, any>
      try {
        msg = JSON.parse(line)
      } catch {
        return line.trim() ? [{ event: { kind: 'log', text: line } }] : []
      }
      switch (msg.type) {
        case 'thread.started':
          return [
            {
              sessionId: typeof msg.thread_id === 'string' ? msg.thread_id : undefined,
              event: { kind: 'status', text: 'Session started', meta: { threadId: msg.thread_id ?? null } }
            }
          ]
        case 'item.started':
          return itemStarted(msg.item ?? {})
        case 'item.completed':
          return itemCompleted(msg.item ?? {})
        case 'turn.completed': {
          const u = msg.usage ?? {}
          const text = lastMessage ?? 'Turn completed'
          return [
            {
              usage: { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cached_input_tokens) },
              result: { text, isError: false, denials: [...denials] },
              event: { kind: 'result', text, meta: { isError: false } }
            }
          ]
        }
        case 'turn.failed': {
          const text = String(msg.error?.message ?? 'Turn failed')
          return [
            {
              usage: RATE_LIMIT.test(text) ? { rateLimitStatus: 'rejected' } : undefined,
              result: { text, isError: true, denials: [...denials] },
              event: { kind: 'error', text }
            }
          ]
        }
        case 'error':
          // Transient (e.g. "Reconnecting... 2/5"); a fatal error arrives as turn.failed.
          return [{ event: { kind: 'log', text: String(msg.message ?? '') } }]
        default:
          return []
      }
    }
  }

  function itemStarted(item: Item): ParsedUpdate[] {
    if (item.type === 'command_execution' && item.command) {
      const text = `Shell: ${truncate(item.command, 200)}`
      return [{ event: { kind: 'tool-use', text, meta: { tool: 'Shell' } }, currentAction: text }]
    }
    if (item.type === 'mcp_tool_call') {
      const text = `MCP: ${item.server}/${item.tool}`
      return [{ event: { kind: 'tool-use', text, meta: { tool: 'MCP' } }, currentAction: text }]
    }
    return []
  }

  function itemCompleted(item: Item): ParsedUpdate[] {
    switch (item.type) {
      case 'agent_message':
        if (!item.text?.trim()) return []
        lastMessage = item.text
        return [{ event: { kind: 'text', text: item.text } }]
      case 'command_execution': {
        if (item.status === 'declined') denials.push({ tool: 'Shell', input: truncate(item.command ?? '', 500) })
        const failed = item.status !== 'completed' || (item.exit_code ?? 0) !== 0
        const head = item.status === 'declined' ? 'Declined by sandbox policy' : `exit ${item.exit_code ?? '?'}`
        const body = item.aggregated_output?.trim() ? `\n${item.aggregated_output}` : ''
        return [{ event: { kind: 'tool-result', text: truncate(head + body, 4000), meta: { isError: failed } } }]
      }
      case 'file_change': {
        const paths = (item.changes ?? []).map((c) => `${c.path ?? '?'}${c.kind && c.kind !== 'update' ? ` (${c.kind})` : ''}`)
        const text = `Edit: ${truncate(paths.join(', ') || 'files', 300)}`
        const updates: ParsedUpdate[] = [{ event: { kind: 'tool-use', text, meta: { tool: 'Edit' } }, currentAction: text }]
        if (item.status === 'failed') updates.push({ event: { kind: 'tool-result', text: 'File change failed', meta: { isError: true } } })
        return updates
      }
      case 'mcp_tool_call': {
        const output = (item.result?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n')
        const text = item.error?.message ?? (output || `MCP ${item.status ?? 'completed'}`)
        return [{ event: { kind: 'tool-result', text: truncate(text, 4000), meta: { isError: item.status === 'failed' || !!item.error } } }]
      }
      case 'web_search':
        return [{ event: { kind: 'tool-use', text: `WebSearch: ${item.query ?? ''}`, meta: { tool: 'WebSearch' } } }]
      case 'error':
        return [{ event: { kind: 'log', text: String(item.message ?? '') } }]
      default:
        return [] // reasoning, todo_list, etc.
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `… [${s.length - max} more chars]` : s
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

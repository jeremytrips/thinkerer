import { describe, expect, it } from 'vitest'
import { codexAdapter, createCodexParser, parseLoginStatus } from '../engine/agents/codex'
import { DEFAULT_POLICY } from '../engine/agents/supervisor'

// Event lines follow `codex exec --json` (codex-cli 0.169). The thread/turn/error
// lines were captured from a real (unauthenticated) run; item shapes follow the
// exec JSONL event schema.
const line = (o: unknown) => JSON.stringify(o)

describe('Codex adapter', () => {
  it('builds a sandboxed, non-interactive invocation that ignores user config and reads the prompt from stdin', () => {
    const inv = codexAdapter.buildInvocation({ executable: '/bin/codex', cwd: '/p', prompt: '--not-a-flag', policy: DEFAULT_POLICY })
    expect(inv.args.slice(0, 4)).toEqual(['exec', '--json', '--cd', '/p'])
    expect(inv.args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', 'approval_policy="never"', 'sandbox_workspace_write.network_access=false', 'web_search="disabled"', '--ignore-user-config', '--ignore-rules']))
    for (const f of ['apps', 'plugins', 'browser_use', 'computer_use', 'hooks']) expect(inv.args.join(' ')).toContain(`--disable ${f}`)
    expect(inv.args.at(-1)).toBe('-')
    expect(inv.stdin).toBe('--not-a-flag')
    expect(inv.args).not.toContain('--not-a-flag')
  })

  it('maps exec events to run updates', () => {
    const p = createCodexParser()
    expect(p.parseLine(line({ type: 'thread.started', thread_id: 't1' }))[0].event).toMatchObject({ kind: 'status' })
    expect(p.parseLine(line({ type: 'turn.started' }))).toEqual([])

    const started = p.parseLine(line({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } }))
    expect(started[0]).toMatchObject({ event: { kind: 'tool-use', text: 'Shell: bash -lc ls', meta: { tool: 'Shell' } }, currentAction: 'Shell: bash -lc ls' })

    const done = p.parseLine(line({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } }))
    expect(done[0].event).toEqual({ kind: 'tool-result', text: 'exit 0\na.txt\n', meta: { isError: false } })

    const failed = p.parseLine(line({ type: 'item.completed', item: { type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } }))
    expect(failed[0].event?.meta).toEqual({ isError: true })

    const edit = p.parseLine(line({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'b.txt', kind: 'add' }], status: 'completed' } }))
    expect(edit[0].event).toMatchObject({ kind: 'tool-use', text: 'Edit: src/a.ts, b.txt (add)' })

    expect(p.parseLine(line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }))).toEqual([])
    p.parseLine(line({ type: 'item.completed', item: { type: 'agent_message', text: 'All done.' } }))

    const [result] = p.parseLine(line({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }))
    expect(result.result).toEqual({ text: 'All done.', isError: false, denials: [] })
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 40 })
  })

  it('treats transient errors as log lines and turn.failed as the failure, flagging rate limits', () => {
    const p = createCodexParser()
    expect(p.parseLine(line({ type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized)' }))[0].event?.kind).toBe('log')
    const [auth] = p.parseLine(line({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } }))
    expect(auth.result).toMatchObject({ isError: true, text: 'unexpected status 401 Unauthorized' })
    expect(auth.usage).toBeUndefined()

    const [limited] = createCodexParser().parseLine(line({ type: 'turn.failed', error: { message: "You've hit your usage limit." } }))
    expect(limited.usage).toEqual({ rateLimitStatus: 'rejected' })
  })

  it('records declined commands as policy denials', () => {
    const p = createCodexParser()
    p.parseLine(line({ type: 'item.completed', item: { type: 'command_execution', command: 'curl example.com', aggregated_output: '', exit_code: null, status: 'declined' } }))
    const [r] = p.parseLine(line({ type: 'turn.completed', usage: {} }))
    expect(r.result!.denials).toEqual([{ tool: 'Shell', input: 'curl example.com' }])
  })

  it('reads login status without echoing API key fragments', () => {
    expect(parseLoginStatus(1, 'Not logged in\n')).toEqual({ authenticated: false, detail: 'Not logged in — run `codex login` in a terminal' })
    expect(parseLoginStatus(0, 'Logged in using ChatGPT\n')).toEqual({ authenticated: true, detail: 'Logged in (ChatGPT)' })
    const apiKey = parseLoginStatus(0, 'Logged in using an API key - sk-proj-abc***xyz\n')
    expect(apiKey).toEqual({ authenticated: true, detail: 'Logged in (API key)' })
    expect(parseLoginStatus(2, 'weird')).toEqual({ authenticated: null, detail: 'Installed; login status unavailable' })
  })
})

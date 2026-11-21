// Test stand-in for a provider CLI: emits Claude-style stream-json on stdout.
// Used by tests/supervisor.test.ts and tests/worktrees.test.ts to exercise process lifecycle.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const mode = process.argv[2]
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  out({ type: 'system', subtype: 'init', model: 'stand-in', session_id: `session-${process.pid}` })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'made.txt' } }] } })
  if (mode === 'hang') {
    // Spawn a grandchild so the test can check the whole tree is killed.
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    writeFileSync(process.argv[3], String(grandchild.pid))
    setInterval(() => {}, 1000)
    return
  }
  if (mode === 'readonly') {
    // A reviewer: reads, writes nothing, and reports one finding in the protocol's format.
    out({ type: 'result', subtype: 'success', is_error: false, result: '[high] made.txt:1: example finding; fix it', usage: { input_tokens: 7, output_tokens: 2 }, permission_denials: [] })
    return
  }
  if (mode === 'review-clean') {
    // A reviewer that says a sentence before the clean verdict.
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Checked the diff against the plan.\nNo findings.', permission_denials: [] })
    return
  }
  if (mode === 'fail') {
    // A turn that ends in an error (a rate limit, say).
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'rate limited', permission_denials: [] })
    process.exitCode = 1
    return
  }
  writeFileSync('made.txt', input)
  // In a chat worktree, record the ports and compose project the agent was given.
  if (process.env.THINKERER_PORT_1) writeFileSync('agent-env.txt', `${process.env.THINKERER_PORT_1} ${process.env.COMPOSE_PROJECT_NAME}`)
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Wrote made.txt', usage: { input_tokens: 3, output_tokens: 5 }, permission_denials: [] })
})

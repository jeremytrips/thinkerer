// Test stand-in for a provider CLI: emits Claude-style stream-json on stdout.
// Used only by tests/supervisor.test.ts to exercise process lifecycle.
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
  writeFileSync('made.txt', input)
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Wrote made.txt', usage: { input_tokens: 3, output_tokens: 5 }, permission_denials: [] })
})

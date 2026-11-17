#!/usr/bin/env node
// Thinkerer's demonstration MCP server (spec F4): one read-only tool that
// reports project health. Speaks MCP's stdio transport (newline-delimited
// JSON-RPC 2.0) with no dependencies.
//
// Env: THINKERER_PROJECT_ROOT (required), THINKERER_PREVIEW_URL (optional).
import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.env.THINKERER_PROJECT_ROOT || process.cwd()
const previewUrl = process.env.THINKERER_PREVIEW_URL || ''

const TOOLS = [
  {
    name: 'project_health',
    description:
      'Report the health of the current Thinkerer project: Git branch and uncommitted file count, Node version, and whether the configured local preview URL responds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  }
]

async function projectHealth() {
  const report = { projectRoot: root, node: process.version, git: null, preview: null }
  try {
    const { stdout } = await exec('git', ['status', '--porcelain=v1', '--branch'], { cwd: root })
    const lines = stdout.split('\n').filter(Boolean)
    report.git = { branch: lines[0]?.slice(3).split('...')[0] ?? null, uncommittedFiles: lines.length - 1 }
  } catch {
    report.git = { error: 'not a git repository' }
  }
  if (previewUrl) {
    try {
      const res = await fetch(previewUrl, { signal: AbortSignal.timeout(3000) })
      report.preview = { url: previewUrl, reachable: true, status: res.status }
    } catch (err) {
      report.preview = { url: previewUrl, reachable: false, error: String(err?.cause?.code ?? err?.message ?? err) }
    }
  }
  return report
}

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

async function handle(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'thinkerer-health', version: '0.1.0' }
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      if (req.params?.name !== 'project_health') {
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params?.name}` }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify(await projectHealth(), null, 2) }], isError: false }
    }
    default: {
      const err = new Error(`Method not found: ${req.method}`)
      err.code = -32601
      throw err
    }
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  if (req.id === undefined || req.id === null) return // notification
  try {
    send({ id: req.id, result: await handle(req) })
  } catch (err) {
    send({ id: req.id, error: { code: err.code ?? -32603, message: err.message } })
  }
})

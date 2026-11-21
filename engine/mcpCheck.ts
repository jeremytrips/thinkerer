import { spawn } from 'node:child_process'
import type { McpCheckResult } from '../shared/types'
import type { ResolvedMcpServer } from './mcp'

// "Check" for the MCP tab: connect to one server the way an agent would, run
// the MCP handshake and list its tools, then disconnect. No tool is called.

const PROTOCOL = '2025-06-18'
const CLIENT = { name: 'thinkerer-check', version: '0.1.0' }
const MAX_PAGES = 5

type Rpc = (method: string, params?: unknown) => Promise<any>
type Notify = (method: string) => Promise<void>

export interface CheckOptions {
  cwd: string
  /** Base environment for stdio servers (PATH etc.). */
  env: NodeJS.ProcessEnv
  timeoutMs?: number
}

export async function checkMcpServer(server: ResolvedMcpServer, secretEnv: Record<string, string>, opts: CheckOptions): Promise<McpCheckResult> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 20_000
  let close = () => {}
  try {
    const session =
      server.transport === 'stdio'
        ? stdioSession(server, secretEnv, opts)
        : server.transport === 'http'
          ? httpSession(server.url, fillHeaders(server.headers, secretEnv))
          : await sseSession(server.url, fillHeaders(server.headers, secretEnv), timeoutMs)
    close = session.close
    const result = await withTimeout(talk(session.rpc, session.notify), timeoutMs, session.stderr)
    return { ok: true, ...result, error: null, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, serverInfo: null, tools: [], error: (err as Error).message, ms: Date.now() - started }
  } finally {
    close()
  }
}

async function talk(rpc: Rpc, notify: Notify): Promise<Pick<McpCheckResult, 'serverInfo' | 'tools'>> {
  const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT })
  await notify('notifications/initialized')
  const info = init?.serverInfo
  const serverInfo = info?.name ? `${info.name}${info.version ? ` ${info.version}` : ''}` : null
  if (!init?.capabilities?.tools) return { serverInfo, tools: [] }
  const tools: McpCheckResult['tools'] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await rpc('tools/list', cursor ? { cursor } : {})
    for (const t of Array.isArray(res?.tools) ? res.tools : []) {
      if (typeof t?.name === 'string') tools.push({ name: t.name, description: typeof t.description === 'string' ? t.description.slice(0, 300) : '' })
    }
    cursor = typeof res?.nextCursor === 'string' ? res.nextCursor : undefined
    if (!cursor) break
  }
  return { serverInfo, tools }
}

/** ${NAME} in header values becomes the secret's value (only for this request, never stored). */
export function fillHeaders(headers: Record<string, string>, secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, n: string) => secrets[n] ?? '')]))
}

interface Session {
  rpc: Rpc
  notify: Notify
  close: () => void
  /** Last stderr output, to explain a timeout. */
  stderr?: () => string
}

/** A pending JSON-RPC request table shared by the transports. */
function requests() {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  return {
    open(): { id: number; done: Promise<any> } {
      const id = nextId++
      const done = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }))
      return { id, done }
    },
    deliver(msg: any) {
      if (typeof msg?.id !== 'number' || !pending.has(msg.id)) return
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`Server error: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
    },
    failAll(err: Error) {
      for (const p of pending.values()) p.reject(err)
      pending.clear()
    }
  }
}

function stdioSession(server: ResolvedMcpServer, secretEnv: Record<string, string>, opts: CheckOptions): Session {
  const child = spawn(server.command, server.args, {
    cwd: opts.cwd,
    env: { ...opts.env, ...server.env, ...secretEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  const reqs = requests()
  let buf = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) {
      try {
        reqs.deliver(JSON.parse(buf.slice(0, nl)))
      } catch {
        // not a JSON-RPC line (some servers log to stdout)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)))
  child.on('error', (err) => reqs.failAll(new Error(`Could not start ${server.command}: ${err.message}`)))
  child.on('exit', (code) => reqs.failAll(new Error(`The server exited (code ${code})${stderr.trim() ? `: ${lastLines(stderr)}` : ''}`)))
  child.stdin.on('error', () => {})
  const write = (o: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
  return {
    rpc: (method, params) => {
      const { id, done } = reqs.open()
      write({ id, method, params })
      return done
    },
    notify: async (method) => void write({ method }),
    close: () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
        else child.kill()
      } catch {
        // already gone
      }
    },
    stderr: () => stderr
  }
}

/** Streamable HTTP: each request is a POST; the reply is JSON or a short SSE stream. */
function httpSession(url: string, headers: Record<string, string>): Session {
  let sessionId: string | null = null
  const controller = new AbortController()
  const post = async (body: object): Promise<Response> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      signal: controller.signal
    })
    sessionId = res.headers.get('mcp-session-id') ?? sessionId
    if (!res.ok && res.status !== 202) throw new Error(httpError(res))
    return res
  }
  let nextId = 1
  return {
    rpc: async (method, params) => {
      const id = nextId++
      const res = await post({ id, method, params })
      const type = res.headers.get('content-type') ?? ''
      const messages = type.includes('text/event-stream') ? sseMessages(await res.text()) : [await res.json()]
      const reply = messages.find((m) => m?.id === id)
      if (!reply) throw new Error(`No reply to ${method}`)
      if (reply.error) throw new Error(`Server error: ${reply.error.message ?? JSON.stringify(reply.error)}`)
      return reply.result
    },
    notify: async (method) => {
      const res = await post({ method })
      await res.body?.cancel().catch(() => {})
    },
    close: () => controller.abort()
  }
}

/** Legacy HTTP+SSE: a GET stream announces a POST endpoint; replies arrive on the stream. */
async function sseSession(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Session> {
  const controller = new AbortController()
  const res = await fetch(url, { headers: { ...headers, accept: 'text/event-stream' }, signal: controller.signal })
  if (!res.ok || !res.body) {
    controller.abort()
    throw new Error(httpError(res))
  }
  const reqs = requests()
  let endpointResolve: (u: string) => void = () => {}
  const endpoint = new Promise<string>((r) => (endpointResolve = r))
  void (async () => {
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        let sep: number
        while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(buf.slice(sep).match(/^\r?\n\r?\n/)![0].length + sep)
          const event = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? 'message'
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
          if (event === 'endpoint') endpointResolve(new URL(data, url).toString())
          else if (data) {
            try {
              reqs.deliver(JSON.parse(data))
            } catch {
              // ignore
            }
          }
        }
      }
      reqs.failAll(new Error('The server closed the event stream'))
    } catch (err) {
      reqs.failAll(err as Error)
    }
  })()
  const postUrl = await withTimeout(endpoint, timeoutMs)
  const post = async (body: object) => {
    const r = await fetch(postUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...body }), signal: controller.signal })
    if (!r.ok && r.status !== 202) throw new Error(httpError(r))
    await r.body?.cancel().catch(() => {})
  }
  return {
    rpc: async (method, params) => {
      const { id, done } = reqs.open()
      await post({ id, method, params })
      return done
    },
    notify: (method) => post({ method }),
    close: () => controller.abort()
  }
}

function sseMessages(text: string): any[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
    .filter(Boolean)
    .flatMap((d) => {
      try {
        return [JSON.parse(d)]
      } catch {
        return []
      }
    })
}

function httpError(res: Response): string {
  if (res.status === 401 || res.status === 403) return `HTTP ${res.status}: the server refused the credentials (check the secrets; OAuth-only servers aren't supported)`
  return `HTTP ${res.status} ${res.statusText}`.trim()
}

function lastLines(s: string): string {
  return s.trim().split('\n').slice(-3).join(' ').slice(0, 500)
}

function withTimeout<T>(p: Promise<T>, ms: number, stderr?: () => string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const tail = stderr?.().trim()
      reject(new Error(`No answer within ${Math.round(ms / 1000)}s${tail ? `: ${lastLines(tail)}` : ''}`))
    }, ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    )
  })
}

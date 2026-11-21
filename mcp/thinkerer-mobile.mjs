#!/usr/bin/env node
// Thinkerer's mobile MCP server: lets the agent drive real Android emulators
// and iOS simulators on this machine (boot, screenshot, tap, swipe, type,
// read the UI tree, install and launch apps, open URLs). The same devices
// show live in Thinkerer's Emulator panel. Speaks MCP's stdio transport
// (newline-delimited JSON-RPC 2.0) with no dependencies.
//
// Env: THINKERER_ARTIFACTS (screenshots are saved there, with the run),
//      THINKERER_PROJECT_ROOT (relative app paths resolve against it),
//      THINKERER_PREVIEW_URL (default for mobile_open_url).
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { isAbsolute, join, resolve } from 'node:path'
import * as mobile from './mobile-driver.mjs'

const artifacts = process.env.THINKERER_ARTIFACTS || ''
const root = process.env.THINKERER_PROJECT_ROOT || process.cwd()
const previewUrl = process.env.THINKERER_PREVIEW_URL || ''
let shots = 0

const device = { type: 'string', description: 'Device id from mobile_list_devices, e.g. "android:Pixel_8" or "ios:<UDID>"' }
const point = { type: 'number', minimum: 0, description: 'Logical points (same space as mobile_screenshot and mobile_describe_ui)' }
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })

const TOOLS = [
  {
    name: 'mobile_list_devices',
    description: 'List Android emulators (AVDs), connected Android devices and iOS simulators on this machine, with their state (booted/shutdown) and whether touch input is available. Also reports which platform tools are missing.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async () => ({ tools: mobile.toolStatus(), devices: await mobile.listDevices() })
  },
  {
    name: 'mobile_boot',
    description: 'Boot an emulator/simulator and wait until it is ready (can take a minute). Headless by default; the user sees it in Thinkerer\'s Emulator panel. It keeps running after the run; shut it down when done unless the user is using it.',
    inputSchema: obj({ device, window: { type: 'boolean', description: 'Also open the emulator window / Simulator.app (default false)' } }, ['device']),
    run: async (a) => mobile.boot(a.device, { window: !!a.window })
  },
  {
    name: 'mobile_shutdown',
    description: 'Shut down a running emulator/simulator.',
    inputSchema: obj({ device }),
    run: async (a) => mobile.shutdown(a.device)
  },
  {
    name: 'mobile_screenshot',
    description: 'Screenshot of the device screen at logical-point resolution: pixel (x, y) in the image is the point to pass to mobile_tap. Saved with the run.',
    inputSchema: obj({ device }),
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const shot = await mobile.screenshot(a.device, { logical: true })
      let saved = null
      if (artifacts) {
        mkdirSync(artifacts, { recursive: true })
        saved = `mobile-${String(++shots).padStart(2, '0')}.png`
        writeFileSync(join(artifacts, saved), shot.data)
      }
      const scaleNote = shot.scale === 1 ? '' : ` Image pixels per point: ${shot.scale}; divide image coordinates by it.`
      return [
        { type: 'image', data: shot.data.toString('base64'), mimeType: shot.mimeType },
        { type: 'text', text: `Screen is ${shot.pointWidth}×${shot.pointHeight} points.${scaleNote}${saved ? ` Saved as ${saved}.` : ''}` }
      ]
    }
  },
  {
    name: 'mobile_describe_ui',
    description: 'On-screen elements (type, label, resource/accessibility id, clickable/editable) with frames and centre points in logical points. Prefer this over guessing coordinates from a screenshot.',
    inputSchema: obj({ device }),
    annotations: { readOnlyHint: true },
    run: async (a) => mobile.describeUi(a.device)
  },
  {
    name: 'mobile_tap',
    description: 'Tap at a point (logical points). Set duration_ms for a long press.',
    inputSchema: obj({ device, x: point, y: point, duration_ms: { type: 'number', minimum: 0, maximum: 10000 } }, ['device', 'x', 'y']),
    run: async (a) => mobile.tap(a.device, a.x, a.y, { durationMs: a.duration_ms ?? 0 })
  },
  {
    name: 'mobile_swipe',
    description: 'Swipe/drag from (x1, y1) to (x2, y2) in logical points, e.g. to scroll (swipe up to scroll down).',
    inputSchema: obj({ device, x1: point, y1: point, x2: point, y2: point, duration_ms: { type: 'number', minimum: 50, maximum: 10000 } }, ['device', 'x1', 'y1', 'x2', 'y2']),
    run: async (a) => mobile.swipe(a.device, a.x1, a.y1, a.x2, a.y2, { durationMs: a.duration_ms ?? 300 })
  },
  {
    name: 'mobile_type',
    description: 'Type text into the focused field (tap the field first). "\\n" presses Enter. Android types ASCII only.',
    inputSchema: obj({ device, text: { type: 'string', maxLength: 5000 } }),
    run: async (a) => mobile.typeText(a.device, a.text)
  },
  {
    name: 'mobile_press_key',
    description: 'Press a system key. back is Android-only.',
    inputSchema: obj({ device, key: { type: 'string', enum: mobile.KEYS } }),
    run: async (a) => mobile.pressKey(a.device, a.key)
  },
  {
    name: 'mobile_open_url',
    description: `Open a URL or deep link on the device (browser or the app that handles it). localhost URLs work on Android too (adb reverse).${previewUrl ? ` Defaults to the project preview, ${previewUrl}.` : ''}`,
    inputSchema: obj({ device, url: { type: 'string' } }, previewUrl ? ['device'] : ['device', 'url']),
    run: async (a) => {
      const url = a.url || previewUrl
      if (!url) throw new Error('url is required')
      return mobile.openUrl(a.device, url)
    }
  },
  {
    name: 'mobile_install_app',
    description: 'Install an app build: an .apk for Android, or a simulator .app bundle for iOS (e.g. from xcodebuild -sdk iphonesimulator). Relative paths resolve against the project.',
    inputSchema: obj({ device, path: { type: 'string' } }),
    run: async (a) => mobile.installApp(a.device, isAbsolute(a.path) ? a.path : resolve(root, a.path))
  },
  {
    name: 'mobile_launch_app',
    description: 'Launch an installed app by Android package name or iOS bundle id.',
    inputSchema: obj({ device, app_id: { type: 'string' } }),
    run: async (a) => mobile.launchApp(a.device, a.app_id)
  },
  {
    name: 'mobile_terminate_app',
    description: 'Stop a running app by Android package name or iOS bundle id.',
    inputSchema: obj({ device, app_id: { type: 'string' } }),
    run: async (a) => mobile.terminateApp(a.device, a.app_id)
  },
  {
    name: 'mobile_list_apps',
    description: 'Installed apps: third-party packages on Android, all apps (with type) on iOS.',
    inputSchema: obj({ device }),
    annotations: { readOnlyHint: true },
    run: async (a) => mobile.listApps(a.device)
  },
  {
    name: 'mobile_logs',
    description: 'Recent device logs (Android logcat; iOS unified log for the last 2 minutes), newest last.',
    inputSchema: obj({ device, lines: { type: 'number', minimum: 1, maximum: 2000 } }, ['device']),
    annotations: { readOnlyHint: true },
    run: async (a) => mobile.logs(a.device, { lines: a.lines ?? 200 })
  }
]

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  try {
    const result = await tool.run(args ?? {})
    const content = Array.isArray(result) ? result : [{ type: 'text', text: typeof result === 'string' ? result || '(empty)' : JSON.stringify(result, null, 2) }]
    return { content, isError: false }
  } catch (err) {
    return { content: [{ type: 'text', text: err?.message ?? String(err) }], isError: true }
  }
}

async function handle(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'thinkerer-mobile', version: '0.1.0' }
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ run: _run, ...t }) => t) }
    case 'tools/call':
      return callTool(req.params?.name, req.params?.arguments)
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

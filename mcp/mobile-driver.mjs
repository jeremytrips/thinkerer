// Drives real Android emulators (Android SDK: emulator + adb) and iOS
// simulators (Xcode: xcrun simctl; touch input through Meta's idb when it is
// installed). No dependencies. Shared by the `mobile` MCP server and the
// Electron main process (the embedded Emulator panel).
//
// Device ids: `android:<AVD name or adb serial>` and `ios:<simulator UDID>`.
// Coordinates are always logical points (iOS points, Android dp), so the same
// numbers work for a screenshot from `screenshot({ logical: true })`, taps and
// the UI tree, whatever the device's pixel density.
//
// Platform code lives in mcp/mobile/ (tools, android, ios, image); this file is
// the public API that validates input and picks the platform.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANDROID_KEYS, adb, androidScale, androidTextChunks, bootAndroid, densityCache, listAndroid, serialOf, shQuote } from './mobile/android.mjs'
import { convert, imageSize, pngSize } from './mobile/image.mjs'
import { IOS_BUTTONS, IOS_KEYS, bootedSim, idb, iosScale, listIos, simctl, simulator } from './mobile/ios.mjs'
import { run, toolStatus, tools } from './mobile/tools.mjs'

export { IOS_INPUT_HELP, toolStatus, tools } from './mobile/tools.mjs'
export { STALE_IDB } from './mobile/ios.mjs'
export { androidTextChunks } from './mobile/android.mjs'

const ID = /^(android|ios):[\w.:-]{1,100}$/
const APP_ID = /^[\w.-]{1,200}$/

function parseId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error(`Invalid device id: ${id}`)
  const i = id.indexOf(':')
  return { platform: id.slice(0, i), key: id.slice(i + 1) }
}

const num = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw new Error(`Invalid ${name}`)
  return v
}

/** Every Android emulator/AVD, connected Android device and iOS simulator. */
export async function listDevices() {
  const [android, ios] = await Promise.all([listAndroid().catch(() => []), listIos().catch(() => [])])
  return [...android, ...ios]
}

/**
 * Boots a device and waits until it is usable. Headless by default (the
 * screen is shown by whoever calls screenshot()); window: true opens the
 * emulator window / Simulator.app as well.
 */
export async function boot(id, { window = false } = {}) {
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    await bootAndroid(key, { window })
  } else {
    if (!tools().xcrun) throw new Error(toolStatus().ios.detail)
    const d = await simulator(key)
    if (d.state !== 'Booted') await simctl(['boot', key], { timeout: 120_000 }).catch((err) => {
      if (!/current state: Booted/.test(err.message)) throw err
    })
    await simctl(['bootstatus', key], { timeout: 240_000 })
    if (window) await run('/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', key])
  }
  return (await listDevices()).find((d) => d.id === id) ?? null
}

export async function shutdown(id) {
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const serial = await serialOf(key, { mustBeBooted: false })
    if (!serial.startsWith('emulator-')) throw new Error('Only emulators can be shut down')
    await adb(serial, ['emu', 'kill'], { timeout: 15_000 })
    densityCache.delete(serial)
  } else {
    await simctl(['shutdown', key], { timeout: 60_000 }).catch((err) => {
      if (!/current state: Shutdown/.test(err.message)) throw err
    })
  }
  return true
}

/**
 * The device screen. `logical: true` resizes to logical points (what tap and
 * UI coordinates use; best for the agent). `format: 'jpeg'` is smaller, for
 * live views. Returns the image and `scale`, image pixels per logical point.
 */
export async function screenshot(id, { logical = false, format = 'png' } = {}) {
  const { platform: p, key } = parseId(id)
  let data
  let scale
  if (p === 'android') {
    const serial = await serialOf(key)
    // screencap's PNG is already compact, so live views get it as is.
    ;[data, scale] = await Promise.all([adb(serial, ['exec-out', 'screencap', '-p'], { binary: true, timeout: 20_000 }), androidScale(serial)])
  } else {
    await bootedSim(key)
    const dir = await mkdtemp(join(tmpdir(), 'thinkerer-sim-'))
    try {
      const file = join(dir, `shot.${format === 'jpeg' && !logical ? 'jpg' : 'png'}`)
      await simctl(['io', key, 'screenshot', `--type=${format === 'jpeg' && !logical ? 'jpeg' : 'png'}`, file], { timeout: 20_000 })
      ;[data, scale] = await Promise.all([readFile(file), iosScale(key)])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  let size = imageSize(data)
  if (!size) throw new Error('Could not read the screenshot')
  const points = { width: Math.round(size.width / scale), height: Math.round(size.height / scale) }
  if (logical && tools().sips) {
    data = await convert(data, { width: points.width, height: points.height, format })
    size = imageSize(data) ?? points
    scale = size.width / points.width
  }
  return { data, mimeType: pngSize(data) ? 'image/png' : 'image/jpeg', width: size.width, height: size.height, scale, pointWidth: points.width, pointHeight: points.height }
}

/** Tap at logical points (or long-press with durationMs). */
export async function tap(id, x, y, { durationMs = 0 } = {}) {
  num(x, 'x')
  num(y, 'y')
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const serial = await serialOf(key)
    const s = await androidScale(serial)
    const [px, py] = [Math.round(x * s), Math.round(y * s)]
    const args = durationMs > 0 ? ['swipe', px, py, px, py, Math.round(durationMs)] : ['tap', px, py]
    await adb(serial, ['shell', 'input', ...args.map(String)])
  } else {
    await bootedSim(key)
    await idb(key, ['ui', 'tap', ...(durationMs > 0 ? ['--duration', String(durationMs / 1000)] : []), String(Math.round(x)), String(Math.round(y))])
  }
  return true
}

/** Swipe/drag between two logical points. */
export async function swipe(id, x1, y1, x2, y2, { durationMs = 300 } = {}) {
  for (const [v, n] of [[x1, 'x1'], [y1, 'y1'], [x2, 'x2'], [y2, 'y2'], [durationMs, 'duration']]) num(v, n)
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const serial = await serialOf(key)
    const s = await androidScale(serial)
    await adb(serial, ['shell', 'input', 'swipe', ...[x1, y1, x2, y2].map((v) => String(Math.round(v * s))), String(Math.round(durationMs))])
  } else {
    await bootedSim(key)
    await idb(key, ['ui', 'swipe', '--duration', String(durationMs / 1000), ...[x1, y1, x2, y2].map((v) => String(Math.round(v)))])
  }
  return true
}

/** Types into the focused field. A newline presses Enter. */
export async function typeText(id, text) {
  if (typeof text !== 'string' || text.length > 5000) throw new Error('Invalid text')
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const serial = await serialOf(key)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const chunk of androidTextChunks(lines[i])) await adb(serial, ['shell', 'input', 'text', shQuote(chunk)])
      if (i < lines.length - 1) await adb(serial, ['shell', 'input', 'keyevent', '66'])
    }
  } else {
    await bootedSim(key)
    await idb(key, ['ui', 'text', text])
  }
  return true
}

export const KEYS = ['home', 'back', 'enter', 'delete', 'tab', 'escape', 'recents', 'power', 'lock', 'volume_up', 'volume_down', 'up', 'down', 'left', 'right']

/** Presses a hardware/system key: home, back (Android), enter, delete, recents, power, volume_up… */
export async function pressKey(id, name) {
  if (typeof name !== 'string') throw new Error('Invalid key')
  const k = name.toLowerCase()
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const code = ANDROID_KEYS[k === 'lock' ? 'power' : k]
    if (!code) throw new Error(`Unknown Android key: ${name}`)
    await adb(await serialOf(key), ['shell', 'input', 'keyevent', String(code)])
  } else {
    await bootedSim(key)
    if (IOS_BUTTONS[k]) await idb(key, ['ui', 'button', IOS_BUTTONS[k]])
    else if (IOS_KEYS[k]) await idb(key, ['ui', 'key', String(IOS_KEYS[k])])
    else throw new Error(k === 'back' ? 'iOS has no back button; tap the app’s back control or swipe from the left edge' : `Unknown iOS key: ${name}`)
  }
  return true
}

/**
 * Opens a URL (web page or deep link). On Android, localhost URLs are made
 * reachable with `adb reverse`, so a dev server on the Mac works unchanged.
 */
export async function openUrl(id, url) {
  const parsed = new URL(url)
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const serial = await serialOf(key)
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)) {
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
      await adb(serial, ['reverse', `tcp:${port}`, `tcp:${port}`])
    }
    await adb(serial, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shQuote(parsed.href)])
  } else {
    await bootedSim(key)
    await simctl(['openurl', key, parsed.href])
  }
  return true
}

/** Installs an .apk (Android) or a simulator .app bundle (iOS). */
export async function installApp(id, path) {
  if (typeof path !== 'string' || !existsSync(path)) throw new Error(`No such file: ${path}`)
  const { platform: p, key } = parseId(id)
  if (p === 'android') await adb(await serialOf(key), ['install', '-r', path], { timeout: 300_000 })
  else {
    await bootedSim(key)
    await simctl(['install', key, path], { timeout: 300_000 })
  }
  return true
}

const appId = (v) => {
  if (typeof v !== 'string' || !APP_ID.test(v)) throw new Error('Invalid app id (package name or bundle id)')
  return v
}

export async function launchApp(id, app) {
  appId(app)
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const serial = await serialOf(key)
    const resolved = await adb(serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', app])
    const component = resolved.trim().split('\n').pop()?.trim() ?? ''
    if (!component.includes('/')) throw new Error(`${app} has no launcher activity (is it installed?)`)
    const out = await adb(serial, ['shell', 'am', 'start', '-n', component])
    if (/^Error/m.test(out)) throw new Error(`Could not launch ${app}: ${out.trim()}`)
  } else {
    await bootedSim(key)
    await simctl(['launch', key, app])
  }
  return true
}

export async function terminateApp(id, app) {
  appId(app)
  const { platform: p, key } = parseId(id)
  if (p === 'android') await adb(await serialOf(key), ['shell', 'am', 'force-stop', app])
  else {
    await bootedSim(key)
    await simctl(['terminate', key, app]).catch(() => {}) // not running is fine
  }
  return true
}

/** Installed apps: user-installed packages (Android) or all apps with their type (iOS). */
export async function listApps(id) {
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const out = await adb(await serialOf(key), ['shell', 'pm', 'list', 'packages', '-3'])
    return out.split('\n').map((l) => l.trim().replace(/^package:/, '')).filter(Boolean).sort().map((id) => ({ id }))
  }
  await bootedSim(key)
  const plist = await simctl(['listapps', key])
  const json = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist }))
  return Object.entries(json).map(([id, a]) => ({ id, name: a.CFBundleDisplayName ?? a.CFBundleName ?? id, type: a.ApplicationType }))
}

function xmlAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : ''
}

/**
 * On-screen elements worth interacting with, with frames and centres in
 * logical points: Android via uiautomator, iOS via idb's accessibility tree.
 */
export async function describeUi(id) {
  const { platform: p, key } = parseId(id)
  if (p === 'android') {
    const serial = await serialOf(key)
    const s = await androidScale(serial)
    const xml = await adb(serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 30_000 })
    const out = []
    for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
      const a = m[1]
      const text = xmlAttr(a, 'text')
      const desc = xmlAttr(a, 'content-desc')
      const rid = xmlAttr(a, 'resource-id')
      const clickable = xmlAttr(a, 'clickable') === 'true'
      const editable = /EditText/.test(xmlAttr(a, 'class'))
      if (!text && !desc && !clickable && !editable) continue
      const b = xmlAttr(a, 'bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
      if (!b) continue
      const [x1, y1, x2, y2] = b.slice(1).map((v) => Number(v) / s)
      if (x2 - x1 < 1 || y2 - y1 < 1) continue
      out.push({
        type: xmlAttr(a, 'class').split('.').pop(),
        label: text || desc || null,
        ...(desc && text ? { description: desc } : {}),
        ...(rid ? { id: rid } : {}),
        ...(clickable ? { clickable: true } : {}),
        ...(editable ? { editable: true } : {}),
        ...(xmlAttr(a, 'focused') === 'true' ? { focused: true } : {}),
        frame: { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) },
        center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
      })
    }
    return out
  }
  await bootedSim(key)
  const raw = JSON.parse(await idb(key, ['ui', 'describe-all', '--json'], { timeout: 30_000 }))
  return (Array.isArray(raw) ? raw : [])
    .filter((e) => e.frame && (e.AXLabel || e.AXValue || e.type === 'Button' || e.type === 'TextField'))
    .map((e) => ({
      type: e.type ?? e.role_description ?? null,
      label: e.AXLabel || e.AXValue || null,
      ...(e.AXValue && e.AXLabel ? { value: e.AXValue } : {}),
      ...(e.AXUniqueId ? { id: e.AXUniqueId } : {}),
      frame: { x: Math.round(e.frame.x), y: Math.round(e.frame.y), width: Math.round(e.frame.width), height: Math.round(e.frame.height) },
      center: { x: Math.round(e.frame.x + e.frame.width / 2), y: Math.round(e.frame.y + e.frame.height / 2) }
    }))
}

/** Recent device logs (newest last). */
export async function logs(id, { lines = 200 } = {}) {
  const n = Math.max(1, Math.min(2000, Math.round(num(lines, 'lines'))))
  const { platform: p, key } = parseId(id)
  if (p === 'android') return adb(await serialOf(key), ['logcat', '-d', '-t', String(n)], { timeout: 30_000 })
  await bootedSim(key)
  const out = await simctl(['spawn', key, 'log', 'show', '--last', '2m', '--style', 'compact'], { timeout: 60_000 })
  return out.split('\n').slice(-n).join('\n')
}

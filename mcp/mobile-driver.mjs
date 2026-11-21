// Drives real Android emulators (Android SDK: emulator + adb) and iOS
// simulators (Xcode: xcrun simctl; touch input through Meta's idb when it is
// installed). No dependencies. Shared by the `mobile` MCP server and the
// Electron main process (the embedded Emulator panel).
//
// Device ids: `android:<AVD name or adb serial>` and `ios:<simulator UDID>`.
// Coordinates are always logical points (iOS points, Android dp), so the same
// numbers work for a screenshot from `screenshot({ logical: true })`, taps and
// the UI tree, whatever the device's pixel density.
import { execFile, spawn } from 'node:child_process'
import { existsSync, openSync, closeSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const ID = /^(android|ios):[\w.:-]{1,100}$/
const APP_ID = /^[\w.-]{1,200}$/
export const IOS_INPUT_HELP =
  'Touch and keyboard input for iOS simulators needs idb (simctl cannot send input). Install it with: brew install facebook/fb/idb-companion && pipx install fb-idb'

// ---------- process helpers ----------

function run(cmd, args, { timeout = 30_000, binary = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout, maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || '').trim() || err.message
          reject(new Error(`${cmd.split(/[\\/]/).pop()} ${args.slice(0, 3).join(' ')}: ${msg.slice(0, 1000)}`))
        } else resolve(stdout)
      }
    )
    if (input !== undefined) child.stdin.end(input)
  })
}

function which(name, extra = []) {
  const dirs = [...(process.env.PATH || '').split(delimiter), ...extra]
  const exts = platform() === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of dirs) for (const ext of exts) {
    if (dir && existsSync(join(dir, name + ext))) return join(dir, name + ext)
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- tool discovery ----------

let toolCache = null

/** Where the platform tools are, or null for each one that is missing. */
export function tools() {
  if (toolCache) return toolCache
  const home = homedir()
  const sdkCandidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    platform() === 'darwin' ? join(home, 'Library', 'Android', 'sdk') : null,
    platform() === 'linux' ? join(home, 'Android', 'Sdk') : null,
    platform() === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null
  ].filter(Boolean)
  const sdk = sdkCandidates.find((d) => existsSync(d)) ?? null
  const exe = platform() === 'win32' ? '.exe' : ''
  const inSdk = (...p) => (sdk && existsSync(join(sdk, ...p) + exe) ? join(sdk, ...p) + exe : null)
  const brewish = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin')]
  toolCache = {
    androidSdk: sdk,
    adb: inSdk('platform-tools', 'adb') ?? which('adb'),
    emulator: inSdk('emulator', 'emulator') ?? which('emulator'),
    xcrun: platform() === 'darwin' && existsSync('/usr/bin/xcrun') ? '/usr/bin/xcrun' : null,
    idb: platform() === 'darwin' ? which('idb', brewish) : null,
    sips: platform() === 'darwin' && existsSync('/usr/bin/sips') ? '/usr/bin/sips' : null
  }
  return toolCache
}

/** Human-readable summary of what is available, for UIs and the agent. */
export function toolStatus() {
  const t = tools()
  return {
    android: t.adb && t.emulator ? { available: true, detail: `Android SDK at ${t.androidSdk ?? 'PATH'}` } : { available: false, detail: 'Android SDK (emulator + platform-tools) not found. Set ANDROID_HOME or install Android Studio.' },
    ios: t.xcrun
      ? { available: true, input: !!t.idb, detail: t.idb ? 'Xcode simulators, input through idb' : `Xcode simulators (view, apps, URLs). ${IOS_INPUT_HELP}` }
      : { available: false, input: false, detail: platform() === 'darwin' ? 'Xcode command line tools not found.' : 'iOS simulators need macOS with Xcode.' }
  }
}

// ---------- Android ----------

const adb = (serial, args, opts) => run(tools().adb, serial ? ['-s', serial, ...args] : args, opts)

async function adbDevices() {
  if (!tools().adb) return []
  const out = await run(tools().adb, ['devices'], { timeout: 10_000 }).catch(() => '')
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state]) => ({ serial, state }))
}

async function avdNameOf(serial) {
  if (!serial.startsWith('emulator-')) return null
  const out = await adb(serial, ['emu', 'avd', 'name'], { timeout: 5_000 }).catch(() => '')
  const name = out.split('\n')[0].trim()
  return name && name !== 'OK' ? name : null
}

async function listAvds() {
  if (!tools().emulator) return []
  const out = await run(tools().emulator, ['-list-avds'], { timeout: 15_000 }).catch(() => '')
  return out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+$/.test(l))
}

async function bootCompleted(serial) {
  const out = await adb(serial, ['shell', 'getprop', 'sys.boot_completed'], { timeout: 5_000 }).catch(() => '')
  return out.trim() === '1'
}

async function listAndroid() {
  const [avds, running] = await Promise.all([listAvds(), adbDevices()])
  const devices = []
  const seen = new Set()
  for (const d of running) {
    const avd = await avdNameOf(d.serial)
    const booted = d.state === 'device' && (await bootCompleted(d.serial))
    let name = avd
    if (!name) name = (await adb(d.serial, ['shell', 'getprop', 'ro.product.model'], { timeout: 5_000 }).catch(() => '')).trim() || d.serial
    if (avd) seen.add(avd)
    devices.push({
      id: `android:${avd ?? d.serial}`,
      platform: 'android',
      name,
      kind: d.serial.startsWith('emulator-') ? 'emulator' : 'device',
      state: booted ? 'booted' : 'booting',
      detail: d.serial,
      input: true
    })
  }
  for (const avd of avds) {
    if (!seen.has(avd)) devices.push({ id: `android:${avd}`, platform: 'android', name: avd.replace(/_/g, ' '), kind: 'emulator', state: 'shutdown', detail: 'AVD', input: true })
  }
  return devices
}

/** adb serial of a running Android device for `android:<avd|serial>`. */
async function serialOf(key, { mustBeBooted = true } = {}) {
  for (const d of await adbDevices()) {
    if (d.serial === key || (await avdNameOf(d.serial)) === key) {
      if (mustBeBooted && !(d.state === 'device' && (await bootCompleted(d.serial)))) throw new Error(`${key} is still booting`)
      return d.serial
    }
  }
  throw new Error(`${key} is not running. Boot it first.`)
}

const densityCache = new Map()
async function androidScale(serial) {
  if (!densityCache.has(serial)) {
    const out = await adb(serial, ['shell', 'wm', 'density'], { timeout: 5_000 })
    const override = out.match(/Override density:\s*(\d+)/)
    const physical = out.match(/Physical density:\s*(\d+)/)
    densityCache.set(serial, Number((override ?? physical)?.[1] ?? 160) / 160)
  }
  return densityCache.get(serial)
}

async function bootAndroid(avd, { window = false, timeoutMs = 240_000 } = {}) {
  const t = tools()
  if (!t.emulator) throw new Error(toolStatus().android.detail)
  if (!(await listAvds()).includes(avd)) throw new Error(`No Android Virtual Device named ${avd}`)
  try {
    return await serialOf(avd)
  } catch {
    // not running (or still booting) yet
  }
  const running = await serialOf(avd, { mustBeBooted: false }).catch(() => null)
  let exited = null
  const log = join(tmpdir(), `thinkerer-emulator-${avd}.log`)
  if (!running) {
    const fd = openSync(log, 'w')
    const args = ['-avd', avd, '-no-audio', '-no-boot-anim']
    if (!window) args.push('-no-window')
    // Detached so the emulator outlives whoever booted it; shut it down explicitly.
    const child = spawn(t.emulator, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
    closeSync(fd)
    child.on('exit', (code) => (exited = code))
    child.on('error', (err) => (exited = err.message))
    child.unref()
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1500)
    if (exited !== null) {
      const tail = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').slice(-8).join('\n')
      throw new Error(`The emulator exited (${exited}).\n${tail}`)
    }
    const serial = await serialOf(avd).catch(() => null)
    if (serial) return serial
  }
  throw new Error(`${avd} did not finish booting within ${Math.round(timeoutMs / 1000)}s`)
}

/** Quote one argument for the device's /system/bin/sh. */
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

const ANDROID_KEYS = {
  home: 3, back: 4, enter: 66, delete: 67, backspace: 67, tab: 61, escape: 111, recents: 187, power: 26,
  volume_up: 24, volume_down: 25, menu: 82, up: 19, down: 20, left: 21, right: 22, search: 84
}

// ---------- iOS ----------

const simctl = (args, opts) => run(tools().xcrun, ['simctl', ...args], opts)

async function simDevices() {
  if (!tools().xcrun) return []
  const json = JSON.parse(await simctl(['list', 'devices', 'available', '-j'], { timeout: 20_000 }))
  const out = []
  for (const [runtime, devices] of Object.entries(json.devices ?? {})) {
    const m = runtime.match(/SimRuntime\.iOS-(\d+)-(\d+)/)
    if (!m) continue // iOS only (no watchOS/tvOS/visionOS)
    for (const d of devices) out.push({ ...d, runtimeName: `iOS ${m[1]}.${m[2]}` })
  }
  return out
}

async function listIos() {
  const input = !!tools().idb
  const map = { Booted: 'booted', Booting: 'booting', Shutdown: 'shutdown', 'Shutting Down': 'shutdown' }
  return (await simDevices()).map((d) => ({
    id: `ios:${d.udid}`,
    platform: 'ios',
    name: d.name,
    kind: 'simulator',
    state: map[d.state] ?? 'shutdown',
    detail: d.runtimeName,
    input
  }))
}

async function simulator(udid) {
  const d = (await simDevices()).find((x) => x.udid === udid)
  if (!d) throw new Error(`No iOS simulator with UDID ${udid}`)
  return d
}

let deviceTypes = null
const iosScaleCache = new Map()
async function iosScale(udid) {
  if (iosScaleCache.has(udid)) return iosScaleCache.get(udid)
  let scale = 3
  try {
    const d = await simulator(udid)
    deviceTypes ??= JSON.parse(await simctl(['list', 'devicetypes', '-j'])).devicetypes
    const type = deviceTypes.find((t) => t.identifier === d.deviceTypeIdentifier)
    if (type?.bundlePath) {
      const plist = join(type.bundlePath, 'Contents', 'Resources', 'profile.plist')
      scale = Number((await run('/usr/bin/plutil', ['-extract', 'mainScreenScale', 'raw', '-o', '-', plist])).trim()) || 3
    }
  } catch {
    // keep the common default
  }
  iosScaleCache.set(udid, scale)
  return scale
}

async function bootedSim(udid) {
  const d = await simulator(udid)
  if (d.state !== 'Booted') throw new Error(`${d.name} is not running. Boot it first.`)
  return d
}

function idb(udid, args, opts) {
  if (!tools().idb) throw new Error(IOS_INPUT_HELP)
  return run(tools().idb, [...args, '--udid', udid], opts)
}

const IOS_BUTTONS = { home: 'HOME', lock: 'LOCK', power: 'LOCK', siri: 'SIRI', side: 'SIDE_BUTTON' }
// USB HID usage ids, which `idb ui key` takes.
const IOS_KEYS = { enter: 40, escape: 41, delete: 42, backspace: 42, tab: 43, right: 79, left: 80, down: 81, up: 82 }

// ---------- images ----------

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  return null
}

function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return null
}

const imageSize = (buf) => pngSize(buf) ?? jpegSize(buf)

/** Resize and/or re-encode with macOS sips; returns the input unchanged elsewhere. */
async function convert(buf, { width, height, format }) {
  if (!tools().sips) return buf
  const dir = await mkdtemp(join(tmpdir(), 'thinkerer-shot-'))
  try {
    const src = join(dir, 'in')
    const dst = join(dir, format === 'jpeg' ? 'out.jpg' : 'out.png')
    await writeFile(src, buf)
    const args = []
    if (width && height) args.push('--resampleHeightWidth', String(height), String(width))
    args.push('-s', 'format', format, ...(format === 'jpeg' ? ['-s', 'formatOptions', '75'] : []), src, '--out', dst)
    await run(tools().sips, args, { timeout: 15_000 })
    return await readFile(dst)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------- public API ----------

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
      // `input text` treats %s as a space; everything else is quoted for the device shell.
      if (lines[i]) await adb(serial, ['shell', 'input', 'text', shQuote(lines[i].replace(/%/g, '\\%').replace(/ /g, '%s'))])
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

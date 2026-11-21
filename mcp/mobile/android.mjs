// Android emulators and devices through the Android SDK (emulator + adb).
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, sleep, toolStatus, tools } from './tools.mjs'

export const adb = (serial, args, opts) => run(tools().adb, serial ? ['-s', serial, ...args] : args, opts)

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

export async function listAndroid() {
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
export async function serialOf(key, { mustBeBooted = true } = {}) {
  for (const d of await adbDevices()) {
    if (d.serial === key || (await avdNameOf(d.serial)) === key) {
      if (mustBeBooted && !(d.state === 'device' && (await bootCompleted(d.serial)))) throw new Error(`${key} is still booting`)
      return d.serial
    }
  }
  throw new Error(`${key} is not running. Boot it first.`)
}

export const densityCache = new Map()
export async function androidScale(serial) {
  if (!densityCache.has(serial)) {
    const out = await adb(serial, ['shell', 'wm', 'density'], { timeout: 5_000 })
    const override = out.match(/Override density:\s*(\d+)/)
    const physical = out.match(/Physical density:\s*(\d+)/)
    densityCache.set(serial, Number((override ?? physical)?.[1] ?? 160) / 160)
  }
  return densityCache.get(serial)
}

export async function bootAndroid(avd, { window = false, timeoutMs = 240_000 } = {}) {
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
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export const ANDROID_KEYS = {
  home: 3, back: 4, enter: 66, delete: 67, backspace: 67, tab: 61, escape: 111, recents: 187, power: 26,
  volume_up: 24, volume_down: 25, menu: 82, up: 19, down: 20, left: 21, right: 22, search: 84
}

/**
 * Arguments for Android's `input text`, which turns "%s" into a space and has no
 * escape for a literal "%s". Spaces become %s; a typed "%" directly followed by
 * "s" is split across two calls so it never reads as one.
 */
export function androidTextChunks(line) {
  if (!line) return []
  return line.split(/(?<=%)(?=s)/).map((part) => part.replace(/ /g, '%s'))
}

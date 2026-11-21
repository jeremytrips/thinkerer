// iOS simulators through Xcode (xcrun simctl), with touch input through Meta's idb.
import { join } from 'node:path'
import { IOS_INPUT_HELP, run, tools } from './tools.mjs'

export const simctl = (args, opts) => run(tools().xcrun, ['simctl', ...args], opts)

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

export async function listIos() {
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

export async function simulator(udid) {
  const d = (await simDevices()).find((x) => x.udid === udid)
  if (!d) throw new Error(`No iOS simulator with UDID ${udid}`)
  return d
}

let deviceTypes = null
const iosScaleCache = new Map()
export async function iosScale(udid) {
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

export async function bootedSim(udid) {
  const d = await simulator(udid)
  if (d.state !== 'Booted') throw new Error(`${d.name} is not running. Boot it first.`)
  return d
}

// idb keeps a companion process per simulator; after a simulator restart (or
// just over time) it goes stale and every call fails with one of these.
export const STALE_IDB = /Mach port invalid|device disconnected|did not answer a frontmost request|Connection refused|companion.*(not|isn't) running/i

export async function idb(udid, args, opts) {
  if (!tools().idb) throw new Error(IOS_INPUT_HELP)
  try {
    return await run(tools().idb, [...args, '--udid', udid], opts)
  } catch (err) {
    if (!STALE_IDB.test(err.message)) throw err
    // Restart the companion and retry once.
    await run(tools().idb, ['kill'], { timeout: 15_000 }).catch(() => {})
    return run(tools().idb, [...args, '--udid', udid], opts)
  }
}

export const IOS_BUTTONS = { home: 'HOME', lock: 'LOCK', power: 'LOCK', siri: 'SIRI', side: 'SIDE_BUTTON' }
// USB HID usage ids, which `idb ui key` takes.
export const IOS_KEYS = { enter: 40, escape: 41, delete: 42, backspace: 42, tab: 43, right: 79, left: 80, down: 81, up: 82 }

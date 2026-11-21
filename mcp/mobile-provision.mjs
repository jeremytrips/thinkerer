// Creates and deletes the devices Thinkerer owns: one per chat and platform,
// copied from a device the user already has (its hardware profile and OS, not
// its data). No dependencies, so the MCP server can share it.
//
// Safety: deleteDevice only ever removes devices whose name carries
// Thinkerer's prefix, so a bug elsewhere can't delete the user's own devices.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shutdown, tools } from './mobile-driver.mjs'

/** iOS simulator names and Android AVD names Thinkerer creates start with this. */
export const OWNED_IOS_PREFIX = 'Thinkerer · '
export const OWNED_AVD_PREFIX = 'Thinkerer_'
const AVD_NAME = /^[\w.-]{1,100}$/
const UDID = /^[0-9A-F-]{36}$/i

function run(cmd, args, timeout = 60_000) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || '').trim() || err.message)) : resolve(stdout)
    )
  )
}

/** Where AVDs live, following the Android emulator's own lookup order. */
export function avdHome(env = process.env) {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME
  if (env.ANDROID_EMULATOR_HOME) return join(env.ANDROID_EMULATOR_HOME, 'avd')
  if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, 'avd')
  return join(homedir(), '.android', 'avd')
}

const iniValue = (text, key) => text.match(new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s*(.*)$`, 'm'))?.[1]?.trim() ?? null

/** A display name safe for simctl and AVD config (one line, short). */
const label = (s) => String(s).replace(/[\r\n=]+/g, ' ').trim().slice(0, 60) || 'Chat'

/**
 * A new device with the same hardware and OS as `baseId`, empty of data.
 * `tag` makes the Android AVD name unique (8+ word characters); `title` is the
 * human name. Returns the new device id.
 */
export async function createDevice(baseId, { tag, title }) {
  if (!/^\w{8,40}$/.test(tag)) throw new Error('Invalid device tag')
  const [platformName, key] = [baseId.slice(0, baseId.indexOf(':')), baseId.slice(baseId.indexOf(':') + 1)]
  if (platformName === 'ios') return createSimulator(key, title)
  if (platformName === 'android') return createAvd(key, `${OWNED_AVD_PREFIX}${tag}`, title)
  throw new Error(`Invalid device id: ${baseId}`)
}

async function createSimulator(baseUdid, title) {
  const xcrun = tools().xcrun
  if (!xcrun) throw new Error('Xcode command line tools not found.')
  if (!UDID.test(baseUdid)) throw new Error(`Invalid simulator UDID: ${baseUdid}`)
  const json = JSON.parse(await run(xcrun, ['simctl', 'list', 'devices', '-j'], 20_000))
  for (const [runtime, devices] of Object.entries(json.devices ?? {})) {
    const base = devices.find((d) => d.udid === baseUdid)
    if (!base) continue
    // simctl create makes a fresh device (no data from the base), so it works while the base runs.
    const udid = (await run(xcrun, ['simctl', 'create', `${OWNED_IOS_PREFIX}${label(title)}`, base.deviceTypeIdentifier, runtime])).trim()
    if (!UDID.test(udid)) throw new Error(`simctl create returned an unexpected id: ${udid.slice(0, 100)}`)
    return `ios:${udid}`
  }
  throw new Error(`No iOS simulator with UDID ${baseUdid}`)
}

/**
 * A new AVD that shares the base's system image and hardware config. Only
 * config.ini is copied; the emulator creates a fresh data partition on first
 * boot, so this is quick and small until the device is used.
 */
export async function createAvd(baseName, name, title, env = process.env) {
  if (!AVD_NAME.test(baseName) || !AVD_NAME.test(name)) throw new Error('Invalid AVD name')
  const home = avdHome(env)
  const baseIni = await readFile(join(home, `${baseName}.ini`), 'utf8').catch(() => null)
  if (baseIni === null) throw new Error(`No Android Virtual Device named ${baseName}`)
  const baseDir = iniValue(baseIni, 'path') ?? join(home, `${baseName}.avd`)
  const config = await readFile(join(baseDir, 'config.ini'), 'utf8').catch(() => null)
  if (config === null) throw new Error(`${baseName} has no config.ini`)
  const dir = join(home, `${name}.avd`)
  if (existsSync(dir) || existsSync(join(home, `${name}.ini`))) throw new Error(`An AVD named ${name} already exists`)
  // Drop the base's identity and its data/snapshot paths, so the copy gets its own.
  const kept = config
    .split(/\r?\n/)
    .filter((l) => !/^(AvdId|avd\.ini\.displayname|disk\.dataPartition\.path|snapshot\.present|firstboot\.\w+)\s*=/.test(l))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.ini'), [`AvdId=${name}`, `avd.ini.displayname=${label(title)}`, ...kept].join('\n').replace(/\n*$/, '\n'))
  const target = iniValue(baseIni, 'target')
  await writeFile(
    join(home, `${name}.ini`),
    ['avd.ini.encoding=UTF-8', `path=${dir}`, `path.rel=avd/${name}.avd`, ...(target ? [`target=${target}`] : [])].join('\n') + '\n'
  )
  return `android:${name}`
}

/** Shuts down and deletes a device Thinkerer created. Refuses any other device. */
export async function deleteDevice(id, env = process.env) {
  const [platformName, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]
  if (platformName === 'android') {
    if (!key.startsWith(OWNED_AVD_PREFIX) || !AVD_NAME.test(key)) throw new Error(`Not a Thinkerer device: ${id}`)
    await shutdown(id).catch(() => {}) // not running is fine
    const home = avdHome(env)
    // `emu kill` returns before the emulator exits, and on exit it writes into its
    // folder again. It holds *.lock files there while running: wait for them to go.
    const dir = join(home, `${key}.avd`)
    for (const deadline = Date.now() + 45_000; Date.now() < deadline; ) {
      const locks = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.lock'))
      if (!locks.length) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await rm(dir, { recursive: true, force: true })
    await rm(join(home, `${key}.ini`), { force: true })
    return true
  }
  if (platformName === 'ios') {
    const xcrun = tools().xcrun
    if (!xcrun || !UDID.test(key)) throw new Error(`Invalid simulator: ${id}`)
    const json = JSON.parse(await run(xcrun, ['simctl', 'list', 'devices', '-j'], 20_000))
    const sim = Object.values(json.devices ?? {}).flat().find((d) => d.udid === key)
    if (!sim) return true // already gone
    if (!sim.name.startsWith(OWNED_IOS_PREFIX)) throw new Error(`Not a Thinkerer device: ${sim.name}`)
    await shutdown(id).catch(() => {})
    await run(xcrun, ['simctl', 'delete', key])
    return true
  }
  throw new Error(`Invalid device id: ${id}`)
}

/** Whether a device id or name looks like one Thinkerer created. */
export function isOwnedDevice(device) {
  return device.platform === 'android' ? device.id.startsWith(`android:${OWNED_AVD_PREFIX}`) : device.name.startsWith(OWNED_IOS_PREFIX)
}

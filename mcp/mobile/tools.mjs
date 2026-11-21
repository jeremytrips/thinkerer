// Process helpers and tool discovery for the mobile driver.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { delimiter, join } from 'node:path'

export const IOS_INPUT_HELP =
  'Touch and keyboard input for iOS simulators needs idb (simctl cannot send input). Install it with: brew install facebook/fb/idb-companion && pipx install fb-idb'

// ---------- process helpers ----------

export function run(cmd, args, { timeout = 30_000, binary = false, input } = {}) {
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

export function which(name, extra = []) {
  const dirs = [...(process.env.PATH || '').split(delimiter), ...extra]
  const exts = platform() === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of dirs) for (const ext of exts) {
    if (dir && existsSync(join(dir, name + ext))) return join(dir, name + ext)
  }
  return null
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

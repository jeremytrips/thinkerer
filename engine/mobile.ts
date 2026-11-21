import * as driver from '../mcp/mobile-driver.mjs'
import * as provision from '../mcp/mobile-provision.mjs'
import type { DeviceTools } from './chatDevices'
import type { MobileDevice, MobileFrame, MobileToolStatus } from '../shared/types'

// Real Android emulators and iOS simulators for the Emulator panel. The
// driver (plain JS in mcp/) is shared with the `mobile` MCP server the agent
// uses, so the user and the agent control the very same devices.

const ID = /^(android|ios):[\w.:-]{1,100}$/

export function deviceId(v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new Error('Invalid device id')
  return v
}

export const mobile = {
  status: (): MobileToolStatus => driver.toolStatus(),
  list: (): Promise<MobileDevice[]> => driver.listDevices(),
  /** Always headless: the Emulator panel shows the screen. */
  boot: (id: string) => driver.boot(id, { window: false }),
  shutdown: (id: string) => driver.shutdown(id),
  /** A live-view frame: JPEG on iOS (full-size PNGs are several MB), PNG on Android. */
  async frame(id: string): Promise<MobileFrame> {
    const shot = await driver.screenshot(id, { format: 'jpeg' })
    return { dataUrl: `data:${shot.mimeType};base64,${shot.data.toString('base64')}`, scale: shot.scale, width: shot.width, height: shot.height }
  },
  /** Full-resolution PNG for attaching to a prompt. */
  async png(id: string): Promise<Buffer> {
    return (await driver.screenshot(id, { format: 'png' })).data
  },
  tap: (id: string, x: number, y: number, durationMs = 0) => driver.tap(id, x, y, { durationMs }),
  swipe: (id: string, x1: number, y1: number, x2: number, y2: number, durationMs = 300) => driver.swipe(id, x1, y1, x2, y2, { durationMs }),
  type: (id: string, text: string) => driver.typeText(id, text),
  key: (id: string, key: string) => driver.pressKey(id, key),
  openUrl: (id: string, url: string) => driver.openUrl(id, url),
  keys: driver.KEYS
}

/** The real platform tools for per-chat devices (engine/chatDevices). */
export const deviceTools: DeviceTools = {
  list: () => driver.listDevices(),
  available: () => {
    const s = driver.toolStatus()
    return { ios: s.ios.available, android: s.android.available }
  },
  create: (baseId, opts) => provision.createDevice(baseId, opts),
  remove: (id) => provision.deleteDevice(id),
  isOwned: (d) => provision.isOwnedDevice(d)
}

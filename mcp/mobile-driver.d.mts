// Types for mobile-driver.mjs (plain JS so the MCP server runs without a build).
import type { MobileDevice, MobileToolStatus } from '../shared/types'

export declare const IOS_INPUT_HELP: string
/** idb errors that mean its companion went stale; the driver restarts it and retries once. */
export declare const STALE_IDB: RegExp
export declare const KEYS: string[]
export interface MobileScreenshot {
  data: Buffer
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  /** Image pixels per logical point. */
  scale: number
  pointWidth: number
  pointHeight: number
}
export declare function tools(): Record<'androidSdk' | 'adb' | 'emulator' | 'xcrun' | 'idb' | 'sips', string | null>
export declare function toolStatus(): MobileToolStatus
export declare function listDevices(): Promise<MobileDevice[]>
export declare function boot(id: string, opts?: { window?: boolean }): Promise<MobileDevice | null>
export declare function shutdown(id: string): Promise<boolean>
export declare function screenshot(id: string, opts?: { logical?: boolean; format?: 'png' | 'jpeg' }): Promise<MobileScreenshot>
export declare function tap(id: string, x: number, y: number, opts?: { durationMs?: number }): Promise<boolean>
export declare function swipe(id: string, x1: number, y1: number, x2: number, y2: number, opts?: { durationMs?: number }): Promise<boolean>
export declare function typeText(id: string, text: string): Promise<boolean>
export declare function pressKey(id: string, key: string): Promise<boolean>
export declare function openUrl(id: string, url: string): Promise<boolean>
export declare function installApp(id: string, path: string): Promise<boolean>
export declare function launchApp(id: string, appId: string): Promise<boolean>
export declare function terminateApp(id: string, appId: string): Promise<boolean>
export declare function listApps(id: string): Promise<{ id: string; name?: string; type?: string }[]>
export declare function describeUi(id: string): Promise<unknown[]>
export declare function logs(id: string, opts?: { lines?: number }): Promise<string>

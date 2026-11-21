// Types for mobile-provision.mjs.
import type { MobileDevice } from '../shared/types'

export declare const OWNED_IOS_PREFIX: string
export declare const OWNED_AVD_PREFIX: string
export declare function avdHome(env?: NodeJS.ProcessEnv): string
export declare function createDevice(baseId: string, opts: { tag: string; title: string }): Promise<string>
export declare function createAvd(baseName: string, name: string, title: string, env?: NodeJS.ProcessEnv): Promise<string>
export declare function deleteDevice(id: string, env?: NodeJS.ProcessEnv): Promise<boolean>
export declare function isOwnedDevice(device: Pick<MobileDevice, 'id' | 'name' | 'platform'>): boolean

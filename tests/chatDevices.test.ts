import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatDevices, deviceScope, type DeviceTools } from '../engine/chatDevices'
import { createAvd, deleteDevice, isOwnedDevice } from '../mcp/mobile-provision.mjs'
import type { MobileDevice } from '../shared/types'

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-devices-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Stand-in for the platform tools: an in-memory device list. */
function fakeTools(initial: MobileDevice[], available = { ios: true, android: true }) {
  const devices = [...initial]
  const removed: string[] = []
  let n = 0
  const tools: DeviceTools = {
    list: async () => devices.map((d) => ({ ...d })),
    available: () => available,
    create: async (baseId, { title }) => {
      const base = devices.find((d) => d.id === baseId)!
      const id = base.platform === 'ios' ? `ios:OWNED-${++n}` : `android:Thinkerer_${++n}`
      devices.push({ ...base, id, name: `Thinkerer · ${title}`, state: 'shutdown' })
      return id
    },
    remove: async (id) => {
      removed.push(id)
      devices.splice(devices.findIndex((d) => d.id === id), 1)
      return true
    },
    isOwned: (d) => d.id.includes('OWNED') || d.id.startsWith('android:Thinkerer_')
  }
  return { tools, devices, removed }
}

const dev = (id: string, platform: 'ios' | 'android', name: string, detail = ''): MobileDevice => ({
  id, platform, name, kind: platform === 'ios' ? 'simulator' : 'emulator', state: 'booted', detail, input: true
})

describe('per-chat devices', () => {
  const mine = [dev('ios:OLD', 'ios', 'iPhone 15', 'iOS 18.6'), dev('ios:NEW', 'ios', 'iPhone 17 Pro', 'iOS 26.5'), dev('ios:PAD', 'ios', 'iPad Air', 'iOS 26.5'), dev('android:Pixel', 'android', 'Pixel')]

  it('gives each chat its own device per platform, copied from the newest iPhone and the first AVD', async () => {
    const { tools } = fakeTools(mine)
    const store = new ChatDevices(tmp, tools)
    const a = await store.ensure(deviceScope('p', 'chat-a'), 'Chat A')
    const b = await store.ensure(deviceScope('p', 'chat-b'), 'Chat B')
    expect(a.problems).toEqual([])
    expect(a.ids).toHaveLength(2)
    expect(b.ids).toHaveLength(2)
    expect(a.ids.some((id) => b.ids.includes(id))).toBe(false)

    const view = await store.view(deviceScope('p', 'chat-a'))
    expect(view.devices.map((d) => d.platform).sort()).toEqual(['android', 'ios'])
    expect(view.devices.find((d) => d.platform === 'ios')!.name).toBe('Chat A (iPhone 17 Pro)')
    // Templates are the user's own devices only, never another chat's.
    expect(view.templates.map((d) => d.id)).toEqual(mine.map((d) => d.id))

    // Running again keeps the same devices.
    expect((await store.ensure(deviceScope('p', 'chat-a'), 'Chat A')).ids).toEqual(a.ids)
  })

  it('remembers the template the user picked for new chats, and refuses a second device per platform', async () => {
    const { tools } = fakeTools(mine)
    const store = new ChatDevices(tmp, tools)
    const scope = deviceScope('p', 'chat-a')
    await store.create(scope, 'ios:PAD', 'Chat A')
    await expect(store.create(scope, 'ios:NEW', 'Chat A')).rejects.toThrow(/already has an iOS device/)
    await expect(store.create(scope, (await store.ids(scope))[0], 'Chat A')).rejects.toThrow(/your own/)
    await store.ensure(deviceScope('p', 'chat-b'), 'Chat B')
    const b = await store.view(deviceScope('p', 'chat-b'))
    expect(b.devices.find((d) => d.platform === 'ios')!.name).toBe('Chat B (iPad Air)')
  })

  it('deletes only the chat’s own devices, and all of them when the chat is cleaned up', async () => {
    const { tools, removed } = fakeTools(mine)
    const store = new ChatDevices(tmp, tools)
    const a = await store.ensure(deviceScope('p', 'chat-a'), 'A')
    const b = await store.ensure(deviceScope('p', 'chat-b'), 'B')
    await expect(store.remove(deviceScope('p', 'chat-a'), b.ids[0])).rejects.toThrow(/Not one of this chat/)
    expect(await store.removeAll(deviceScope('p', 'chat-a'))).toEqual([])
    expect(removed.sort()).toEqual([...a.ids].sort())
    expect(await store.ids(deviceScope('p', 'chat-a'))).toEqual([])
    expect(await store.ids(deviceScope('p', 'chat-b'))).toEqual(b.ids)
  })

  it('skips platforms without tools or templates, and keeps a record while the list is briefly empty', async () => {
    const { tools, devices } = fakeTools([dev('ios:NEW', 'ios', 'iPhone 17 Pro', 'iOS 26.5')], { ios: true, android: true })
    const store = new ChatDevices(tmp, tools)
    const scope = deviceScope('p', null)
    const first = await store.ensure(scope, 'Project')
    expect(first.ids).toHaveLength(1)
    expect(first.problems).toEqual(['No Android device to copy for this chat'])
    // Listing fails for a moment (nothing listed): the device is not replaced by a duplicate.
    const saved = devices.splice(0, devices.length)
    expect((await store.ensure(scope, 'Project')).ids).toEqual(first.ids)
    devices.push(...saved)
    expect((await store.view(scope)).devices.map((d) => d.id)).toEqual(first.ids)
  })
})

describe('Android device copies', () => {
  function baseAvd(home: string) {
    mkdirSync(join(home, 'Pixel.avd'), { recursive: true })
    writeFileSync(join(home, 'Pixel.ini'), `avd.ini.encoding=UTF-8\npath=${join(home, 'Pixel.avd')}\npath.rel=avd/Pixel.avd\ntarget=android-37.0\n`)
    writeFileSync(
      join(home, 'Pixel.avd', 'config.ini'),
      'AvdId=Pixel\navd.ini.displayname=Pixel\ndisk.dataPartition.path=<temp>\nhw.lcd.width=1080\nimage.sysdir.1=system-images/android-37.0/google_apis/arm64-v8a/\n'
    )
    writeFileSync(join(home, 'Pixel.avd', 'userdata-qemu.img'), 'user data')
  }

  it('copies only the hardware config, with its own identity and no data', async () => {
    const home = join(tmp, 'avd')
    baseAvd(home)
    const env = { ANDROID_AVD_HOME: home }
    expect(await createAvd('Pixel', 'Thinkerer_abc123def456', 'My chat\nname=evil', env)).toBe('android:Thinkerer_abc123def456')
    const config = readFileSync(join(home, 'Thinkerer_abc123def456.avd', 'config.ini'), 'utf8')
    expect(config).toContain('AvdId=Thinkerer_abc123def456\n')
    expect(config).toContain('avd.ini.displayname=My chat name evil\n')
    expect(config).toContain('hw.lcd.width=1080\n')
    expect(config).toContain('image.sysdir.1=system-images/android-37.0/google_apis/arm64-v8a/\n')
    expect(config).not.toContain('AvdId=Pixel')
    expect(config).not.toContain('disk.dataPartition.path')
    expect(existsSync(join(home, 'Thinkerer_abc123def456.avd', 'userdata-qemu.img'))).toBe(false)
    expect(readFileSync(join(home, 'Thinkerer_abc123def456.ini'), 'utf8')).toContain('target=android-37.0')
    await expect(createAvd('Pixel', 'Thinkerer_abc123def456', 'again', env)).rejects.toThrow(/already exists/)
    await expect(createAvd('Nope', 'Thinkerer_x', 'x', env)).rejects.toThrow(/No Android Virtual Device/)
  })

  it('deletes Thinkerer copies and refuses to delete the user’s own devices', async () => {
    const home = join(tmp, 'avd')
    baseAvd(home)
    const env = { ANDROID_AVD_HOME: home }
    await createAvd('Pixel', 'Thinkerer_abc123def456', 'chat', env)
    await expect(deleteDevice('android:Pixel', env)).rejects.toThrow(/Not a Thinkerer device/)
    expect(existsSync(join(home, 'Pixel.avd', 'config.ini'))).toBe(true)
    expect(await deleteDevice('android:Thinkerer_abc123def456', env)).toBe(true)
    expect(existsSync(join(home, 'Thinkerer_abc123def456.avd'))).toBe(false)
    expect(existsSync(join(home, 'Thinkerer_abc123def456.ini'))).toBe(false)
    expect(isOwnedDevice({ id: 'android:Thinkerer_abc', name: 'x', platform: 'android' })).toBe(true)
    expect(isOwnedDevice({ id: 'ios:1', name: 'iPhone 17 Pro', platform: 'ios' })).toBe(false)
    expect(isOwnedDevice({ id: 'ios:1', name: 'Thinkerer · chat', platform: 'ios' })).toBe(true)
  })
})

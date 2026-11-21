import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ChatDevicesView, MobileDevice, MobilePlatform } from '../shared/types'
import { readJson, writeJson } from './store'

// Each chat (and a project folder's own runs) gets its own emulator per
// platform, so two chats never fight over one device's screen or state. The
// devices are created from one of the user's own devices (same hardware and OS,
// fresh data) and deleted when the chat's worktree goes away. The user's own
// devices are never handed to a chat directly; they are only templates.

/** What the store needs from the platform tools (mcp/mobile-driver + mobile-provision in the app). */
export interface DeviceTools {
  list(): Promise<MobileDevice[]>
  available(): Record<MobilePlatform, boolean>
  create(baseId: string, opts: { tag: string; title: string }): Promise<string>
  remove(id: string): Promise<boolean>
  isOwned(device: MobileDevice): boolean
}

interface OwnedDevice {
  id: string
  platform: MobilePlatform
  name: string
  baseId: string
  createdAt: string
}

interface DevicesFile {
  schemaVersion: 1
  scopes: Record<string, OwnedDevice[]>
  /** Last template the user picked per platform; new chats copy it. */
  defaults: Partial<Record<MobilePlatform, string>>
}

const PLATFORMS: MobilePlatform[] = ['ios', 'android']
const PLATFORM_NAME: Record<MobilePlatform, string> = { ios: 'iOS', android: 'Android' }

/** A chat's scope key, or the project folder's when there is no chat. */
export function deviceScope(projectId: string, chatId: string | null): string {
  return chatId ? `chat:${chatId}` : `project:${projectId}`
}

export class ChatDevices {
  private readonly file: string
  private lock: Promise<unknown> = Promise.resolve()

  constructor(
    appDataDir: string,
    private readonly tools: DeviceTools
  ) {
    this.file = join(appDataDir, 'chat-devices.json')
  }

  /** The scope's devices (live state), and the user's devices it can copy from. */
  async view(scope: string): Promise<ChatDevicesView> {
    const [data, live] = await Promise.all([this.read(), this.tools.list()])
    const byId = new Map(live.map((d) => [d.id, d]))
    // Records of devices missing from the list are kept: listing can fail for a moment.
    // create()/ensure() replace them once the platform is clearly listing fine.
    const owned = (data.scopes[scope] ?? []).filter((o) => byId.has(o.id))
    return {
      devices: owned.map((o) => ({ ...byId.get(o.id)!, name: o.name })),
      templates: live.filter((d) => d.kind !== 'device' && !this.tools.isOwned(d)),
      defaults: data.defaults
    }
  }

  async ids(scope: string): Promise<string[]> {
    return ((await this.read()).scopes[scope] ?? []).map((o) => o.id)
  }

  /** The name a chat's device was given ("<chat> (<template>)"), for labels; null if no chat owns it. */
  async nameOf(id: string): Promise<string | null> {
    return Object.values((await this.read()).scopes).flat().find((o) => o.id === id)?.name ?? null
  }

  async owns(scope: string, id: string): Promise<boolean> {
    return (await this.ids(scope)).includes(id)
  }

  /** Creates the scope's device for the template's platform (one per platform). */
  async create(scope: string, templateId: string, title: string): Promise<MobileDevice> {
    return this.serial(async () => {
      const live = await this.tools.list()
      const template = live.find((d) => d.id === templateId)
      if (!template || this.tools.isOwned(template)) throw new Error('Pick one of your own emulators or simulators to copy')
      const data = await this.read()
      const mine = data.scopes[scope] ?? []
      const existing = mine.find((o) => o.platform === template.platform && live.some((d) => d.id === o.id))
      if (existing) throw new Error(`This chat already has an ${PLATFORM_NAME[template.platform]} device. Delete it first to pick another.`)
      const id = await this.tools.create(templateId, { tag: tagOf(scope, template.platform), title })
      const name = `${title} (${template.name})`
      data.scopes[scope] = [...mine.filter((o) => o.platform !== template.platform), { id, platform: template.platform, name, baseId: templateId, createdAt: new Date().toISOString() }]
      data.defaults[template.platform] = templateId
      await this.write(data)
      const created = (await this.tools.list()).find((d) => d.id === id)
      return { ...(created ?? { ...template, state: 'shutdown' as const }), id, name }
    })
  }

  /**
   * Makes sure the scope has a device for every platform whose tools are
   * installed, copying the last template the user picked (or a sensible
   * default). Returns the scope's device ids. Platforms that can't get one
   * (no templates, creation failed) are reported, not thrown.
   */
  async ensure(scope: string, title: string): Promise<{ ids: string[]; problems: string[] }> {
    const problems: string[] = []
    const available = this.tools.available()
    for (const platform of PLATFORMS) {
      if (!available[platform]) continue
      const view = await this.view(scope)
      if (view.devices.some((d) => d.platform === platform)) continue
      // A recorded device that isn't listed only counts as gone if other devices of that platform are.
      const recorded = (await this.read()).scopes[scope]?.some((o) => o.platform === platform)
      if (recorded && !view.templates.some((d) => d.platform === platform)) continue
      const templates = view.templates.filter((d) => d.platform === platform)
      const template = templates.find((d) => d.id === view.defaults[platform]) ?? pickDefault(templates)
      if (!template) {
        problems.push(`No ${PLATFORM_NAME[platform]} device to copy for this chat`)
        continue
      }
      try {
        await this.create(scope, template.id, title)
      } catch (err) {
        problems.push(`Could not create this chat's ${PLATFORM_NAME[platform]} device: ${(err as Error).message}`)
      }
    }
    return { ids: await this.ids(scope), problems }
  }

  /** Shuts down and deletes one of the scope's devices. */
  async remove(scope: string, id: string): Promise<boolean> {
    return this.serial(async () => {
      const data = await this.read()
      if (!(data.scopes[scope] ?? []).some((o) => o.id === id)) throw new Error('Not one of this chat’s devices')
      await this.tools.remove(id)
      data.scopes[scope] = (data.scopes[scope] ?? []).filter((o) => o.id !== id)
      if (!data.scopes[scope].length) delete data.scopes[scope]
      await this.write(data)
      return true
    })
  }

  /** Deletes all of the scope's devices (the chat's worktree is gone). Errors are returned, not thrown. */
  async removeAll(scope: string): Promise<string[]> {
    const errors: string[] = []
    for (const id of await this.ids(scope)) {
      await this.remove(scope, id).catch((err: Error) => errors.push(`${id}: ${err.message}`))
    }
    return errors
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn)
    this.lock = next.catch(() => {})
    return next
  }

  private async read(): Promise<DevicesFile> {
    const data = await readJson<DevicesFile>(this.file).catch(() => null)
    return data?.schemaVersion === 1 ? { ...data, scopes: data.scopes ?? {}, defaults: data.defaults ?? {} } : { schemaVersion: 1, scopes: {}, defaults: {} }
  }

  private write(data: DevicesFile): Promise<void> {
    return writeJson(this.file, data)
  }
}

/** Short, stable, filesystem-safe tag for a scope's device (Android AVD names). */
function tagOf(scope: string, platform: MobilePlatform): string {
  return createHash('sha256').update(`${scope}:${platform}`).digest('hex').slice(0, 12)
}

/** The newest iPhone, or the first AVD. */
function pickDefault(templates: MobileDevice[]): MobileDevice | undefined {
  const version = (d: MobileDevice) => Number(d.detail.match(/(\d+)\.(\d+)/)?.slice(1).reduce((a, b) => Number(a) * 1000 + Number(b), 0) ?? 0)
  return [...templates].sort((a, b) => Number(/iPhone/.test(b.name)) - Number(/iPhone/.test(a.name)) || version(b) - version(a))[0]
}

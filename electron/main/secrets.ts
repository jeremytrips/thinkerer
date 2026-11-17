import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { SecretStore } from '../../engine/mcp'
import { readJson, writeJson } from '../../engine/store'

type SecretsFile = Record<string, Record<string, string>> // serverId → name → base64 ciphertext

/**
 * MCP secrets encrypted with Electron safeStorage (macOS Keychain / Windows
 * DPAPI / libsecret). Stored in app data, never in a project or a log.
 */
export class SafeSecretStore implements SecretStore {
  private readonly file: string

  constructor(appDataDir: string) {
    this.file = join(appDataDir, 'secrets.json')
  }

  async get(serverId: string, name: string): Promise<string | null> {
    const enc = (await this.read())[serverId]?.[name]
    if (!enc) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }

  async set(serverId: string, name: string, value: string | null): Promise<void> {
    const all = await this.read()
    if (value === null) {
      if (all[serverId]) delete all[serverId][name]
    } else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential storage is not available on this system')
      all[serverId] = { ...all[serverId], [name]: safeStorage.encryptString(value).toString('base64') }
    }
    await writeJson(this.file, all)
  }

  async names(serverId: string): Promise<string[]> {
    return Object.keys((await this.read())[serverId] ?? {})
  }

  private async read(): Promise<SecretsFile> {
    return (await readJson<SecretsFile>(this.file).catch(() => null)) ?? {}
  }
}

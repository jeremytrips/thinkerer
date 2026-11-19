import { join } from 'node:path'
import { readJson, writeJson } from './store'

// Commands from .thinkerer/project.json run with the user's permissions, and an
// agent can edit that file, so each one only runs once the user has approved
// that exact text. One approved command per project and kind.

export type CommandKind = 'dev' | 'setup' | 'teardown'

type ApprovalsFile = Record<string, Partial<Record<CommandKind, string>>>

export class Approvals {
  private readonly file: string
  /** Dev-command approvals from before hooks existed: projectId → command. */
  private readonly legacyFile: string

  constructor(appDataDir: string) {
    this.file = join(appDataDir, 'approved-commands.json')
    this.legacyFile = join(appDataDir, 'approved-dev-commands.json')
  }

  async isApproved(projectId: string, kind: CommandKind, command: string): Promise<boolean> {
    const all = await this.read()
    const approved = all[projectId]?.[kind] ?? (kind === 'dev' ? (await this.legacy())[projectId] : undefined)
    return approved === command
  }

  async approve(projectId: string, kind: CommandKind, command: string): Promise<void> {
    const all = await this.read()
    all[projectId] = { ...all[projectId], [kind]: command }
    await writeJson(this.file, all)
  }

  private async read(): Promise<ApprovalsFile> {
    return (await readJson<ApprovalsFile>(this.file).catch(() => null)) ?? {}
  }

  private async legacy(): Promise<Record<string, string>> {
    return (await readJson<Record<string, string>>(this.legacyFile).catch(() => null)) ?? {}
  }
}

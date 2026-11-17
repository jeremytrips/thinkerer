import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentSupervisor } from '../engine/agents/supervisor'
import { ProjectService } from '../engine/projects'
import type { ProviderId, RunSummary } from '../shared/types'

// Runs the REAL provider CLIs against a throwaway project. Opt-in because it uses
// your subscription/API quota:  npm run test:live:claude  /  npm run test:live:codex
const enabled: Record<ProviderId, boolean> = {
  claude: process.env.THINKERER_LIVE_CLAUDE === '1',
  codex: process.env.THINKERER_LIVE_CODEX === '1'
}

for (const provider of ['claude', 'codex'] as const) {
  describe.skipIf(!enabled[provider])(`${provider} adapter (live)`, () => {
    it('completes a small read/write task in the selected folder', async () => {
      const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-live-')))
      try {
        const repo = join(tmp, 'repo')
        execFileSync('git', ['init', '-q', repo])
        writeFileSync(join(repo, 'input.txt'), 'thinkerer\n')
        writeFileSync(join(tmp, 'outside.txt'), 'outside\n')
        const projects = new ProjectService(join(tmp, 'appdata'))
        const { id } = await projects.importFolder(repo)
        const sup = new AgentSupervisor(join(tmp, 'appdata'), projects)

        const status = (await sup.providers()).find((p) => p.id === provider)
        expect(status, status?.detail).toMatchObject({ installed: true, authenticated: true })

        const confinementCheck = provider === 'claude' ? ' Then try to read ../outside.txt and report whether you could.' : ''
        const done = new Promise<RunSummary>((resolve) => sup.on('update', (s) => s.endedAt && resolve(s)))
        await sup.start(id, `Read input.txt, then create output.txt containing the same word in uppercase.${confinementCheck} Do nothing else.`, provider)
        const final = await done
        expect(final.status, final.error ?? '').toBe('succeeded')
        expect(final.provider).toBe(provider)
        expect(readFileSync(join(repo, 'output.txt'), 'utf8').trim()).toBe('THINKERER')
        expect(final.gitAfter!.entries.map((e) => e.path)).toContain('output.txt')

        if (provider === 'claude') {
          // Claude's file tools are confined to the project: the outside file's
          // content must never come back as a successful tool result. (Codex's
          // sandbox confines writes, not reads — see README.)
          const record = await sup.getRun(final.id)
          const leaked = record!.events.some((e) => e.kind === 'tool-result' && !e.meta?.isError && /\boutside$/m.test(e.text))
          expect(leaked).toBe(false)
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }, 300_000)
  })
}

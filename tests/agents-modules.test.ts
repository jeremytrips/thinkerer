import { describe, expect, it } from 'vitest'
import type { ChatRecord, ProviderId, ProviderStatus } from '../shared/types'
import type { ResolvedMcpServer } from '../engine/mcp'
import { attachmentNote, buildInstructions } from '../engine/agents/prompt'
import { missingAdapter, rateLimitUntil, selectProvider } from '../engine/agents/providerSelect'
import type { Workspace } from '../engine/agents/runState'

const status = (id: ProviderId, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  ...missingAdapter(id),
  installed: true,
  adapterAvailable: true,
  authenticated: true,
  executable: `/bin/${id}`,
  ...over
})

describe('selectProvider', () => {
  const statuses = [status('claude'), status('codex')]

  it('rejects a manual choice that is not usable, saying why', () => {
    expect(() => selectProvider([status('claude', { authenticated: false }), status('codex')], 'claude', new Map())).toThrow('Claude Code is unavailable: not logged in')
  })

  it('takes a usable manual choice as is', () => {
    expect(selectProvider(statuses, 'codex', new Map())).toMatchObject({ provider: 'codex', rationale: 'manually selected' })
  })

  it('Auto skips a provider that is cooling down after a rate limit', () => {
    const now = 1_000_000
    const picked = selectProvider(statuses, 'auto', new Map([['claude', now + 60_000]]), now)
    expect(picked.provider).toBe('codex')
    expect(picked.rationale).toContain('skipped Claude Code (cooling down after a rate limit)')
  })

  it('Auto fails when no provider is usable', () => {
    expect(() => selectProvider([missingAdapter('claude'), status('codex', { installed: false })], 'auto', new Map())).toThrow(
      'No usable agent provider: Claude Code (not installed); Codex (not installed)'
    )
  })

  it('cools down at least five minutes, or until the latest reported reset', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(rateLimitUntil({ windows: {} } as never, now)).toBe(now + 5 * 60_000)
    const reset = '2026-01-01T02:00:00Z'
    expect(rateLimitUntil({ windows: { five_hour: { resetsAt: reset } } } as never, now)).toBe(Date.parse(reset))
  })
})

describe('buildInstructions', () => {
  const folder: Workspace = { chat: null, cwd: '/p', env: {}, previewUrl: null }

  it('adds the plan-mode lines only in plan mode', () => {
    expect(buildInstructions('BASE', [], folder, 'plan', undefined, '')).toContain('This message is in plan mode')
    expect(buildInstructions('BASE', [], folder, 'auto', undefined, '')).not.toContain('plan mode')
  })

  it('describes the chat worktree and its ports', () => {
    const chat = { worktree: { branch: 'thinkerer/x', base: 'main' }, ports: [4100, 4101], composeProject: 'proj-x' } as unknown as ChatRecord
    const text = buildInstructions('BASE', [], { ...folder, chat }, 'auto', undefined, '')
    expect(text.startsWith('BASE ')).toBe(true)
    expect(text).toContain('own Git worktree on branch thinkerer/x (created from main)')
    expect(text).toContain('THINKERER_PORT_1=4100, THINKERER_PORT_2=4101')
    expect(text).toContain('COMPOSE_PROJECT_NAME=proj-x')
  })

  it('mentions the browser check only with playwright and a preview URL', () => {
    const pw = [{ id: 'playwright' }] as ResolvedMcpServer[]
    expect(buildInstructions('B', pw, { ...folder, previewUrl: 'http://localhost:4100' }, 'auto', undefined, '')).toContain('against http://localhost:4100')
    expect(buildInstructions('B', pw, folder, 'auto', undefined, '')).not.toContain('PASSED or FAILED')
  })

  it('tells the agent to skip the browser check when the preview is down', () => {
    const pw = [{ id: 'playwright' }] as ResolvedMcpServer[]
    const text = buildInstructions('B', pw, { ...folder, previewUrl: 'http://localhost:4100' }, 'auto', undefined, '', '', false)
    expect(text).toContain('The preview at http://localhost:4100 is not running, so skip the browser check')
    expect(text).not.toContain('PASSED or FAILED')
  })

  it('puts extra instructions before the project instructions, which come last', () => {
    const text = buildInstructions('B', [], folder, 'auto', undefined, 'STAGE', '# Rules')
    expect(text.indexOf('STAGE')).toBeLessThan(text.indexOf('Project instructions'))
    expect(text.endsWith('Project instructions from the repository (follow them):\n\n# Rules')).toBe(true)
  })
})

describe('attachmentNote', () => {
  it('is empty without attachments', () => {
    expect(attachmentNote([])).toBe('')
  })

  it('lists each screenshot with its page and console errors', () => {
    const note = attachmentNote([{ id: 'a1b2', url: 'http://localhost:4100/x', consoleErrors: ['boom'], at: '' }])
    expect(note).toContain('a screenshot of the site')
    expect(note).toContain('Page: http://localhost:4100/x')
    expect(note).toContain('   - boom')
  })
})

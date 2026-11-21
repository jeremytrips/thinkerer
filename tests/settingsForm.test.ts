import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../engine/projects'
import { formFromConfig, isDirty, patchFromForm } from '../src/settingsForm'

const config = normalizeConfig(
  {
    name: 'Demo',
    components: ['website', 'mobile'],
    worktrees: { setupCommand: 'npm ci', teardownCommand: '', ports: 2 },
    agent: { provider: 'claude', enabledMcpServers: [], claude: { model: 'opus', effort: 'high', tools: ['Skill', 'Task'] } },
    protocol: { checkCommand: 'npm test', maxReviewRounds: 3, review: { model: 'sonnet', effort: '' } }
  },
  'fallback'
)

function patchOf(form: ReturnType<typeof formFromConfig>) {
  const result = patchFromForm(form)
  if ('error' in result) throw new Error(result.error)
  return result.patch
}

describe('settings form', () => {
  it('round-trips the config into a patch with the same values', () => {
    const patch = patchOf(formFromConfig(config))
    expect(patch).toEqual({
      name: 'Demo',
      components: ['website', 'mobile'],
      target: 'web',
      website: { devCommand: config.website.devCommand, previewUrl: config.website.previewUrl },
      agent: { provider: 'claude', claude: { model: 'opus', effort: 'high', tools: config.agent.claude.tools } },
      worktrees: { setupCommand: 'npm ci', teardownCommand: '', ports: 2 },
      protocol: { checkCommand: 'npm test', maxReviewRounds: 3, review: { model: 'sonnet', effort: '' } }
    })
  })

  it.each(['', ' ', '2.5', '-1', '11', 'abc'])('rejects ports %j', (ports) => {
    expect(patchFromForm({ ...formFromConfig(config), ports })).toEqual({ error: expect.stringMatching(/^Ports per worktree/) })
  })

  it.each(['', '0', '6', '1.5'])('rejects review rounds %j', (reviewRounds) => {
    expect(patchFromForm({ ...formFromConfig(config), reviewRounds })).toEqual({ error: expect.stringMatching(/^Review rounds/) })
  })

  it('accepts the range limits and surrounding spaces', () => {
    expect(patchOf({ ...formFromConfig(config), ports: ' 0 ', reviewRounds: '5' })).toMatchObject({ worktrees: { ports: 0 }, protocol: { maxReviewRounds: 5 } })
    expect(patchOf({ ...formFromConfig(config), ports: '10', reviewRounds: '1' })).toMatchObject({ worktrees: { ports: 10 }, protocol: { maxReviewRounds: 1 } })
  })

  it('rejects an empty display name', () => {
    expect(patchFromForm({ ...formFromConfig(config), name: '   ' })).toEqual({ error: 'Display name cannot be empty' })
  })

  it('tracks whether the form differs from the stored config', () => {
    const form = formFromConfig(config)
    expect(isDirty(form, config)).toBe(false)
    expect(isDirty({ ...form, devCommand: 'npm start' }, config)).toBe(true)
    expect(isDirty({ ...form, ports: '3' }, config)).toBe(true)
    expect(isDirty({ ...form, components: ['website'] }, config)).toBe(true)
  })

  it('ignores differences the server normalises away', () => {
    const form = formFromConfig(config)
    expect(isDirty({ ...form, name: '  Demo  ', model: 'opus ', checkCommand: ' npm test', reviewModel: 'sonnet ' }, config)).toBe(false)
    expect(isDirty({ ...form, components: ['mobile', 'website'], claudeTools: [...form.claudeTools].reverse() }, config)).toBe(false)
  })

  it('sends a model of only spaces as empty, which the server accepts as "default"', () => {
    const patch = patchOf({ ...formFromConfig(config), model: '   ', reviewModel: ' sonnet ' })
    expect(patch.agent?.claude?.model).toBe('')
    expect(patch.protocol?.review?.model).toBe('sonnet')
  })

  it('checks the server length limits with messages that say what to fix', () => {
    const form = formFromConfig(config)
    expect(patchFromForm({ ...form, name: 'x'.repeat(101) })).toEqual({ error: 'Display name must be 100 characters or fewer' })
    expect(patchOf({ ...form, name: ` ${'x'.repeat(100)} ` }).name).toBe('x'.repeat(100))
    expect(patchFromForm({ ...form, checkCommand: 'x'.repeat(501) })).toEqual({ error: 'Check command must be 500 characters or fewer' })
    expect(patchFromForm({ ...form, setupCommand: 'x'.repeat(501) })).toEqual({ error: 'Setup command must be 500 characters or fewer' })
  })

  it('treats numbers with leading zeros as the value they save', () => {
    const form = formFromConfig(config)
    expect(isDirty({ ...form, ports: '02', reviewRounds: ' 003' }, config)).toBe(false)
    expect(patchOf({ ...form, ports: '02' }).worktrees?.ports).toBe(2)
  })
})

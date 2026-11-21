import { describe, expect, it } from 'vitest'
import { composerMode } from '../src/views/composerMode'

describe('composerMode', () => {
  const base = { hasChat: true, protocolChat: true, stage: 'plan' as const, mode: 'auto' as const }
  it('turns a plain approval at the plan stage into implementation, and keeps other replies read-only', () => {
    expect(composerMode({ ...base, draft: 'ok implement' })).toEqual({ approving: true, planning: false })
    expect(composerMode({ ...base, draft: 'ok, but drop step 3' })).toEqual({ approving: false, planning: true })
  })
  it('follows the stage in protocol chats and the picker elsewhere', () => {
    expect(composerMode({ ...base, stage: 'implement', draft: 'ok' })).toEqual({ approving: false, planning: false })
    expect(composerMode({ ...base, hasChat: false, stage: undefined, draft: 'ok' })).toEqual({ approving: false, planning: true })
    expect(composerMode({ ...base, protocolChat: false, stage: undefined, mode: 'plan', draft: 'ok' })).toEqual({ approving: false, planning: true })
  })
})

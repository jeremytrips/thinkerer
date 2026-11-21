import type { ProviderChoice, ProviderId, ProviderStatus, UsageObservation } from '../../shared/types'
import { DEFAULT_PREFERENCE } from './policy'

export interface ProviderSelection {
  provider: ProviderId
  rationale: string
  status: ProviderStatus
}

/**
 * Picks the provider for a new chat. A manual choice must be usable; Auto takes
 * the first usable provider in the preference order that is not cooling down.
 */
export function selectProvider(statuses: ProviderStatus[], requested: ProviderChoice, cooldownUntil: ReadonlyMap<ProviderId, number>, now = Date.now()): ProviderSelection {
  const usable = (s: ProviderStatus) => s.installed && s.adapterAvailable && s.authenticated !== false
  const why = (s: ProviderStatus) =>
    !s.installed ? 'not installed' : !s.adapterAvailable ? 'no adapter in this build' : s.authenticated === false ? 'not logged in' : 'cooling down after a rate limit'

  if (requested !== 'auto') {
    const s = statuses.find((x) => x.id === requested)!
    if (!usable(s)) throw new Error(`${s.label} is unavailable: ${why(s)}`)
    return { provider: requested, rationale: 'manually selected', status: s }
  }

  const skipped: string[] = []
  for (const id of DEFAULT_PREFERENCE) {
    const s = statuses.find((x) => x.id === id)!
    const cooling = (cooldownUntil.get(id) ?? 0) > now
    if (usable(s) && !cooling) {
      const note = skipped.length ? `; skipped ${skipped.join(', ')}` : ''
      return {
        provider: id,
        rationale: `Auto: no comparable consumption signal across providers, using configured preference (${DEFAULT_PREFERENCE.join(' > ')})${note}`,
        status: s
      }
    }
    skipped.push(`${s.label} (${cooling ? 'cooling down after a rate limit' : why(s)})`)
  }
  throw new Error(`No usable agent provider: ${skipped.join('; ')}`)
}

/** Until when Auto skips a provider that was rate limited: its latest reported reset, at least five minutes. */
export function rateLimitUntil(usage: UsageObservation, now = Date.now()): number {
  const resets = Object.values(usage.windows ?? {}).map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : 0))
  return Math.max(now + 5 * 60_000, ...resets.filter((t) => t > now))
}

export function missingAdapter(id: ProviderId): ProviderStatus {
  const label = id === 'claude' ? 'Claude Code' : 'Codex'
  return { id, label, installed: false, executable: null, version: null, authenticated: null, adapterAvailable: false, detail: 'No adapter registered', policy: '' }
}

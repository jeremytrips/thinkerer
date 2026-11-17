import type { ProviderStatus } from '../../shared/types'

export function providerState(p: ProviderStatus): { label: string; tone: 'ok' | 'warn' | 'off' } {
  if (!p.installed) return { label: 'Not installed', tone: 'off' }
  if (!p.adapterAvailable) return { label: 'Adapter not in this build', tone: 'off' }
  if (p.authenticated === false) return { label: 'Not logged in', tone: 'warn' }
  if (p.authenticated === null) return { label: 'Login status unknown', tone: 'warn' }
  return { label: 'Ready', tone: 'ok' }
}

export function ProviderList({ providers, compact }: { providers: ProviderStatus[]; compact?: boolean }) {
  return (
    <ul className="providers">
      {providers.map((p) => {
        const s = providerState(p)
        return (
          <li key={p.id}>
            <span className={`dot dot-${s.tone}`} aria-hidden />
            <strong>{p.label}</strong>
            <span className="small muted">{s.label}</span>
            {!compact && (
              <span className="small muted provider-detail">
                {p.version ? `${p.version} · ` : ''}
                {p.detail}
              </span>
            )}
            {!compact && p.adapterAvailable && p.policy && (
              <details className="small provider-detail provider-policy">
                <summary className="muted">What runs may do</summary>
                <p>{p.policy}</p>
              </details>
            )}
          </li>
        )
      })}
    </ul>
  )
}

import { useState } from 'react'
import type { AppInfo } from '../../shared/types'
import { api, errorMessage } from '../api'

/** Deliberate restart: picks up Electron main/preload/engine changes (spec F7). */
export function RestartButton({ info, label = 'Restart app' }: { info: AppInfo | null; label?: string }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'restarting'>('idle')
  const [error, setError] = useState<string | null>(null)
  if (!info) return null

  if (state === 'confirm') {
    return (
      <span className="row restart-confirm">
        <span className="small muted">{info.isDev ? 'Rebuild main/preload and relaunch?' : 'Relaunch Thinkerer?'}</span>
        <button className="small" onClick={() => setState('idle')}>Cancel</button>
        <button
          className="small primary"
          onClick={async () => {
            setState('restarting')
            try {
              await api.app.restart()
            } catch (err) {
              setError(errorMessage(err))
              setState('idle')
            }
          }}
        >
          Restart
        </button>
      </span>
    )
  }
  return (
    <span className="row">
      {error && <span className="small error-text">{error}</span>}
      <button className="small" onClick={() => setState('confirm')} disabled={state === 'restarting'}>
        {state === 'restarting' ? 'Restarting…' : label}
      </button>
    </span>
  )
}

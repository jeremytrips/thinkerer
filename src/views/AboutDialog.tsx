import { useEffect } from 'react'
import type { AppInfo } from '../../shared/types'
import { useOverlay } from '../overlay'

export function AboutDialog({ info, onClose }: { info: AppInfo | null; onClose: () => void }) {
  useOverlay()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal card about" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="about-title"><span className="brand-mark" aria-hidden>◆</span> About Thinkerer</h2>
        <p>A project-first AI creation environment. Each project is a real folder on disk; agents change the source and you review the result.</p>
        <dl className="about-facts small">
          <dt>Version</dt>
          <dd className="mono">{info?.version ?? '—'}{info?.isDev && ' (dev build)'}</dd>
          {info?.sourceRoot && (
            <>
              <dt>Source</dt>
              <dd className="mono">{info.sourceRoot}</dd>
            </>
          )}
        </dl>
        <div className="row space">
          <span />
          <button className="primary" autoFocus onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

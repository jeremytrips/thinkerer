import { useEffect, useRef, useState } from 'react'
import type { PromptAttachment, RunArtifact } from '../../shared/types'
import { api } from '../api'
import { useOverlay } from '../overlay'

/** Screenshots captured by the agent's browser during the run. */
export function ArtifactGallery({ runId, artifacts }: { runId: string; artifacts: RunArtifact[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [zoom, setZoom] = useState<string | null>(null)
  const requested = useRef(new Set<string>())

  useEffect(() => {
    for (const a of artifacts) {
      const key = `${runId}/${a.name}`
      if (requested.current.has(key)) continue
      requested.current.add(key)
      api.runs.artifact(runId, a.name).then((u) => setUrls((cur) => ({ ...cur, [a.name]: u })), () => {})
    }
  }, [runId, artifacts])

  return (
    <div className="artifacts card">
      <h3>Browser screenshots ({artifacts.length})</h3>
      <div className="artifact-grid">
        {artifacts.map((a) => (
          <button key={a.name} className="artifact" onClick={() => setZoom(a.name)} title={a.name}>
            {urls[a.name] ? <img src={urls[a.name]} alt={`Screenshot ${a.name}`} /> : <span className="muted small">Loading…</span>}
            <span className="small mono ellipsis">{a.name}</span>
          </button>
        ))}
      </div>
      {zoom && urls[zoom] && <ZoomedImage src={urls[zoom]} alt={`Screenshot ${zoom}`} onClose={() => setZoom(null)} />}
    </div>
  )
}

function ZoomedImage({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useOverlay()
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <img className="artifact-zoom" src={src} alt={alt} />
    </div>
  )
}

/** Preview screenshots the user sent with a prompt, shown in their message. */
export function SentAttachments({ runId, attachments }: { runId: string; attachments: PromptAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [zoom, setZoom] = useState<string | null>(null)

  useEffect(() => {
    for (const a of attachments) api.runs.attachment(runId, a.id).then((u) => setUrls((cur) => ({ ...cur, [a.id]: u })), () => {})
  }, [runId, attachments.length])

  return (
    <div className="sent-attachments">
      {attachments.map((a) => (
        <button key={a.id} type="button" className="sent-attachment" onClick={() => setZoom(a.id)} title={[a.url, ...a.consoleErrors].filter(Boolean).join('\n')}>
          {urls[a.id] ? <img src={urls[a.id]} alt={`Screenshot of ${a.url ?? 'the preview'}`} /> : <span className="muted small">Loading…</span>}
        </button>
      ))}
      {zoom && urls[zoom] && <ZoomedImage src={urls[zoom]} alt="Sent screenshot" onClose={() => setZoom(null)} />}
    </div>
  )
}

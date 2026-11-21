import { useState, type CSSProperties, type RefObject } from 'react'
import type { PreviewCapture, Project } from '../../shared/types'
import { loadState, saveState } from '../api'
import { EmulatorPane } from './EmulatorPane'
import { PreviewPane, type PreviewDevice } from './PreviewPane'

// The preview beside the Agent tab's chat: which surface it shows, and the
// resizable split between chat and preview. Layout choices persist.

// Share of the split given to the chat when the preview is shown.
const SPLIT_MIN = 0.25
const SPLIT_MAX = 0.75
const clampSplit = (v: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
const SIDE_WIDTH = 260 // .agent-side width in styles.css

// What the preview panel beside the chat can show. Add new surfaces here.
type SurfaceId = 'web' | 'mobile' | 'emulator'
const SURFACES: { id: SurfaceId; label: string; title: string }[] = [
  { id: 'web', label: 'Web browser', title: 'The site in the embedded browser' },
  { id: 'mobile', label: 'Phone viewport', title: 'The site in the embedded browser, sized like a phone (no device emulation)' },
  { id: 'emulator', label: 'Emulator', title: 'A real Android emulator or iOS simulator running on this machine' }
]
const DEVICES: PreviewDevice[] = [
  { id: 'iphone-15', label: 'iPhone 15', width: 393, height: 852 },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667 },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915 },
  { id: 'ipad-mini', label: 'iPad mini', width: 744, height: 1133 }
]

/** Chat list, preview and split state for the Agent tab. */
export function usePreviewLayout(sectionRef: RefObject<HTMLElement | null>, mainRef: RefObject<HTMLDivElement | null>) {
  const [showPreview, setShowPreview] = useState(() => loadState('agent.preview', true))
  const [surface, setSurface] = useState<SurfaceId>(() => {
    const saved = loadState<SurfaceId>('agent.surface', 'web')
    return SURFACES.some((s) => s.id === saved) ? saved : 'web'
  })
  const [deviceId, setDeviceId] = useState(() => loadState('agent.device', DEVICES[0].id))
  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0]
  const [showChats, setShowChats] = useState(() => loadState('agent.chats', true))
  const [split, setSplit] = useState(() => clampSplit(loadState('agent.split', 0.5)))
  const [dragging, setDragging] = useState(false)

  return {
    showPreview,
    showChats,
    surface,
    device,
    split,
    dragging,
    setDragging,
    /** Width of the chat column while the preview is shown. */
    mainStyle: (showPreview ? { flex: `0 0 calc((100% - ${showChats ? SIDE_WIDTH : 0}px) * ${split})` } : undefined) as CSSProperties | undefined,
    togglePreview: () => setShowPreview((v) => (saveState('agent.preview', !v), !v)),
    toggleChats: () => setShowChats((v) => (saveState('agent.chats', !v), !v)),
    chooseSurface(id: SurfaceId) {
      setSurface(id)
      saveState('agent.surface', id)
    },
    chooseDevice(id: string) {
      setDeviceId(id)
      saveState('agent.device', id)
    },
    /** The split covers everything right of the chat list: chat, divider, preview. */
    resizeTo(clientX: number) {
      const left = mainRef.current?.getBoundingClientRect().left
      const right = sectionRef.current?.getBoundingClientRect().right
      if (left !== undefined && right !== undefined && right > left) setSplit(clampSplit((clientX - left) / (right - left)))
    },
    nudgeSplit(delta: number) {
      setSplit((v) => {
        const next = clampSplit(v + delta)
        saveState('agent.split', next)
        return next
      })
    }
  }
}

export type PreviewLayout = ReturnType<typeof usePreviewLayout>

interface Props {
  layout: PreviewLayout
  project: Project
  /** The chat whose worktree preview to show; null for the project folder. */
  previewChat: string | null
  reloadNonce: number
  onCapture: (capture: PreviewCapture) => void
}

/** The split handle and the preview panel. */
export function AgentPreviewSide({ layout, project, previewChat, reloadNonce, onCapture }: Props) {
  const { split, dragging, setDragging, resizeTo, nudgeSplit, surface, chooseSurface, device, chooseDevice } = layout
  return (
    <>
      <div
        className="split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat and preview"
        aria-valuemin={SPLIT_MIN * 100}
        aria-valuemax={SPLIT_MAX * 100}
        aria-valuenow={Math.round(split * 100)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => dragging && resizeTo(e.clientX)}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId)
          setDragging(false)
          saveState('agent.split', split)
        }}
        onDoubleClick={() => nudgeSplit(0.5 - split)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') nudgeSplit(-0.05)
          else if (e.key === 'ArrowRight') nudgeSplit(0.05)
        }}
      />
      <div className="agent-preview">
        <div className="surface-bar">
          <div className="row segmented" role="tablist" aria-label="Preview surface">
            {SURFACES.map((s) => (
              <button key={s.id} role="tab" aria-selected={surface === s.id} className={surface === s.id ? 'tab active' : 'tab'} title={s.title} onClick={() => chooseSurface(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          {surface === 'mobile' && (
            <label className="inline small">
              Device
              <select value={device.id} onChange={(e) => chooseDevice(e.target.value)}>
                {DEVICES.map((d) => (
                  <option key={d.id} value={d.id}>{d.label} ({d.width}×{d.height})</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {surface === 'emulator' ? (
          <EmulatorPane project={project} chatId={previewChat} onCapture={onCapture} />
        ) : (
          <PreviewPane
            project={project}
            chatId={previewChat}
            onCapture={onCapture}
            suspended={dragging}
            reloadNonce={reloadNonce}
            device={surface === 'mobile' ? device : null}
          />
        )}
      </div>
    </>
  )
}

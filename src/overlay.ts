import { useEffect, useSyncExternalStore } from 'react'

// The website preview is a native view drawn above the page, so it would cover
// any dialog. Dialogs register here while open and the preview steps aside.

let open = 0
const listeners = new Set<() => void>()

function change(delta: number) {
  open += delta
  for (const l of listeners) l()
}

/** Call from a dialog or full-window overlay while it is shown. */
export function useOverlay(active = true): void {
  useEffect(() => {
    if (!active) return
    change(1)
    return () => change(-1)
  }, [active])
}

export function useOverlayOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open > 0
  )
}

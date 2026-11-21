import { useEffect, useRef } from 'react'
import type { PaletteItem } from './paletteModel'

// Views add their own palette entries here (the Agent tab's slash commands, the
// projects screen's buttons). Sources are read only when the palette renders, and
// nothing is notified on change: a view re-registering on every render must not
// re-render the app.

const sources = new Map<string, { current: () => PaletteItem[] }>()

/** Offers `items()` in the palette while the calling view is mounted; always called with the view's latest state. */
export function usePaletteSource(key: string, items: () => PaletteItem[]): void {
  const latest = useRef(items)
  latest.current = items
  useEffect(() => {
    sources.set(key, latest)
    return () => {
      if (sources.get(key) === latest) sources.delete(key)
    }
  }, [key])
}

export function paletteSourceItems(): PaletteItem[] {
  return [...sources.values()].flatMap((s) => s.current())
}

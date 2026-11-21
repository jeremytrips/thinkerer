import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useOverlay } from '../overlay'
import { filterPalette, type PaletteItem } from '../paletteModel'

/** "⌘K" on a Mac, "Ctrl K" elsewhere. */
export const PALETTE_SHORTCUT = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'

interface Props {
  items: PaletteItem[]
  onClose: () => void
}

/** The ⌘K palette: type to filter, ↑/↓ to move, ↵ to run, esc to close. */
export function CommandPalette({ items, onClose }: Props) {
  useOverlay()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const groups = useMemo(() => filterPalette(items, query), [items, query])
  const flat = groups.flatMap((g) => g.items)
  const active = flat.length ? Math.min(index, flat.length - 1) : -1
  const activeId = active >= 0 ? `palette-${flat[active].id}` : undefined

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  function run(item: PaletteItem) {
    onClose()
    item.run()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Keep other views' window-level esc handlers (a task's detail) from closing too.
      e.stopPropagation()
      return onClose()
    }
    if (!flat.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : flat.length - 1
      setIndex((active + step) % flat.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      run(flat[active])
    }
  }

  let n = -1
  return (
    <div className="modal-backdrop palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          className="palette-input"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          placeholder="Search projects, tabs and commands…  (/ for slash commands)"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={activeId}
          aria-label="Search commands"
          spellCheck={false}
        />
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Commands">
          {groups.map((g) => (
            <div key={g.section} role="group" aria-label={g.section}>
              <div className="palette-section" aria-hidden>{g.section}</div>
              {g.items.map((item) => {
                const i = ++n
                return (
                  <div
                    key={item.id}
                    id={`palette-${item.id}`}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? 'palette-item active' : 'palette-item'}
                    onMouseMove={() => i !== active && setIndex(i)}
                    onClick={() => run(item)}
                  >
                    <span className={item.title.startsWith('/') ? 'palette-title mono' : 'palette-title'}>{item.title}</span>
                    {item.hint && <span className="palette-hint ellipsis">{item.hint}</span>}
                    <span className="palette-key">{i === active ? '↵' : item.shortcut ?? ''}</span>
                  </div>
                )
              })}
            </div>
          ))}
          {!flat.length && <p className="palette-empty">No commands match “{query.trim()}”.</p>}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

/** Top-bar button that opens the palette and shows its shortcut. */
export function PaletteButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="small palette-button" onClick={onClick} aria-label="Command palette" title={`Command palette (${PALETTE_SHORTCUT})`}>
      <kbd>{PALETTE_SHORTCUT}</kbd> Commands
    </button>
  )
}

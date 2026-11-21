// The command palette's data: what an entry is, how a query matches it, and the
// app-wide entries (projects, tabs, new chat). Pure, so it is unit-tested.

/** Sections in the order the palette shows them. */
export const SECTIONS = ['Actions', 'Slash commands', 'Tabs', 'Projects'] as const
export type PaletteSection = (typeof SECTIONS)[number]

export interface PaletteItem {
  /** Unique across the palette. */
  id: string
  section: PaletteSection
  title: string
  hint?: string
  /** Shortcut shown right-aligned, e.g. "↵". */
  shortcut?: string
  /** Extra words that match but aren't shown (a project's path, "switch"…). */
  keywords?: string
  run: () => void
}

/**
 * Fuzzy score of `query` against `text`: every query character must appear in order.
 * Higher is better; null means no match. Consecutive runs, word starts and an exact
 * prefix score extra, so "mer" ranks "/merge" above "Make changes, review".
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    if (ch === ' ') continue
    const at = t.indexOf(ch, from)
    if (at < 0) return null
    score += 1
    if (at === prev + 1) score += 3
    if (at === 0 || /[\s/\-_.:·]/.test(t[at - 1])) score += 2
    prev = at
    from = at + 1
  }
  if (t.startsWith(q)) score += 5
  // Shorter texts win ties: "Tasks" before "Tasks archive".
  return score - t.length / 100
}

export interface PaletteGroup {
  section: PaletteSection
  items: PaletteItem[]
}

/** The entries matching a query, grouped by section in a fixed order and ranked within each. */
export function filterPalette(items: PaletteItem[], query: string): PaletteGroup[] {
  // A leading "/" asks for slash commands only (a project path would match it too).
  const slash = query.trimStart().startsWith('/')
  const scored = items
    .filter((item) => !slash || item.section === 'Slash commands')
    .map((item, order) => {
      const title = fuzzyScore(query, item.title)
      // Hints and keywords (paths, long descriptions) only match a whole substring: a
      // scattered match across a path is noise. They rank below every title match.
      const q = query.trim().toLowerCase()
      const extra = `${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(q) ? -1 : null
      const score = title ?? extra
      return { item, order, score }
    })
    .filter((s): s is { item: PaletteItem; order: number; score: number } => s.score !== null)
  return SECTIONS.map((section) => ({
    section,
    items: scored
      .filter((s) => s.item.section === section)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((s) => s.item)
  })).filter((g) => g.items.length > 0)
}

export interface AppPaletteInput<Tab extends string> {
  projects: { id: string; name: string; path: string }[]
  /** The open project and tab, or null on the projects screen. */
  current: { projectId: string; tab: Tab; hasConfig: boolean } | null
  tabs: { id: Tab; label: string; later?: boolean }[]
  openProject: (id: string) => void
  openHome: () => void
  openTab: (tab: Tab) => void
  newChat: () => void
}

/** Entries every screen has: switch project, switch tab, start a new chat. */
export function appPaletteItems<Tab extends string>(p: AppPaletteInput<Tab>): PaletteItem[] {
  const items: PaletteItem[] = []
  const cur = p.current
  if (cur?.hasConfig) {
    items.push({ id: 'action:new-chat', section: 'Actions', title: 'New chat', hint: 'Start a chat with an agent in this project', keywords: 'agent start', run: p.newChat })
    for (const t of p.tabs) {
      if (t.later || t.id === cur.tab) continue
      items.push({ id: `tab:${t.id}`, section: 'Tabs', title: t.label, hint: 'Tab', keywords: 'go to switch', run: () => p.openTab(t.id) })
    }
  }
  if (cur) items.push({ id: 'project:home', section: 'Projects', title: 'All projects', hint: 'Back to the project list', keywords: 'home back', run: p.openHome })
  for (const proj of p.projects) {
    if (proj.id === cur?.projectId) continue
    items.push({ id: `project:${proj.id}`, section: 'Projects', title: proj.name, hint: proj.path, keywords: 'open switch project', run: () => p.openProject(proj.id) })
  }
  return items
}

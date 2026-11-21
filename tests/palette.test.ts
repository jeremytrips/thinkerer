import { describe, expect, it, vi } from 'vitest'
import { appPaletteItems, filterPalette, fuzzyScore, type PaletteItem } from '../src/paletteModel'
import { chatPaletteItems } from '../src/views/ChatBits'

const item = (id: string, section: PaletteItem['section'], title: string, hint?: string): PaletteItem => ({ id, section, title, hint, run: () => {} })
const titles = (items: PaletteItem[], q: string) => filterPalette(items, q).flatMap((g) => g.items.map((i) => i.title))

describe('fuzzyScore', () => {
  it('matches characters in order, and rejects out-of-order ones', () => {
    expect(fuzzyScore('mrg', '/merge')).not.toBeNull()
    expect(fuzzyScore('gm', '/merge')).toBeNull()
    expect(fuzzyScore('', 'anything')).toBe(0)
  })
  it('ranks a prefix and consecutive letters above a scattered match', () => {
    expect(fuzzyScore('set', 'Settings')!).toBeGreaterThan(fuzzyScore('set', 'Start a new task')!)
  })
})

describe('filterPalette', () => {
  const items = [
    item('p', 'Projects', 'Website', '/Users/me/merge-tool'),
    item('t1', 'Tabs', 'Tasks'),
    item('t2', 'Tabs', 'Settings'),
    item('s', 'Slash commands', '/merge'),
    item('a', 'Actions', 'New chat')
  ]
  it('keeps sections in a fixed order and everything when the query is empty', () => {
    expect(filterPalette(items, '').map((g) => g.section)).toEqual(['Actions', 'Slash commands', 'Tabs', 'Projects'])
  })
  it('ranks title matches within a section', () => {
    expect(titles(items, 'set')).toEqual(['Settings'])
    expect(titles(items, 'ts')).toEqual(['Tasks', 'Settings'])
  })
  it('matches hints too, and a leading slash only finds slash commands', () => {
    expect(titles(items, 'merge')).toEqual(['/merge', 'Website'])
    expect(titles(items, '/merge')).toEqual(['/merge'])
  })
})

describe('appPaletteItems', () => {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'agent', label: 'Agent' },
    { id: 'marketing', label: 'Marketing', later: true }
  ] as const
  const base = {
    projects: [{ id: 'a', name: 'Alpha', path: '/a' }, { id: 'b', name: 'Beta', path: '/b' }],
    tabs: [...tabs],
    openProject: vi.fn(),
    openHome: vi.fn(),
    openTab: vi.fn(),
    newChat: vi.fn()
  }
  it('offers every project on the projects screen, and no tabs or new chat', () => {
    expect(appPaletteItems({ ...base, current: null }).map((i) => i.title)).toEqual(['Alpha', 'Beta'])
  })
  it('in a project: new chat, the other ready tabs, the other projects and home', () => {
    const items = appPaletteItems({ ...base, current: { projectId: 'a', tab: 'overview', hasConfig: true } })
    expect(items.map((i) => i.title)).toEqual(['New chat', 'Agent', 'All projects', 'Beta'])
    items.find((i) => i.title === 'Agent')!.run()
    expect(base.openTab).toHaveBeenCalledWith('agent')
    items.find((i) => i.title === 'Beta')!.run()
    expect(base.openProject).toHaveBeenCalledWith('b')
  })
  it('a missing project folder offers no chat or tabs', () => {
    expect(appPaletteItems({ ...base, current: { projectId: 'a', tab: 'overview', hasConfig: false } }).map((i) => i.title)).toEqual(['All projects', 'Beta'])
  })
})

describe('chatPaletteItems', () => {
  const agentCommands = [{ name: 'compact', hint: 'Summarize', kind: 'agent' as const }]
  it('runs Thinkerer commands on the open chat and completes agent commands', () => {
    const run = vi.fn()
    const complete = vi.fn()
    const items = chatPaletteItems({ chatTitle: 'Fix login', closed: false, agentCommands, run, complete })
    expect(items.map((i) => i.title)).toEqual(['/merge', '/cleanup', '/done', '/discard', '/compact'])
    items[0].run()
    expect(run).toHaveBeenCalledWith('merge')
    items[4].run()
    expect(complete).toHaveBeenCalledWith('compact')
  })
  it('offers only agent commands without an open chat, and nothing once closed', () => {
    const fns = { run: vi.fn(), complete: vi.fn() }
    expect(chatPaletteItems({ chatTitle: null, closed: false, agentCommands, ...fns }).map((i) => i.title)).toEqual(['/compact'])
    expect(chatPaletteItems({ chatTitle: 'x', closed: true, agentCommands, ...fns })).toEqual([])
  })
})

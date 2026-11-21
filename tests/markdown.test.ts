import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/views/Markdown'

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

describe('Markdown tables', () => {
  it('renders a GFM table with header, body and inline formatting', () => {
    const out = html(
      [
        '| | Files it mainly changes | Overlaps with |',
        '|---|---|---|',
        '| R-01 Agent instructions | supervisor.ts, `claude.ts` | R-03 |',
        '| **R-02** palette | src/styles.css | almost nothing |'
      ].join('\n')
    )
    expect(out).toContain('<table class="md-table">')
    expect(out).toContain('<thead><tr><th></th>')
    expect(out).toContain('<th>Files it mainly changes</th>')
    expect(out).toContain('<td>supervisor.ts, <code>claude.ts</code></td>')
    expect(out).toContain('<td><strong>R-02</strong> palette</td>')
    expect(out.match(/<tr>/g)).toHaveLength(3)
    expect(out).not.toContain('|---|')
  })

  it('applies column alignment from the separator row', () => {
    const out = html('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    expect(out).toContain('<td style="text-align:left">1</td>')
    expect(out).toContain('<td style="text-align:center">2</td>')
    expect(out).toContain('<td style="text-align:right">3</td>')
  })

  it('keeps escaped pipes and pipes inside inline code in one cell', () => {
    const out = html('| expr | note |\n|---|---|\n| `a|b` | x \\| y |')
    expect(out).toContain('<td><code>a|b</code></td>')
    expect(out).toContain('<td>x | y</td>')
  })

  it('pads short rows and starts a table right after a paragraph line', () => {
    const out = html('Here is the plan:\n| a | b |\n|---|---|\n| only |')
    expect(out).toContain('<p>Here is the plan:</p>')
    expect(out).toContain('<td>only</td><td></td>')
  })

  it('leaves pipes in ordinary text and "text then ---" alone', () => {
    const out = html('use a | b here\n---')
    expect(out).not.toContain('<table')
    expect(html('just a | pipe')).toBe('<div class="md"><p>just a | pipe</p></div>')
  })

  it('never turns agent text into markup', () => {
    const out = html('| <img src=x onerror=alert(1)> |\n|---|')
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('<img')
  })
})

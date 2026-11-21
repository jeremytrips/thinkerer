import type { ReactNode } from 'react'

/**
 * The small subset of Markdown agents write in replies: headings, lists, code
 * fences, quotes, inline code, bold, italic and links. Builds React elements
 * only (never HTML strings), so agent output can't inject markup. Links are
 * shown as text with their URL, not followed.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++ // closing fence
      out.push(<pre key={out.length} className="md-code" data-lang={fence[2] || undefined}>{body.join('\n')}</pre>)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6) // replies sit inside the page: start at h3
      const Tag = `h${level}` as 'h3'
      out.push(<Tag key={out.length} className="md-h">{inline(heading[2])}</Tag>)
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={out.length} />)
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(<blockquote key={out.length}>{blocks(body.join('\n'))}</blockquote>)
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+/
    if (item.test(line)) {
      const ordered = /\d/.test(line.match(item)![2])
      const items: string[][] = []
      while (i < lines.length && (item.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (item.test(lines[i]) && (lines[i].match(item)![1].length < 2 || !items.length)) items.push([lines[i].replace(item, '')])
        else items[items.length - 1].push(lines[i].trim().replace(item, '• '))
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={out.length}>
          {items.map((it, k) => (
            <li key={k}>{it.map((l, j) => <span key={j} className={j ? 'md-sub' : undefined}>{inline(l)}</span>)}</li>
          ))}
        </List>
      )
      continue
    }
    if (isTableStart(lines, i)) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined
      )
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      out.push(
        <div key={out.length} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{head.map((c, k) => <th key={k} style={{ textAlign: align[k] }}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>{head.map((_, k) => <td key={k} style={{ textAlign: align[k] }}>{inline(r[k] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(\s*(`{3,}|~{3,})|#{1,6}\s|\s*>|(\s*)([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
      !(para.length && isTableStart(lines, i))
    )
      para.push(lines[i++])
    if (!para.length) para.push(lines[i++]) // a line no other rule took
    out.push(<p key={out.length}>{para.flatMap((l, k) => (k ? [<br key={`b${k}`} />, ...inline(l)] : inline(l)))}</p>)
  }
  return out
}

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** A GFM table: a row with pipes followed by a `|---|:--:|` separator line with as many columns. */
function isTableStart(lines: string[], i: number): boolean {
  if (!lines[i].includes('|') || i + 1 >= lines.length || !lines[i + 1].includes('-') || !TABLE_RULE.test(lines[i + 1])) return false
  return cells(lines[i]).length === cells(lines[i + 1]).length
}

/** Split a table row on unescaped pipes outside inline code, dropping the outer ones. */
function cells(row: string): string[] {
  const out: string[] = []
  let cur = ''
  let tick = false
  const s = row.trim()
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|'
      k++
    } else if (ch === '`') {
      tick = !tick
      cur += ch
    } else if (ch === '|' && !tick) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  if (s.startsWith('|')) out.shift()
  if (s.endsWith('|') && !s.endsWith('\\|')) out.pop()
  return out.map((c) => c.trim())
}

const INLINE =/(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = out.length
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>)
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={k}>{inline(m[3] ?? m[4])}</strong>)
    else if (m[5] !== undefined) out.push(<em key={k}>{inline(m[5])}</em>)
    else out.push(<span key={k} className="md-link" title={m[7]}>{inline(m[6])}</span>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

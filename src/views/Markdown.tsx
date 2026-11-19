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
        if (item.test(lines[i]) && lines[i].match(item)![1].length < 2) items.push([lines[i].replace(item, '')])
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
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(\s*(`{3,}|~{3,})|#{1,6}\s|\s*>|(\s*)([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++])
    if (!para.length) para.push(lines[i++]) // a line no other rule took
    out.push(<p key={out.length}>{para.flatMap((l, k) => (k ? [<br key={`b${k}`} />, ...inline(l)] : inline(l)))}</p>)
  }
  return out
}

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g

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

// Image size sniffing and conversion (macOS sips) for screenshots.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, tools } from './tools.mjs'

export function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  return null
}

function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return null
}

export const imageSize = (buf) => pngSize(buf) ?? jpegSize(buf)

/** Resize and/or re-encode with macOS sips; returns the input unchanged elsewhere. */
export async function convert(buf, { width, height, format }) {
  if (!tools().sips) return buf
  const dir = await mkdtemp(join(tmpdir(), 'thinkerer-shot-'))
  try {
    const src = join(dir, 'in')
    const dst = join(dir, format === 'jpeg' ? 'out.jpg' : 'out.png')
    await writeFile(src, buf)
    const args = []
    if (width && height) args.push('--resampleHeightWidth', String(height), String(width))
    args.push('-s', 'format', format, ...(format === 'jpeg' ? ['-s', 'formatOptions', '75'] : []), src, '--out', dst)
    await run(tools().sips, args, { timeout: 15_000 })
    return await readFile(dst)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Argument checks for IPC handlers: the renderer is untrusted, so every value is checked here.

export function str(v: unknown, name: string, max = 10_000): string {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${name}`)
  return v
}

export function bounds(v: unknown): { x: number; y: number; width: number; height: number } {
  const b = v as Record<string, unknown>
  if (!b || !['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k] as number))) {
    throw new Error('Invalid bounds')
  }
  return { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
}

/** A plain object of bounded size (its fields are checked by the code that uses them). */
export function plainObject(v: unknown, name: string, maxBytes = 200_000): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`Invalid ${name}`)
  if (JSON.stringify(v).length > maxBytes) throw new Error(`${name} is too large`)
  return v as Record<string, unknown>
}

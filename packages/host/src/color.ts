/**
 * Just enough colour for the pairing UI: read a host's colour (hex, rgb(), or an "R G B" triplet as design tokens
 * often hold it), measure it (WCAG relative luminance), and move it darker or lighter until it reads.
 */

export type Rgb = [number, number, number]

/** A CSS colour as sRGB 0–255, or null for anything this can't read (named colours, hsl(), var(), …). */
export function parseColor(input: string | null | undefined): Rgb | null {
  const s = (input ?? '').trim().toLowerCase()
  let m = /^#([0-9a-f]{3,4})$/.exec(s)
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as Rgb
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s)
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as Rgb
  // rgb(1, 2, 3) · rgb(1 2 3 / 50%) · rgba(…) · a bare "1 2 3" or "1, 2, 3" triplet
  m = /^(?:rgba?\()?\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)\s*(?:[,/][^)]*)?\)?$/.exec(s)
  if (m && (s.startsWith('rgb') || !s.includes('('))) {
    const c = [m[1], m[2], m[3]].map(Number)
    if (c.every((v) => v <= 255)) return c.map(Math.round) as Rgb
  }
  return null
}

export const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`

const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
const unlin = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)

/** WCAG relative luminance, 0 (black) to 1 (white). */
export const luminance = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** The same hue made darker (scaled in linear light) until its luminance is at most `max`. */
export function darkenTo(c: Rgb, max: number): Rgb {
  const l = luminance(c)
  if (l <= max) return c
  const k = max / l
  return c.map((v) => unlin(lin(v) * k)) as Rgb
}

/** The same hue made lighter (mixed toward white in linear light) until its luminance is at least `min`. */
export function lightenTo(c: Rgb, min: number): Rgb {
  const l = luminance(c)
  if (l >= min) return c
  const k = (min - l) / (1 - l)
  return c.map((v) => unlin(lin(v) + (1 - lin(v)) * k)) as Rgb
}

/** Mix two colours in sRGB (t = 0: a, t = 1: b). */
export const mix = (a: Rgb, b: Rgb, t: number) => a.map((v, i) => v + (b[i] - v) * t) as Rgb

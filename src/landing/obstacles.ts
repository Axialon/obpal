/** Cached document-space outlines. Scroll changes their view, never their geometry. */
import { Font } from 'three/examples/jsm/loaders/FontLoader.js'
import { glyphData } from './letters'
import type { PadRect } from './world'

export type ObstacleKind = 'block' | 'rail' | 'peg' | 'ramp'

/** Content cards are solid exclusion blocks. Icons are round pegs. */
export function obstacleRect(rect: PadRect, kind: ObstacleKind): PadRect {
  if (rect.w <= 0 || rect.h <= 0) return { ...rect, w: 0, h: 0 }
  if (kind === 'peg') {
    const d = Math.min(rect.w, rect.h)
    return { ...rect, x: rect.x + (rect.w - d) / 2, y: rect.y + (rect.h - d) / 2, w: d, h: d, r: d / 2, height: 0.22 }
  }
  if (kind === 'ramp') return { ...rect, h: Math.max(3, rect.h), r: 1, height: 0.055 }
  if (kind === 'rail' && Math.min(rect.w, rect.h) > 32) {
    return { ...rect, height: 0.3, exclude: true, step: false }
  }
  return { ...rect, height: 0.3 }
}

const font = new Font(glyphData)
const glyphs = new Map<string, { rings: number[][]; box: number[] }>()

/** A display letter mapped into its measured ink box, retaining its counters. */
export function obstacleLetter(ch: string, rect: PadRect, fontSize?: number): PadRect | null {
  if (!glyphData.glyphs[ch] || /\s/.test(ch) || rect.w <= 0 || rect.h <= 0) return null
  let glyph = glyphs.get(ch)
  if (!glyph) {
    const rings = font.generateShapes(ch, 1).flatMap(s => [s.getPoints(4), ...s.holes.map(h => h.getPoints(4))])
      .map(points => points.flatMap(p => [p.x, -p.y]))
    const xs = rings.flatMap(r => r.filter((_, i) => i % 2 === 0))
    const ys = rings.flatMap(r => r.filter((_, i) => i % 2 === 1))
    if (!xs.length) return null
    glyph = { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
    glyphs.set(ch, glyph)
  }
  const [x0, y0, x1, y1] = glyph.box
  if (fontSize !== undefined) {
    const baseline = rect.y + glyphData.ascender / glyphData.resolution * fontSize
    return { ...rect, x: rect.x + x0 * fontSize, y: baseline + y0 * fontSize,
      w: (x1 - x0) * fontSize, h: (y1 - y0) * fontSize, height: 0.12, step: false,
      rings: glyph.rings.map(r => r.map((v, i) => (i % 2 ? baseline : rect.x) + v * fontSize)) }
  }
  return { ...rect, height: 0.12, step: false, rings: glyph.rings.map(r => r.map((v, i) => i % 2
    ? rect.y + (v - y0) / (y1 - y0 || 1) * rect.h
    : rect.x + (v - x0) / (x1 - x0 || 1) * rect.w)) }
}

export function nearViewport(rect: PadRect, scroll: number, height: number, margin = 100): boolean {
  return rect.w > 0 && rect.h > 0 && rect.y + rect.h >= scroll - margin && rect.y <= scroll + height + margin
}

/** Rest redraws nothing; visibility and the persisted preference always take precedence over input. */
export function fieldAwake(enabled: boolean, hidden: boolean, moving: boolean, lastInput: number, now: number): boolean {
  return enabled && !hidden && (moving || now - lastInput < 2600)
}

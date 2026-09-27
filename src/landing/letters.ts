/**
 * The headline laid out as 3D letters on the floor, without any drawing: each letter's shapes (for the geometry),
 * where it stands, and its footprint for the physics (./bounce.ts), from the display face's outlines (./glyphs.json).
 * Also the opening's route across them. Pure (three.js geometry only), so the physics can be tested on the real letters.
 */
import type { Shape } from 'three'
import { Font, type FontData } from 'three/examples/jsm/loaders/FontLoader.js'
import glyphJson from './glyphs.json'
import { landingSpot, type Footprint } from './bounce'

/** How tall a letter stands, its bevel, and its top (with the bevel), in em. */
export const LETTER_H = 0.17
export const BEVEL = 0.012
export const TOP = LETTER_H + BEVEL
/** Line spacing of the 3D headline (the page's h1 line-height). */
export const LINE = 0.98

type GlyphData = { ha: number; x_min: number; x_max: number; o: string }
export const glyphData = glyphJson as unknown as FontData & { glyphs: Record<string, GlyphData>; kerning: Record<string, number>; resolution: number }
const font = new Font(glyphData)

export interface LaidLetter {
  ch: string
  /** The glyph's outline shapes, 1 em tall, y up; placed at (x, zBase) on the floor. */
  shapes: Shape[]
  x: number
  zBase: number
  /** Which word it belongs to, counting across lines. */
  word: number
  fp: Footprint
}

/** Lay out lines of text left-aligned, centred as a block on the origin; lines stack toward +z (down the screen). */
export function layoutLetters(lines: string[]): LaidLetter[] {
  const out: LaidLetter[] = []
  const scale = 1 / glyphData.resolution
  const maxW = Math.max(...lines.map((line) => lineWidth(line) * scale))
  let word = 0
  lines.forEach((line, li) => {
    if (li) word++
    const zBase = (li - (lines.length - 1) / 2) * LINE + 0.36
    let x = -maxW / 2
    let prev = ''
    for (const ch of line) {
      const g = glyphData.glyphs[ch]
      if (!g) { prev = ''; continue }
      if (prev) x += (glyphData.kerning[prev + ch] ?? 0) * scale
      if (ch === ' ' && prev !== ' ') word++
      if (ch !== ' ') {
        const shapes = font.generateShapes(ch, 1)
        // The footprint: each outline (and hole) of the glyph, laid on the floor (glyph up is away from the viewer: -z).
        const rings: Float64Array[] = []
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
        for (const s of shapes) {
          for (const pts of [s.getPoints(6), ...s.holes.map((h) => h.getPoints(6))]) {
            const r = new Float64Array(pts.length * 2)
            pts.forEach((p, i) => {
              const px = p.x + x, pz = -p.y + zBase
              r[i * 2] = px; r[i * 2 + 1] = pz
              x0 = Math.min(x0, px); x1 = Math.max(x1, px); z0 = Math.min(z0, pz); z1 = Math.max(z1, pz)
            })
            rings.push(r)
          }
        }
        const box: [number, number, number, number] = [x0, z0, x1, z1]
        out.push({ ch, shapes, x, zBase, word, fp: { id: out.length, height: TOP, box, rings, spot: landingSpot(rings, box) } })
      }
      x += g.ha * scale
      prev = ch
    }
  })
  return out
}

function lineWidth(line: string) {
  let w = 0, prev = ''
  for (const ch of line) {
    const g = glyphData.glyphs[ch]
    if (!g) continue
    if (prev) w += glyphData.kerning[prev + ch] ?? 0
    w += g.ha
    prev = ch
  }
  const last = glyphData.glyphs[line.trimEnd().slice(-1)]
  return last ? w - (last.ha - last.x_max) : w
}

/** The opening's route: a letter from the middle of each word, then the full stop (the last letter). */
export function tourStops(letters: readonly { ch: string; spot: readonly [number, number]; word: number }[]): { x: number; z: number }[] {
  const stops: { x: number; z: number }[] = []
  const last = letters[letters.length - 1]
  const end = last && /[.!?]/.test(last.ch) ? letters.length - 1 : letters.length
  for (let i = 0; i < end; ) {
    let j = i
    while (j < end && letters[j].word === letters[i].word) j++
    const mid = letters[i + Math.floor((j - i - 1) / 2)]
    stops.push({ x: mid.spot[0], z: mid.spot[1] })
    i = j
  }
  if (end < letters.length) stops.push({ x: last.spot[0], z: last.spot[1] })
  return stops
}

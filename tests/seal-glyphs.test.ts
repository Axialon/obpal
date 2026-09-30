import { describe, expect, it } from 'vitest'
import { GLYPH_GRID, SEAL_GLYPHS, glyphDots } from '../packages/core/src/seal-glyphs'

const DOT_RADIUS = .39 / GLYPH_GRID

/** Four samples per pixel approximate the antialiasing of the round SVG dots. */
function raster(index: number, size = 28): Uint8Array {
  const scale = 4, width = size * scale
  const samples = new Uint8Array(width * width)
  for (const dot of glyphDots(index)) {
    const x = dot.x * width, y = dot.y * width, radius = DOT_RADIUS * width
    for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(width - 1, Math.ceil(y + radius)); py++) {
      for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(width - 1, Math.ceil(x + radius)); px++) {
        if ((px + .5 - x) ** 2 + (py + .5 - y) ** 2 <= radius ** 2) samples[py * width + px] = 1
      }
    }
  }
  const pixels = new Uint8Array(size * size)
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    pixels[Math.floor(y / scale) * size + Math.floor(x / scale)] += samples[y * width + x]
  }
  return pixels
}

function overlap(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0, union = 0
  for (let i = 0; i < a.length; i++) {
    intersection += Math.min(a[i], b[i])
    union += Math.max(a[i], b[i])
  }
  return intersection / union
}

describe('connection seal dot glyphs', () => {
  it('has 64 individually named original objects in the stable six-bit order', () => {
    expect(SEAL_GLYPHS).toHaveLength(64)
    expect(new Set(SEAL_GLYPHS.map(g => g.name)).size).toBe(64)
    expect(SEAL_GLYPHS.slice(0, 3).map(g => g.name)).toEqual(['comet', 'anchor', 'leaf'])
    expect(SEAL_GLYPHS.every(g => /^[a-z]+$/.test(g.name))).toBe(true)
  })

  it('uses an 11 by 11 occupancy grid with a broad silhouette and at most 100 dots', () => {
    expect(GLYPH_GRID).toBe(11)
    for (const [index, { name, rows }] of SEAL_GLYPHS.entries()) {
      expect(rows, name).toHaveLength(GLYPH_GRID)
      for (const row of rows) expect(row, name).toMatch(/^[.#]{11}$/)
      const points = glyphDots(index)
      expect(points.length, name).toBeGreaterThanOrEqual(30)
      expect(points.length, name).toBeLessThanOrEqual(100)
      expect(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)), name).toBeGreaterThanOrEqual(6 / GLYPH_GRID)
      expect(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)), name).toBeGreaterThanOrEqual(6 / GLYPH_GRID)
    }
  })

  it('returns each occupied cell centre once in normalized row order', () => {
    for (const [index, { rows }] of SEAL_GLYPHS.entries()) {
      const expected = rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '#' ? [{ x: (x + .5) / GLYPH_GRID, y: (y + .5) / GLYPH_GRID }] : []))
      expect(glyphDots(index)).toEqual(expected)
      expect(glyphDots(index)).toBe(glyphDots(index))
      expect(Object.isFrozen(glyphDots(index))).toBe(true)
    }
  })

  it('rejects indices outside the six-bit vocabulary', () => {
    for (const index of [-1, 64, .5, NaN, Infinity]) expect(() => glyphDots(index)).toThrow(RangeError)
  })

  it('keeps rotations and reflections from making near duplicate drawings', () => {
    const mask = (rows: readonly string[]) => Uint8Array.from([...rows.join('')], cell => cell === '#' ? 1 : 0)
    for (let a = 0; a < SEAL_GLYPHS.length; a++) for (let b = a + 1; b < SEAL_GLYPHS.length; b++) {
      const original = mask(SEAL_GLYPHS[a].rows)
      let current = [...SEAL_GLYPHS[b].rows]
      for (let turn = 0; turn < 4; turn++) {
        for (const candidate of [current, current.map(row => [...row].reverse().join(''))]) {
          expect(overlap(original, mask(candidate)), `${SEAL_GLYPHS[a].name} / transformed ${SEAL_GLYPHS[b].name}`).toBeLessThan(.8)
        }
        current = current.map((_, y) => current.map(row => row[y]).reverse().join(''))
      }
    }
  })

  it('keeps every pair below 75 percent dot silhouette overlap at 28 pixels', () => {
    const masks = SEAL_GLYPHS.map((_, i) => raster(i))
    for (let a = 0; a < masks.length; a++) for (let b = a + 1; b < masks.length; b++) {
      expect(overlap(masks[a], masks[b]), `${SEAL_GLYPHS[a].name} / ${SEAL_GLYPHS[b].name}`).toBeLessThan(.75)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { markSVG } from '../extension/scripts/mark.mjs'

/** The sizes the bold mark is drawn at: the icons' art (48 and 96 px) and the store art's. */
const SIZES = [40, 48, 60, 72, 96, 168, 196, 200, 230]

const polygons = (svg: string) => [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => m[1].split(' ').map((p) => p.split(',').map(Number)))
const attrs = (svg: string, name: string) => [...svg.matchAll(new RegExp(`${name}="([\\d.]+)"`, 'g'))].map((m) => Number(m[1]))

describe('the bold mark (extension/scripts/mark.mjs)', () => {
  it.each(SIZES)('puts the cube on the pixel grid at %i px', (size) => {
    const svg = markSVG(size, { bold: true })
    const shapes = polygons(svg)
    expect(shapes.length).toBeGreaterThanOrEqual(8)
    for (const pts of shapes) {
      for (const [x, y] of pts) {
        // Corners on whole pixels, or half ones (the keyline when it's odd): either keeps a 2:1 edge's steps even.
        expect(Number.isInteger(x)).toBe(true)
        expect(Number.isInteger(y * 2)).toBe(true)
      }
      // Every edge vertical or at exactly 2:1.
      pts.forEach(([x, y], i) => {
        const [nx, ny] = pts[(i + 1) % pts.length]
        if (nx !== x) expect(Math.abs((ny - y) / (nx - x))).toBe(0.5)
      })
    }
  })

  it.each(SIZES)('draws nothing thinner than 2 px and keeps the orbit inside the box at %i px', (size) => {
    const svg = markSVG(size, { bold: true, width: size * 8 })
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`)
    for (const w of attrs(svg, 'stroke-width')) expect(w).toBeGreaterThanOrEqual(2)
    const [rx] = attrs(svg, 'rx'), [ry] = attrs(svg, 'ry')
    const front = Number(svg.match(/stroke="#C6FF34" stroke-width="([\d.]+)"/)?.[1])
    expect(front).toBeGreaterThanOrEqual(4)
    const tilt = (14 * Math.PI) / 180
    const reach = Math.hypot(rx * Math.cos(tilt), ry * Math.sin(tilt))
    expect(reach + front / 2).toBeLessThanOrEqual(size / 2)
  })

  it('leaves the fine mark as it was without the option', () => {
    expect(markSVG(96)).not.toBe(markSVG(96, { bold: true }))
    expect(markSVG(96)).toContain('stroke="rgba(255,255,255,.45)"')
  })
})

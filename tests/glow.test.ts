import { describe, expect, it } from 'vitest'
import { findBlob, glowMove, hueOf } from '../packages/host/src/glow'

function image(w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); px.set([r, g, b, 255], (y * w + x) * 4) }
  return px
}

describe('camera tracking: a phone glowing its seat colour', () => {
  it('finds the glow of one colour and ignores another', () => {
    // A dim room, a sky-blue phone at (40, 30) and a rose one at (120, 90).
    const px = image(160, 120, (x, y) => {
      if (Math.abs(x - 40) < 8 && Math.abs(y - 30) < 12) return [56, 189, 248]
      if (Math.abs(x - 120) < 8 && Math.abs(y - 90) < 12) return [251, 113, 133]
      return [40, 38, 36]
    })
    const sky = findBlob(px, 160, 120, hueOf('#38bdf8'))!
    expect(sky.x).toBeCloseTo(40, 0)
    expect(sky.y).toBeCloseTo(30, 0)
    const rose = findBlob(px, 160, 120, hueOf('#fb7185'))!
    expect(rose.x).toBeCloseTo(120, 0)
    expect(findBlob(px, 160, 120, hueOf('#34d399'))).toBeNull()
  })

  it('reads a move toward the camera from the glow growing, and the person’s right from the picture’s left', () => {
    const a = { x: 80, y: 60, n: 400 }
    const closer = glowMove(a, { x: 80, y: 60, n: 900 }, 160, 120)
    expect(closer.forward).toBeCloseTo(0.2, 2)
    const right = glowMove(a, { x: 60, y: 60, n: 400 }, 160, 120)
    expect(right.right).toBeGreaterThan(0.05)
    expect(Math.abs(right.forward)).toBeLessThan(1e-9)
  })
})

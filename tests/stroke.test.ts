import { describe, expect, it } from 'vitest'
import { orbitStroke, pointAt, walk, walkTime, type Headline } from '../src/landing/stroke'

// A headline as a computer shows it (two lines, 104px type) and as a phone does (two lines, 44px type).
const DESK: Headline = { left: 130, right: 820, top: 250, bottom: 452, dot: { x: 806, y: 420 } }
const PHONE: Headline = { left: 20, right: 352, top: 128, bottom: 240, dot: { x: 342, y: 226 } }

describe('the hero stroke: once round the headline, then onto its full stop', () => {
  for (const [name, h, W] of [['computer', DESK, 1440], ['phone', PHONE, 375]] as const) {
    const k = orbitStroke(h, W)
    it(`${name}: comes in from off the left edge and lands exactly on the full stop`, () => {
      expect(k.xs[0]).toBeLessThan(0)
      const [x, y] = pointAt(k, k.len)
      expect(x).toBeCloseTo(h.dot.x, 6)
      expect(y).toBeCloseTo(h.dot.y, 6)
      expect(k.landFrom).toBeGreaterThan(0)
      expect(k.landFrom).toBeLessThan(k.len)
    })
    it(`${name}: goes all the way round the headline, and stays on screen doing it`, () => {
      const on = [...k.xs.keys()].filter((i) => k.xs[i] >= 0)
      const xs = on.map((i) => k.xs[i]), ys = on.map((i) => k.ys[i])
      expect(Math.min(...xs)).toBeLessThan(h.left)
      expect(Math.max(...xs)).toBeGreaterThan(h.right - 4)
      expect(Math.min(...ys)).toBeLessThan(h.top)
      expect(Math.max(...ys)).toBeGreaterThan(h.bottom)
      expect(Math.max(...xs)).toBeLessThanOrEqual(W - 10)
    })
    it(`${name}: is one smooth line, with no corners anywhere`, () => {
      let worst = 0
      for (let i = 2; i < k.xs.length; i++) {
        const a = Math.atan2(k.ys[i - 1] - k.ys[i - 2], k.xs[i - 1] - k.xs[i - 2])
        const b = Math.atan2(k.ys[i] - k.ys[i - 1], k.xs[i] - k.xs[i - 1])
        let d = Math.abs(b - a)
        if (d > Math.PI) d = 2 * Math.PI - d
        worst = Math.max(worst, d)
      }
      // Under 12° between neighbouring pieces, the joins between the entry, the ring and the landing included.
      expect(worst).toBeLessThan(0.21)
    })
  }
})

describe('the walk along it', () => {
  it('starts and ends still, and keeps an even pace in between', () => {
    expect(walk(0)).toBe(0)
    expect(walk(1)).toBeCloseTo(1, 9)
    const speed = (u: number) => (walk(u + 0.005) - walk(u - 0.005)) / 0.01
    expect(speed(0.005)).toBeLessThan(0.15)
    expect(speed(0.995)).toBeLessThan(0.15)
    const middle = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map(speed)
    expect(Math.max(...middle) / Math.min(...middle)).toBeLessThan(1.03)
    for (let u = 0.01; u <= 1; u += 0.01) expect(walk(u)).toBeGreaterThanOrEqual(walk(u - 0.01))
  })
  it('takes an unhurried few seconds on any screen', () => {
    for (const [h, W] of [[DESK, 1440], [PHONE, 375]] as const) {
      const T = walkTime(orbitStroke(h, W).len)
      expect(T).toBeGreaterThanOrEqual(4.5)
      expect(T).toBeLessThanOrEqual(7)
    }
  })
})

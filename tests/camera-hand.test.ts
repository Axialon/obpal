import { describe, expect, it } from 'vitest'
import { OneEuro, HandGestures, HandBandwidth, palmPosition } from '../src/controller/hand-signal'
import type { Vec3 } from '@obpal/core'

const points = (): Vec3[] => Array.from({ length: 21 }, () => [0, 0, 0])

describe('camera hand smoothing', () => {
  it('keeps a stationary landmark steady and follows a fast move with low lag', () => {
    const f = new OneEuro()
    expect(f.sample(0, 0)).toBe(0)
    const noise = Array.from({ length: 120 }, (_, i) => f.sample(i % 2 ? .001 : -.001, (i + 1) / 120))
    expect(Math.max(...noise.map(Math.abs))).toBeLessThan(.0004)
    expect(f.sample(.1, 121 / 120)).toBeGreaterThan(.025)
    expect(f.sample(.1, 122 / 120)).toBeGreaterThan(.05)
  })
  it('ignores repeated timestamps and invalid samples, and resets after a gap', () => {
    const f = new OneEuro()
    expect(f.sample(1, 1)).toBe(1)
    expect(f.sample(2, 1)).toBe(1)
    expect(f.sample(NaN, 1.1)).toBe(1)
    expect(f.sample(2, 2)).toBe(2)
    f.reset()
    expect(f.sample(3, 0)).toBe(3)
  })
})

describe('camera hand gestures', () => {
  it('pinch has separate enter and release distances, scaled to palm width', () => {
    const g = new HandGestures(), p = points()
    p[5] = [-.04, .06, 0]; p[17] = [.04, .06, 0]; p[4] = [0, .1, 0]
    for (const i of [9, 13, 17]) { p[i + 3] = [p[i][0], .2, 0] }
    p[8] = [.019, .1, 0]
    expect(g.sample(p) & 1).toBe(0)
    expect(g.sample(p) & 1).toBe(1)
    p[8][0] = .026
    expect(g.sample(p) & 1).toBe(1)
    p[8][0] = .04
    expect(g.sample(p) & 1).toBe(0)
    p[8][0] = .026
    expect(g.sample(p) & 1).toBe(0)
  })
  it('grip and point have hysteresis and reset when the hand disappears', () => {
    const g = new HandGestures(), p = points()
    for (const i of [5, 9, 13, 17]) { p[i] = [(i - 11) * .005, .06, 0]; p[i + 3] = [p[i][0], .07, 0] }
    p[4] = [-.1, .04, 0]
    g.sample(p)
    expect(g.sample(p) & 2).toBe(2)
    for (const i of [8, 12, 16, 20]) p[i][1] = .09
    expect(g.sample(p) & 2).toBe(2)
    for (const i of [8, 12, 16, 20]) p[i][1] = .14
    expect(g.sample(p) & 2).toBe(0)
    for (const i of [12, 16, 20]) p[i][1] = .07
    g.sample(p)
    expect(g.sample(p) & 4).toBe(4)
    p[8][1] = .12
    expect(g.sample(p) & 4).toBe(4)
    p[8][1] = .07
    expect(g.sample(p) & 4).toBe(0)
    g.reset()
    expect(g.sample([])).toBe(0)
  })
})

describe('camera hand budget and translation', () => {
  it('admits all 120 fps packets but caps bursts to the byte budget', () => {
    const b = new HandBandwidth()
    let packets = 0
    for (let i = 0; i < 120; i++) if (b.take(i * 1000 / 120)) packets++
    expect(packets).toBe(120)
    const burst = new HandBandwidth()
    expect(Array.from({ length: 1000 }, () => burst.take(0)).filter(Boolean).length).toBe(2)
    expect(burst.take(100)).toBe(true)
  })
  it('estimates finite camera-space palm translation without claiming absolute tracking', () => {
    const world = points(), image = points()
    world[5] = [-.04, .04, 0]; world[17] = [.04, .04, 0]
    image[5] = [.4, .5, 0]; image[17] = [.6, .5, 0]; image[0] = [.5, .6, 0]; image[9] = [.5, .4, 0]; image[13] = [.5, .5, 0]
    const p = palmPosition(world, image, 640, 480)
    expect(p.every(Number.isFinite)).toBe(true)
    expect(p[0]).toBeCloseTo(0)
    expect(p[2]).toBeLessThan(-.15)
    expect(p[2]).toBeGreaterThan(-2.5)
  })
})

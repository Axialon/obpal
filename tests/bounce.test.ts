import { describe, expect, it } from 'vitest'
import { G, flightTime, inside, landingSpot, nearest, newOrb, step, surfaceAt, type Footprint, type Orb } from '../src/landing/bounce'

const ring = (...pts: number[]) => Float64Array.from(pts)
/** An "o": a square 2 wide with a square hole 1 wide, standing `height` tall at (cx, cz). */
function oLetter(id: number, cx: number, cz: number, height = 0.2): Footprint {
  const outer = ring(cx - 1, cz - 1, cx + 1, cz - 1, cx + 1, cz + 1, cx - 1, cz + 1)
  const hole = ring(cx - 0.5, cz - 0.5, cx - 0.5, cz + 0.5, cx + 0.5, cz + 0.5, cx + 0.5, cz - 0.5)
  const box: [number, number, number, number] = [cx - 1, cz - 1, cx + 1, cz + 1]
  return { id, height, box, rings: [outer, hole], spot: landingSpot([outer, hole], box) }
}
const BOUNDS: [number, number, number, number] = [-20, -20, 20, 20]
const run = (o: Orb, fps: Footprint[], seconds: number, hop = 0.8, extra: { push?: [number, number] } = {}) => {
  const events: { landed: number | null; bumped: number | null; t: number }[] = []
  let peak = 0
  for (let t = 0; t < seconds; t += 1 / 120) {
    const r = step(o, fps, 1 / 120, { hop, bounds: BOUNDS, ...extra })
    if (r.landed !== null || r.bumped !== null) events.push({ ...r, t })
    peak = Math.max(peak, o.y)
  }
  return { events, peak }
}

describe('letters as footprints', () => {
  const o = oLetter(3, 0, 0)
  it('knows inside from the hole and from outside', () => {
    expect(inside(o, 0.75, 0)).toBe(true)
    expect(inside(o, 0, 0)).toBe(false)
    expect(inside(o, 1.5, 0)).toBe(false)
  })
  it('finds the nearest edge and which way is out', () => {
    const e = nearest(o, 1.3, 0)
    expect(e.d).toBeCloseTo(0.3, 6)
    expect(e.nx).toBeCloseTo(1, 6)
    const h = nearest(o, 0.2, 0) // in the hole, nearest the hole's right wall
    expect(h.d).toBeCloseTo(0.3, 6)
  })
  it('lands in the thick of the letter, never in its hole', () => {
    expect(inside(o, o.spot[0], o.spot[1])).toBe(true)
    expect(nearest(o, o.spot[0], o.spot[1]).d).toBeGreaterThan(0.2)
  })
  it('the surface is the letter over it, else the floor', () => {
    expect(surfaceAt([o], 0.75, 0)).toEqual({ h: 0.2, id: 3 })
    expect(surfaceAt([o], 0, 0)).toEqual({ h: 0, id: -1 })
  })
})

describe('an orb', () => {
  it('keeps hopping at the set height while active', () => {
    const b = newOrb(5, 5, 0.1)
    b.active = true
    b.vy = Math.sqrt(2 * G * 0.8)
    b.resting = false
    const { events, peak } = run(b, [], 4)
    expect(peak).toBeGreaterThan(0.8)
    expect(peak).toBeLessThan(0.95)
    expect(events.filter((e) => e.landed === -1).length).toBeGreaterThanOrEqual(4)
  })
  it('left alone, bounces lower each time and comes to rest, then nothing moves', () => {
    const b = newOrb(5, 5, 0.1)
    b.y = 1.2
    b.resting = false
    const { events } = run(b, [], 4)
    expect(events.length).toBeGreaterThan(2)
    expect(b.resting).toBe(true)
    expect(b.y).toBeCloseTo(0.1, 6)
    expect(step(b, [], 1 / 60, { hop: 0.8, bounds: BOUNDS }).moving).toBe(false)
  })
  it('hops exactly onto a letter it is sent to, and lands on its top', () => {
    const o = oLetter(7, 3, 0)
    const b = newOrb(-2, 0, 0.1)
    b.route = [{ x: o.spot[0], z: o.spot[1] }]
    b.resting = false
    let landed: { x: number; z: number; y: number } | null = null
    for (let t = 0; t < 3 && !landed; t += 1 / 240) {
      const r = step(b, [o], 1 / 240, { hop: 0.8, bounds: BOUNDS })
      if (r.landed === 7) landed = { x: b.x, z: b.z, y: b.y }
    }
    expect(landed).not.toBeNull()
    expect(Math.hypot(landed!.x - o.spot[0], landed!.z - o.spot[1])).toBeLessThan(0.05)
    expect(landed!.y).toBeCloseTo(0.2 + 0.1, 6)
  })
  it('runs into a tall letter and bounces off its side instead of passing through', () => {
    const wall = oLetter(9, 3, 0, 5)
    const b = newOrb(0, 0.75, 0.1)
    b.vx = 10
    b.resting = false
    const { events } = run(b, [wall], 1.5, 0.3)
    expect(events.some((e) => e.bumped === 9)).toBe(true)
    expect(b.x).toBeLessThan(3 - 1 - 0.09)
    for (let t = 0; t < 1; t += 1 / 120) { step(b, [wall], 1 / 120, { hop: 0.3, bounds: BOUNDS }); expect(inside(wall, b.x, b.z)).toBe(false) }
  })
  it('steered, glides to its target without overshooting far, hopping all the way', () => {
    const b = newOrb(-5, 0, 0.1)
    b.active = true
    b.target = { x: 4, z: 2 }
    b.resting = false
    let beyond = 0
    for (let t = 0; t < 3; t += 1 / 120) { step(b, [], 1 / 120, { hop: 0.8, bounds: BOUNDS }); beyond = Math.max(beyond, b.x - 4) }
    expect(Math.hypot(b.x - 4, b.z - 2)).toBeLessThan(0.05)
    expect(beyond).toBeLessThan(0.15)
  })
  it('a tilt pushes it along like a marble on a tray', () => {
    const b = newOrb(0, 0, 0.1)
    b.resting = false
    run(b, [], 1, 0.8, { push: [8, 0] })
    expect(b.x).toBeGreaterThan(1)
  })
  it('flight time lands a hop on a higher or lower surface', () => {
    const vy = Math.sqrt(2 * G * 0.8)
    const t = flightTime(vy, 0, 0.2)
    expect(0 + vy * t - (G * t * t) / 2).toBeCloseTo(0.2, 9)
    expect(flightTime(vy, 0, 0)).toBeCloseTo((2 * vy) / G, 9)
  })
})

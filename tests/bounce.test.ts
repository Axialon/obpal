import { describe, expect, it } from 'vitest'
import { G, collide, flightTime, hopTo, inside, landingSpot, nearest, newOrb, step, surfaceAt, toss, type Footprint, type Orb } from '../src/landing/bounce'

const ring = (...pts: number[]) => Float64Array.from(pts)
/** An "o": a square 2 wide with a square hole 1 wide, standing `height` tall at (cx, cz). */
function oLetter(id: number, cx: number, cz: number, height = 0.2): Footprint {
  const outer = ring(cx - 1, cz - 1, cx + 1, cz - 1, cx + 1, cz + 1, cx - 1, cz + 1)
  const hole = ring(cx - 0.5, cz - 0.5, cx - 0.5, cz + 0.5, cx + 0.5, cz + 0.5, cx + 0.5, cz - 0.5)
  const box: [number, number, number, number] = [cx - 1, cz - 1, cx + 1, cz + 1]
  return { id, height, box, rings: [outer, hole], spot: landingSpot([outer, hole], box) }
}
const BOUNDS: [number, number, number, number] = [-20, -20, 20, 20]
const run = (o: Orb, fps: Footprint[], seconds: number, hop = 0.8, extra: { push?: [number, number]; air?: number } = {}) => {
  const events: { landed: number | null; bumped: number | null; impact: number; t: number }[] = []
  let peak = 0
  for (let t = 0; t < seconds; t += 1 / 120) {
    const r = step(o, fps, 1 / 120, { hop, bounds: BOUNDS, ...extra })
    if (r.landed !== null || r.bumped !== null) events.push({ landed: r.landed, bumped: r.bumped, impact: r.impact, t })
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
  it('never bounces by itself: a toss sends it up once, as high as the toss, then it settles', () => {
    const b = newOrb(5, 5, 0.1)
    expect(toss(b, Math.sqrt(2 * G * 0.8), [])).toBe(true)
    const { events, peak } = run(b, [], 4)
    expect(peak - 0.1).toBeGreaterThan(0.74)
    expect(peak - 0.1).toBeLessThan(0.82)
    // Each landing lower than the one before, then rest.
    const hits = events.filter((e) => e.landed === -1).map((e) => e.impact)
    expect(hits.length).toBeGreaterThan(1)
    for (let i = 1; i < hits.length; i++) expect(hits[i]).toBeLessThan(hits[i - 1])
    expect(b.resting).toBe(true)
  })
  it('a toss while it is still in the air waits for it to touch down', () => {
    const b = newOrb(5, 5, 0.1)
    b.y = 0.3
    b.resting = false
    expect(toss(b, 6, [])).toBe(false)
    let peak = 0, landed = 0
    for (let t = 0; t < 1.5; t += 1 / 120) {
      const r = step(b, [], 1 / 120, { hop: 0.8, bounds: BOUNDS })
      if (r.landed !== null) landed++
      if (landed) peak = Math.max(peak, b.y)
    }
    // It fell to the floor and left at the toss's speed: 6²/2G high.
    expect(peak - 0.1).toBeCloseTo(36 / (2 * G), 1)
  })
  it('a toss that finds it still in the air too long is dropped', () => {
    const b = newOrb(5, 5, 0.1)
    b.y = 3
    b.resting = false
    toss(b, 6, [])
    const { peak } = run(b, [], 2.5)
    expect(peak).toBeLessThanOrEqual(3)
    expect(b.resting).toBe(true)
  })
  it('rolling along the floor is not landing on it', () => {
    const b = newOrb(0, 0, 0.1)
    b.target = { x: 6, z: 0 }
    b.resting = false
    const { events } = run(b, [], 2)
    expect(events).toEqual([])
    expect(b.x).toBeGreaterThan(5.9)
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
  it('steered, rolls to its target without overshooting far', () => {
    const b = newOrb(-5, 0, 0.1)
    b.target = { x: 4, z: 2 }
    b.resting = false
    let beyond = 0
    for (let t = 0; t < 3; t += 1 / 120) { step(b, [], 1 / 120, { hop: 0.8, bounds: BOUNDS }); beyond = Math.max(beyond, b.x - 4) }
    expect(Math.hypot(b.x - 4, b.z - 2)).toBeLessThan(0.05)
    expect(beyond).toBeLessThan(0.15)
    expect(b.y).toBeCloseTo(0.1, 6)
  })
  it('in the air it keeps its momentum, only a little steered', () => {
    const fly = (air: number) => {
      const b = newOrb(0, 0, 0.1)
      b.target = { x: 0, z: 0 }
      b.vx = 4
      toss(b, 8, [])
      for (let t = 0; t < 0.4; t += 1 / 120) step(b, [], 1 / 120, { hop: 0.8, bounds: BOUNDS, air })
      return b.x
    }
    expect(fly(0.2)).toBeGreaterThan(fly(1) + 0.3)
  })
  it('a precise hop goes from rest to exactly the spot', () => {
    const b = newOrb(0, 0, 0.1)
    hopTo(b, { x: 1.5, z: -0.5 })
    const { events } = run(b, [], 2)
    expect(events[0].landed).toBe(-1)
    expect(b.resting).toBe(true)
    expect(Math.hypot(b.x - 1.5, b.z + 0.5)).toBeLessThan(0.03)
  })
  it('two marbles knock into each other and bounce apart', () => {
    const a = newOrb(0, 0, 0.1), b = newOrb(0.3, 0, 0.1)
    a.vx = 3
    a.resting = false
    let hit = 0
    for (let t = 0; t < 0.5; t += 1 / 120) {
      step(a, [], 1 / 120, { hop: 0.8, bounds: BOUNDS })
      step(b, [], 1 / 120, { hop: 0.8, bounds: BOUNDS })
      hit = Math.max(hit, collide(a, b))
    }
    expect(hit).toBeGreaterThan(2)
    expect(b.vx).toBeGreaterThan(a.vx)
    expect(b.x - a.x).toBeGreaterThanOrEqual(0.2 - 1e-9)
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

describe('a precise hop', () => {
  it('leaves from right beside a letter without catching its side on the way up', () => {
    const wall = oLetter(4, 3, 0)
    // On the floor just left of the letter's left side, sent to its far side.
    const b = newOrb(3 - 1 - 0.11, 0.75, 0.1)
    hopTo(b, { x: 3 + 0.75, z: 0.75 })
    let landed: number | null = null
    for (let t = 0; t < 2 && landed === null; t += 1 / 120) {
      const r = step(b, [wall], 1 / 120, { hop: 0.8, bounds: BOUNDS })
      if (r.bumped !== null) throw new Error('caught the side')
      if (r.landed !== null) landed = r.landed
    }
    expect(landed).toBe(4)
    expect(Math.hypot(b.x - 3.75, b.z - 0.75)).toBeLessThan(0.03)
  })
})

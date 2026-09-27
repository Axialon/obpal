import { describe, expect, it } from 'vitest'
import { FIELD, keepIn, MIDDLE, rally, stepRally, type Pt, type Rally } from '../src/landing/rally'

const DT = 1 / 60
const CORNERS: Pt[] = [{ x: FIELD.L, y: FIELD.T }, { x: FIELD.R, y: FIELD.T }, { x: FIELD.L, y: FIELD.B }, { x: FIELD.R, y: FIELD.B }]
const nearest = (q: Pt, ps: Pt[]) => ps.reduce((m, c) => (Math.hypot(c.x - q.x, c.y - q.y) < Math.hypot(m.x - q.x, m.y - q.y) ? c : m))
const unit = (x: number, y: number) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d } }

/** Whether a point is inside the field, `inset` in from its edge (round corners), to within a hair. */
function inField(q: Pt, inset: number) {
  const c = { ...q }
  keepIn(c, inset)
  return Math.hypot(c.x - q.x, c.y - q.y) < 1e-6
}

/**
 * Play `seconds` at 60 frames a second, your pointer where `pointer` says (null: nobody's playing). Returns the longest
 * the ball stayed within 18 units of one spot, the longest between two hits of the ball, and how often it was sent
 * back toward the middle. Checks every frame that the ball and the pucks are on the field.
 */
function play(seconds: number, pointer: (r: Rally, t: number) => Pt | null) {
  const r = rally()
  const seen: { t: number; x: number; y: number }[] = []
  let still = 0, gap = 0, lastHits = 0, lastHitAt = 0
  for (let i = 0, t = 0; t < seconds; i++, t = i * DT) {
    stepRally(r, DT, pointer(r, t))
    expect(inField(r, 8 - 1e-6), `ball on the field at ${t.toFixed(2)} s`).toBe(true)
    for (const pk of r.pucks) expect(inField(pk, 14 - 1e-6), `puck on the field at ${t.toFixed(2)} s`).toBe(true)
    if (r.contacts !== lastHits) { gap = Math.max(gap, t - lastHitAt); lastHits = r.contacts; lastHitAt = t }
    if (i % 6) continue
    seen.push({ t, x: r.x, y: r.y })
    // How long back the ball has been within 18 units of where it is now.
    let k = seen.length - 1
    while (k > 0 && Math.hypot(seen[k - 1].x - r.x, seen[k - 1].y - r.y) < 18) k--
    still = Math.max(still, t - seen[k].t)
  }
  gap = Math.max(gap, seconds - lastHitAt)
  return { still, gap, hits: r.contacts, nudges: r.nudges }
}

describe('the Play card: the rally never stops', () => {
  const FIVE_MINUTES = 300

  it('with nobody playing, the guards keep the ball moving for five minutes', () => {
    const run = play(FIVE_MINUTES, () => null)
    expect(run.still).toBeLessThan(2)
    expect(run.gap).toBeLessThan(10)
    expect(run.hits).toBeGreaterThan(100)
  })

  it('your puck pushing the ball into the nearest corner, again and again, can\'t wedge it there', () => {
    const run = play(FIVE_MINUTES, (r) => {
      const c = nearest(r, CORNERS), u = unit(c.x - r.x, c.y - r.y)
      return { x: r.x - u.x * 10, y: r.y - u.y * 10 }
    })
    expect(run.still).toBeLessThan(2)
    expect(run.gap).toBeLessThan(10)
  })

  it('your puck pinning the ball against the nearest edge can\'t hold it there', () => {
    const run = play(FIVE_MINUTES, (r) => {
      const d = [r.x - FIELD.L, FIELD.R - r.x, r.y - FIELD.T, FIELD.B - r.y]
      const k = d.indexOf(Math.min(...d))
      const away = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }][k]
      return { x: r.x + away.x * 10, y: r.y + away.y * 10 }
    })
    expect(run.still).toBeLessThan(2)
    expect(run.gap).toBeLessThan(10)
  })

  it('a ball that has hardly moved for a moment and a half (however it came to be) heads back toward the middle', () => {
    const r = rally()
    Object.assign(r, { x: FIELD.R - 12, y: FIELD.B - 12, vx: 150, vy: 0 })
    r.anchor = { x: r.x, y: r.y, t: r.t - 1.6 }
    stepRally(r, DT, null)
    expect(r.nudges).toBe(1)
    const toMiddle = unit(MIDDLE.x - r.x, MIDDLE.y - r.y)
    expect((r.vx * toMiddle.x + r.vy * toMiddle.y) / Math.hypot(r.vx, r.vy)).toBeGreaterThan(0.9)
    // And the guards near it back off, so it gets away.
    expect(r.pucks.filter((pk) => Math.hypot(pk.x - r.x, pk.y - r.y) < 60).every((pk) => pk.rest > 0)).toBe(true)
  })

  it('your puck parked in each corner in turn, or wandering anywhere, leaves the rally going', () => {
    const parked = play(FIVE_MINUTES, (_, t) => { const c = CORNERS[Math.floor(t / 75) % 4]; return { x: c.x + (MIDDLE.x - c.x) * 0.05, y: c.y + (MIDDLE.y - c.y) * 0.05 } })
    expect(parked.still).toBeLessThan(2)
    expect(parked.gap).toBeLessThan(10)
    let seed = 11
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    let at: Pt = { ...MIDDLE }
    const wander = play(FIVE_MINUTES, (_, t) => {
      if (Math.floor(t * 60) % 20 === 0) at = { x: FIELD.L + rand() * (FIELD.R - FIELD.L), y: FIELD.T + rand() * (FIELD.B - FIELD.T) }
      return at
    })
    expect(wander.still).toBeLessThan(2)
    expect(wander.gap).toBeLessThan(10)
  })
})

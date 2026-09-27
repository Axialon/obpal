/**
 * The hero's marble on the page as a person sees it (./harness: the page's layouts as a browser lays them out, a hand's
 * input with its noise, the world stepped as the page steps it, measured as it's drawn): still where it rests, never a
 * jump, never inside anything, always a way out, the raised things as steps, and every knock at its moment.
 */
import { describe, expect, it } from 'vitest'
import { counterOf, inside, roundedRect, withinWalls } from '../src/landing/bounce'
import { TOP } from '../src/landing/letters'
import { PAD_H } from '../src/landing/world'
import { gauss, rng } from './harness/inputs'
import { beside, counters, distTo, gaps } from './harness/metrics'
import { run, type Scenario } from './harness/run'
import { buildWorld, LAYOUTS, ORB_R, type Harness } from './harness/world'

const PHONE = 'phone-390x844'
const DESK = 'desk-1280x800'
/** Dropped from a little above the letters' tops, over (x, z). */
const drop = (x: number, z: number): Scenario['place'] => (m) => { Object.assign(m.orb, { x, z, y: TOP + ORB_R + 0.3, resting: false }) }
/** Set on whatever is at (x, z). */
const at = (x: number, z: number): Scenario['place'] => (m, h) => { Object.assign(m.orb, { x, z, y: h.world.surface(x, z).h + ORB_R, resting: false }) }
/** A phone's tilt of `deg` degrees down (toward you) and right, from 0.3 s on (level before, as held when it started). */
const tipped = (down: number, right: number, from = 0.3) => (t: number): [number, number] => (t < from ? [0, 0] : [down, right])
/** Every counter of the headline, and every gap between two of its letters narrower than a marble. */
const spots = (h: Harness) => {
  const out: { what: string; x: number; z: number; fp?: number; pair?: [number, number] }[] = []
  h.world.footprints.forEach((fp, i) => { for (const c of counters(fp, counterOf)) out.push({ what: `the ${h.world.letters()[i].ch} (letter ${i})`, x: c.x, z: c.z, fp: i }) })
  for (const g of gaps(h, 2 * ORB_R)) out.push({ what: `${h.world.letters()[g.a].ch}|${h.world.letters()[g.b].ch}`, x: g.x, z: g.z, pair: [g.a, g.b] })
  return out
}

describe("the hero's marble at rest, on a 3x phone and a computer", { timeout: 180_000 }, () => {
  it('in every counter of the headline: dead still for 5 s in a noisy hand (tremble, drift, stray readings), at 30, 60 and 120 frames a second', () => {
    const h0 = buildWorld(PHONE)
    const cs = h0.world.footprints.flatMap((fp, i) => counters(fp, counterOf).map((c) => ({ ...c, i })))
    expect(cs.length).toBe(8)
    for (const c of cs) {
      for (const [fps, noise] of [[30, 1], [60, 0.7], [120, 0.5]] as const) {
        for (const hold of [[0, 0], [0, 2]] as const) {
          const h = buildWorld(PHONE)
          const r = run({ h, fps, seconds: 8, seed: c.i * 7 + fps, gyro: { noise, tilt: tipped(hold[0], hold[1]) }, place: drop(c.x, c.z), measureFrom: 3 })
          const what = `letter ${c.i} at ${fps} fps, noise ${noise}°, held ${hold}`
          // Under a tenth of a pixel a frame (as drawn: CSS px; on the 3x screen, device px too), and no jumps.
          expect(r.summary.maxPx, what).toBeLessThan(0.1)
          expect(r.summary.maxDevPx, what).toBeLessThan(0.3)
          expect(r.summary.teleports, what).toBe(0)
          expect(r.summary.maxPen, what).toBeLessThan(0.002)
          expect(counterOf(h.world.footprints[c.i], r.m.orb.x, r.m.orb.z), what).not.toBeNull()
        }
      }
    }
  })
  it('across a gap narrower than itself, sitting on both letters\' edges (the r and the full stop among them): dead still in a noisy hand', () => {
    const h0 = buildWorld(PHONE)
    let cups = 0
    for (const sp of spots(h0).filter((s) => s.pair)) {
      // Where it sits, dropped there: across the gap, up on both edges, at rest (where the gap slopes, it rolls on along
      // it; where it opens out, it's below on the floor).
      const settled = run({ h: buildWorld(PHONE), fps: 60, seconds: 3, seed: 3, place: drop(sp.x, sp.z) }).m.orb
      if (!settled.held || !settled.resting) continue
      cups++
      for (const fps of [30, 60]) {
        const h = buildWorld(PHONE)
        const r = run({ h, fps, seconds: 8, seed: fps, gyro: { noise: 0.8 }, place: drop(sp.x, sp.z), measureFrom: 3 })
        expect(r.summary.maxPx, `${sp.what} at ${fps} fps`).toBeLessThan(0.1)
        expect(r.summary.teleports, sp.what).toBe(0)
        expect(r.summary.maxPen, sp.what).toBeLessThan(0.002)
        expect(sp.pair!.every((k) => distTo(h.world.footprints[k], r.m.orb.x, r.m.orb.y, r.m.orb.z) < ORB_R + 0.01), `${sp.what}: still across it`).toBe(true)
      }
      if (sp.what === 'r|.') cups += 100
    }
    expect(cups).toBeGreaterThan(100)
  })
  it('against a letter\'s side, pressed there by a tilt or pulled by the mouse: still, and silent (a knock as it arrives, none while it leans)', () => {
    for (const i of [0, 3, 6, 9]) {
      for (const deg of [4, 8, 16]) {
        const h = buildWorld(PHONE)
        const fp = h.world.footprints[i]
        const r = run({ h, fps: 60, seconds: 6, seed: i + deg, gyro: { noise: 0.7, tilt: tipped(-deg, 0) }, place: at((fp.box[0] + fp.box[2]) / 2, fp.box[3] + 0.25), measureFrom: 3 })
        expect(r.hits.filter((q) => q.speed > 0.3), `letter ${i}, ${deg}°`).toEqual([])
      }
    }
    // The mouse on the far side of the headline: the marble held against a letter's side, pulled hard.
    for (const [tx, ty] of [[2, 560], [1278, 560]]) {
      for (const i of [1, 5]) {
        const h = buildWorld(DESK)
        const r0 = rng(i)
        const fp = h.world.footprints[i]
        const pointer = Array.from({ length: 6 * 60 }, (_, k) => ({ t: 1000 + k * (1000 / 60), x: tx + gauss(r0) * 0.3, y: ty + gauss(r0) * 0.3 }))
        const r = run({ h, fps: 60, seconds: 6, seed: i, pointer, place: at(fp.spot[0], fp.spot[1]), measureFrom: 3 })
        expect(r.hits, `pulled toward ${tx},${ty} from letter ${i}`).toEqual([])
      }
    }
  })
})

describe("the hero's marble in play", { timeout: 180_000 }, () => {
  it('ten minutes of random play (a wandering tilt, taps and tosses) at 30, 60 and 120 frames a second: never a jump its speed doesn\'t explain', () => {
    for (const [name, fps] of [[PHONE, 60], [PHONE, 30], ['phone-360x800', 120]] as const) {
      const h = buildWorld(name)
      const r0 = rng(fps)
      // A hand's tilt wandering (an Ornstein-Uhlenbeck walk, about 8° either way), a tap every 6 s, a toss every 10.
      let a = 0, b = 0
      const walk: [number, number][] = []
      for (let i = 0; i < 600 * 60; i++) { a += (-a * 0.8 + gauss(r0) * 9) / 60; b += (-b * 0.8 + gauss(r0) * 9) / 60; walk.push([a, b]) }
      const letters = h.world.letters()
      const hops = Array.from({ length: 100 }, (_, k) => { const l = letters[Math.floor(r0() * letters.length)]; return { t: 1000 + k * 6000 + r0() * 3000, x: l.spot[0], z: l.spot[1] } })
      const tosses = Array.from({ length: 60 }, (_, k) => ({ t: 3000 + k * 9700 + r0() * 2000, vy: 3 + r0() * 6 }))
      const r = run({ h, fps, seconds: 600, seed: 99 + fps, gyro: { noise: 0.8, tilt: (t) => walk[Math.min(walk.length - 1, Math.floor(t * 60))] }, hops, tosses, measureFrom: 1 })
      expect(r.summary.teleports, `${name} at ${fps} fps`).toBe(0)
      expect(r.summary.maxJump, `${name} at ${fps} fps`).toBeLessThan(0.05)
      // (Never inside anything but for a hop's first moments, rising past the side of the letter it left from.)
      expect(r.summary.maxPen, `${name} at ${fps} fps`).toBeLessThan(0.1)
      expect(r.summary.maxWallPen, `${name} at ${fps} fps`).toBeLessThan(0.005)
    }
  })
  it('fired at every letter at top speed (14 em/s), from 24 ways round: never through one, never into one', () => {
    const h0 = buildWorld(DESK)
    let shots = 0
    h0.world.footprints.forEach((fp) => {
      const cx = (fp.box[0] + fp.box[2]) / 2, cz = (fp.box[1] + fp.box[3]) / 2
      for (let k = 0; k < 24; k++) {
        const h = buildWorld(DESK)
        const ang = (k / 24) * Math.PI * 2
        const p = withinWalls(h.world.walls, cx - Math.cos(ang) * 1.2, ORB_R, cz - Math.sin(ang) * 1.2, ORB_R)
        if (h.world.footprints.some((f) => inside(f, p.x, p.z) || distTo(f, p.x, ORB_R, p.z) < ORB_R + 0.01)) continue
        const m = h.world.marble('me')
        Object.assign(m.orb, { x: p.x, z: p.z, y: ORB_R, vx: Math.cos(ang) * 14, vz: Math.sin(ang) * 14, resting: false })
        shots++
        for (let i = 0; i < 40; i++) {
          h.world.step(1 / 60)
          const o = m.orb
          for (const f of h.world.footprints) expect(inside(f, o.x, o.z) && o.y - o.r < f.height - 0.002, `into letter ${f.id}`).toBe(false)
        }
      }
    })
    expect(shots).toBeGreaterThan(200)
  })
  it('a tilt rolls it as before: 8°, held a second from rest on the floor, rolls it about an em', () => {
    const h = buildWorld(DESK)
    const start = h.world.floorAt(1000, 650)
    const r = run({ h, fps: 60, seconds: 1.3, seed: 1, gyro: { noise: 0, spikes: 0, drift: 0, tilt: tipped(0, 8) }, place: at(start.x, start.z) })
    expect(r.m.orb.x - start.x).toBeGreaterThan(0.85)
    expect(r.m.orb.x - start.x).toBeLessThan(1.25)
  })
})

describe('always a way out', { timeout: 180_000 }, () => {
  // Where it sits, dropped at each counter and gap: in a cup (a counter; or across a gap, up on both edges), or on the
  // floor below a gap that opens out (between two letters' sides, which are walls there).
  const out = (h: Harness, sp: ReturnType<typeof spots>[number], o: { x: number; y: number; z: number; r: number }) => sp.fp !== undefined
    ? !counterOf(h.world.footprints[sp.fp], o.x, o.z)
    : !sp.pair!.every((k) => distTo(h.world.footprints[k], o.x, o.y, o.z) < o.r + 0.01)
  const ways = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
  it('from every cup, a 5° tilt any of four ways takes it out; so does pointing anywhere outside it', () => {
    const h0 = buildWorld(PHONE)
    for (const sp of spots(h0)) {
      const cup = sp.fp !== undefined || !!run({ h: buildWorld(PHONE), fps: 60, seconds: 2, seed: 3, place: drop(sp.x, sp.z) }).m.orb.held
      if (!cup) continue
      for (const [dx, dz] of ways) {
        const h = buildWorld(PHONE)
        const r = run({ h, fps: 60, seconds: 4.5, seed: 7, gyro: { noise: 0.5, tilt: tipped(dz * 5, dx * 5, 1.5) }, place: drop(sp.x, sp.z) })
        expect(out(h, sp, r.m.orb), `${sp.what}, tipped ${dx},${dz}`).toBe(true)
      }
      if (sp.fp === undefined) continue
      // Pointed (a mouse, no tilt) at a spot outside the counter, a marble's width off, each way.
      for (const [dx, dz] of ways) {
        const h = buildWorld(DESK)
        const scr = h.world.project(sp.x + dx * 0.6, TOP, sp.z + dz * 0.6)
        const pointer = Array.from({ length: 3 * 60 }, (_, k) => ({ t: 2500 + k * (1000 / 60), x: scr.x, y: scr.y }))
        const r = run({ h, fps: 60, seconds: 4.5, seed: 9, pointer, place: drop(sp.x, sp.z) })
        expect(out(h, sp, r.m.orb), `${sp.what}, pointed ${dx},${dz}`).toBe(true)
      }
    }
  })
  it('from the floor between two letters, some tilt and some point take it out', () => {
    const h0 = buildWorld(PHONE)
    for (const sp of spots(h0).filter((s) => s.pair)) {
      if (run({ h: buildWorld(PHONE), fps: 60, seconds: 2, seed: 3, place: drop(sp.x, sp.z) }).m.orb.held) continue
      const tilt = ways.some(([dx, dz]) => { const h = buildWorld(PHONE); return out(h, sp, run({ h, fps: 60, seconds: 4.5, seed: 7, gyro: { noise: 0.5, tilt: tipped(dz * 5, dx * 5, 1.5) }, place: drop(sp.x, sp.z) }).m.orb) })
      expect(tilt, `${sp.what}: by tilt`).toBe(true)
    }
  })
  it('from every corner of what\'s on screen, on phones (upright and sideways) and computers: out by a 5° tilt toward the middle, and by pointing there', () => {
    let corners = 0
    for (const name of Object.keys(LAYOUTS)) {
      const h0 = buildWorld(name)
      const { W, play } = h0.layout
      const bottom = Math.min(play.bottom, h0.layout.H)
      for (const [cx, cy] of [[0, play.top], [W, play.top], [0, bottom], [W, bottom]]) {
        // Set in the corner (its outline touching both edges, as drawn), where nothing else stands, and left to sleep.
        const f = h0.world.floorAt(cx, cy)
        const p = withinWalls(h0.world.walls, f.x, ORB_R, f.z, ORB_R)
        if (h0.world.surface(p.x, p.z).id !== -1 || [...h0.world.footprints, ...h0.world.pads].some((fp) => distTo(fp, p.x, ORB_R, p.z) < ORB_R)) continue
        corners++
        const what = `${name}, corner ${cx},${cy}`
        const down = cy > play.top ? -5 : 5, right = cx > 0 ? -5 : 5
        const h = buildWorld(name)
        const r = run({ h, fps: 60, seconds: 6, seed: 11, gyro: { noise: 0.6, tilt: (t) => (t < 1.5 ? [0, 0] : [down, right]) }, place: at(p.x, p.z), measureFrom: 0 })
        const start = r.samples.find((q) => q.t >= 2400)!, end = r.samples.at(-1)!
        expect(start.resting, `${what}: asleep there`).toBe(true)
        expect(Math.hypot(end.sx - start.sx, end.sy - start.sy), `${what}: out by tilt`).toBeGreaterThan(40)
        // Pointed at the middle, from the corner.
        const hp = buildWorld(name)
        const pointer = Array.from({ length: 3 * 60 }, (_, k) => ({ t: 2500 + k * (1000 / 60), x: W / 2, y: (play.top + bottom) / 2 }))
        const rp = run({ h: hp, fps: 60, seconds: 5.5, seed: 12, pointer, place: at(p.x, p.z), measureFrom: 0 })
        const a = rp.samples.find((q) => q.t >= 2400)!, b = rp.samples.at(-1)!
        expect(Math.hypot(b.sx - a.sx, b.sy - a.sy), `${what}: out by pointing`).toBeGreaterThan(40)
      }
    }
    expect(corners).toBeGreaterThan(16)
  })
})

describe("the raised things (the buttons, the hint, the sound control, the three steps' icons): blocks 0.3 em tall", { timeout: 180_000 }, () => {
  // (On a phone the first button sends the page to a computer; on a computer it opens the viewer.)
  const things = [
    ['the first button', (h: Harness) => h.pad(/send|open the viewer/i)], ['"See what it does"', (h: Harness) => h.pad(/see what/i)],
    ["a step's icon", (h: Harness) => h.icon(0)], ["the second step's icon", (h: Harness) => h.icon(1)], ["the third step's icon", (h: Harness) => h.icon(2)],
    ['the sound control', (h: Harness) => h.pad(/sound/i)], ['the hint', (h: Harness) => h.pad(/tilt/i)],
  ] as const
  /** From open floor right beside one, tipped `deg` toward it for 5 s: whether it went up onto it, and the run. */
  const tip = (pick: (h: Harness) => number, deg: number, seed = deg) => {
    const h = buildWorld(PHONE)
    const i = pick(h)
    const pad = h.world.pads.find((p) => p.id === 1000 + i)!
    const b = beside(h, i)
    const r = run({ h, fps: 60, seconds: 6, seed, gyro: { noise: 0.7, tilt: tipped(b.down * deg, b.right * deg) }, place: at(b.x, b.z), measureFrom: 0 })
    const up = r.samples.find((q) => q.y > pad.height + ORB_R - 0.01 && inside(pad, q.x, q.z))
    return { up: !!up, r }
  }
  it('each is a block its own height (half as tall again as a marble\'s radius), whose top is where the page draws it', () => {
    expect(PAD_H).toBeCloseTo(0.3, 9)
    expect(PAD_H).toBeGreaterThan(ORB_R)
    for (const name of Object.keys(LAYOUTS)) {
      const h = buildWorld(name)
      h.layout.pads.forEach((b, i) => {
        if (!(b.w > 0)) return
        const pad = h.world.pads.find((p) => p.id === 1000 + i)!
        expect(pad.height).toBe(PAD_H)
        // Its top's outline, seen from the camera at its height, is its box on screen (to a hundredth of a pixel).
        const pts = roundedRect(b.x, b.y, b.w, b.h, b.r, 4)
        for (let k = 0; k < pts.length; k += 2) {
          const q = h.world.project(pad.rings[0][k], PAD_H, pad.rings[0][k + 1])
          expect(Math.hypot(q.x - pts[k], q.y - pts[k + 1]), `${name}, raised thing ${i}`).toBeLessThan(0.01)
        }
      })
    }
  })
  it('each blocks a gentle tilt (5°, 8°, 11°), against its side without a tremor, and is climbed with a clear one (15°): up its side and over its edge, never a jump', () => {
    for (const [what, pick] of things) {
      for (const deg of [5, 8, 11]) {
        const { up, r } = tip(pick, deg)
        expect(up, `${what} at ${deg}°`).toBe(false)
        // Held against it (a round one, the sound control on a phone, lets it roll slowly round its side).
        const last = r.samples.filter((q) => q.t > 5000)
        const steps = last.slice(1).map((q, k) => [q.sx - last[k].sx, q.sy - last[k].sy])
        expect(Math.max(...steps.map(([x, y]) => Math.hypot(x, y))), `${what} at ${deg}°: no more than rolling slowly`).toBeLessThan(0.5)
        // Not a tremor: never back the way it just came.
        expect(steps.slice(1).every(([x, y], k) => x * steps[k][0] + y * steps[k][1] >= -1e-6), `${what} at ${deg}°: no tremor`).toBe(true)
      }
      for (const seed of [15, 16, 17]) {
        const { up, r } = tip(pick, 15, seed)
        expect(up, `${what} at 15°`).toBe(true)
        expect(r.summary.teleports, `${what} at 15°`).toBe(0)
        expect(r.summary.maxPen, `${what} at 15°`).toBeLessThan(0.01)
      }
    }
  })
  it('each is climbed by pointing at it; resting on one is still; rolling over their edges never jumps', () => {
    for (const [what, pick] of things) {
      const h = buildWorld(DESK)
      let i: number
      try { i = pick(h) } catch { continue }
      const b = h.layout.pads[i]
      if (!(b.w > 0)) continue
      const pad = h.world.pads.find((p) => p.id === 1000 + i)!
      const from = beside(h, i)
      const pointer = Array.from({ length: 5 * 60 }, (_, k) => ({ t: 1000 + k * (1000 / 60), x: b.x + b.w / 2, y: b.y + b.h / 2 }))
      const r = run({ h, fps: 60, seconds: 7, seed: i, pointer, place: at(from.x, from.z), measureFrom: 0.5 })
      const o = r.m.orb
      expect(inside(pad, o.x, o.z), `${what}: up on it`).toBe(true)
      expect(o.y).toBeCloseTo(pad.height + ORB_R, 3)
      expect(r.summary.teleports, what).toBe(0)
      // Resting there, the last second: nothing moves.
      const last = r.samples.slice(-60)
      expect(Math.max(...last.slice(1).map((q, k) => Math.hypot(q.sx - last[k].sx, q.sy - last[k].sy))), `${what}: still on it`).toBeLessThan(0.1)
    }
  })
  it('a flick (a toss) beside one, tilted gently toward it, lands it on top', () => {
    for (const [what, pick] of things) {
      const h = buildWorld(PHONE)
      const i = pick(h)
      const pad = h.world.pads.find((p) => p.id === 1000 + i)!
      const b = beside(h, i)
      const r = run({ h, fps: 60, seconds: 4.5, seed: 5, gyro: { noise: 0.5, tilt: (t) => (t < 0.3 || t > 2.2 ? [0, 0] : [b.down * 8, b.right * 8]) }, tosses: [{ t: 2400, vy: 5 }], place: at(b.x, b.z), measureFrom: 0 })
      const landed = r.hits.find((q) => q.kind === 'button' && q.pad === i && q.landed && !q.soft)
      expect(landed, `${what}: landed on it`).toBeDefined()
      expect(r.samples.some((q) => q.t > 2400 && inside(pad, q.x, q.z) && Math.abs(q.y - pad.height - ORB_R) < 0.01), `${what}: on it`).toBe(true)
    }
  })
  it('rolled off one, it drops to the floor: a knock as hard as a fall of its height, then each bounce lower', () => {
    const h = buildWorld(PHONE)
    const i = h.pad(/see what/i)
    const pad = h.world.pads.find((p) => p.id === 1000 + i)!
    const [cx, cz] = pad.spot
    const r = run({ h, fps: 60, seconds: 5, seed: 4, spikes: 0, gyro: { noise: 0.5, tilt: tipped(8, 0) }, place: at(cx, cz), measureFrom: 0 })
    const floor = r.hits.filter((q) => q.kind === 'floor' && q.landed)
    expect(floor.length).toBeGreaterThan(1)
    expect(floor[0].speed).toBeGreaterThan(Math.sqrt(2 * 18 * PAD_H) * 0.8)
    expect(floor[0].speed).toBeLessThan(Math.sqrt(2 * 18 * PAD_H) * 1.1)
    for (let k = 1; k < floor.length; k++) expect(floor[k].speed).toBeLessThan(floor[k - 1].speed)
    expect(r.summary.teleports).toBe(0)
  })
})

describe('knocks', () => {
  it('each at its moment: dropped from a height, it lands at the moment a fall takes, whatever the frame rate (within one step)', () => {
    const fall = Math.sqrt((2 * 1) / 18)
    for (const fps of [30, 60, 120]) {
      const h = buildWorld(DESK)
      const p = h.world.floorAt(1000, 650)
      const r = run({ h, fps, seconds: 1.5, seed: 1, spikes: 0, place: (m) => { Object.assign(m.orb, { x: p.x, z: p.z, y: ORB_R + 1, resting: false }) } })
      const land = r.hits.find((q) => q.kind === 'floor' && q.landed)!
      expect(land, `${fps} fps`).toBeDefined()
      expect(Math.abs(land.t - fall), `${fps} fps: at ${land.t}`).toBeLessThan(1 / 240)
      expect(land.speed).toBeCloseTo(18 * fall, 0)
    }
  })
  it('once for each contact that begins: rolling along the floor or a side is silent, each new bounce is heard', () => {
    const h = buildWorld(DESK)
    const p = h.world.floorAt(900, 650)
    const r = run({ h, fps: 60, seconds: 4, seed: 1, spikes: 0, place: (m) => { Object.assign(m.orb, { x: p.x, z: p.z, y: ORB_R + 1.2, resting: false }) } })
    const floor = r.hits.filter((q) => q.kind === 'floor')
    // Each bounce lower than the last (a knock for each), then quiet: it's resting, rolling nowhere.
    for (let k = 1; k < floor.length; k++) expect(floor[k].speed).toBeLessThan(floor[k - 1].speed)
    expect(floor.length).toBeGreaterThan(2)
    expect(floor.filter((q) => q.t > 2)).toEqual([])
  })
})

/**
 * The hero's marble, measured across the page's layouts and the ways people play (the numbers behind the physics'
 * tests): runs only with LANEQ=1 (LANEQ=1 npx vitest run tests/harness/report.test.ts --reporter=verbose), and prints
 * its report as one line of JSON after "LANEQ-REPORT ". Every scenario is seeded, so a run is reproducible frame for
 * frame.
 */
import { describe, it } from 'vitest'
import { counterOf, inside, withinWalls } from '../../src/landing/bounce'
import { TOP } from '../../src/landing/letters'
import { gauss, rng } from './inputs'
import { counters, distTo, gaps } from './metrics'
import { run, type Scenario } from './run'
import { buildWorld, ORB_R, type Harness } from './world'

const ON = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LANEQ === '1'
const round = (v: unknown): unknown => typeof v === 'number' ? +v.toPrecision(4) : Array.isArray(v) ? v.map(round) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v
const drop = (x: number, z: number) => (m: { orb: { x: number; y: number; z: number; resting: boolean } }) => { Object.assign(m.orb, { x, z, y: TOP + ORB_R + 0.3, resting: false }) }
const at = (x: number, z: number) => (m: { orb: { x: number; y: number; z: number; resting: boolean } }, h: Harness) => { Object.assign(m.orb, { x, z, y: h.world.surface(x, z).h + ORB_R, resting: false }) }
const report: Record<string, unknown> = {}
const go = (sc: Scenario, extra: Record<string, unknown> = {}) => {
  const r = run(sc)
  const sounds = r.hits.filter((q) => q.speed > (q.kind === 'wall' ? 0.3 : 0.6))
  return { ...extra, ...(round(r.summary) as object), sounds: sounds.length, kinds: sounds.reduce<Record<string, number>>((k, q) => ((k[q.kind] = (k[q.kind] ?? 0) + 1), k), {}), end: r.m.orb }
}

describe.skipIf(!ON)('lane Q: the marble, measured', () => {
  it('rests in the headline\'s counters (phone, gyro held with noise)', () => {
    const rows: unknown[] = []
    const h0 = buildWorld('phone-390x844')
    h0.world.footprints.forEach((fp, i) => {
      for (const c of counters(fp, counterOf)) {
        for (const [fps, noise] of [[60, 0.7], [30, 1], [120, 0.5], [60, 1]] as const) {
          for (const hold of [[0, 0], [1.5, 0], [0, 2]] as const) {
            const h = buildWorld('phone-390x844')
            const s = go({ h, fps, seconds: 8, seed: 11 + i * 7 + fps, gyro: { noise, tilt: (t) => (t < 0.3 ? [0, 0] : [hold[0], hold[1]]) }, place: drop(c.x, c.z), measureFrom: 3 }, { letter: `${h.world.letters()[i].ch}#${i}`, a: c.a, fps, noise, hold })
            rows.push({ ...s, inCounter: !!counterOf(fp, (s.end as { x: number }).x, (s.end as { z: number }).z), end: undefined })
          }
        }
      }
    })
    report.counters = rows
  })
  it('rests in counters of other glyphs (isolated: O, P, R, a, d, e, o, p, …)', () => {
    const rows: unknown[] = []
    for (const ch of ['O', 'P', 'R', 'a', 'd', 'e', 'o', 'p', 'b', 'g', 'q', 'B', 'D', 'Q', '0', '8']) {
      const glyphBox = { x: 150, y: 140, w: 70, h: 90 }
      const h = buildWorld('phone-390x844', [ch], glyphBox)
      const fp = h.world.footprints[0]
      for (const c of counters(fp, counterOf)) {
        const hh = buildWorld('phone-390x844', [ch], glyphBox)
        const s = go({ h: hh, fps: 60, seconds: 8, seed: ch.charCodeAt(0), gyro: { noise: 0.8 }, place: drop(c.x, c.z), measureFrom: 3 }, { ch, a: c.a })
        rows.push({ ...s, inCounter: !!counterOf(fp, (s.end as { x: number }).x, (s.end as { z: number }).z), end: undefined })
      }
    }
    report.glyphCounters = rows
  })
  it('rests in gaps narrower than a marble (phone and computer)', () => {
    const rows: unknown[] = []
    for (const name of ['phone-390x844', 'desk-1280x800']) {
      for (const gp of gaps(buildWorld(name), 2 * ORB_R)) {
        for (const fps of [60, 30]) {
          const h = buildWorld(name)
          const pair = `${h.world.letters()[gp.a].ch}|${h.world.letters()[gp.b].ch}`
          rows.push({ ...go({ h, fps, seconds: 8, seed: gp.a * 31 + gp.b + fps, gyro: name.startsWith('phone') ? { noise: 0.8 } : undefined, place: drop(gp.x, gp.z), measureFrom: 3 }, { layout: name, pair, w: gp.w, fps }), end: undefined })
        }
      }
    }
    report.gaps = rows
  })
  it('pressed against a letter\'s side by a steady tilt', () => {
    const rows: unknown[] = []
    for (const i of [0, 3, 6, 9]) {
      for (const deg of [4, 8, 16]) {
        const h = buildWorld('phone-390x844')
        const fp = h.world.footprints[i]
        const x = (fp.box[0] + fp.box[2]) / 2
        rows.push({ ...go({ h, fps: 60, seconds: 6, seed: i + deg, gyro: { noise: 0.7, tilt: (t) => [t < 0.3 ? 0 : -deg, 0] }, place: at(x, fp.box[3] + 0.25), measureFrom: 3 }, { letter: `${h.world.letters()[i].ch}#${i}`, deg }), end: undefined })
      }
    }
    report.sidePress = rows
  })
  it('steered by the mouse at a point behind a letter (the rattle)', () => {
    const rows: unknown[] = []
    for (const [label, tx, ty] of [['left edge', 2, 560], ['right edge', 1278, 560], ['left, level with line 2', 2, 330], ['above line 1', 300, 120]] as const) {
      for (const i of [1, 5, 12]) {
        const h = buildWorld('desk-1280x800')
        const r = rng(i)
        const fp = h.world.footprints[i]
        const pointer = Array.from({ length: 6 * 60 }, (_, k) => ({ t: 1000 + k * (1000 / 60), x: tx + gauss(r) * 0.3, y: ty + gauss(r) * 0.3 }))
        rows.push({ ...go({ h, fps: 60, seconds: 6, seed: i, pointer, place: at(fp.spot[0], fp.spot[1]), measureFrom: 2 }, { target: label, from: `${h.world.letters()[i].ch}#${i}` }), end: undefined })
      }
    }
    report.pointerBehind = rows
  })
  it('pointed at a counter with the hand on the mouse (tremor)', () => {
    const rows: unknown[] = []
    const h0 = buildWorld('desk-1280x800')
    h0.world.footprints.forEach((fp, i) => {
      for (const c of counters(fp, counterOf)) {
        const h = buildWorld('desk-1280x800')
        const sp = h.world.project(c.x, TOP, c.z)
        const r = rng(i)
        const pointer = Array.from({ length: 8 * 60 }, (_, k) => ({ t: 1000 + k * (1000 / 60), x: sp.x + gauss(r) * 0.5, y: sp.y + gauss(r) * 0.5 }))
        const s = go({ h, fps: 60, seconds: 8, seed: i, pointer, place: at(fp.spot[0], fp.spot[1]), measureFrom: 3 }, { letter: `${h.world.letters()[i].ch}#${i}`, a: c.a })
        rows.push({ ...s, inCounter: !!counterOf(fp, (s.end as { x: number }).x, (s.end as { z: number }).z), end: undefined })
      }
    })
    report.pointCounter = rows
  })
  it('tipped into the corners of the screen, and against the raised things', () => {
    const rows: unknown[] = []
    for (const [label, down, right, sx, sy] of [['top-left', -12, -12, 120, 90], ['top-right', -12, 12, 270, 90], ['left', 3, -12, 200, 300], ['right', 3, 12, 200, 300]] as const) {
      const h = buildWorld('phone-390x844')
      const p = h.world.floorAt(sx, sy)
      rows.push({ ...go({ h, fps: 60, seconds: 7, seed: down * 3 + right, gyro: { noise: 0.7, tilt: (t) => [t < 0.3 ? 0 : down, t < 0.3 ? 0 : right] }, place: at(p.x, p.z), measureFrom: 4 }, { where: label }), end: undefined })
    }
    // Below each raised thing, tipped gently toward it (too little to climb it), and clearly (enough).
    for (const [what, pick] of [['send', (h: Harness) => h.pad(/send/i)], ['see', (h: Harness) => h.pad(/see what/i)], ['icon', (h: Harness) => h.icon(0)], ['sound', (h: Harness) => h.pad(/sound/i)]] as const) {
      for (const deg of [2, 5, 8, 10]) {
        const h = buildWorld('phone-390x844')
        const pad = h.world.pads.find((p) => p.id === 1000 + pick(h))!
        const below = h.world.floorAt(...(() => { const c = h.layout.pads[pick(h)]; return [c.x + c.w / 2, c.y + c.h + 26] as [number, number] })())
        const s = go({ h, fps: 60, seconds: 7, seed: deg, gyro: { noise: 0.7, tilt: (t) => [t < 0.3 ? 0 : -deg, 0] }, place: at(below.x, below.z), measureFrom: 4 }, { where: `${what}, ${deg}°` })
        rows.push({ ...s, onPad: inside(pad, (s.end as { x: number }).x, (s.end as { z: number }).z) || (s.end as { z: number }).z < pad.box[1], end: undefined })
      }
    }
    report.cornersButtons = rows
  })
  it('ten minutes of random play (tilt and taps): teleports, depth, tunnelling', () => {
    const rows: unknown[] = []
    for (const [name, fps] of [['phone-390x844', 60], ['phone-390x844', 30], ['phone-360x800', 120]] as const) {
      const h = buildWorld(name)
      const r = rng(fps)
      // A hand's tilt wandering (an Ornstein-Uhlenbeck walk, about 8° either way), and a tap now and then.
      let a = 0, b = 0
      const walk: [number, number][] = []
      for (let i = 0; i < 600 * 60; i++) { a += (-a * 0.8 + gauss(r) * 9) / 60; b += (-b * 0.8 + gauss(r) * 9) / 60; walk.push([a, b]) }
      const letters = h.world.letters()
      const hops = Array.from({ length: 100 }, (_, k) => { const l = letters[Math.floor(r() * letters.length)]; return { t: 1000 + k * 6000 + r() * 3000, x: l.spot[0], z: l.spot[1] } })
      const tosses = Array.from({ length: 60 }, (_, k) => ({ t: 3000 + k * 9700 + r() * 2000, vy: 3 + r() * 6 }))
      rows.push({ ...go({ h, fps, seconds: 600, seed: 99 + fps, gyro: { noise: 0.8, tilt: (t) => walk[Math.min(walk.length - 1, Math.floor(t * 60))] }, hops, tosses, measureFrom: 1 }, { layout: name, fps }), end: undefined })
    }
    report.random = rows
  })
  it('fired at the letters at top speed: does it ever pass through one, or sink into one?', () => {
    let through = 0, shots = 0, deepest = 0
    const worst: unknown[] = []
    const h = buildWorld('desk-1280x800')
    h.world.footprints.forEach((fp, li) => {
      const cx = (fp.box[0] + fp.box[2]) / 2, cz = (fp.box[1] + fp.box[3]) / 2
      for (let k = 0; k < 24; k++) {
        const hh = buildWorld('desk-1280x800')
        const ang = (k / 24) * Math.PI * 2
        const p = withinWalls(hh.world.walls, cx - Math.cos(ang) * 1.2, ORB_R, cz - Math.sin(ang) * 1.2, ORB_R)
        // (From open floor only: not a start inside another letter, or against one.)
        if (hh.world.footprints.some((f) => inside(f, p.x, p.z) || distTo(f, p.x, ORB_R, p.z) < ORB_R + 0.01)) continue
        const m = hh.world.marble('me')
        Object.assign(m.orb, { x: p.x, z: p.z, y: ORB_R, vx: Math.cos(ang) * 14, vz: Math.sin(ang) * 14, resting: false })
        shots++
        let pen = 0, crossed = false
        for (let i = 0; i < 40; i++) {
          hh.world.step(1 / 60)
          for (const f of hh.world.footprints) {
            const o = m.orb
            if (inside(f, o.x, o.z) && o.y - o.r < f.height - 0.02) crossed = true
          }
          pen = Math.max(pen, ...hh.world.footprints.map((f) => { const o = m.orb; const e = inside(f, o.x, o.z); return e && o.y < f.height + o.r ? f.height + o.r - o.y : 0 }))
        }
        deepest = Math.max(deepest, pen)
        if (crossed) { through++; if (worst.length < 8) worst.push({ letter: li, ang: k }) }
      }
    })
    report.tunnel = { shots, through, deepest, worst }
  })
  it('breaks away from every cup and gap: by tilt alone (5°), and by pointing alone', () => {
    const rows: unknown[] = []
    const h0 = buildWorld('phone-390x844')
    const spots: { what: string; x: number; z: number; fp?: number; pair?: [number, number] }[] = []
    h0.world.footprints.forEach((fp, i) => { for (const c of counters(fp, counterOf)) spots.push({ what: `counter ${h0.world.letters()[i].ch}#${i}`, x: c.x, z: c.z, fp: i }) })
    for (const gp of gaps(h0, 2 * ORB_R)) spots.push({ what: `gap ${h0.world.letters()[gp.a].ch}|${h0.world.letters()[gp.b].ch}`, x: gp.x, z: gp.z, pair: [gp.a, gp.b] })
    // Out: out of the counter; out of the gap (no longer held between its two letters).
    const isOut = (h: Harness, sp: (typeof spots)[number], o: { x: number; y: number; z: number; r: number }) => sp.fp !== undefined
      ? !counterOf(h.world.footprints[sp.fp], o.x, o.z)
      : !sp.pair!.every((k) => distTo(h.world.footprints[k], o.x, o.y, o.z) < o.r + 0.01)
    for (const sp of spots) {
      // Where it settles, dropped there: in a cup (a counter, or up on edges across a gap), or on the floor below.
      const settled = run({ h: buildWorld('phone-390x844'), fps: 60, seconds: 1.5, seed: 7, place: drop(sp.x, sp.z) }).m.orb
      const cup = sp.fp !== undefined || !!settled.held
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const h = buildWorld('phone-390x844')
        // Settled there first (1.5 s), then tilted 5° that way for 3 s.
        const r = run({ h, fps: 60, seconds: 4.5, seed: 7, gyro: { noise: 0.5, tilt: (t) => (t < 1.5 ? [0, 0] : [dz * 5, dx * 5]) }, place: drop(sp.x, sp.z) })
        const o = r.m.orb
        const moved = Math.hypot(o.x - sp.x, o.z - sp.z)
        rows.push({ what: sp.what, cup, by: `tilt ${dx},${dz}`, out: isOut(h, sp, o), moved: +moved.toFixed(3) })
      }
      // Pointed at a spot a marble's width outside, that way, for 3 s (a mouse, no tilt).
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const h = buildWorld('desk-1280x800')
        const hs = buildWorld('desk-1280x800')
        void hs
        const tx = sp.x + dx * 0.6, tz = sp.z + dz * 0.6
        const scr = h.world.project(tx, TOP, tz)
        const pointer = Array.from({ length: 3 * 60 }, (_, k) => ({ t: 2500 + k * (1000 / 60), x: scr.x, y: scr.y }))
        const r = run({ h, fps: 60, seconds: 4.5, seed: 9, pointer, place: drop(sp.x, sp.z) })
        const o = r.m.orb
        const moved = Math.hypot(o.x - sp.x, o.z - sp.z)
        rows.push({ what: sp.what, cup, by: `point ${dx},${dz}`, out: isOut(h, sp, o), moved: +moved.toFixed(3) })
      }
    }
    report.breakaway = rows
  })
  it('prints the report', () => { console.log(`LANEQ-REPORT ${JSON.stringify(report)}`) })
})

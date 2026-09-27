/**
 * The hero's knocks as they're heard: the physics harness's world (./harness), the hero's sound itself
 * (../src/landing/glass.ts), driven frame by frame as the hero drives it, into speakers as far behind the screen as a
 * computer's or a Bluetooth link's (./harness/speakers.ts). Foreseen and started ahead, a knock is heard with the frame
 * that shows it; none is heard twice; one called off is never heard, and nothing is cut off once playing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlass } from '../src/landing/glass'
import { foreseeable, heard, keyOf } from '../src/landing/world'
import { gauss, hold, rng, type PointerEvt } from './harness/inputs'
import { run, type Scenario } from './harness/run'
import { speakers } from './harness/speakers'
import { buildWorld } from './harness/world'

const PHONE = 'phone-390x844'
const DESK = 'desk-1280x800'
/** On time: heard with the frame that shows it, this long after its moment (ms: glass.ts SCREEN_MS). */
const ON_TIME = 20

interface Heard {
  /** Knocks the physics made that were heard, and how many of them had been foreseen (met by the knock itself). */
  knocks: number
  met: number
  /** How long after its moment each was heard (ms): the median and the 90th percentile. */
  median: number
  p90: number
  /**
   * Foreseen and heard, but never met by the knock itself: heard for nothing, or heard twice (the knock heard as it came
   * as well, within 40 ms); sounds cut off once playing; knocks foreseen and called off.
   */
  wrong: number
  twice: number
  cuts: number
  calledOff: number
  /** This machine's time for the foresight each frame (ms, mean). */
  foreseeMs: number
}

/** A scenario played with the hero's sound on, into speakers `lag` s behind; with the knocks foreseen, or not. */
function listen(sc: Omit<Scenario, 'each'>, lag: number, foresight: boolean, also?: (T: number) => void): Heard {
  const realNow = performance.now.bind(performance)
  const sp = speakers(lag)
  vi.stubGlobal('AudioContext', sp.Ctx)
  vi.spyOn(performance, 'now').mockImplementation(() => sp.now)
  const glass = createGlass()
  glass.gesture()
  const w = sc.h.world
  const log: { how: 'hit' | 'foresee'; key: string; at: number; made: boolean; verdict?: string }[] = []
  let spent = 0, frames = 0
  run({
    ...sc,
    each(T, dt, hits) {
      // The hero's actor: the frame's knocks heard at their moments, then those foreseen.
      sp.now = T + 1
      const shownAt = w.shownAt()
      for (const h of hits) {
        if (!heard(h)) continue
        const at = T - (shownAt - h.t) * 1000, id = log.length, n = sp.sounds.length
        log.push({ how: 'hit', key: keyOf(h), at, made: false })
        log[id].verdict = glass.hit(h.kind, h.speed, sp.panOf(id), [h.orb, h.other], at, keyOf(h))
        log[id].made = sp.sounds.length > n
      }
      const t0 = realNow()
      const lead = foresight ? glass.lead(dt) : 0
      const ahead = lead > 0 ? w.foresee(lead).filter((h) => foreseeable(h)) : []
      spent += realNow() - t0
      frames++
      glass.foresee(ahead.map((h) => {
        const at = T - (shownAt - h.t) * 1000, id = log.length
        log.push({ how: 'foresee', key: keyOf(h), at, made: true })
        return { key: keyOf(h), kind: h.kind, speed: h.speed, pan: sp.panOf(id), marbles: [h.orb, h.other] as [string, string?], at }
      }), dt)
      also?.(T)
    },
  })
  // Each knock's sounds: heard if any of them is, from the first to start.
  const knocks = new Map<number, { when: number; heard: boolean }>()
  for (const s of sp.sounds) {
    if (s.knock < 0) continue
    const k = knocks.get(s.knock) ?? { when: Infinity, heard: false }
    k.when = Math.min(k.when, sp.heardAt(s.start))
    k.heard ||= s.stop === null || s.stop > s.start
    knocks.set(s.knock, k)
  }
  const sounded = [...knocks].filter(([, k]) => k.heard).map(([id, k]) => ({ id, when: k.when, ...log[id] }))
  // Each knock heard: its own sound, or the one foreseen for it (of its name, the nearest its moment, not yet taken).
  const taken = new Set<number>()
  const delays: number[] = []
  let met = 0
  for (const [id, q] of log.entries()) {
    if (q.how !== 'hit' || q.verdict !== 'heard') continue
    if (q.made) { const k = knocks.get(id); if (k?.heard) delays.push(k.when - q.at); continue }
    const early = sounded.filter((s) => s.how === 'foresee' && s.key === q.key && !taken.has(s.id)).sort((a, b) => Math.abs(a.when - q.at) - Math.abs(b.when - q.at))[0]
    if (!early) continue
    taken.add(early.id)
    delays.push(early.when - q.at)
    met++
  }
  // Foreseen and heard, but no knock of its name came to meet it: heard for nothing, or (a knock of its name heard as
  // it came, within 40 ms) heard twice.
  const unmet = sounded.filter((s) => s.how === 'foresee' && !taken.has(s.id))
  const own = sounded.filter((s) => s.how === 'hit')
  const twice = unmet.filter((s) => own.some((q) => q.key === s.key && Math.abs(q.when - s.when) < 40)).length
  const wrong = unmet.length - twice
  delays.sort((a, b) => a - b)
  const out: Heard = {
    knocks: delays.length, met, wrong, twice, cuts: sp.cuts, calledOff: glass.stats().foreseen.calledOff,
    median: delays[Math.floor(delays.length / 2)] ?? NaN, p90: delays[Math.floor(delays.length * 0.9)] ?? NaN,
    foreseeMs: spent / Math.max(1, frames),
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  return out
}

/** A phone played at random for `seconds`: a hand's tilt wandering (about 8° either way), a tap every 6 s, a toss every 10. */
function phonePlay(seed: number, seconds: number): Omit<Scenario, 'each'> {
  const h = buildWorld(PHONE)
  const r = rng(seed)
  let a = 0, b = 0
  const walk: [number, number][] = []
  for (let i = 0; i < seconds * 60; i++) { a += (-a * 0.8 + gauss(r) * 9) / 60; b += (-b * 0.8 + gauss(r) * 9) / 60; walk.push([a, b]) }
  const letters = h.world.letters()
  const hops = Array.from({ length: Math.floor(seconds / 6) }, (_, k) => { const l = letters[Math.floor(r() * letters.length)]; return { t: 1000 + k * 6000 + r() * 3000, x: l.spot[0], z: l.spot[1] } })
  const tosses = Array.from({ length: Math.floor(seconds / 10) }, (_, k) => ({ t: 3000 + k * 9700 + r() * 2000, vy: 3 + r() * 6 }))
  return { h, fps: 60, seconds, seed, gyro: { noise: 0.8, tilt: (t) => walk[Math.min(walk.length - 1, Math.floor(t * 60))] }, hops, tosses }
}

/** A computer's mouse at random for `seconds`: held a while here, then there (with a hand's tremor), and a click every 5 s. */
function mousePlay(seed: number, seconds: number): Omit<Scenario, 'each'> {
  const h = buildWorld(DESK)
  const r = rng(seed)
  const pointer: PointerEvt[] = []
  const { W } = h.layout, { top, bottom } = h.layout.play
  for (let t = 1000; t < 1000 + seconds * 1000;) {
    const dur = 400 + r() * 2600
    pointer.push(...hold(W * (0.05 + 0.9 * r()), top + (bottom - top) * r(), t, dur / 1000, r))
    t += dur
  }
  const letters = h.world.letters()
  const hops = Array.from({ length: Math.floor(seconds / 5) }, (_, k) => { const l = letters[Math.floor(r() * letters.length)]; return { t: 2000 + k * 5000 + r() * 2000, x: l.spot[0], z: l.spot[1] } })
  return { h, fps: 60, seconds, seed, pointer, hops }
}

/** With LANEQ=1 (and --reporter=verbose), each case's numbers, as a line after "LANEQ-SOUND ". */
const LANEQ = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LANEQ === '1'
const report = (what: string, q: Heard) => {
  if (LANEQ) console.log(`LANEQ-SOUND ${what}: ${JSON.stringify({ ...q, median: +q.median.toFixed(1), p90: +q.p90.toFixed(1), foreseeMs: +q.foreseeMs.toFixed(3) })}`)
}

describe("the hero's knocks, heard", { timeout: 300_000 }, () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('on a computer\'s speakers (50 ms behind): foreseen, heard with the frame that shows them; never twice, never cut off', () => {
    for (const [what, play] of [['mouse', () => mousePlay(12, 600)], ['phone', () => phonePlay(11, 600)]] as const) {
      const was = listen(play(), 0.05, false)
      const now = listen(play(), 0.05, true)
      report(`${what} 50ms without`, was)
      report(`${what} 50ms foreseen`, now)
      expect(now.knocks, what).toBeGreaterThan(150)
      // As many knocks heard either way (none lost, none added).
      expect(Math.abs(now.knocks - was.knocks), what).toBeLessThanOrEqual(Math.max(2, was.knocks * 0.02))
      // Nearly all foreseen, and heard on time (as they come, they're a frame and the speakers' lag late).
      expect(now.met / now.knocks, what).toBeGreaterThan(0.8)
      expect(now.median, what).toBeLessThanOrEqual(ON_TIME + 1)
      expect(was.median, what).toBeGreaterThan(50)
      // Hardly ever one for nothing; never one twice; nothing cut off.
      expect(now.wrong / now.knocks, what).toBeLessThan(0.02)
      expect(now.twice + was.twice, what).toBe(0)
      expect(now.cuts, what).toBe(0)
    }
  })
  it('two marbles knocking into each other and everything else, on a phone\'s speakers (30 ms behind)', () => {
    const play = () => {
      const sc = phonePlay(21, 300)
      const r = rng(5)
      const other = sc.h.world.marble('p1')
      const letters = sc.h.world.letters()
      Object.assign(other.orb, { x: letters[3].spot[0], z: letters[3].spot[1] + 1.2, y: 0.4, resting: false })
      // Its phone's tilt, wandering on its own.
      let a = 0, b = 0
      return { sc, also: () => { a += (-a * 0.8 + gauss(r) * 9) / 60; b += (-b * 0.8 + gauss(r) * 9) / 60; other.push = [b * 0.55, a * 0.55] } }
    }
    const x = play(), y = play()
    const was = listen(x.sc, 0.03, false, x.also)
    const now = listen(y.sc, 0.03, true, y.also)
    report('two marbles 30ms without', was)
    report('two marbles 30ms foreseen', now)
    expect(now.knocks).toBeGreaterThan(100)
    expect(now.median).toBeLessThanOrEqual(ON_TIME + 1)
    expect(now.wrong / now.knocks).toBeLessThan(0.02)
    expect(now.twice + was.twice).toBe(0)
    expect(now.cuts).toBe(0)
  })
  it('over Bluetooth (200 ms behind): 60 ms of it made up, the rest as it comes; never twice, never cut off', () => {
    const was = listen(phonePlay(31, 600), 0.2, false)
    const now = listen(phonePlay(31, 600), 0.2, true)
    report('phone 200ms without', was)
    report('phone 200ms foreseen', now)
    expect(now.met / now.knocks).toBeGreaterThan(0.8)
    expect(was.median - now.median).toBeGreaterThan(50)
    expect(now.wrong / now.knocks).toBeLessThan(0.02)
    expect(now.twice + was.twice).toBe(0)
    expect(now.cuts).toBe(0)
  })
})

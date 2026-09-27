/**
 * Input for the physics harness, made reproducible: a seeded random source, frame clocks (30, 60 or 120 Hz, with the
 * odd long frame a busy phone has), a phone's orientation readings (held still or tilted, with sensor noise, a slow
 * drift and spikes), a mouse (with a hand's tremor), and the hero's own rules for turning them into what moves the
 * marble (../../src/landing/hero.ts, its actor: the page's tilt filter, 0.55 em/s² a degree, and each input holding for
 * HOLD_MS after it last really moved). A trace is a list of timed events; replaying it with the same seed gives the same
 * run, frame for frame.
 */
import { readTilt, tiltState } from '../../src/landing/tilt'
import type { World, WorldMarble } from '../../src/landing/world'

/** mulberry32: a small, fast, seeded random source (0 ≤ x < 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** A standard normal sample (Box-Muller). */
export function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
}

/**
 * Frame times (ms, rAF timestamps) for `seconds` at `hz`: each frame one period after the last (give or take 2%), but
 * now and then a long one (a busy frame: `spikes` of them a second, 2 to 6 periods long).
 */
export function frames(seconds: number, hz: number, r: () => number, spikes = 0.5): number[] {
  const out: number[] = []
  const p = 1000 / hz
  let t = 1000
  while (t < 1000 + seconds * 1000) {
    out.push(t)
    const long = r() < spikes / hz
    t += long ? p * (2 + Math.floor(r() * 5)) : p * (1 + (r() - 0.5) * 0.04)
  }
  return out
}

export interface Orient { t: number; beta: number; gamma: number }
export interface GyroOptions {
  /** Where the phone is held: beta (tipped toward you) and gamma (to the right), degrees. */
  beta?: number
  gamma?: number
  /** A tilt from there, as a function of time (s): degrees down (toward you) and right. */
  tilt?: (t: number) => [number, number]
  /** Noise of each reading (degrees, one standard deviation), a slow drift (degrees/s at most), and spikes a second. */
  noise?: number
  drift?: number
  spikes?: number
  /** Readings a second. */
  hz?: number
}
/** A phone's deviceorientation readings for `seconds`, from t = 1000 ms. */
export function gyro(seconds: number, r: () => number, o: GyroOptions = {}): Orient[] {
  const hz = o.hz ?? 60, noise = o.noise ?? 0.7, drift = o.drift ?? 0.05, spikes = o.spikes ?? 0.3
  const out: Orient[] = []
  const db = (r() - 0.5) * 2 * drift, dg = (r() - 0.5) * 2 * drift
  for (let i = 0; i < seconds * hz; i++) {
    const t = i / hz
    const [down, right] = o.tilt ? o.tilt(t) : [0, 0]
    let b = (o.beta ?? 40) + down + db * t + gauss(r) * noise
    let g = (o.gamma ?? 0) + right + dg * t + gauss(r) * noise
    // A spike: one reading well off (a knock, a sensor glitch).
    if (r() < spikes / hz) { b += (r() - 0.5) * 12; g += (r() - 0.5) * 12 }
    out.push({ t: 1000 + t * 1000, beta: b, gamma: g })
  }
  return out
}

export interface PointerEvt { t: number; x: number; y: number }
/** A mouse held at (x, y) (canvas px) from t0 (ms) for `seconds`, with a hand's tremor (px), 60 moves a second. */
export function hold(x: number, y: number, t0: number, seconds: number, r: () => number, tremor = 0.4): PointerEvt[] {
  const out: PointerEvt[] = []
  for (let i = 0; i < seconds * 60; i++) out.push({ t: t0 + (i * 1000) / 60, x: x + gauss(r) * tremor, y: y + gauss(r) * tremor })
  return out
}

/** hero.ts: a tilt of a degree pushes this hard (em/s²), and a hand that stops moving holds this long (ms). */
export const TILT_PUSH = 0.55
export const HOLD_MS = 2600

/**
 * The hero's hand on its own marble, as its actor sets it every frame: the mouse steering it (to what's under the
 * pointer, while the mouse moved within HOLD_MS), and the phone's tilt (through the page's filter) pushing it (while it
 * really moved within HOLD_MS).
 */
export class Hand {
  private st = tiltState()
  private tiltPush: [number, number] | null = null
  private tiltAt = -1e9
  private pointer: { x: number; y: number; at: number } | null = null
  constructor(private world: World, private m: WorldMarble) {}
  orient(e: Orient) {
    const t = readTilt(this.st, e.beta, e.gamma, 0, e.t)
    if (!t) return
    this.tiltPush = [t.x * TILT_PUSH, t.y * TILT_PUSH]
    if (t.wake) this.tiltAt = e.t
  }
  move(e: PointerEvt) { this.pointer = { x: e.x, y: e.y, at: e.t } }
  /** The frame at `now` (ms): what steers and pushes the marble. */
  frame(now: number) {
    const mine = !!this.pointer && now - this.pointer.at < HOLD_MS
    const tilting = !!this.tiltPush && now - this.tiltAt < HOLD_MS
    this.m.orb.target = mine ? this.world.pointAt(this.pointer!.x, this.pointer!.y) : null
    this.m.push = tilting ? this.tiltPush : null
  }
}

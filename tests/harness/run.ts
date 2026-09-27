/**
 * The physics harness's runner: a scenario (a page's layout, a frame clock, a phone's readings, a mouse, taps and
 * tosses, where the marble starts) replayed through the hero's world (../../src/landing/world.ts) frame by frame, as the
 * page's loop drives it (./inputs.ts Hand: the hero's rules; each frame's dt as the ticker gives it, at most 0.05 s),
 * and measured as drawn (./metrics.ts).
 */
import { hopTo } from '../../src/landing/bounce'
import type { WorldHit, WorldMarble } from '../../src/landing/world'
import { frames, gyro, Hand, rng, type GyroOptions, type PointerEvt } from './inputs'
import { sample, summarize, type Sample, type Summary } from './metrics'
import type { Harness } from './world'

export interface Scenario {
  h: Harness
  seconds: number
  fps: number
  seed: number
  /** The phone's readings (a phone's tilt drives the marble), a mouse, hops to spots and tosses (at ms from 1000). */
  gyro?: GyroOptions
  pointer?: PointerEvt[]
  hops?: { t: number; x: number; z: number }[]
  tosses?: { t: number; vy: number }[]
  /** Where the marble starts (it's 'me', made resting on the full stop). */
  place?: (m: WorldMarble, h: Harness) => void
  /** Measure from this long in (s). */
  measureFrom?: number
  /** Long frames a second (a busy page). */
  spikes?: number
  /** After each frame's step: its time (ms), its dt (s) and what the marbles struck in it (as the hero's actor goes on). */
  each?: (T: number, dt: number, hits: WorldHit[]) => void
}

export interface Run {
  summary: Summary
  samples: Sample[]
  /** What it struck, with the frame each was reported in (ms). */
  hits: (WorldHit & { frame: number })[]
  m: WorldMarble
  /** The frames (ms). */
  frames: number[]
}

export function run(sc: Scenario): Run {
  const r = rng(sc.seed)
  const w = sc.h.world
  const m = w.marble('me')
  sc.place?.(m, sc.h)
  const hand = new Hand(w, m)
  const readings = sc.gyro ? gyro(sc.seconds, r, sc.gyro) : []
  const pointer = sc.pointer ?? []
  const hops = [...(sc.hops ?? [])], tosses = [...(sc.tosses ?? [])]
  const ts = frames(sc.seconds, sc.fps, r, sc.spikes)
  let gi = 0, pi = 0, last = 0
  const samples: Sample[] = []
  const hits: (WorldHit & { frame: number })[] = []
  const from = 1000 + (sc.measureFrom ?? 0) * 1000
  for (const T of ts) {
    while (gi < readings.length && readings[gi].t <= T) hand.orient(readings[gi++])
    while (pi < pointer.length && pointer[pi].t <= T) hand.move(pointer[pi++])
    while (hops.length && hops[0].t <= T) { const q = hops.shift()!; hopTo(m.orb, q) }
    while (tosses.length && tosses[0].t <= T) w.toss(m, tosses.shift()!.vy)
    hand.frame(T)
    const dt = last ? Math.min(0.05, (T - last) / 1000) : 1 / 60
    last = T
    const res = w.step(dt)
    for (const q of res.hits) hits.push({ ...q, frame: T })
    sc.each?.(T, dt, res.hits)
    if (T >= from) samples.push(sample(sc.h, m, T))
  }
  return { summary: summarize(sc.h, samples), samples, hits: hits.filter((q) => q.frame >= from), m, frames: ts }
}

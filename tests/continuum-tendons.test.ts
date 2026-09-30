import { describe, expect, it } from 'vitest'
import { COVE, radiusAt, straight } from '../src/sim/continuum/profile'
import { ArmTendons, ContinuumClock, route, unroute } from '../src/sim/continuum/tendons'

const arm = COVE.arms[0],
  section = arm.sections[0]

describe('continuum tendon mechanics', () => {
  it('recovers bend and extension from opposing cable routes before saturation', () => {
    for (const strain of [-0.08, 0, 0.12])
      for (const kx of [-1.5, 0, 1.5])
        for (const ky of [-1.5, 0, 1.5]) {
          const q = { kx, ky, strain, twist: 0 },
            recovered = unroute(section, route(section, q))
          for (const key of ['kx', 'ky', 'strain'] as const) expect(recovered[key]).toBeCloseTo(q[key], 10)
        }
  })
  it('has the published route handedness: +kx lengthens the +y tendon and +ky shortens +x', () => {
    expect(route(section, { ...straight(), kx: 1 })[1]).toBeGreaterThan(0)
    expect(route(section, { ...straight(), ky: 1 })[0]).toBeLessThan(0)
    expect(unroute(section, [0, 0.01, 0, -0.01]).kx).toBeGreaterThan(0)
  })
  it('shares finite travel while preserving bend direction and common extension', () => {
    const small = { ...section, stroke: 0.035 },
      requested = { kx: 4, ky: -2, strain: 0.1, twist: 0 },
      strokes = route(small, requested),
      q = unroute(small, strokes)
    expect(strokes.every((value) => Math.abs(value) <= small.stroke + 1e-12)).toBe(true)
    expect(q.kx / q.ky).toBeCloseTo(-2)
    expect(q.strain).toBeCloseTo(0.1)
  })
  it.each([0, 1])('settles below 3%% overshoot with conserved volume, nonnegative tension and water=%i', (water) => {
    const t = new ArmTendons(COVE, arm),
      target = arm.sections.map(() => ({ kx: 1.5, ky: -1, strain: 0.05, twist: 0.1 }))
    let max = 0
    for (let i = 0; i < 600; i++) {
      t.step(target, 1 / 120, water)
      max = Math.max(max, t.pose[0].kx)
      for (let j = 0; j < t.pose.length; j++) {
        const q = t.pose[j],
          s = arm.sections[j],
          radius = radiusAt(s, q.strain)
        expect(radius ** 2 * s.length * (1 + q.strain)).toBeCloseTo(s.radius ** 2 * s.length, 12)
        expect(t.state[j].tensions.every((n) => n >= 0 && n <= 12)).toBe(true)
        expect(t.state[j].springs.every((spring) => Math.abs(spring.v) <= s.strokeRate)).toBe(true)
      }
    }
    expect(t.pose[0].kx).toBeCloseTo(1.5, 5)
    expect(max).toBeLessThan(1.5 * 1.03)
  })
  it('replays moving intentions and contact impulses identically across 30, 60 and 120 Hz presentation', () => {
    const results = [30, 60, 120].map((hz) => {
      const t = new ArmTendons(COVE, arm),
        clock = new ContinuumClock(),
        target = arm.sections.map(straight)
      for (let i = 0; i < hz * 5; i++) clock.advance(1 / hz, (dt, time) => {
        target.forEach((q, j) => Object.assign(q, {
          kx: 2 * Math.sin(time * 3 + j), ky: Math.cos(time * 2), strain: 0.1 * Math.sin(time), twist: 0.2,
        }))
        if (clock.ticks === 240) t.contact(0, 1, 0.02)
        t.step(target, dt, +(time > 2), [0.5, 0.2, 0, 0])
      })
      expect(clock.ticks).toBe(600)
      return t.pose
    })
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
  })
  it.each([30, 60, 120])('survives full-range reversals, water damping and impacts at %i Hz', (hz) => {
    const t = new ArmTendons(COVE, arm),
      target = arm.sections.map(straight)
    for (let i = 0; i < hz * 8; i++) {
      const sign = Math.floor(i / (hz / 4)) % 2 ? 1 : -1
      target.forEach((q) => Object.assign(q, { kx: sign * 30, ky: -sign * 30, strain: sign, twist: sign * 20 }))
      if (i % hz === 0) t.contact(1, 0, 0.2)
      const pose = t.step(target, 1 / hz, (i % hz) / hz, [1, 1, 1, 1])
      for (let j = 0; j < pose.length; j++) {
        const s = arm.sections[j],
          q = pose[j],
          length = s.length * (1 + q.strain)
        expect(Object.values(q).every(Number.isFinite)).toBe(true)
        expect(Math.hypot(q.kx, q.ky) * length).toBeLessThanOrEqual(s.bend + 1e-12)
        expect(Math.abs(q.twist) * length).toBeLessThanOrEqual(s.twist + 1e-12)
      }
    }
  })
  it('holds invalid cadence, bounds malformed targets, and clears elastic energy on reset', () => {
    const t = new ArmTendons(COVE, arm)
    t.step(arm.sections.map(() => ({ ...straight(), kx: 1 })), 1 / 120)
    const before = JSON.stringify(t.pose)
    for (const dt of [0, -1, NaN, Infinity]) t.step([], dt)
    expect(JSON.stringify(t.pose)).toBe(before)
    for (let i = 0; i < 240; i++) t.step([{ kx: NaN, ky: Infinity, strain: NaN, twist: NaN }], 1 / 120)
    expect(t.pose[0].kx).toBeCloseTo(0, 6)
    t.freeze()
    expect(t.state.every((s) => s.springs.every((spring) => spring.v === 0))).toBe(true)
    t.reset()
    expect(t.pose).toEqual(arm.sections.map(straight))
  })
  it('discards a background-page backlog instead of bursting old actuation', () => {
    const clock = new ContinuumClock(),
      ticks: number[] = []
    clock.advance(0.005, (_, time) => ticks.push(time))
    expect(clock.advance(2, (_, time) => ticks.push(time))).toBe(0)
    expect(clock.paused).toBe(true)
    clock.advance(1 / 120, (_, time) => ticks.push(time))
    expect(ticks).toEqual([0])
    clock.reset()
    expect(clock.ticks).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { BodyBandwidth, BodySignal } from '../src/controller/body-signal'
import { bodyResult } from './body-fixture'

describe('body confidence and filtering', () => {
  it('requires three confident torso frames and hysteresis, using visibility as effective presence', () => {
    const filter = new BodySignal(), result = bodyResult()
    expect(filter.sample(result, 0)?.body.flags).toBe(0)
    expect(filter.sample(result, 34)?.body.flags).toBe(0)
    expect(filter.sample(result, 68)).toMatchObject({ acquired: true, body: { flags: 1 } })
    result.landmarks[0][11].visibility = .6
    expect(filter.sample(result, 102)?.body.flags).toBe(1)
    result.landmarks[0][11].visibility = .49
    expect(filter.sample(result, 136)?.body.flags).toBe(0)
    result.landmarks[0][11].visibility = .9
    expect(filter.sample(result, 170)?.body.flags).toBe(0)
    expect(filter.sample(result, 204)?.body.presence[11]).toBe(.9)
    expect(filter.sample(result, 238)?.acquired).toBe(true)
  })
  it('gates individual occluded and out-of-frame joints, preserving the visible torso', () => {
    const filter = new BodySignal(), r = bodyResult()
    filter.sample(r, 0); filter.sample(r, 34)
    r.landmarks[0][27].y = 1.1; r.worldLandmarks[0][15].x = NaN; r.landmarks[0][16].presence = .2
    const s = filter.sample(r, 68)!
    expect(s.body.flags).toBe(1)
    expect(s.body.presence[27]).toBe(0); expect(s.body.landmarks[15]).toEqual([0, 0, 0]); expect(s.body.presence[16]).toBe(.2)
    r.landmarks[0][23].x = -1
    expect(filter.sample(r, 102)?.body.flags).toBe(0)
  })
  it('rejects duplicate time and resets on gaps, implausible torso jumps and malformed results', () => {
    const filter = new BodySignal(), r = bodyResult()
    filter.sample(r, 0); filter.sample(r, 34); filter.sample(r, 68)
    expect(filter.sample(r, 68)).toBeNull(); expect(filter.sample(r, NaN)).toBeNull()
    expect(filter.sample(r, 400)?.body.flags).toBe(0)
    filter.sample(r, 434); filter.sample(r, 468)
    r.worldLandmarks[0][11].x += 1
    expect(filter.sample(r, 502)?.body.flags).toBe(0)
    expect(filter.sample({ landmarks: [], worldLandmarks: [] }, 536)?.body.flags).toBe(0)
  })
  it('converts axes once and attenuates stationary alternating jitter', () => {
    const filter = new BodySignal(), r = bodyResult(), x = r.worldLandmarks[0][15].x
    const output: number[] = []
    for (let i = 0; i < 100; i++) {
      r.worldLandmarks[0][15].x = x + (i % 2 ? .004 : -.004)
      output.push(filter.sample(r, i * 34)!.body.landmarks[15][0])
    }
    const s = filter.sample(r, 3400)!.body
    expect(s.landmarks[11][1]).toBeCloseTo(-r.worldLandmarks[0][11].y)
    expect(s.landmarks[11][2]).toBeCloseTo(-r.worldLandmarks[0][11].z)
    expect(Math.max(...output.slice(20)) - Math.min(...output.slice(20))).toBeLessThan(.004)
  })
})
describe('shared BODY/HAND budget', () => {
  it.each([[30, 30, 12600], [60, 10, 18000]])('sustains %i body + %i hand fps at %i bytes/s', (body, hand, bytes) => {
    const budget = new BodyBandwidth(); let total = 0
    for (let i = 0; i < body * 10; i++) {
      const at = i * 1000 / body
      expect(budget.take(at)).toBe(true); total += 276
      if (i % (body / hand) === 0) { expect(budget.take(at, 144)).toBe(true); total += 144 }
    }
    expect(total).toBe(bytes * 10)
  })
  it('bounds even a burst producer to 18 kB/s plus a two-packet allowance', () => {
    const budget = new BodyBandwidth(); let bytes = 0
    for (let at = 0; at < 10000; at++) for (let i = 0; i < 5; i++) if (budget.take(at)) bytes += 276
    expect(bytes).toBeLessThanOrEqual(180000 + 552)
  })
})

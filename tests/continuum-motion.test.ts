import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { COVE } from '../src/sim/continuum/profile'
import { BendDynamics, JetMantle, REFERENCE_BEND, REFERENCE_JET, ReachPrimitive, fetchSegments, fetchShapes, recruitCrawl, stiffening } from '../src/sim/continuum/primitives'
import { ArmTendons, ContinuumClock } from '../src/sim/continuum/tendons'

describe('source-constrained motion primitives', () => {
  it('propagates a bend distally with one bell-shaped speed peak, not a pose interpolation', () => {
    const reach = new ReachPrimitive(COVE.arms[0]),
      speeds: number[] = [],
      positions: number[] = []
    for (let i = 0; i < 480; i++) {
      reach.step(1 / 120)
      speeds.push(reach.velocity)
      positions.push(reach.position)
    }
    const peak = speeds.indexOf(Math.max(...speeds))
    expect(positions.every((p, i) => i === 0 || p >= positions[i - 1])).toBe(true)
    expect(speeds.slice(0, peak + 1).every((v, i, a) => i === 0 || v >= a[i - 1])).toBe(true)
    expect(speeds.slice(peak).every((v, i, a) => i === 0 || v <= a[i - 1])).toBe(true)
    expect(reach.position).toBeGreaterThan(0.7)
    expect(reach.position).toBeLessThan(0.98)
    expect(speeds[0]).toBeLessThan(0.1 * speeds[peak])
    expect(speeds[479]).toBeLessThan(0.03 * speeds[peak])
  })
  it('matches an independent RK4 integration of the published variable-mass/drag equation', () => {
    const p = REFERENCE_BEND,
      model = new BendDynamics(),
      h = 1 / 4800
    let x = 0, v = 0, maxPositionError = 0, maxSpeedError = 0
    const acceleration = (position: number, velocity: number) => {
      const s = 1 - position / 0.26,
        m = 0.025 * s ** 3,
        dm = -3 * 0.025 * s ** 2 / 0.26,
        area = Math.PI * 0.0085 * Math.hypot(0.26, 0.0085) * s ** 2,
        force = position < 0.26 * 0.7 ? 0.108 * s ** 2 : 0,
        drag = 0.5 * 1000 * 0.313 * area * velocity ** 2
      return (force - drag - 2 * dm * velocity ** 2) / (2 * m)
    }
    for (let i = 0; i < 480; i++) {
      model.step(1 / 240)
      for (let n = 0; n < 20; n++) {
        const a = acceleration(x, v),
          b = acceleration(x + v * h / 2, v + a * h / 2),
          c = acceleration(x + (v + a * h / 2) * h / 2, v + b * h / 2),
          d = acceleration(x + (v + b * h / 2) * h, v + c * h)
        x += (h / 6) * (v + 2 * (v + a * h / 2) + 2 * (v + b * h / 2) + v + c * h)
        v += (h / 6) * (a + 2 * b + 2 * c + d)
      }
      maxPositionError = Math.max(maxPositionError, Math.abs(model.position - x) / p.length)
      maxSpeedError = Math.max(maxSpeedError, Math.abs(model.velocity - v) / 0.47)
    }
    expect(maxPositionError).toBeLessThan(0.005)
    expect(maxSpeedError).toBeLessThan(0.02)
  })
  it('puts peak stiffening 50–100 ms ahead of the bend, with onset in the preceding 200–300 ms', () => {
    const points = Array.from({ length: 401 }, (_, i) => i / 1000),
      values = points.map(stiffening),
      peak = points[values.indexOf(Math.max(...values))],
      onset = points.filter((time) => stiffening(time) > 0.012).at(-1)!
    expect(peak).toBeGreaterThanOrEqual(0.05)
    expect(peak).toBeLessThanOrEqual(0.1)
    expect(onset).toBeGreaterThanOrEqual(0.2)
    expect(onset).toBeLessThanOrEqual(0.3)
  })
  it.each([0.02, 1, 4])('delivers ahead-of-bend excitation even at reaching effort=%f', (effort) => {
    const reach = new ReachPrimitive(COVE.arms[0], effort),
      peak = reach.activation.map(() => ({ value: 0, time: 0 })),
      arrival = reach.activation.map(() => Infinity)
    for (let i = 0; i < Math.ceil(480 / Math.sqrt(effort)); i++) {
      reach.step(1 / 120)
      reach.activation.forEach((value, j) => {
        if (value > peak[j].value) peak[j] = { value, time: (i + 1) / 120 }
        if (arrival[j] === Infinity && reach.position >= (j + 0.5) / arrival.length) arrival[j] = (i + 1) / 120
      })
    }
    peak.forEach((activation, j) => {
      expect(arrival[j] - activation.time).toBeGreaterThanOrEqual(0.05)
      expect(arrival[j] - activation.time).toBeLessThanOrEqual(0.1)
    })
  })
  it.each([0.3, 0.6, 0.9])('places a fetching elbow halfway to grip=%f and reserves a distal hand', (grip) => {
    const segments = fetchSegments(grip)
    expect(segments.proximal / segments.medial).toBe(1)
    expect(segments.elbow).toBeCloseTo(grip / 2)
    expect(segments.proximal + segments.medial + segments.hand).toBeCloseTo(1)
    for (const shape of fetchShapes(COVE.arms[0], grip, 1)) expect(Object.values(shape).every(Number.isFinite)).toBe(true)
  })
  it('recruits supporting arms by direction and remaining elongation rather than time or a fixed gait', () => {
    const arms = [new Vector3(-1, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 0, -1)].map((direction, i) => ({
      id: `arm${i}`, direction, attached: true, strain: 0, capacity: 10,
    }))
    expect(recruitCrawl(arms, new Vector3(1, 0, 0)).map((arm) => arm.id)).toEqual(['arm0'])
    expect(recruitCrawl(arms, new Vector3(-1, 0, 0)).map((arm) => arm.id)).toEqual(['arm1'])
    arms[0].strain = 0.15
    expect(recruitCrawl(arms, new Vector3(1, 0, 0))).toEqual([])
    arms[0].strain = 0
    arms[0].attached = false
    expect(recruitCrawl(arms, new Vector3(1, 0, 0))).toEqual([])
    expect(recruitCrawl(arms, new Vector3())).toEqual([])
  })
  it('contracts under muscle force, refills elastically and glides with no reverse jet', () => {
    const mantle = new JetMantle(),
      fractions: number[] = []
    expect(mantle.pulse()).toBe(true)
    expect(mantle.pulse()).toBe(false)
    let impulse = 0
    for (let i = 0; i < 150; i++) {
      const thrust = mantle.step(1 / 240)
      fractions.push(mantle.fraction)
      impulse += thrust / 240
      expect(thrust).toBeGreaterThanOrEqual(0)
      expect(thrust).toBeLessThanOrEqual(REFERENCE_JET.thrustCap)
      if (i > 50) expect(thrust).toBe(0)
    }
    expect(Math.min(...fractions)).toBeGreaterThanOrEqual(1 - REFERENCE_JET.expelled)
    expect(Math.min(...fractions)).toBeLessThan(0.7)
    expect(mantle.fraction).toBeGreaterThan(0.97)
    expect(impulse).toBeGreaterThan(0)
    expect(impulse).toBeLessThan(REFERENCE_JET.thrustCap * REFERENCE_JET.contraction)
    expect(mantle.pulse()).toBe(true)
  })
  it('matches the reference robot frequency/capacity, without calling its expulsion ratio animal data', () => {
    expect(1 / REFERENCE_JET.period).toBe(1.6)
    expect(REFERENCE_JET.capacity * 1e6).toBeCloseTo(35)
    expect(REFERENCE_JET.contraction / REFERENCE_JET.period).toBeCloseTo(1 / 3)
  })
  it('replays reach, stiffness excitation and jet impulse identically at 30–120 Hz', () => {
    const results = [30, 60, 120].map((hz) => {
      const reach = new ReachPrimitive(COVE.arms[0]),
        t = new ArmTendons(COVE, COVE.arms[0]),
        mantle = new JetMantle(),
        clock = new ContinuumClock()
      let impulse = 0
      for (let i = 0; i < hz * 3; i++) clock.advance(1 / hz, (dt) => {
        if (clock.ticks % 75 === 0) mantle.pulse()
        t.step(reach.step(dt), dt, 1, reach.activation)
        impulse += mantle.step(dt) * dt
      })
      return { pose: t.pose, impulse, volume: mantle.fraction, position: reach.position, pulses: mantle.pulses }
    })
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
  })
  it('restarts a repeat reach with identical excitation while preserving the separate elastic state', () => {
    const reach = new ReachPrimitive(COVE.arms[0]),
      t = new ArmTendons(COVE, COVE.arms[0])
    for (let i = 0; i < 120; i++) t.step(reach.step(1 / 120), 1 / 120, 0, reach.activation)
    const before = JSON.stringify(t.pose),
      samples = JSON.stringify({ shapes: reach.shapes, activation: reach.activation, position: reach.position })
    reach.reset()
    expect(JSON.stringify(t.pose)).toBe(before)
    for (let i = 0; i < 120; i++) reach.step(1 / 120)
    expect(JSON.stringify({ shapes: reach.shapes, activation: reach.activation, position: reach.position })).toBe(samples)
  })
  it('rejects invalid jet/duration profiles and holds an invalid tick without a motion jump', () => {
    expect(() => new JetMantle({ ...REFERENCE_JET, nozzle: 0 })).toThrow()
    expect(() => new ReachPrimitive(COVE.arms[0], NaN)).toThrow()
    const reach = new ReachPrimitive(COVE.arms[0]),
      mantle = new JetMantle()
    mantle.pulse()
    mantle.step(1 / 120)
    const before = mantle.fraction
    mantle.step(Infinity)
    expect(mantle.fraction).toBe(before)
    reach.step(NaN)
    expect(reach.position).toBe(0)
  })
})

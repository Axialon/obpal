import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { ContactSurface, Sucker } from '../src/sim/continuum/contact'
import { collideBody, stepBody, streamShape, submerged, type BodyState } from '../src/sim/continuum/medium'
import { COVE, straight } from '../src/sim/continuum/profile'
import { ArmTendons, ContinuumClock } from '../src/sim/continuum/tendons'

const water = { id: 'tank', min: new Vector3(-3, -3, -3), max: new Vector3(3, 0, 3), density: 1000 },
  zero = new Vector3(),
  body = (): BodyState => ({ position: new Vector3(0, -1, 0), velocity: new Vector3(), radius: 0.15, mass: 1, volume: 0.001, airDrag: 0.1, waterDrag: 3 })

describe('shared land and water mechanics', () => {
  it('computes continuous geometric submerged volume at the waterline and tank edge', () => {
    expect(submerged(new Vector3(0, 0, 0), 0.15, water)).toBe(0.5)
    expect(submerged(new Vector3(0, -1, 0), 0.15, water)).toBe(1)
    expect(submerged(new Vector3(0, 1, 0), 0.15, water)).toBe(0)
    let before = 0
    for (let i = 0; i <= 300; i++) {
      const f = submerged(new Vector3(0, 0.15 - i / 1000, 0), 0.15, water)
      expect(f).toBeGreaterThanOrEqual(before)
      expect(f - before).toBeLessThan(0.006)
      before = f
    }
    expect(submerged(new Vector3(3, -1, 0), 0.15, water)).toBeCloseTo(0.5)
  })
  it('holds neutral depth for five minutes without a stabilizing position setter', () => {
    const state = body()
    for (let i = 0; i < 36000; i++) stepBody(state, [water], zero, 1 / 120)
    expect(state.position.toArray()).toEqual([0, -1, 0])
    expect(state.velocity.length()).toBe(0)
  })
  it('allows a bounded downward dive and upward surfacing through momentum and buoyancy', () => {
    const state = body()
    for (let i = 0; i < 120; i++) stepBody(state, [water], new Vector3(0, -0.2, 0), 1 / 120)
    expect(state.position.y).toBeLessThan(-1.05)
    for (let i = 0; i < 1200; i++) stepBody(state, [water], new Vector3(0, 0.4, 0), 1 / 120)
    expect(state.position.y).toBeGreaterThan(-0.15)
    expect(state.velocity.length()).toBeLessThan(1)
  })
  it('enters water without resetting momentum or popping the body to a new mode pose', () => {
    const state = body()
    state.position.y = 0.3
    state.velocity.y = -0.5
    let crossed = false
    for (let i = 0; i < 120; i++) {
      const before = state.position.clone(),
        velocity = state.velocity.clone(),
        fraction = stepBody(state, [water], zero, 1 / 120)
      expect(state.position.distanceTo(before)).toBeLessThan(0.025)
      expect(state.velocity.distanceTo(velocity)).toBeLessThan(0.1)
      if (fraction > 0.1 && fraction < 0.9) crossed = true
    }
    expect(crossed).toBe(true)
  })
  it('falls under gravity after support loss and lands dissipatively on the same contact floor', () => {
    const state = body(),
      floor = new ContactSurface('floor', 'plane', new Vector3(3, 3, 1), 0.8)
        .pose(zero, new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(0, 1, 0)))
    state.position.y = 1.5
    for (let i = 0; i < 600; i++) {
      stepBody(state, [], zero, 1 / 120)
      collideBody(state, [floor])
    }
    expect(state.position.y).toBeCloseTo(state.radius, 10)
    expect(state.velocity.length()).toBeCloseTo(0, 10)
    state.position.set(10, -0.1, 0)
    collideBody(state, [floor])
    expect(state.position.x).toBe(10)
    expect(state.position.y).toBe(-0.1)
  })
  it('couples four cup springs to body momentum under gravity, then falls when every seal releases', () => {
    const state = body(),
      wall = new ContactSurface('wall', 'plane', new Vector3(3, 3, 1), 1),
      offsets = [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].map(([x, y]) => new Vector3(x, y, -0.2)),
      cups = offsets.map((_, i) => new Sucker({ ...COVE.arms[i].cups[0] }, COVE.suction)),
      point = new Vector3(),
      force = new Vector3(),
      facing = new Vector3(0, 0, -1)
    state.position.set(0, 1, 0.2)
    for (let i = 0; i < 20; i++) cups.forEach((cup, j) =>
      cup.step({ point: point.copy(offsets[j]).add(state.position), facing, velocity: zero, attach: true }, [wall], 1 / 120))
    for (let i = 0; i < 600; i++) {
      force.set(0, 0, 0)
      cups.forEach((cup, j) => {
        cup.step({ point: point.copy(offsets[j]).add(state.position), facing, velocity: state.velocity, attach: true }, [wall], 1 / 120)
        expect(cup.phase).toBe('attached')
        force.add(cup.force)
      })
      stepBody(state, [], force, 1 / 120)
    }
    expect(state.position.y).toBeCloseTo(1 - 9.81 / (4 * COVE.suction.stiffness), 5)
    expect(Math.abs(state.velocity.y)).toBeLessThan(1e-5)
    const supported = state.position.y
    for (let i = 0; i < 120; i++) {
      force.set(0, 0, 0)
      cups.forEach((cup, j) => {
        cup.step({ point: point.copy(offsets[j]).add(state.position), facing, velocity: state.velocity, attach: false }, [wall], 1 / 120)
        force.add(cup.force)
      })
      stepBody(state, [], force, 1 / 120)
    }
    expect(cups.every((cup) => cup.phase === 'free')).toBe(true)
    expect(state.position.y).toBeLessThan(supported - 1)
  })
  it('damps water motion more strongly than air without reversing drag or injecting energy', () => {
    const wet = body(),
      dry = body()
    wet.velocity.x = dry.velocity.x = 2
    for (let i = 0; i < 120; i++) {
      stepBody(wet, [water], zero, 1 / 120)
      stepBody(dry, [], new Vector3(0, 9.81, 0), 1 / 120)
      expect(wet.velocity.x).toBeGreaterThan(0)
    }
    expect(wet.velocity.x).toBeLessThan(dry.velocity.x * 0.25)
  })
  it.each([30, 60, 120])('keeps arm streaming finite under changing water load at %i Hz', (hz) => {
    const arm = COVE.arms[0],
      t = new ArmTendons(COVE, arm),
      shapes = arm.sections.map(straight),
      flow = new Vector3(0.3, -0.15, -1.2)
    for (let i = 0; i < hz * 8; i++) {
      const medium = (i % hz) / hz
      arm.sections.forEach((s, j) => streamShape(s, flow, medium, 0.12, shapes[j]))
      for (const q of t.step(shapes, 1 / hz, medium)) expect(Object.values(q).every(Number.isFinite)).toBe(true)
    }
  })
  it('replays a forced land/water transition identically at different render cadences', () => {
    const results = [30, 60, 120].map((hz) => {
      const state = body(),
        clock = new ContinuumClock()
      state.position.y = 0.3
      for (let i = 0; i < hz * 2; i++) clock.advance(1 / hz, (dt, time) => {
        stepBody(state, [water], new Vector3(Math.sin(time), 0, 0), dt)
      })
      return { position: state.position.toArray(), velocity: state.velocity.toArray() }
    })
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
  })
})

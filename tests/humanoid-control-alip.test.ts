import { describe, expect, it } from 'vitest'
import { angularMomentumState, alipStepPlacement, alipLandingCentre } from '../src/sim/humanoid/physics/stepping'
import type { Observation } from '../src/sim/humanoid/physics/observation'
import { validateScene, type Body, type BodyInput } from '../src/sim/physics/schema'
import { ZERO, IDENTITY, add, scale, rotate, multiply, fromRotationVector, type Vec3 } from '../src/sim/physics/math'

function vector(actual: Vec3, expected: Vec3) {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 10)
}
function fixture(inputs: BodyInput[], pivot: Vec3 = { ...ZERO }): { bodies: Body[]; o: Observation } {
  const bodies = validateScene({ bodies: inputs }).bodies, dynamic = bodies.filter(b => !b.fixed)
  const mass = dynamic.reduce((sum, b) => sum + b.mass, 0)
  const com = scale(dynamic.reduce((sum, b) => add(sum, scale(b.position, b.mass)), { ...ZERO }), 1 / mass)
  const comVelocity = scale(dynamic.reduce((sum, b) => add(sum, scale(b.velocity, b.mass)), { ...ZERO }), 1 / mass)
  return { bodies, o: { schema_version: 1, modelVersion: 'fixture', profileId: 'fixture', actorId: 'actor', generation: 1, stateTick: 0, timeS: 0,
    bodies: dynamic.map(b => ({ ...b, sleeping: false })), com, comVelocity, joints: [],
    feet: [{ id: 'stance', minSoleY: pivot.y, maxSoleY: pivot.y, centre: { ...pivot }, speedMps: 0, normalImpulseNs: 1,
      centreOfPressure: { ...pivot }, contactPoints: [{ ...pivot }], tangentialSpeedMps: 0 }],
    support: { points: [{ ...pivot }], polygon: [], marginM: null, normalImpulseNs: 1 } } }
}
const sphere = (id: string, position: Vec3, velocity: Vec3, mass = 2): BodyInput =>
  ({ id, shape: { kind: 'sphere', radius: .1 }, mass, position, velocity })

/** Independent fourth-order integration of x''=omega^2*x about a stationary pivot. */
function integrate(position: number, velocity: number, omega: number, seconds: number) {
  const dt = seconds / 800, acceleration = omega * omega
  for (let i = 0; i < 800; i++) {
    const k1x = velocity, k1v = acceleration * position
    const k2x = velocity + dt * k1v / 2, k2v = acceleration * (position + dt * k1x / 2)
    const k3x = velocity + dt * k2v / 2, k3v = acceleration * (position + dt * k2x / 2)
    const k4x = velocity + dt * k3v, k4v = acceleration * (position + dt * k3x)
    position += dt * (k1x + 2 * k2x + 2 * k3x + k4x) / 6
    velocity += dt * (k1v + 2 * k2v + 2 * k3v + k4v) / 6
  }
  return { position, velocity }
}

describe('contact angular momentum', () => {
  it('recovers both horizontal velocity signs in a y-up point-mass example and ignores fixed bodies', () => {
    const { bodies, o } = fixture([sphere('mass', { x: 0, y: 1.5, z: 0 }, { x: 2, y: 0, z: -3 }),
      { id: 'floor', fixed: true, shape: { kind: 'plane' }, position: { ...ZERO }, mass: 1000 }])
    const before = structuredClone({ bodies, o }), state = angularMomentumState(bodies, o, ZERO)
    vector(state.angularMomentum, { x: -9, y: 0, z: -6 })
    vector(state.equivalentVelocity, { x: 2, y: 0, z: -3 })
    expect(state.massKg).toBe(2); expect(state.heightM).toBe(1.5)
    expect({ bodies, o }).toEqual(before)
  })
  it('retains internal orbital momentum even when the whole-body COM is stationary', () => {
    const { bodies, o } = fixture([sphere('left', { x: -.3, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, 1),
      sphere('right', { x: .3, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 1)])
    vector(o.comVelocity, ZERO)
    const state = angularMomentumState(bodies, o, ZERO)
    vector(state.angularMomentum, { x: 0, y: 0, z: .6 })
    vector(state.equivalentVelocity, { x: -.3, y: 0, z: 0 })
  })
  it('rotates declared principal spin inertia into the world frame', () => {
    const rotation = fromRotationVector({ x: 0, y: Math.PI / 2, z: 0 })
    const { bodies, o } = fixture([{ id: 'box', shape: { kind: 'box', half: { x: 1, y: 1, z: 1 } }, mass: 2,
      inertia: { x: 1, y: 2, z: 3 }, position: { x: 0, y: 2, z: 0 }, rotation,
      angularVelocity: rotate(rotation, { x: 2, y: 0, z: 0 }) }])
    const state = angularMomentumState(bodies, o, ZERO)
    vector(state.angularMomentum, { x: 0, y: 0, z: -2 })
    vector(state.equivalentVelocity, { x: .5, y: 0, z: 0 })
    // Omitting the override gives the uniform cube's 4/3 kg m^2 about its x axis.
    const uniform = bodies.map(({ inertia: _inertia, ...body }) => body)
    expect(angularMomentumState(uniform, o, ZERO).angularMomentum.z).toBeCloseTo(-8 / 3, 10)
  })
  it('rejects missing dynamic state, nonpositive height, no dynamic mass and non-finite motion', () => {
    const { bodies, o } = fixture([sphere('mass', { x: 0, y: 1, z: 0 }, ZERO)])
    expect(() => angularMomentumState(bodies, { ...o, bodies: [] }, ZERO)).toThrow(RangeError)
    expect(() => angularMomentumState(bodies, o, { x: 0, y: 1, z: 0 })).toThrow(RangeError)
    expect(() => angularMomentumState([], o, ZERO)).toThrow(RangeError)
    const broken = structuredClone(o); broken.bodies[0].angularVelocity.x = NaN
    expect(() => angularMomentumState(bodies, broken, ZERO)).toThrow(RangeError)
  })
})

describe('ALIP endpoint placement', () => {
  it.each([0, .35, 1])('reaches the requested next-step terminal momentum with retention %s', retention => {
    const position = .08, velocity = -.19, omega = 3.3, remaining = .23, period = .7, target = -.4
    const plan = alipStepPlacement(position, velocity, omega, remaining, period, target, retention)
    const touchdown = integrate(position, velocity, omega, remaining)
    const terminal = integrate(touchdown.position - plan.footOffsetM, touchdown.velocity, omega, period)
    expect(plan.touchdownPositionM).toBeCloseTo(touchdown.position, 9)
    expect(plan.touchdownVelocityMps).toBeCloseTo(touchdown.velocity, 9)
    expect(terminal.velocity).toBeCloseTo((1 - retention) * target + retention * touchdown.velocity, 9)
    expect(plan.terminalVelocityMps).toBeCloseTo(terminal.velocity, 9)
  })
  it('needs no new placement when the requested terminal velocity is the unaltered pendulum evolution', () => {
    const initial = { position: -.04, velocity: .16 }, omega = 3, remaining = .2, period = .6
    const terminal = integrate(initial.position, initial.velocity, omega, remaining + period)
    expect(alipStepPlacement(initial.position, initial.velocity, omega, remaining, period, terminal.velocity).footOffsetM).toBeCloseTo(0, 9)
  })
  it('places alternating stationary steps on opposite sides and uses the measured COP before its fallback', () => {
    const { bodies, o } = fixture([sphere('mass', { x: 0, y: 1, z: 0 }, ZERO)])
    const right = alipLandingCentre(bodies, o, 'stance', { x: 100, y: 0, z: 100 }, IDENTITY, ZERO, 1, .7, .7, .2, 1)
    const left = alipLandingCentre(bodies, o, 'stance', ZERO, IDENTITY, ZERO, -1, .7, .7, .2, 1)
    expect(right.x).toBeGreaterThan(0); expect(left.x).toBeLessThan(0)
    expect(left.x).toBeCloseTo(-right.x, 12); expect(right.z).toBe(0); expect(right.y).toBe(0)
    o.feet[0].centreOfPressure = null
    vector(alipLandingCentre(bodies, o, 'stance', ZERO, IDENTITY, ZERO, 1, .7, .7, .2, 1), right)
  })
  it('preserves momentum and landing under a rigid yaw and a full world translation', () => {
    const pivot = { x: .07, y: .13, z: -.02 }
    const { bodies, o } = fixture([{ id: 'box', shape: { kind: 'box', half: { x: .3, y: .4, z: .2 } }, mass: 3,
      inertia: { x: .4, y: .3, z: .5 }, position: { x: -.2, y: 1.2, z: .3 },
      rotation: fromRotationVector({ x: .2, y: -.3, z: .1 }), velocity: { x: .3, y: -.04, z: -.5 }, angularVelocity: { x: .7, y: -.2, z: .4 } },
      sphere('mass', { x: .4, y: .9, z: -.1 }, { x: -.2, y: .06, z: .1 })], pivot)
    const yaw = fromRotationVector({ x: 0, y: .73, z: 0 }), translation = { x: 2, y: .4, z: -3 }
    const point = (p: Vec3) => add(translation, rotate(yaw, p)), transformed = structuredClone(o)
    transformed.com = point(o.com); transformed.comVelocity = rotate(yaw, o.comVelocity)
    transformed.bodies = o.bodies.map(b => ({ ...b, position: point(b.position), rotation: multiply(yaw, b.rotation),
      velocity: rotate(yaw, b.velocity), angularVelocity: rotate(yaw, b.angularVelocity) }))
    transformed.feet[0].centreOfPressure = point(pivot)
    const state = angularMomentumState(bodies, o, pivot), moved = angularMomentumState(bodies, transformed, point(pivot))
    vector(moved.angularMomentum, rotate(yaw, state.angularMomentum)); vector(moved.equivalentVelocity, rotate(yaw, state.equivalentVelocity))
    expect(moved.heightM).toBeCloseTo(state.heightM, 12); expect(moved.massKg).toBe(state.massKg)
    const heading = fromRotationVector({ x: 0, y: -.4, z: 0 }), command = { x: .12, y: 0, z: -.4 }
    const landing = alipLandingCentre(bodies, o, 'stance', pivot, heading, command, -1, .25, .7, .2, 1.15, .2)
    vector(alipLandingCentre(bodies, transformed, 'stance', point(pivot), multiply(yaw, heading), rotate(yaw, command),
      -1, .25, .7, .2, 1.15, .2), point(landing))
  })
  it('rejects singular periods and overflowing prediction horizons', () => {
    for (const period of [0, -1, NaN, Infinity]) expect(() => alipStepPlacement(0, 0, 3, .2, period, 0)).toThrow(RangeError)
    expect(() => alipStepPlacement(0, 0, 3, -1, .7, 0)).toThrow(RangeError)
    expect(() => alipStepPlacement(0, 0, 3, .2, .7, 0, 1.1)).toThrow(RangeError)
    expect(() => alipStepPlacement(1, 1, 3, 1000, .7, 0)).toThrow(RangeError)
  })
})

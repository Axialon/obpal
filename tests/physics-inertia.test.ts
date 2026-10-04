/** Mass-preserving inertia overrides are validated and reach both native and comparison backends. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, STEP, validateScene, type BodyInput, type Vec3 } from '../src/sim/physics/schema'
import { bodyInertia } from '../src/sim/physics/servo'
import { createCustomBackend } from '../src/sim/physics/backends/custom'
import { createRapierBackend } from '../src/sim/physics/backends/rapier'

const box = (): BodyInput => ({ id: 'link', mass: 2, shape: { kind: 'box', half: { x: .1, y: .2, z: .3 } }, position: { x: 0, y: 1, z: 0 } })
const uniform = () => bodyInertia(validateScene({ bodies: [box()] }).bodies[0])
const scaled = (n: number): Vec3 => { const i = uniform(); return { x: i.x * n, y: i.y * n, z: i.z * n } }

describe('validated body inertia', () => {
  it('preserves uniform defaults and owns an explicit corner-bound override', () => {
    const original = validateScene({ bodies: [box()] }).bodies[0]
    expect(original).not.toHaveProperty('inertia')
    expect(bodyInertia(original)).toEqual({ x: 2 / 3 * (.2 ** 2 + .3 ** 2), y: 2 / 3 * (.1 ** 2 + .3 ** 2), z: 2 / 3 * (.1 ** 2 + .2 ** 2) })
    const input = { ...box(), inertia: scaled(3) }, body = validateScene({ bodies: [input] }).bodies[0]
    expect(bodyInertia(body)).toEqual(scaled(3))
    expect(body.mass).toBe(original.mass)
    input.inertia.x = 0
    expect(body.inertia!.x).toBeGreaterThan(0)
    const read = bodyInertia(body); read.y = 0
    expect(body.inertia!.y).toBeGreaterThan(0)
  })
  it.each([
    { x: 0, y: .1, z: .1 }, { x: -.1, y: .1, z: .1 }, { x: NaN, y: .1, z: .1 },
    { x: Infinity, y: .1, z: .1 }, { x: .2, y: .01, z: .01 }, scaled(3.01),
  ])('rejects a nonphysical principal tensor %j', inertia => {
    expect(() => validateScene({ bodies: [{ ...box(), inertia }] })).toThrow(RangeError)
  })
  it.each([1e-320, 1e-50, 1e-40])('rejects %s kg m² when its float32 moment or reciprocal is unusable', moment => {
    const inertia = { x: moment, y: moment, z: moment }
    expect(() => validateScene({ bodies: [{ ...box(), inertia }] })).toThrow(RangeError)
  })
  it('scales triangle tolerance to the tensor while retaining small representable moments', () => {
    const inertia = { x: 1e-20, y: 1e-20, z: 1e-20 }
    expect(validateScene({ bodies: [{ ...box(), inertia }] }).bodies[0].inertia).toEqual(inertia)
    expect(() => validateScene({ bodies: [{ ...box(), inertia: { x: 1e-20, y: 1e-22, z: 1e-22 } }] })).toThrow(RangeError)
  })
  it('rejects fixed overrides and respects the sphere envelope', () => {
    expect(() => validateScene({ bodies: [{ ...box(), fixed: true, inertia: uniform() }] })).toThrow(/dynamic body/)
    expect(() => validateScene({ bodies: [{ ...box(), fixed: true, shape: { kind: 'plane' }, inertia: uniform() }] })).toThrow(/dynamic body/)
    const sphere: BodyInput = { ...box(), shape: { kind: 'sphere', radius: .1 }, inertia: { x: .01, y: .01, z: .01 } }
    expect(validateScene({ bodies: [sphere] }).bodies[0].inertia).toEqual(sphere.inertia)
    expect(() => validateScene({ bodies: [{ ...sphere, inertia: { x: .02, y: .02, z: .02 } }] })).toThrow(/sphere inertia bound/)
  })
})

for (const [name, factory] of [['custom', createCustomBackend], ['rapier', createRapierBackend]] as const) {
  it(`${name} doubles angular inertia without changing linear mass response`, async () => {
    const base = await factory(validateScene({ gravity: { x: 0, y: 0, z: 0 }, bodies: [box()] }), DEFAULT_LIMITS)
    const raised = await factory(validateScene({ gravity: { x: 0, y: 0, z: 0 }, bodies: [{ ...box(), inertia: scaled(2) }] }), DEFAULT_LIMITS)
    try {
      for (const backend of [base, raised]) {
        backend.force('link', { x: 0, y: 2, z: 0 }, box().position)
        backend.torque('link', { x: .5, y: 0, z: 0 }); backend.step(STEP)
      }
      const a = base.read('link'), b = raised.read('link')
      expect(b.velocity.y).toBeCloseTo(STEP, 7)
      expect(b.velocity).toEqual(a.velocity)
      expect(b.angularVelocity.x).toBeCloseTo(a.angularVelocity.x / 2, 7)
      expect(b.angularVelocity.x).toBeCloseTo(.5 * STEP / scaled(2).x, 7)
    } finally { base.dispose(); raised.dispose() }
  })
}

it('Rapier bodies without an override retain the exact setMass trajectory', async () => {
  const R = await import('@dimforge/rapier3d-compat'); await R.init()
  const scene = validateScene({ bodies: [box()] }), b = scene.bodies[0]
  const backend = await createRapierBackend(scene, DEFAULT_LIMITS), world = new R.World(scene.gravity)
  try {
    world.numSolverIterations = 8; world.timestep = STEP
    const native = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(b.position.x, b.position.y, b.position.z)
      .setRotation(b.rotation).setLinvel(b.velocity.x, b.velocity.y, b.velocity.z).setAngvel(b.angularVelocity)
      .setLinearDamping(b.linearDamping).setAngularDamping(b.angularDamping).setCanSleep(false))
    const desc = R.ColliderDesc.cuboid(.1, .2, .3).setMass(b.mass).setFriction(Math.sqrt(b.friction))
      .setFrictionCombineRule(R.CoefficientCombineRule.Multiply).setRestitution(b.restitution).setRestitutionCombineRule(R.CoefficientCombineRule.Min)
    world.createCollider(desc, native)
    for (let tick = 0; tick < 120; tick++) {
      const torque = { x: .5, y: -.3, z: .1 }
      backend.torque('link', torque); native.addTorque(torque, false)
      backend.step(STEP); world.step(); native.resetForces(false); native.resetTorques(false)
      expect(backend.read('link')).toEqual({ id: 'link', position: { ...native.translation() }, rotation: { ...native.rotation() },
        velocity: { ...native.linvel() }, angularVelocity: { ...native.angvel() }, sleeping: false })
    }
  } finally { backend.dispose(); world.free() }
})

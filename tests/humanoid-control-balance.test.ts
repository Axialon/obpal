import { describe, expect, it } from 'vitest'
import { BALANCE_CONTROL, BalanceController, hipStrategyMoment } from '../src/sim/humanoid/physics/balance'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { jointFrame, jointTorque } from '../src/sim/humanoid/physics/targets'
import { polygonCentroid } from '../src/sim/humanoid/physics/stepping'
import { ZERO, add, sub, scale, rotate, multiply, conjugate, fromRotationVector, rotationVector, angleBetween, norm, type Vec3 } from '../src/sim/physics/math'
import { STEP } from '../src/sim/physics/schema'
import { supportFixture } from './humanoid-balance-cases'

async function fixture() {
  const { model, states, contacts, observe } = await supportFixture()
  const observation = observe(model, states, contacts, 1, 0)
  const centroid = polygonCentroid(observation.support.polygon)!
  observation.com.x = centroid.x; observation.com.z = centroid.z
  return { model, observation, controller: new BalanceController(model, 1) }
}
function vector(actual: Vec3, expected: Vec3) {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 9)
}

describe('capture-point balance requests', () => {
  it('delegates the quiet region exactly to the existing stance controller without mutating inputs', async () => {
    const { model, observation, controller } = await fixture(), before = structuredClone({ model, observation })
    const result = controller.step(observation)
    expect(result.diagnostics.phase).toBe('quiet')
    expect(result.frame).toEqual(new StanceController(model, 1).step(observation).frame)
    expect({ model, observation }).toEqual(before)
    expect(controller.step(observation)).toEqual(result)
  })

  it('uses both the speed and capture-centroid quiet conditions', async () => {
    const { observation, controller } = await fixture()
    observation.com.x += BALANCE_CONTROL.quietCaptureRadiusM + .001
    expect(controller.step(observation).diagnostics.phase).toBe('ankle')
    observation.com.x -= BALANCE_CONTROL.quietCaptureRadiusM + .001
    observation.comVelocity.x = BALANCE_CONTROL.quietSpeedMps
    expect(controller.step(observation).diagnostics.phase).toBe('ankle')
  })

  it('uses capture feedback, a clipped COP and horizontal virtual COM forces with no root target', async () => {
    const { model, observation, controller } = await fixture()
    observation.comVelocity.z = -.5
    const { frame, diagnostics: d } = controller.step(observation), c = d.capture!
    const mass = model.scene.bodies.reduce((sum, b) => sum + (b.fixed ? 0 : b.mass), 0)
    expect(d.phase).toBe('hip')
    expect(d.desiredCMP!.z).toBeCloseTo(2 * c.point.z - c.centroid.z, 10)
    expect(d.desiredCOP!.z).toBeCloseTo(Math.min(...observation.support.polygon.map(p => p.z)) + .01, 10)
    vector(d.forceN, { x: mass * c.omega ** 2 * (observation.com.x - d.desiredCOP!.x), y: 0,
      z: mass * c.omega ** 2 * (observation.com.z - d.desiredCOP!.z) })
    expect(Object.keys(frame.targets).sort()).toEqual(model.scene.joints.map(j => j.id).sort())
    expect(frame.targets).not.toHaveProperty(model.root)
    expect(model.scene.bodies.find(b => b.id === model.root)!.fixed).toBe(false)
  })

  it('pins actual ankle, reversed-knee and hip Jacobian signs and load shares', async () => {
    const { model, observation, controller } = await fixture()
    observation.comVelocity.z = -.1
    observation.feet[0].normalImpulseNs = 3; observation.feet[1].normalImpulseNs = 1
    const d = controller.step(observation).diagnostics
    expect(d.phase).toBe('ankle')
    expect(d.loadShares[model.feet[0]]).toBe(.75); expect(d.loadShares[model.feet[1]]).toBe(.25)
    for (const joint of model.scene.joints.filter(j => /_(foot|shin|thigh)$/.test(j.child))) {
      const parent = observation.bodies.find(b => b.id === joint.parent)!, anchor = jointFrame(joint, parent).position
      const share = joint.child.includes('_left_') ? .75 : .25
      const lever = sub(observation.com, anchor), force = scale(d.forceN, share)
      // Independent cross-product expansion; every stance-chain joint uses the foot-rooted negative sign.
      vector(d.jointTorquesNm[joint.id], { x: -lever.y * force.z, y: -lever.z * force.x + lever.x * force.z, z: lever.y * force.x })
      const local = jointTorque(joint, parent, d.jointTorquesNm[joint.id])
      if (joint.child.endsWith('_shin')) expect(local.x).toBeGreaterThan(0)
      else if (joint.child.endsWith('_foot')) expect(local.y).toBeGreaterThan(0)
      else expect(local.y).toBeLessThan(0) // The hip anchor is above the whole-body COM in this fixture.
    }
  })

  it('disables ankle torque for point/line support, unloaded feet and feet turning above 1 rad/s', async () => {
    const { model, observation, controller } = await fixture()
    observation.comVelocity.z = -.1
    const foot = model.feet[0], ankle = model.scene.joints.find(j => j.child === foot)!
    const measured = observation.joints.find(j => j.id === ankle.id)!
    measured.rotation = fromRotationVector({ x: 0, y: .05, z: 0 })
    measured.angularVelocity = { x: 0, y: .2, z: -.1 }
    for (const count of [0, 1, 2]) {
      const input = structuredClone(observation); input.feet[0].contactPoints.length = count
      const r = controller.step(input)
      expect(r.diagnostics.ankleFeet).not.toContain(foot)
      const spring = scale(rotationVector(multiply(r.frame.targets[ankle.id], conjugate(measured.rotation))), ankle.motor.stiffness)
      vector(sub(spring, scale(measured.angularVelocity, ankle.motor.damping)), ZERO)
      vector(r.diagnostics.jointTorquesNm[ankle.id], ZERO)
    }
    const turning = structuredClone(observation)
    turning.bodies.find(b => b.id === foot)!.angularVelocity.y = 1.001
    expect(controller.step(turning).diagnostics.ankleFeet).not.toContain(foot)
    turning.bodies.find(b => b.id === foot)!.angularVelocity.y = 1
    expect(controller.step(turning).diagnostics.ankleFeet).toContain(foot)
    const unloaded = structuredClone(observation); unloaded.feet[0].normalImpulseNs = 0
    expect(controller.step(unloaded).diagnostics.ankleFeet).not.toContain(foot)
  })

  it('requests toe-ward trunk pitch, opposite stance-hip reaction, and an upright return moment', async () => {
    const { model, observation, controller } = await fixture()
    const toe = hipStrategyMoment({ x: 0, y: 0, z: -.01 }, 59.5, 9.81)
    expect(toe.x).toBeLessThan(0)
    expect(rotate(fromRotationVector(scale(toe, .01)), { x: 0, y: 1, z: 0 }).z).toBeLessThan(0)
    expect(norm(hipStrategyMoment({ x: 5, y: 0, z: -5 }, 59.5, 9.81))).toBeCloseTo(60, 10)
    observation.comVelocity.z = -.5
    const d = controller.step(observation).diagnostics
    expect(d.trunkMomentNm.x).toBeLessThan(0)
    for (const hip of model.scene.joints.filter(j => j.parent === model.root && j.child.endsWith('_thigh'))) {
      const parent = observation.bodies.find(b => b.id === hip.parent)!, anchor = jointFrame(hip, parent).position
      const virtualX = -(observation.com.y - anchor.y) * d.forceN.z / 2
      expect(d.jointTorquesNm[hip.id].x - virtualX).toBeCloseTo(-d.trunkMomentNm.x / 2, 10)
    }
    const trunk = observation.bodies.find(b => b.id === model.parts.thorax.bodyId)!
    trunk.rotation = fromRotationVector({ x: -.36, y: 0, z: 0 })
    const limited = controller.step(observation).diagnostics
    vector(limited.residualTrunkMomentNm, ZERO)
    expect(limited.trunkMomentNm.x).toBeGreaterThan(0)
  })

  it('is equivariant under a yaw and translation of the actor and its contacts', async () => {
    const { observation, controller } = await fixture()
    observation.comVelocity = { x: .1, y: 0, z: -.2 }
    const original = controller.step(observation), q = fromRotationVector({ x: 0, y: .8, z: 0 }), shift = { x: 3, y: 0, z: -2 }
    const point = (p: Vec3) => add(rotate(q, p), shift), turned = structuredClone(observation)
    turned.com = point(turned.com); turned.comVelocity = rotate(q, turned.comVelocity)
    for (const body of turned.bodies) { body.position = point(body.position); body.rotation = multiply(q, body.rotation)
      body.velocity = rotate(q, body.velocity); body.angularVelocity = rotate(q, body.angularVelocity) }
    for (const foot of turned.feet) { foot.centre = point(foot.centre); foot.centreOfPressure = point(foot.centreOfPressure!)
      foot.contactPoints = foot.contactPoints.map(point) }
    turned.support.points = turned.support.points.map(point); turned.support.polygon = turned.support.polygon.map(point)
    const result = controller.step(turned)
    vector(result.diagnostics.forceN, rotate(q, original.diagnostics.forceN))
    vector(result.diagnostics.trunkMomentNm, rotate(q, original.diagnostics.trunkMomentNm))
    for (const id of Object.keys(original.frame.targets)) expect(angleBetween(result.frame.targets[id], original.frame.targets[id])).toBeLessThan(1e-9)
  })

  it('leaves cone projection, slew and identity enforcement to the unchanged gate', async () => {
    const { model, observation, controller } = await fixture(), gate = new ActuationGate(model, 1), initial = gate.targets()
    observation.comVelocity = { x: 3, y: 0, z: -3 }
    const request = controller.step(observation).frame, accepted = gate.accept(request)
    for (const id of Object.keys(initial)) expect(angleBetween(accepted.targets[id], initial[id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
    expect(() => gate.accept({ ...request, actorId: 'seat2', tick: 1 })).toThrow()
  })

  it('returns stance fallback outside the support envelope and rejects invalid identity or active state', async () => {
    const { model, observation, controller } = await fixture()
    const outside = structuredClone(observation); outside.com.y = .1
    expect(controller.step(outside).diagnostics.phase).toBe('outside-envelope')
    expect(controller.step(outside).frame).toEqual(new StanceController(model, 1).step(outside).frame)
    const unsupported = structuredClone(observation); unsupported.support.polygon = []
    expect(controller.step(unsupported).diagnostics.phase).toBe('no-support')
    expect(() => controller.step({ ...observation, generation: 2 })).toThrow()
    expect(() => controller.step({ ...observation, comVelocity: { x: NaN, y: 0, z: 0 } })).toThrow()
    observation.comVelocity.z = -.1; observation.joints.pop()
    expect(() => controller.step(observation)).toThrow('Missing balance joint')
    expect(() => hipStrategyMoment(ZERO, -1, 9.81)).toThrow()
  })
})

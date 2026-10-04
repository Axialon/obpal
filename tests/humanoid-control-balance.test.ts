import { describe, expect, it } from 'vitest'
import { BALANCE_CONTROL, BalanceController, hipStrategyMoment, supportGeometryDeparture } from '../src/sim/humanoid/physics/balance'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { jointFrame, jointTorque } from '../src/sim/humanoid/physics/targets'
import { polygonCentroid, supportHull, sinkSafeDiamond } from '../src/sim/humanoid/physics/stepping'
import { ZERO, add, sub, scale, rotate, multiply, conjugate, fromRotationVector, rotationVector, angleBetween, clampCone, norm, type Vec3 } from '../src/sim/physics/math'
import { STEP } from '../src/sim/physics/schema'
import { supportFixture } from './humanoid-balance-cases'
import type { Observation } from '../src/sim/humanoid/physics/observation'

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

/** Observation-only arrangement fixture; this does not move a native body. */
function staggered(input: Observation, metres = .12): Observation {
  const o = structuredClone(input), foot = o.feet[1], body = o.bodies.find(b => b.id === foot.id)!
  body.position.z -= metres; foot.centre.z -= metres; foot.centreOfPressure!.z -= metres
  for (const point of foot.contactPoints) point.z -= metres
  o.support.points = o.feet.flatMap(f => f.contactPoints)
  o.support.polygon = supportHull(o.support.points)
  const centre = polygonCentroid(o.support.polygon)!
  o.com.x = centre.x; o.com.z = centre.z
  return o
}
function atTick(input: Observation, tick: number): Observation {
  return { ...structuredClone(input), stateTick: tick, timeS: tick * STEP }
}

describe('capture-point balance requests', () => {
  it('measures support departure in metres independently of actor heading and translation', async () => {
    const { model, observation } = await fixture(), changed = staggered(observation)
    expect(supportGeometryDeparture(model, observation)).toBeCloseTo(0, 12)
    expect(supportGeometryDeparture(model, changed)).toBeCloseTo(.12, 12)
    const q = fromRotationVector({ x: 0, y: .8, z: 0 }), shift = { x: 3, y: 0, z: -2 }
    for (const body of changed.bodies) {
      body.position = add(rotate(q, body.position), shift); body.rotation = multiply(q, body.rotation)
    }
    expect(supportGeometryDeparture(model, changed)).toBeCloseTo(.12, 12)
  })

  it('keeps authored quiet stance identical on first entry and after an observation gap', async () => {
    const { model, observation, controller } = await fixture()
    for (const tick of [0, 1, 100]) {
      const input = atTick(observation, tick)
      expect(controller.step(input).frame).toEqual(new StanceController(model, 1).step(input).frame)
    }
  })

  it('retains a changed support posture on entry without relatching every continuous gait observation', async () => {
    const { model, observation } = await fixture(), changed = staggered(observation)
    const knee = model.scene.joints.find(j => j.child === model.parts.right_shin.bodyId)!
    changed.joints.find(j => j.id === knee.id)!.rotation = fromRotationVector({ x: .15, y: 0, z: 0 })
    const before = structuredClone({ model, changed }), continuous = new BalanceController(model, 1)
    continuous.step(observation)
    const next = atTick(changed, 1), retained = new BalanceController(model, 1).step(next), unchanged = continuous.step(next)
    expect(angleBetween(retained.frame.targets[knee.id], unchanged.frame.targets[knee.id])).toBeGreaterThan(.1)
    expect({ model, changed }).toEqual(before)
    expect(Object.keys(retained.frame.targets).sort()).toEqual(model.scene.joints.map(j => j.id).sort())
    expect(retained.frame.targets).not.toHaveProperty(model.root)
  })

  it('holds its leg reference through contiguous observations and refreshes it after a real gap', async () => {
    const { model, observation } = await fixture(), changed = staggered(observation), controller = new BalanceController(model, 1)
    const knee = model.scene.joints.find(j => j.child === model.parts.right_shin.bodyId)!
    changed.joints.find(j => j.id === knee.id)!.rotation = fromRotationVector({ x: .1, y: 0, z: 0 })
    const first = controller.step(changed)
    const next = atTick(changed, 1)
    next.joints.find(j => j.id === knee.id)!.rotation = fromRotationVector({ x: .2, y: 0, z: 0 })
    const continuous = controller.step(next)
    expect(angleBetween(continuous.frame.targets[knee.id], first.frame.targets[knee.id])).toBeLessThan(1e-10)
    expect(controller.step(next)).toEqual(continuous)
    const resumed = controller.step(atTick(next, 10))
    expect(angleBetween(resumed.frame.targets[knee.id], first.frame.targets[knee.id])).toBeCloseTo(.1, 10)
  })

  it('keeps zero conform moment when an offset ankle lies outside the narrowed COP diamond', async () => {
    const { model, observation } = await fixture(), changed = staggered(observation)
    const foot = changed.feet[1], body = changed.bodies.find(b => b.id === foot.id)!
    body.rotation = fromRotationVector({ x: .04, y: 0, z: 0 })
    const ankle = model.scene.joints.find(j => j.child === foot.id)!, measured = changed.joints.find(j => j.id === ankle.id)!
    measured.rotation = fromRotationVector({ x: .05, y: .02, z: 0 })
    measured.angularVelocity = { x: .2, y: -.1, z: .05 }
    const diamond = sinkSafeDiamond({ ...model.scene.bodies.find(b => b.id === foot.id)!, ...body }, foot.normalImpulseNs / STEP)
    const anchor = jointFrame(ankle, changed.bodies.find(b => b.id === ankle.parent)!).position
    expect(diamond.rho).toBeLessThan(.5)
    expect(Math.hypot(anchor.x - diamond.centre.x, anchor.z - diamond.centre.z)).toBeGreaterThan(.1)

    const result = new BalanceController(model, 1).step(changed)
    const spring = scale(rotationVector(multiply(result.frame.targets[ankle.id], conjugate(measured.rotation))), ankle.motor.stiffness)
    vector(sub(spring, scale(measured.angularVelocity, ankle.motor.damping)), ZERO)
    vector(result.diagnostics.jointTorquesNm[ankle.id], ZERO)
    vector(result.diagnostics.ankleResidualNm[foot.id], ZERO)
  })

  it('repairs an infeasible retained ankle only after conform, at most once per observed tick', async () => {
    const { model, observation } = await fixture(), changed = staggered(observation), controller = new BalanceController(model, 1)
    const ankle = model.scene.joints.find(j => j.child === model.feet[1])!, measured = changed.joints.find(j => j.id === ankle.id)!
    measured.rotation = fromRotationVector({ x: 1, y: 1, z: 1 })
    expect(angleBetween(measured.rotation, clampCone(measured.rotation, ankle.cone))).toBeGreaterThan(BALANCE_CONTROL.supportFlattenConeErrorRad)
    let previous: ReturnType<BalanceController['step']> | null = null, moved = false
    for (let tick = 0; tick < 40; tick++) {
      const input = atTick(changed, tick), first = controller.step(input)
      expect(controller.step(input)).toEqual(first)
      if (tick === 0) vector(first.diagnostics.jointTorquesNm[ankle.id], ZERO)
      if (previous && tick > 20) {
        const change = angleBetween(previous.frame.targets[ankle.id], first.frame.targets[ankle.id])
        expect(change).toBeLessThanOrEqual(BALANCE_CONTROL.supportFlattenRateRadps * STEP + 1e-9)
        moved ||= change > 1e-6
      }
      previous = first
    }
    expect(moved).toBe(true)
    const feasible = structuredClone(changed)
    feasible.joints.find(j => j.id === ankle.id)!.rotation = clampCone(measured.rotation, ankle.cone)
    const resumed = atTick(feasible, 100), fresh = new BalanceController(model, 1)
    expect(controller.step(resumed)).toEqual(fresh.step(resumed))
    expect(controller.step(atTick(feasible, 101))).toEqual(fresh.step(atTick(feasible, 101)))
  })

  it('does not latch unloaded geometry and rejects missing or non-finite measured posture joints', async () => {
    const { model, observation } = await fixture(), knee = model.scene.joints.find(j => j.child === model.parts.right_shin.bodyId)!
    const changed = staggered(observation); changed.feet[1].normalImpulseNs = 0
    changed.joints.find(j => j.id === knee.id)!.rotation = fromRotationVector({ x: .2, y: 0, z: 0 })
    expect(new BalanceController(model, 1).step(changed).frame.targets[knee.id]).toEqual(knee.motor.target)
    const missing = staggered(observation); missing.joints.pop()
    expect(() => new BalanceController(model, 1).step(missing)).toThrow('Missing balance joint')
    const invalid = staggered(observation); invalid.joints[0].rotation.x = NaN
    expect(() => new BalanceController(model, 1).step(invalid)).toThrow('Invalid balance joint state')
  })

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
    const diamonds = observation.feet.flatMap(f => sinkSafeDiamond({ ...model.scene.bodies.find(b => b.id === f.id)!,
      ...observation.bodies.find(b => b.id === f.id)! }, f.normalImpulseNs / STEP).points)
    expect(d.desiredCOP!.z).toBeCloseTo(Math.min(...diamonds.map(p => p.z)), 10)
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

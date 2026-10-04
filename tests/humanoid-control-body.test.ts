import { describe, expect, it } from 'vitest'
import { STEP } from '../src/sim/physics/schema'
import { angleBetween, fromRotationVector, multiply, swingTwist } from '../src/sim/physics/math'
import { neutral, rad, type Angles } from '../src/sim/humanoid/profile'
import type { Retargeted } from '../src/sim/humanoid/retarget'
import { presetPose } from '../src/sim/humanoid/controls'
import { ActuationGate, type ActuationFrame } from '../src/sim/humanoid/physics/contract'
import { buildHumanoid, profileFor, targetsFromAngles } from '../src/sim/humanoid/physics/model'
import { observe } from '../src/sim/humanoid/physics/observation'
import { BODY_CONTROL, BODY_MODE_WEIGHT, bodyCaptureMarginM, UpperBodyController } from '../src/sim/humanoid/physics/upper-body'
import type { BehaviourMode } from '../src/sim/humanoid/physics/supervisor'

const model = buildHumanoid('keel-v1'), profile = profileFor(model.profileId)
const body = (q: Angles = {}, generation = 7): Retargeted => ({ q: { ...neutral(profile), ...q }, raw: {}, valid: new Set(Object.keys(q)),
  tracked: true, calibrating: false, generation, residual: 0, limited: false, heading: .6 })
function sample(tick: number, m = model) {
  const observation = observe(m, m.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, tick)
  const frame: ActuationFrame = { schema_version: 1, profileId: m.profileId, actorId: m.actorId, generation: 1, tick, source: 'classical',
    targets: Object.fromEntries(m.scene.joints.map(j => [j.id, { ...j.motor.target }])) }
  return { observation, frame }
}
const run = (controller: UpperBodyController, tick: number, mode: BehaviourMode = 'stance', trace: Retargeted | null = body(), margin = .04) => {
  const { observation, frame } = sample(tick)
  return controller.step(observation, frame, { mode, body: trace, captureMarginM: margin })
}

describe('BODY fixed-tick ramps and safety weights', () => {
  it('acquires in 150 ms, holds the last angles on loss and reaches zero within 250 ms', () => {
    const c = new UpperBodyController(model, 1), q = body({ 'left.arm.elbow': 1 })
    let result = run(c, 0, 'stance', q)
    expect(result.diagnostics.trackWeight).toBeCloseTo(STEP / BODY_CONTROL.acquisitionS)
    for (let tick = 1; tick < 36; tick++) result = run(c, tick, 'stance', q)
    expect(result.diagnostics.trackWeight).toBeCloseTo(1)
    const lost = { ...q, tracked: false, q: { ...q.q, 'left.arm.elbow': 0 } }
    result = run(c, 36, 'stance', lost)
    expect(result.diagnostics.trackWeight).toBeCloseTo(1 - STEP / BODY_CONTROL.lossS)
    expect(swingTwist(result.frame.targets.seat1_joint_left_forearm).twist).toBeCloseTo(result.diagnostics.trackWeight)
    for (let tick = 37; tick < 96; tick++) result = run(c, tick, 'stance', null)
    expect(result.diagnostics.trackWeight).toBe(0)
    expect(result.frame.source).toBe('classical')
  })
  it.each(Object.keys(BODY_MODE_WEIGHT) as BehaviourMode[])('uses %s mode weight and leaves every leg target untouched', mode => {
    const c = new UpperBodyController(model, 1), q = body({ pelvis: 2, 'left.leg.pitch': NaN, 'left.arm.pitch': .6 })
    let result = run(c, 0, mode, q)
    for (let tick = 1; tick < 36; tick++) result = run(c, tick, mode, q)
    expect(result.diagnostics.bodyWeight).toBeCloseTo(BODY_MODE_WEIGHT[mode])
    for (const d of model.drives.filter(d => d.axes.some(n => n.includes('.leg.')))) expect(result.frame.targets[d.id]).toEqual(sample(35).frame.targets[d.id])
    if (mode === 'fall' || mode === 'getup') expect(result.frame.targets).toEqual(sample(35).frame.targets)
    expect(result.frame.source).toBe(BODY_MODE_WEIGHT[mode] >= .5 ? 'body' : 'classical')
  })
  it.each([[-.02, .5], [0, .5], [.02, .75], [.04, 1], [.1, 1]])('shoulder pitch/roll scales at margin %s m, preserving shoulder yaw', (margin, weight) => {
    const c = new UpperBodyController(model, 1), q = body({ 'left.arm.pitch': .4, 'left.arm.yaw': .3, 'left.arm.roll': 0, 'left.arm.elbow': .6 })
    let result = run(c, 0, 'stance', q, margin)
    for (let tick = 1; tick < 36; tick++) result = run(c, tick, 'stance', q, margin)
    const shoulder = swingTwist(result.frame.targets.seat1_joint_left_upper_arm), desired = swingTwist(targetsFromAngles(model, q.q).seat1_joint_left_upper_arm)
    expect(result.diagnostics.shoulderMarginWeight).toBe(weight)
    expect(result.diagnostics.jointWeights.seat1_joint_left_upper_arm).toBeCloseTo(weight)
    expect(shoulder.twist).toBeCloseTo(desired.twist)
    expect(swingTwist(result.frame.targets.seat1_joint_left_forearm).twist).toBeCloseTo(.6)
  })
  it('routes spine pitch/roll only as clamped torso offsets and preserves the leg frame spine swing', () => {
    const c = new UpperBodyController(model, 1), q = body({ 'spine.pitch': 1, 'spine.roll': -1, 'spine.yaw': .2 })
    const spine = 'seat1_joint_lumbar', swing = fromRotationVector({ x: 0, y: -.07, z: .03 })
    let result: ReturnType<UpperBodyController['step']> | undefined
    for (let tick = 0; tick < 36; tick++) {
      const { observation, frame } = sample(tick)
      frame.targets[spine] = multiply(swing, fromRotationVector({ x: .02, y: 0, z: 0 }))
      result = c.step(observation, frame, { mode: 'stance', body: q, captureMarginM: .04 })
    }
    expect(result!.torsoOffset).toEqual({ pitchRad: .15, rollRad: -.15 })
    const actual = swingTwist(result!.frame.targets[spine]), original = swingTwist(swing)
    expect(actual.swingY).toBeCloseTo(original.swingY); expect(actual.swingZ).toBeCloseTo(original.swingZ)
    expect(actual.twist).toBeCloseTo(.1) // The physical model divides spine yaw across two joints.
  })
  it('maps existing presets through the same upper-only path', () => {
    const c = new UpperBodyController(model, 1), { observation, frame } = sample(0), preset = presetPose(profile, 'uppercut', .5)
    const result = c.step(observation, frame, { mode: 'stance', preset })
    expect(result.torsoOffset.pitchRad).toBe(-.15)
    expect(result.frame.targets.seat1_joint_left_upper_arm).toEqual(targetsFromAngles(model, preset).seat1_joint_left_upper_arm)
    expect(result.frame.targets.seat1_joint_left_thigh).toEqual(frame.targets.seat1_joint_left_thigh)
    expect(result.frame.targets.seat1_joint_lumbar).toEqual(frame.targets.seat1_joint_lumbar)
  })
  it('all output remains subject to the original slew, cones and complete-frame gate', () => {
    const c = new UpperBodyController(model, 1), gate = new ActuationGate(model, 1), q = body({ 'left.arm.pitch': rad(140), 'left.arm.elbow': rad(140) })
    let previous = gate.targets()
    for (let tick = 0; tick < 60; tick++) {
      const accepted = gate.accept(run(c, tick, 'stance', q).frame)
      for (const id of Object.keys(previous)) expect(angleBetween(previous[id], accepted.targets[id])).toBeLessThanOrEqual(4 * STEP + 1e-10)
      previous = accepted.targets
    }
    expect(previous).not.toHaveProperty(model.root)
  })
})

describe('BODY identity and capture-point isolation', () => {
  it('starts a fresh ramp on a newer BODY generation and ignores older source generations', () => {
    const c = new UpperBodyController(model, 1)
    for (let tick = 0; tick < 36; tick++) run(c, tick, 'stance', body({ 'left.arm.elbow': 1 }, 7))
    const next = run(c, 36, 'stance', body({ 'left.arm.elbow': .2 }, 8))
    expect(next.diagnostics.trackWeight).toBeCloseTo(STEP / .15)
    const stale = run(c, 37, 'stance', body({ 'left.arm.elbow': 2 }, 7))
    expect(stale.diagnostics.inputGeneration).toBe(8)
    expect(stale.diagnostics.trackWeight).toBeLessThan(next.diagnostics.trackWeight)
  })
  it('rejects wrong actors, generations, malformed targets and reordered ticks without advancing the state', () => {
    const c = new UpperBodyController(model, 1), { observation, frame } = sample(0)
    expect(() => c.step({ ...observation, actorId: 'seat2' }, frame, { mode: 'stance' })).toThrow()
    expect(() => c.step(observation, { ...frame, generation: 2 }, { mode: 'stance' })).toThrow()
    expect(() => c.step(observation, { ...frame, targets: {} }, { mode: 'stance' })).toThrow()
    expect(() => c.step(observation, frame, { mode: 'stance', body: body({ 'head.pitch': NaN }) })).toThrow()
    expect(run(c, 0).diagnostics.trackWeight).toBeCloseTo(STEP / .15)
    expect(() => run(c, 0)).toThrow()
    expect(() => run(c, 2)).toThrow()
    expect(run(c, 1).diagnostics.trackWeight).toBeCloseTo(2 * STEP / .15)
  })
  it('one seat acquisition/loss/generation cannot change the other seat targets or generation', () => {
    const m2 = buildHumanoid('keel-v1', 'seat2'), c1 = new UpperBodyController(model, 1), c2 = new UpperBodyController(m2, 1)
    const reference = new UpperBodyController(m2, 1)
    for (let tick = 0; tick < 120; tick++) {
      run(c1, tick, 'stance', tick < 40 ? body({ 'left.arm.elbow': 1 }, 7) : tick < 80 ? null : body({ 'left.arm.elbow': .3 }, 8))
      const { observation, frame } = sample(tick, m2), before = structuredClone(frame)
      expect(c2.step(observation, frame, { mode: 'stance' })).toEqual(reference.step(observation, frame, { mode: 'stance' }))
      expect(frame).toEqual(before)
    }
  })
  it('uses capture-point rather than COM margin, including clockwise footprints and unavailable support', () => {
    const { observation } = sample(0)
    observation.support.polygon = [{ x: -.1, y: 0, z: -.2 }, { x: .1, y: 0, z: -.2 }, { x: .1, y: 0, z: .2 }, { x: -.1, y: 0, z: .2 }]
    observation.com = { x: 0, y: 1, z: 0 }; observation.comVelocity = { x: 0, y: 0, z: 0 }
    for (const foot of observation.feet) { foot.normalImpulseNs = 1; foot.centreOfPressure = { x: 0, y: 0, z: 0 } }
    expect(bodyCaptureMarginM(observation)).toBeCloseTo(.1)
    observation.comVelocity.x = Math.sqrt(9.81) * .12
    expect(bodyCaptureMarginM(observation)).toBeCloseTo(-.02)
    observation.support.polygon.reverse()
    expect(bodyCaptureMarginM(observation)).toBeCloseTo(-.02)
    observation.support.polygon = []
    expect(bodyCaptureMarginM(observation)).toBeNull()
  })
})

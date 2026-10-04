import { describe, expect, it } from 'vitest'
import { ActuationGate, MAX_TARGET_RATE, type ActuationFrame } from '../src/sim/humanoid/physics/contract'
import { ALL_PHYSICAL_PROFILES, buildHumanoid } from '../src/sim/humanoid/physics/model'
import { jointFrame, worldTarget, jointTorque, torqueOffset, targetOffset, torqueTarget, jacobianTransposeTorque,
  gravityCompensation, TORQUE_TARGET_FRACTION } from '../src/sim/humanoid/physics/targets'
import { IDENTITY, ZERO, add, sub, scale, rotate, localPoint, multiply, conjugate, quaternion, fromRotationVector,
  rotationVector, angleBetween, norm, clampCone, type Vec3 } from '../src/sim/physics/math'
import { STEP, type BodyState } from '../src/sim/physics/schema'

const model = buildHumanoid('keel-v1'), ankle = model.scene.joints.find(j => j.child === model.feet[0])!
const parent: BodyState = { ...model.scene.bodies.find(b => b.id === ankle.parent)!, sleeping: false }
function vector(actual: Vec3, expected: Vec3) {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 10)
}
const request = (targets: ActuationFrame['targets'], tick = 0): ActuationFrame => ({ schema_version: 1,
  profileId: model.profileId, actorId: model.actorId, generation: 1, tick, source: 'classical', targets })

describe('shared humanoid joint targets', () => {
  it('places the parent anchor and frame in world coordinates without changing inputs', () => {
    const state = { ...parent, position: { x: 2, y: 3, z: -4 }, rotation: fromRotationVector({ x: .2, y: .4, z: -.3 }) }
    const before = structuredClone({ ankle, state }), frame = jointFrame(ankle, state)
    vector(frame.position, localPoint(state.position, state.rotation, ankle.anchorParent))
    expect(angleBetween(frame.rotation, multiply(state.rotation, ankle.frameParent))).toBeLessThan(1e-12)
    expect({ ankle, state }).toEqual(before)
    expect(() => jointFrame(ankle, { ...state, id: model.root })).toThrow('parent mismatch')
  })
  it('inverts noncommuting parent, parent-frame and child-frame rotations exactly', () => {
    const joint = { ...ankle, frameParent: fromRotationVector({ x: .4, y: .1, z: -.2 }),
      frameChild: fromRotationVector({ x: -.2, y: .3, z: .5 }) }
    const parentRotation = fromRotationVector({ x: .2, y: .6, z: -.1 }), desired = fromRotationVector({ x: -.4, y: .3, z: .7 })
    const target = worldTarget(joint, parentRotation, desired)
    const reconstructed = multiply(multiply(multiply(parentRotation, joint.frameParent), target), conjugate(joint.frameChild))
    expect(angleBetween(reconstructed, desired)).toBeLessThan(1e-12)
    const negative = { x: -desired.x, y: -desired.y, z: -desired.z, w: -desired.w }
    expect(angleBetween(worldTarget(joint, parentRotation, negative), target)).toBeLessThan(1e-12)
  })
  it.each(ALL_PHYSICAL_PROFILES)('%s preserves each authored drive frame and toe-ward -Z', profile => {
    const form = buildHumanoid(profile)
    for (const joint of form.scene.joints) {
      const a = form.scene.bodies.find(b => b.id === joint.parent)!, b = form.scene.bodies.find(b => b.id === joint.child)!
      expect(angleBetween(worldTarget(joint, a.rotation, b.rotation), joint.motor.target)).toBeLessThan(1e-12)
    }
    for (const id of form.feet) vector(rotate(form.scene.bodies.find(b => b.id === id)!.rotation, { x: 0, y: 0, z: -1 }), { x: 0, y: 0, z: -1 })
  })
  it('converts world torques into joint coordinates, including the reversed knee X basis', () => {
    const state = { ...parent, rotation: fromRotationVector({ x: .3, y: .8, z: -.4 }) }, torque = { x: 2, y: -3, z: 4 }
    vector(rotate(jointFrame(ankle, state).rotation, jointTorque(ankle, state, torque)), torque)
    const knee = model.scene.joints.find(j => j.id.endsWith('_joint_left_shin'))!
    const thigh = { ...model.scene.bodies.find(b => b.id === knee.parent)!, sleeping: false }
    vector(jointTorque(knee, thigh, { x: 3, y: 0, z: 0 }), { x: -3, y: 0, z: 0 })
  })
  it('uses tau/K and premultiplies a nonidentity posture', () => {
    const torque = { x: 4, y: -6, z: 8 }, posture = fromRotationVector({ x: .1, y: -.2, z: .3 })
    vector(torqueOffset(ankle, torque), scale(torque, 1 / ankle.motor.stiffness))
    const error = rotationVector(multiply(targetOffset(ankle, posture, torque), conjugate(posture)))
    vector(scale(error, ankle.motor.stiffness), torque)
  })
  it('reconstructs wanted torque with measured rotation and joint-relative damping below the cap', () => {
    const measured = fromRotationVector({ x: .1, y: -.2, z: .3 }), velocity = { x: .2, y: -.3, z: .4 }, torque = { x: 4, y: -6, z: 8 }
    const target = torqueTarget(ankle, measured, velocity, torque)
    vector(sub(scale(rotationVector(multiply(target, conjugate(measured))), ankle.motor.stiffness), scale(velocity, ankle.motor.damping)), torque)
    expect(angleBetween(torqueTarget(ankle, measured, ZERO, torque), targetOffset(ankle, measured, torque))).toBeLessThan(1e-12)
  })
  it('caps vector magnitude at 0.8 effort in posture and damping-compensated torque modes', () => {
    const torque = { x: 200, y: -300, z: 400 }, cap = TORQUE_TARGET_FRACTION * ankle.motor.maxTorque
    const offset = torqueOffset(ankle, torque)
    expect(norm(offset) * ankle.motor.stiffness).toBeCloseTo(cap, 10)
    vector(scale(offset, 1 / norm(offset)), scale(torque, 1 / norm(torque)))
    const target = torqueTarget(ankle, IDENTITY, { x: 100, y: 0, z: 0 }, ZERO)
    expect(norm(rotationVector(target)) * ankle.motor.stiffness).toBeCloseTo(cap, 10)
    vector(torqueOffset({ ...ankle, motor: { ...ankle.motor, maxTorque: 0 } }, torque), ZERO)
  })
  it('rejects invalid inverse gains, damping, torque and rotation rather than producing a target', () => {
    for (const stiffness of [0, -1, NaN, Infinity]) expect(() => torqueOffset({ ...ankle, motor: { ...ankle.motor, stiffness } }, ZERO)).toThrow()
    for (const maxTorque of [-1, NaN, Infinity]) expect(() => torqueOffset({ ...ankle, motor: { ...ankle.motor, maxTorque } }, ZERO)).toThrow()
    expect(() => torqueTarget({ ...ankle, motor: { ...ankle.motor, damping: -1 } }, IDENTITY, ZERO, ZERO)).toThrow()
    expect(() => torqueOffset(ankle, { x: NaN, y: 0, z: 0 })).toThrow()
    expect(() => torqueTarget(ankle, IDENTITY, { x: 0, y: Infinity, z: 0 }, ZERO)).toThrow()
    expect(() => worldTarget(ankle, { ...ZERO, w: 0 }, IDENTITY)).toThrow()
  })
  it('leaves complete target requests to ActuationGate for cone, slew and identity enforcement', () => {
    const before = structuredClone(model), gate = new ActuationGate(model, 1), targets = gate.targets(), initial = targets[ankle.id]
    targets[ankle.id] = targetOffset(ankle, initial, { x: 0, y: -900, z: 0 })
    expect(angleBetween(targets[ankle.id], initial)).toBeGreaterThan(MAX_TARGET_RATE * STEP)
    let accepted = gate.accept(request(targets))
    expect(angleBetween(accepted.targets[ankle.id], initial)).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
    for (let tick = 1; tick < 120; tick++) accepted = gate.accept(request(targets, tick))
    const limits = ankle.cone
    expect(rotationVector(accepted.targets[ankle.id]).y).toBeGreaterThanOrEqual(limits.swingYMin! - 1e-10)
    expect(Object.keys(accepted.targets).sort()).toEqual(model.scene.joints.map(j => j.id).sort())
    expect(accepted.targets).not.toHaveProperty(model.root)
    expect(() => gate.accept(request({ ...targets, [model.root]: quaternion(IDENTITY) }, 120))).toThrow()
    expect(() => gate.accept({ ...request(targets, 120), actorId: 'seat2' })).toThrow()
    expect(model.scene.bodies.find(b => b.id === model.root)!.fixed).toBe(false)
    expect(model).toEqual(before)
  })
  it('projects an unreachable target onto the cone while bounding every accepted target step', () => {
    const gate = new ActuationGate(model, 1), targets = gate.targets(), impossible = fromRotationVector({ x: 0, y: -1, z: 0 })
    targets[ankle.id] = impossible
    let previous = gate.targets()[ankle.id]
    for (let tick = 0; tick < 120; tick++) {
      const next = gate.accept(request(targets, tick)).targets[ankle.id]
      expect(angleBetween(previous, next)).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
      previous = next
    }
    expect(angleBetween(previous, impossible)).toBeGreaterThan(.1)
    expect(angleBetween(previous, clampCone(impossible, ankle.cone))).toBeLessThan(1e-10)
  })
})

describe('shared virtual torques', () => {
  it.each([
    [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }],
    [{ x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
    [{ x: 1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }],
  ])('pins foot/pelvis-rooted Jacobian sign for lever %j and force %j', (point, force, expected) => {
    vector(jacobianTransposeTorque(ZERO, point, force, 'foot'), expected)
    vector(jacobianTransposeTorque(ZERO, point, force, 'pelvis'), scale(expected, -1))
    const shift = { x: 2, y: 3, z: 4 }
    vector(jacobianTransposeTorque(shift, add(shift, point), force, 'foot'), expected)
    vector(jacobianTransposeTorque(point, point, force, 'foot'), ZERO)
  })
  it('sums distal gravity moments with opposite chain-root signs', () => {
    const links = [{ position: { x: 0, y: 1, z: -1 }, massKg: 2 }, { position: { x: 1, y: 2, z: 0 }, massKg: 3 }]
    const gravity = { x: 0, y: -10, z: 0 }, expected = { x: -20, y: 0, z: -30 }
    vector(gravityCompensation(ZERO, links, gravity, 'foot'), expected)
    vector(gravityCompensation(ZERO, links, gravity, 'pelvis'), scale(expected, -1))
    vector(gravityCompensation(ZERO, [], gravity, 'foot'), ZERO)
    for (const root of ['foot', 'pelvis'] as const) {
      const passive = links.reduce((sum, link) => add(sum, jacobianTransposeTorque(ZERO, link.position, scale(gravity, link.massKg), root)), { ...ZERO })
      vector(add(passive, gravityCompensation(ZERO, links, gravity, root)), ZERO)
    }
  })
  it('keeps virtual torques equivariant under world yaw and translation', () => {
    const yaw = fromRotationVector({ x: 0, y: .7, z: 0 }), shift = { x: 2, y: .4, z: -3 },
      anchor = { x: .1, y: .2, z: .3 }, point = { x: .4, y: .8, z: -.5 }, force = { x: 3, y: 2, z: -4 }
    const transform = (p: Vec3) => add(shift, rotate(yaw, p))
    for (const root of ['foot', 'pelvis'] as const) {
      vector(jacobianTransposeTorque(transform(anchor), transform(point), rotate(yaw, force), root), rotate(yaw, jacobianTransposeTorque(anchor, point, force, root)))
      vector(gravityCompensation(transform(anchor), [{ position: transform(point), massKg: 2 }], rotate(yaw, force), root),
        rotate(yaw, gravityCompensation(anchor, [{ position: point, massKg: 2 }], force, root)))
    }
  })
  it('rejects nonfinite geometry and invalid distal mass', () => {
    expect(() => jacobianTransposeTorque(ZERO, { x: NaN, y: 0, z: 0 }, ZERO, 'foot')).toThrow()
    expect(() => gravityCompensation(ZERO, [{ position: ZERO, massKg: -1 }], ZERO, 'pelvis')).toThrow()
    expect(() => gravityCompensation(ZERO, [{ position: ZERO, massKg: Infinity }], ZERO, 'foot')).toThrow()
  })
})

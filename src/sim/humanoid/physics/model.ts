/** F1a original primitive mass model. Visual profiles supply dimensions/ROM, never masses or a learned controller. */
import { robotRoster, neutral, rad, type Angles, type RigProfile } from '../profile'
import { validateScene, type Scene, type Body, type BodyState, type JointInput } from '../../physics/schema'
import { IDENTITY, ZERO, add, sub, scale, localPoint, multiply, conjugate, quaternion, rotate, fromRotationVector, rotationVector, clampCone,
  type Vec3, type Quat, type Cone } from '../../physics/math'
import { uniformInertia } from '../../physics/servo'
export const MODEL_VERSION = 'humanoid-f1a-v1'
export const ALL_PHYSICAL_PROFILES = Object.freeze(robotRoster(true).flatMap(r => r.forms.map(p => p.id)))
export interface WorldFrame { position: Vec3; rotation: Quat }
export interface Part { bodyId: string; massKg: number; inertia: Vec3 }
export interface PhysicalHumanoid {
  version: typeof MODEL_VERSION; profileId: string; actorId: string; root: string; feet: string[]; scene: Scene
  parts: Record<string, Part>; frames: Record<string, { bodyId: string; point: Vec3 }>
  drives: { id: string; axes: string[]; fraction: number }[]
}
export function profileFor(id: string): RigProfile {
  const profile = robotRoster(true).flatMap(r => r.forms).find(p => p.id === id)
  if (!profile) throw new RangeError('Unknown humanoid profile')
  return profile
}
const v = (a: readonly number[]): Vec3 => ({ x: a[0], y: a[1], z: a[2] })
const BASIS_Y = fromRotationVector({ x: 0, y: 0, z: Math.PI / 2 })
const BASIS_MINUS_X = fromRotationVector({ x: 0, y: Math.PI, z: 0 })
/** Seven original simultaneous targets, not evidence of reachability, balance or get-up. Values are radians. */
export function canonicalPoses(profileId: string): Record<string, Angles> {
  const p = profileFor(profileId), pose = (values: Angles) => ({ ...neutral(p), ...Object.fromEntries(Object.entries(values).map(([k, n]) => [k, rad(n)])) })
  return {
    t: pose({ 'left.arm.roll': 90, 'right.arm.roll': 90 }),
    squat: pose({ 'left.leg.pitch': 45, 'right.leg.pitch': 45, 'left.leg.knee': 80, 'right.leg.knee': 80, 'left.leg.ankle.pitch': 25, 'right.leg.ankle.pitch': 25 }),
    lunge: pose({ 'left.leg.pitch': 65, 'left.leg.knee': 85, 'right.leg.pitch': -20, 'right.leg.knee': 20, 'left.arm.roll': 20, 'right.arm.roll': 20 }),
    overhead: pose({ 'left.arm.pitch': 130, 'right.arm.pitch': 130 }),
    highKick: pose({ 'left.leg.pitch': 95, 'left.leg.knee': 10, 'left.arm.roll': 60, 'right.arm.roll': 60 }),
    twist: pose({ 'spine.yaw': 30, 'spine.pitch': 15, 'head.yaw': -35, 'left.arm.roll': 60, 'right.arm.roll': 60 }),
    crouchGuard: pose({ 'left.leg.pitch': 35, 'right.leg.pitch': 35, 'left.leg.knee': 55, 'right.leg.knee': 55, 'left.arm.roll': 20, 'right.arm.roll': 20,
      'left.arm.pitch': 20, 'right.arm.pitch': 20, 'left.arm.elbow': 100, 'right.arm.elbow': 100 }),
  }
}
export function buildHumanoid(profileId: string, actorId = 'seat1'): PhysicalHumanoid {
  if (!/^[a-z][a-z0-9_]{0,11}$/.test(actorId)) throw new RangeError('Invalid actor identity')
  const p = profileFor(profileId), sizeScale = p.height / 1.8, frames: PhysicalHumanoid['frames'] = {}, drives: PhysicalHumanoid['drives'] = []
  const points = new Map<string, Vec3>()
  for (const j of p.joints) points.set(j.id, add(j.parent ? points.get(j.parent)! : ZERO, v(j.offset)))
  const id = (part: string) => `${actorId}_${part}`, point = (name: string) => points.get(name)!
  const bodies: Body[] = [], joints: JointInput[] = [], byPart = new Map<string, Body>(), parts: PhysicalHumanoid['parts'] = {}
  // Original simulation defaults, SI: kg, m, N m, N m/rad, N m s/rad. Identical masses across forms;
  // only collision dimensions follow existing profiles. No manufacturer's mass, density or servo rating is implied.
  function box(part: string, position: Vec3, half: Vec3, massKg: number) {
    const b = validateScene({ bodies: [{ id: id(part), shape: { kind: 'box', half }, position, mass: massKg,
      restitution: 0, friction: .8, linearDamping: .02, angularDamping: .02 }] }).bodies[0]
    bodies.push(b); byPart.set(part, b); parts[part] = { bodyId: b.id, massKg, inertia: uniformInertia(b) }; return b
  }
  function skin(part: string, joint: string, massKg: number) {
    const s = p.skins.find(s => s.joint === joint && !s.axle && ['shell', 'trim', 'metal'].includes(s.finish))
    if (!s) throw new RangeError('Missing primitive skin dimensions')
    return box(part, add(point(joint), v(s.offset)), scale(v(s.size), .5), massKg)
  }
  function bind(names: string[], part: string, at: Vec3) { for (const name of names) frames[name] = { bodyId: id(part), point: sub(at, byPart.get(part)!.position) } }
  function link(part: string, parent: string, at: Vec3, axes: string[], basis: Quat, cone: Cone, effort: number, stiffness: number, damping: number, fraction = 1) {
    const jointId = `${actorId}_joint_${part}`
    joints.push({ id: jointId, parent: id(parent), child: id(part), anchorParent: sub(at, byPart.get(parent)!.position), anchorChild: sub(at, byPart.get(part)!.position),
      frameParent: basis, frameChild: basis, cone, motor: { target: IDENTITY, maxTorque: effort, stiffness, damping, integration: 'inertia-damped' } })
    drives.push({ id: jointId, axes, fraction })
  }
  const limits = (name: string) => p.joints.find(j => j.id === name)!.limits
  function yCone(pitch: string, roll?: string, twist?: string, side = 1, fraction = 1): Cone {
    const [lo, hi] = limits(pitch), [rlo, rhi] = roll ? limits(roll) : [-.001, .001], [tlo, thi] = twist ? limits(twist) : [-.001, .001]
    return { swingY: Math.max(.001, -lo * fraction), swingYMin: -Math.max(.001, hi * fraction),
      swingZ: Math.max(.001, (side > 0 ? rhi : -rlo) * fraction), swingZMin: -Math.max(.001, (side > 0 ? -rlo : rhi) * fraction),
      twistMin: tlo * fraction, twistMax: thi * fraction }
  }
  skin('pelvis', 'pelvis', 10); bind(['pelvis'], 'pelvis', point('pelvis'))
  const lowerAt = add(point('pelvis'), { x: 0, y: .035 * sizeScale, z: 0 }), upperAt = point('spine.yaw')
  skin('lumbar', 'spine.yaw', 3)
  skin('thorax', 'spine.roll', 12)
  const spine = ['spine.yaw', 'spine.pitch', 'spine.roll'], spineCone = yCone('spine.pitch', 'spine.roll', 'spine.yaw', 1, .5)
  link('lumbar', 'pelvis', lowerAt, spine, BASIS_Y, spineCone, 200, 1200, 50, .5)
  link('thorax', 'lumbar', upperAt, spine, BASIS_Y, spineCone, 200, 1200, 50, .5)
  bind(['spine.yaw'], 'lumbar', upperAt); bind(['spine.pitch', 'spine.roll'], 'thorax', upperAt)
  skin('head', 'head.pitch', 3.5); bind(['head.yaw', 'head.pitch'], 'head', point('head.yaw'))
  link('head', 'thorax', point('head.yaw'), ['head.yaw', 'head.pitch'], BASIS_Y, yCone('head.pitch', undefined, 'head.yaw'), 20, 120, 8)
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? -1 : 1, a = `${side}.arm`, l = `${side}.leg`
    skin(`${side}_upper_arm`, `${a}.yaw`, 2.5); skin(`${side}_forearm`, `${a}.elbow`, 1.5); skin(`${side}_hand`, `${a}.wrist.yaw`, .7)
    bind([`${a}.roll`, `${a}.pitch`, `${a}.yaw`], `${side}_upper_arm`, point(`${a}.roll`))
    bind([`${a}.elbow`], `${side}_forearm`, point(`${a}.elbow`))
    bind([`${a}.wrist.roll`, `${a}.wrist.pitch`, `${a}.wrist.yaw`], `${side}_hand`, point(`${a}.wrist.roll`))
    link(`${side}_upper_arm`, 'thorax', point(`${a}.roll`), [`${a}.roll`, `${a}.pitch`, `${a}.yaw`], BASIS_Y, yCone(`${a}.pitch`, `${a}.roll`, `${a}.yaw`, sign), 70, 300, 18)
    link(`${side}_forearm`, `${side}_upper_arm`, point(`${a}.elbow`), [`${a}.elbow`], IDENTITY,
      { swingY: .001, swingZ: .001, twistMin: 0, twistMax: limits(`${a}.elbow`)[1] }, 45, 220, 14)
    link(`${side}_hand`, `${side}_forearm`, point(`${a}.wrist.roll`), [`${a}.wrist.roll`, `${a}.wrist.pitch`, `${a}.wrist.yaw`], BASIS_Y,
      yCone(`${a}.wrist.pitch`, `${a}.wrist.yaw`, `${a}.wrist.roll`), 12, 60, 4)
    skin(`${side}_thigh`, `${l}.yaw`, 6); skin(`${side}_shin`, `${l}.knee`, 3.5); skin(`${side}_foot`, `${l}.ankle.roll`, 1.3)
    bind([`${l}.roll`, `${l}.pitch`, `${l}.yaw`], `${side}_thigh`, point(`${l}.roll`))
    bind([`${l}.knee`], `${side}_shin`, point(`${l}.knee`))
    bind([`${l}.ankle.pitch`, `${l}.ankle.roll`], `${side}_foot`, point(`${l}.ankle.pitch`))
    link(`${side}_thigh`, 'pelvis', point(`${l}.roll`), [`${l}.roll`, `${l}.pitch`, `${l}.yaw`], BASIS_Y, yCone(`${l}.pitch`, `${l}.roll`, `${l}.yaw`, sign), 120, 800, 40)
    link(`${side}_shin`, `${side}_thigh`, point(`${l}.knee`), [`${l}.knee`], BASIS_MINUS_X,
      { swingY: .001, swingZ: .001, twistMin: 0, twistMax: limits(`${l}.knee`)[1] }, 160, 1000, 45)
    link(`${side}_foot`, `${side}_shin`, point(`${l}.ankle.pitch`), [`${l}.ankle.pitch`, `${l}.ankle.roll`], BASIS_Y,
      yCone(`${l}.ankle.pitch`, `${l}.ankle.roll`), 90, 800, 30)
  }
  const model: PhysicalHumanoid = { version: MODEL_VERSION, profileId, actorId, root: id('pelvis'), feet: [id('left_foot'), id('right_foot')], parts, frames, drives,
    scene: validateScene({ bodies, joints, contact: { solverIterations: 16, allowedLinearError: .0002, predictionDistance: .001 } }) }
  // Authored clear-arm stance: 20 deg abduction avoids neutral hands overlapping Morrow's wider hips.
  // Positioning is initialisation only. No per-tick root correction or kinematic pelvis exists in the pilot.
  const targets = targetsFromAngles(model, { 'left.arm.roll': rad(20), 'right.arm.roll': rad(20) })
  const states = new Map(model.scene.bodies.map(b => [b.id, b]))
  for (const j of model.scene.joints) {
    j.motor.target = targets[j.id]
    const parent = states.get(j.parent)!, child = states.get(j.child)!
    child.rotation = quaternion(multiply(multiply(multiply(parent.rotation, j.frameParent), j.motor.target), conjugate(j.frameChild)))
    child.position = sub(localPoint(parent.position, parent.rotation, j.anchorParent), rotate(child.rotation, j.anchorChild))
  }
  const minSole = Math.min(...model.feet.flatMap(id => soleCorners(states.get(id)!).map(v => v.y)))
  const shift = .002 - minSole // m: original 2 mm initial release gap, not a resting-height target.
  for (const b of model.scene.bodies) b.position.y += shift
  model.scene = validateScene({ ...model.scene, bodies: [{ id: 'floor', fixed: true, shape: { kind: 'plane' }, position: ZERO, friction: .8, restitution: 0 }, ...model.scene.bodies] })
  return model
}
export function targetsFromAngles(model: PhysicalHumanoid, angles: Angles): Record<string, Quat> {
  const p = profileFor(model.profileId)
  for (const [id, n] of Object.entries(angles)) {
    if (!Number.isFinite(n) || !p.joints.some(j => j.id === id)) throw new RangeError('Invalid named angle')
    if (id === p.root && n !== 0) throw new RangeError('Actuation cannot rotate the root')
  }
  return Object.fromEntries(model.drives.map(d => {
    let rotation: Quat = { ...IDENTITY }
    for (const name of d.axes) {
      const j = p.joints.find(j => j.id === name)!, n = Math.max(j.limits[0], Math.min(j.limits[1], angles[name] ?? 0))
      rotation = multiply(rotation, fromRotationVector(scale(v(j.axis), n)))
    }
    if (d.fraction !== 1) rotation = fromRotationVector(scale(rotationVector(rotation), d.fraction))
    const j = model.scene.joints.find(j => j.id === d.id)!
    return [d.id, clampCone(multiply(multiply(conjugate(j.frameParent), rotation), j.frameChild), j.cone)]
  }))
}
export function framesFromBodies(model: PhysicalHumanoid, states: readonly BodyState[]): Record<string, WorldFrame> {
  const byId = new Map(states.map(s => [s.id, s]))
  return Object.fromEntries(Object.entries(model.frames).map(([id, binding]) => {
    const body = byId.get(binding.bodyId)
    if (!body) throw new Error(`Missing render body ${binding.bodyId}`)
    return [id, { position: localPoint(body.position, body.rotation, binding.point), rotation: { ...body.rotation } }]
  }))
}
export function soleCorners(b: Pick<Body, 'shape' | 'position' | 'rotation'>): Vec3[] {
  if (b.shape.kind !== 'box') throw new RangeError('Sole must be a box')
  const h = b.shape.half
  return [-1, 1].flatMap(x => [-1, 1].map(z => localPoint(b.position, b.rotation, { x: x * h.x, y: -h.y, z: z * h.z })))
}

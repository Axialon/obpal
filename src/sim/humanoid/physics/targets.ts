/** Pure joint target requests. Complete frames still pass through ActuationGate; no body or root writes. */
import { add, sub, scale, cross, capped, localPoint, rotate, multiply, conjugate, quaternion, fromRotationVector, ZERO,
  type Vec3, type Quat } from '../../physics/math'
import type { BodyState, Joint } from '../../physics/schema'
import type { WorldFrame } from './model'

export const TORQUE_TARGET_FRACTION = .8 // Original simulation default, not a native effort guarantee.
export type ChainRoot = 'foot' | 'pelvis'
export interface GravityLink { position: Vec3; massKg: number }
function finite(v: Vec3): Vec3 {
  if (![v.x, v.y, v.z].every(Number.isFinite)) throw new RangeError('Invalid target vector')
  return v
}
/** Parent anchor and orientation in world coordinates. The motor applies positive torque to the child. */
export function jointFrame(joint: Joint, parent: BodyState): WorldFrame {
  if (parent.id !== joint.parent) throw new RangeError('Joint parent mismatch')
  const rotation = quaternion(parent.rotation)
  return { position: localPoint(finite(parent.position), rotation, finite(joint.anchorParent)),
    rotation: quaternion(multiply(rotation, quaternion(joint.frameParent))) }
}
/** Exact child body world orientation -> joint motor target, including both authored joint frames. */
export function worldTarget(joint: Joint, parentRotation: Quat, childWorldRotation: Quat): Quat {
  const frame = multiply(quaternion(parentRotation), quaternion(joint.frameParent))
  return quaternion(multiply(multiply(conjugate(frame), quaternion(childWorldRotation)), quaternion(joint.frameChild)))
}
/** World torque -> parent joint-frame torque, the coordinates used by observed relative angular velocity. */
export function jointTorque(joint: Joint, parent: BodyState, worldTorque: Vec3): Vec3 {
  return rotate(conjugate(jointFrame(joint, parent).rotation), finite(worldTorque))
}
/** Local spring moment / stiffness, capped before inversion. Cone and slew limits belong to ActuationGate. */
export function torqueOffset(joint: Joint, torque: Vec3): Vec3 {
  const { stiffness, maxTorque } = joint.motor
  if (!Number.isFinite(stiffness) || stiffness <= 0 || !Number.isFinite(maxTorque) || maxTorque < 0)
    throw new RangeError('Invalid torque target gains')
  return finite(scale(capped(finite(torque), TORQUE_TARGET_FRACTION * maxTorque), 1 / stiffness))
}
/** Add local tau/K on the left: motor error is target * conjugate(measured), not the reverse product. */
export function targetOffset(joint: Joint, posture: Quat, torque: Vec3): Quat {
  return quaternion(multiply(fromRotationVector(torqueOffset(joint, torque)), quaternion(posture)))
}
/** Torque mode uses (tau + D*w_rel)/K on measured rotation; the compensated spring moment shares the 0.8 cap.
 * Slew, cone projection and the native coupled solve can reduce the realised torque.
 */
export function torqueTarget(joint: Joint, measured: Quat, relativeAngularVelocity: Vec3, torque: Vec3): Quat {
  if (!Number.isFinite(joint.motor.damping) || joint.motor.damping < 0) throw new RangeError('Invalid torque target damping')
  return targetOffset(joint, measured, finite(add(finite(torque), scale(finite(relativeAngularVelocity), joint.motor.damping))))
}
/** Jacobian transpose in world coordinates: foot-rooted stance is -(p-anchor) x F; pelvis-rooted swing flips it. */
export function jacobianTransposeTorque(anchor: Vec3, point: Vec3, force: Vec3, root: ChainRoot): Vec3 {
  if (root !== 'foot' && root !== 'pelvis') throw new RangeError('Invalid chain root')
  return finite(scale(cross(sub(finite(point), finite(anchor)), finite(force)), root === 'foot' ? -1 : 1))
}
/** Cancel distal gravity: sum (COM-anchor) x m*g for a foot root, with the opposite sign for a pelvis root.
 * Callers supply only the links distal to this joint in their chosen chain; no force is applied here.
 */
export function gravityCompensation(anchor: Vec3, links: readonly GravityLink[], gravity: Vec3, root: ChainRoot): Vec3 {
  finite(anchor); finite(gravity)
  if (root !== 'foot' && root !== 'pelvis') throw new RangeError('Invalid chain root')
  return links.reduce((sum, link) => {
    if (!Number.isFinite(link.massKg) || link.massKg < 0) throw new RangeError('Invalid distal mass')
    return finite(sub(sum, jacobianTransposeTorque(anchor, link.position, finite(scale(gravity, link.massKg)), root)))
  }, { ...ZERO })
}

/** Capture-point balance requests. Forces are virtual: only joint targets leave this controller. */
import { ZERO, add, sub, scale, norm, capped, cross, rotate, type Vec3 } from '../../physics/math'
import type { Joint } from '../../physics/schema'
import type { ActuationFrame } from './contract'
import type { PhysicalHumanoid } from './model'
import type { Observation } from './observation'
import { StanceController } from './stance'
import { captureState, polygonMargin, projectToPolygon, shrinkPolygon, supportHull, type CaptureState } from './stepping'
import { jointFrame, jointTorque, jacobianTransposeTorque, targetOffset, torqueTarget } from './targets'

export const BALANCE_CONTROL = Object.freeze({
  version: 'capture-balance-v1',
  // Original simulation defaults. These select strategies, not relaxed acceptance gates.
  quietSpeedMps: .05, quietCaptureRadiusM: .03, copInsetM: .01,
  captureGain: 1, // dimensionless
  maxFootAngularSpeedRadps: 1, maxHipMomentNm: 60, maxTrunkPitchRad: .35,
  torsoStiffness: 300, torsoDamping: 30, // N m/rad and N m s/rad, SIMBICON torso PD.
})

export interface BalanceDiagnostics {
  version: string
  phase: 'quiet' | 'ankle' | 'hip' | 'no-support' | 'outside-envelope'
  capture: CaptureState | null
  desiredCMP: Vec3 | null
  desiredCOP: Vec3 | null
  forceN: Vec3
  residualTrunkMomentNm: Vec3
  trunkMomentNm: Vec3
  /** Requested world moments, before target inversion, cone projection and target slew. */
  jointTorquesNm: Record<string, Vec3>
  ankleFeet: string[]
  loadShares: Record<string, number>
}

/** A toe-ward (-Z at yaw zero) CMP excess requests a forward (-X) trunk pitch. */
export function hipStrategyMoment(excess: Vec3, massKg: number, gravityMps2: number): Vec3 {
  if (![excess.x, excess.y, excess.z, massKg, gravityMps2].every(Number.isFinite) || massKg <= 0 || gravityMps2 <= 0)
    throw new RangeError('Invalid balance moment')
  const moment = { x: massKg * gravityMps2 * excess.z, y: 0, z: -massKg * gravityMps2 * excess.x }
  if (!Number.isFinite(norm(moment))) throw new RangeError('Balance moment overflow')
  return capped(moment, BALANCE_CONTROL.maxHipMomentNm)
}

export class BalanceController {
  private readonly model: PhysicalHumanoid
  private readonly stance: StanceController
  private readonly mass: number
  private readonly gravity: number
  private readonly chains: { foot: string; joints: Joint[] }[]
  constructor(model: PhysicalHumanoid, generation: number) {
    this.model = structuredClone(model)
    this.stance = new StanceController(model, generation)
    this.mass = model.scene.bodies.reduce((sum, b) => sum + (b.fixed ? 0 : b.mass), 0)
    this.gravity = -model.scene.gravity.y
    if (!Number.isFinite(this.gravity) || this.gravity <= 0) throw new RangeError('Balance requires downward gravity')
    this.chains = this.model.feet.map(foot => {
      const joints: Joint[] = []
      let child = foot
      while (child !== this.model.root) {
        const joint = this.model.scene.joints.find(j => j.child === child)
        if (!joint || joints.includes(joint)) throw new RangeError('Missing balance stance chain')
        joints.push(joint); child = joint.parent
      }
      return { foot, joints }
    })
  }

  /** Stateless fixed-tick observation -> complete schema-1 request. The pilot/world owns its ActuationGate. */
  step(o: Observation): { frame: ActuationFrame; diagnostics: BalanceDiagnostics } {
    // Keep the established stance validation and its exact quiet-stance output in one place.
    const standing = this.stance.step(o)
    const diagnostics: BalanceDiagnostics = { version: BALANCE_CONTROL.version, phase: 'no-support', capture: null,
      desiredCMP: null, desiredCOP: null, forceN: { ...ZERO }, residualTrunkMomentNm: { ...ZERO },
      trunkMomentNm: { ...ZERO }, jointTorquesNm: {}, ankleFeet: [], loadShares: {} }
    const result = { frame: standing.frame, diagnostics }
    if (standing.diagnostics.phase === 'outside-envelope') { diagnostics.phase = 'outside-envelope'; return result }
    if (standing.diagnostics.phase === 'no-support') return result
    const capture = captureState(o, this.gravity)
    diagnostics.capture = capture
    if (!capture) return result
    if ((polygonMargin(capture.polygon, o.com) ?? -Infinity) >= 0 && capture.speedMps < BALANCE_CONTROL.quietSpeedMps &&
      Math.hypot(capture.point.x - capture.centroid.x, capture.point.z - capture.centroid.z) < BALANCE_CONTROL.quietCaptureRadiusM) {
      diagnostics.phase = 'quiet'
      return result
    }

    const bodies = new Map(o.bodies.map(b => [b.id, b])), observedJoints = new Map(o.joints.map(j => [j.id, j]))
    for (const b of bodies.values()) if (![b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z].every(Number.isFinite))
      throw new RangeError('Invalid balance angular velocity')
    if (observedJoints.size !== o.joints.length || this.model.scene.joints.some(j => !observedJoints.has(j.id)))
      throw new RangeError('Missing balance joint')
    const cmp = add(capture.point, scale(sub(capture.point, capture.centroid), BALANCE_CONTROL.captureGain))
    const cop = projectToPolygon(shrinkPolygon(o.support.polygon, BALANCE_CONTROL.copInsetM), cmp)
    if (!cop) return result
    diagnostics.desiredCMP = cmp; diagnostics.desiredCOP = cop
    const force = { x: this.mass * capture.omega ** 2 * (o.com.x - cop.x), y: 0,
      z: this.mass * capture.omega ** 2 * (o.com.z - cop.z) }
    if (!Number.isFinite(norm(force))) throw new RangeError('Balance force overflow')
    diagnostics.forceN = force

    const trunk = bodies.get(this.model.parts.thorax.bodyId)!, root = bodies.get(this.model.root)!
    const up = rotate(trunk.rotation, { x: 0, y: 1, z: 0 }), forward = rotate(root.rotation, { x: 0, y: 0, z: -1 })
    const forwardLength = Math.hypot(forward.x, forward.z)
    const pitch = Math.atan2(forwardLength > 0 ? (up.x * forward.x + up.z * forward.z) / forwardLength : 0, up.y)
    const residual = Math.abs(pitch) < BALANCE_CONTROL.maxTrunkPitchRad ? hipStrategyMoment(sub(cmp, cop), this.mass, this.gravity) : { ...ZERO }
    // Axis-angle up correction is heading-independent. It requests no yaw torque.
    const axis = cross(up, { x: 0, y: 1, z: 0 }), sine = norm(axis)
    const tilt = sine > 1e-12 ? scale(axis, Math.atan2(sine, up.y) / sine) : { ...ZERO }
    const torso = add(residual, { x: BALANCE_CONTROL.torsoStiffness * tilt.x - BALANCE_CONTROL.torsoDamping * trunk.angularVelocity.x,
      y: 0, z: BALANCE_CONTROL.torsoStiffness * tilt.z - BALANCE_CONTROL.torsoDamping * trunk.angularVelocity.z })
    diagnostics.residualTrunkMomentNm = residual; diagnostics.trunkMomentNm = torso
    diagnostics.phase = norm(residual) > 0 ? 'hip' : 'ankle'
    const totalLoad = o.feet.reduce((sum, f) => sum + f.normalImpulseNs, 0)
    const targets = Object.fromEntries(this.model.scene.joints.map(j => [j.id, { ...j.motor.target }]))
    for (const chain of this.chains) {
      const foot = o.feet.find(f => f.id === chain.foot)!, share = foot.normalImpulseNs / totalLoad
      diagnostics.loadShares[foot.id] = share
      const ankleEnabled = share > 0 && supportHull(foot.contactPoints).length >= 3 && norm(bodies.get(foot.id)!.angularVelocity) <= BALANCE_CONTROL.maxFootAngularSpeedRadps
      if (ankleEnabled) diagnostics.ankleFeet.push(foot.id)
      else {
        // Request zero ankle moment in measured coordinates, rather than a nominal-posture spring moment.
        // Gate slew, caps and the coupled solve still determine the realised native moment.
        const ankle = chain.joints[0], measured = observedJoints.get(ankle.id)!
        targets[ankle.id] = torqueTarget(ankle, measured.rotation, measured.angularVelocity, ZERO)
        diagnostics.jointTorquesNm[ankle.id] = { ...ZERO }
      }
      if (share <= 0) continue
      for (const joint of chain.joints) {
        if (joint.child === foot.id && !ankleEnabled) continue
        const parent = bodies.get(joint.parent)!, measured = observedJoints.get(joint.id)!
        const virtual = jacobianTransposeTorque(jointFrame(joint, parent).position, o.com, scale(force, share), 'foot')
        // Positive hip motor torque goes to the thigh; the trunk receives the opposite reaction.
        const world = joint.parent === this.model.root ? sub(virtual, scale(torso, share)) : virtual
        diagnostics.jointTorquesNm[joint.id] = world
        const local = jointTorque(joint, parent, world)
        targets[joint.id] = joint.parent === this.model.root ? torqueTarget(joint, measured.rotation, measured.angularVelocity, local) :
          targetOffset(joint, joint.motor.target, local)
      }
    }
    return { frame: { ...standing.frame, targets }, diagnostics }
  }
}

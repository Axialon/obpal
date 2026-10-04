/** Capture-point balance requests. Forces are virtual: only joint targets leave this controller. */
import { ZERO, add, sub, scale, norm, capped, clampCone, angleBetween, cross, rotate, conjugate, multiply, fromRotationVector, rotationVector, type Vec3, type Quat } from '../../physics/math'
import { STEP, type Joint } from '../../physics/schema'
import type { ActuationFrame } from './contract'
import type { PhysicalHumanoid } from './model'
import type { Observation } from './observation'
import { StanceController } from './stance'
import { captureState, polygonMargin, projectToPolygon, supportHull, SinkSafeSupport, sinkSafeAnkleMoment, conformAnkleMoment, type CaptureState } from './stepping'
import { jointFrame, jointTorque, jacobianTransposeTorque, targetOffset, torqueTarget, worldTarget } from './targets'

export const BALANCE_CONTROL = Object.freeze({
  version: 'capture-balance-v1',
  // Original simulation defaults. These select strategies, not relaxed acceptance gates.
  quietSpeedMps: .05, quietCaptureRadiusM: .03, copInsetM: .01,
  captureGain: 1, // dimensionless
  maxFootAngularSpeedRadps: 1, maxHipMomentNm: 60, maxTrunkPitchRad: .35,
  torsoStiffness: 300, torsoDamping: 30, // N m/rad and N m s/rad, SIMBICON torso PD.
  supportGeometryDepartureM: .030, // m, simulation default: changed foot separation/stagger after a handoff.
  supportFlattenRateRadps: 1, supportFlattenConeErrorRad: .01, // Simulation defaults, rad/s and rad: infeasible retained ankle correction.
  supportDampingPerS: 3, // s^-1, simulation default: virtual COM damping in the retained support posture.
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
  ankleResidualNm: Record<string, Vec3>
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

/** Translation- and heading-independent departure from the authored two-foot arrangement, in metres. */
export function supportGeometryDeparture(model: PhysicalHumanoid, o: Observation): number {
  const heading = (rotation: Quat) => {
    const forward = rotate(rotation, { x: 0, y: 0, z: -1 })
    return fromRotationVector({ x: 0, y: Math.atan2(-forward.x, -forward.z), z: 0 })
  }
  const root = o.bodies.find(b => b.id === model.root)!, authoredRoot = model.scene.bodies.find(b => b.id === model.root)!
  const observed = rotate(conjugate(heading(root.rotation)), sub(o.bodies.find(b => b.id === model.feet[1])!.position,
    o.bodies.find(b => b.id === model.feet[0])!.position))
  const authored = rotate(conjugate(heading(authoredRoot.rotation)), sub(model.scene.bodies.find(b => b.id === model.feet[1])!.position,
    model.scene.bodies.find(b => b.id === model.feet[0])!.position))
  return Math.max(Math.abs(observed.x - authored.x), Math.abs(observed.z - authored.z))
}

export class BalanceController {
  private readonly model: PhysicalHumanoid
  private readonly stance: StanceController
  private readonly mass: number
  private readonly gravity: number
  private readonly sinkSupport: SinkSafeSupport
  private readonly chains: { foot: string; joints: Joint[] }[]
  private previousTick: number | null = null
  private supportPosture: Map<string, Quat> | null = null
  private flattenPosture: Map<string, Quat> | null = null
  private flattenNeeded = false
  private flattenTick: number | null = null
  private supportPoseContact: SinkSafeSupport | null = null
  private readonly bodyMasses: Map<string, number>
  constructor(model: PhysicalHumanoid, generation: number) {
    this.model = structuredClone(model)
    this.stance = new StanceController(model, generation)
    this.sinkSupport = new SinkSafeSupport(model.scene.bodies, model.feet)
    this.bodyMasses = new Map(model.scene.bodies.map(b => [b.id, b.mass]))
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

  /** Fixed-tick observation -> complete schema-1 request, with observation-only contact trim. */
  step(o: Observation): { frame: ActuationFrame; diagnostics: BalanceDiagnostics } {
    // Validate through the established controller before retaining any observation state.
    const result = this.captureStep(o)
    if (this.previousTick === null || o.stateTick > this.previousTick + 1 || o.stateTick < this.previousTick) {
      this.supportPosture = null
      this.flattenPosture = null; this.flattenNeeded = false; this.flattenTick = null
      this.supportPoseContact = null
      if (supportGeometryDeparture(this.model, o) > BALANCE_CONTROL.supportGeometryDepartureM && o.feet.every(f => f.normalImpulseNs > 0)) {
        const joints = new Map(o.joints.map(j => [j.id, j]))
        if (joints.size !== o.joints.length || joints.size !== this.model.scene.joints.length || this.model.scene.joints.some(j => !joints.has(j.id)))
          throw new RangeError('Missing balance joint')
        for (const joint of joints.values()) if (![joint.rotation.x, joint.rotation.y, joint.rotation.z, joint.rotation.w,
          joint.angularVelocity.x, joint.angularVelocity.y, joint.angularVelocity.z].every(Number.isFinite) ||
          Math.abs(Math.hypot(joint.rotation.x, joint.rotation.y, joint.rotation.z, joint.rotation.w) - 1) > 1e-4)
          throw new RangeError('Invalid balance joint state')
        this.supportPosture = new Map(o.joints.map(j => [j.id, { ...j.rotation }]))
        this.supportPoseContact = new SinkSafeSupport(this.model.scene.bodies, this.model.feet)
      }
    }
    this.previousTick = o.stateTick
    if (!this.supportPosture || result.diagnostics.phase === 'outside-envelope' || result.diagnostics.phase === 'no-support') return result
    return this.supportPostureStep(o, result)
  }

  /** Keep the measured leg arrangement after locomotion instead of straightening staggered supports. */
  private supportPostureStep(o: Observation, result: { frame: ActuationFrame; diagnostics: BalanceDiagnostics }) {
    const bodies = new Map(o.bodies.map(b => [b.id, b])), observed = new Map(o.joints.map(j => [j.id, j]))
    const total = o.feet.reduce((sum, foot) => sum + foot.normalImpulseNs, 0)
    if (!(total > 0)) return result
    const targets = { ...result.frame.targets }, active = result.diagnostics.phase !== 'quiet'
    // Preserve feasible measured supports; correct only a newly retained ankle pose already outside its cone tolerance.
    if (this.flattenPosture !== this.supportPosture) {
      this.flattenPosture = this.supportPosture
      this.flattenTick = null
      this.flattenNeeded = this.model.scene.joints.some(joint => this.model.feet.includes(joint.child) &&
        angleBetween(this.supportPosture!.get(joint.id)!, clampCone(this.supportPosture!.get(joint.id)!, joint.cone)) > BALANCE_CONTROL.supportFlattenConeErrorRad)
    }
    if (this.flattenNeeded && this.flattenTick !== o.stateTick) {
      this.flattenTick = o.stateTick
      for (const foot of this.supportPoseContact!.update(o)) {
        if (foot.contactBlend <= 0) continue
        const ankle = this.model.scene.joints.find(joint => joint.child === foot.id)!
        const parent = bodies.get(ankle.parent)!, body = bodies.get(foot.id)!
        const forward = rotate(body.rotation, { x: 0, y: 0, z: -1 })
        const heading = fromRotationVector({ x: 0, y: Math.atan2(-forward.x, -forward.z), z: 0 })
        const desired = worldTarget(ankle, parent.rotation, heading), prior = this.supportPosture!.get(ankle.id)!
        const change = rotationVector(multiply(desired, conjugate(prior)))
        this.supportPosture!.set(ankle.id, multiply(fromRotationVector(capped(change, BALANCE_CONTROL.supportFlattenRateRadps * STEP)), prior))
      }
    }
    const diagnostics = { ...result.diagnostics, jointTorquesNm: { ...result.diagnostics.jointTorquesNm },
      ankleResidualNm: { ...result.diagnostics.ankleResidualNm }, loadShares: { ...result.diagnostics.loadShares } }
    for (const chain of this.chains) {
      const foot = o.feet.find(f => f.id === chain.foot)!, share = foot.normalImpulseNs / total
      diagnostics.loadShares[foot.id] = share
      if (!(share > 0)) continue
      const cop = foot.centreOfPressure ?? foot.centre
      for (let depth = 0; depth < chain.joints.length; depth++) {
        const joint = chain.joints[depth], hip = joint.parent === this.model.root, parent = bodies.get(joint.parent)!
        if (depth === 0 && active && !result.diagnostics.ankleFeet.includes(foot.id)) continue
        const anchor = jointFrame(joint, parent).position
        let supportMoment = scale(cross(sub(cop, anchor), { x: 0, y: this.mass * this.gravity * share, z: 0 }), -1)
        for (const distal of chain.joints.slice(0, depth + 1)) {
          const body = bodies.get(distal.child)!
          supportMoment = sub(supportMoment, cross(sub(body.position, anchor), scale(this.model.scene.gravity, this.bodyMasses.get(body.id)!)))
        }
        supportMoment = add(supportMoment, jacobianTransposeTorque(anchor, o.com,
          scale(o.comVelocity, -this.mass * BALANCE_CONTROL.supportDampingPerS * share), 'foot'))
        diagnostics.jointTorquesNm[joint.id] = add(result.diagnostics.jointTorquesNm[joint.id] ?? ZERO, supportMoment)
        if (hip && active) {
          const virtual = result.diagnostics.jointTorquesNm[joint.id] ?? ZERO
          targets[joint.id] = targetOffset(joint, this.supportPosture!.get(joint.id)!, jointTorque(joint, parent, add(virtual, supportMoment)))
        } else {
          const correction = multiply(targets[joint.id], conjugate(joint.motor.target))
          targets[joint.id] = multiply(correction, this.supportPosture!.get(joint.id)!)
          targets[joint.id] = targetOffset(joint, targets[joint.id], jointTorque(joint, parent, supportMoment))
        }
      }
    }
    // Shape the complete pose-plus-support ankle request, including the retained posture spring.
    for (const foot of this.supportPoseContact!.update(o)) {
      const ankle = this.model.scene.joints.find(j => j.child === foot.id)!, measured = observed.get(ankle.id)!
      const parent = bodies.get(ankle.parent)!, frame = jointFrame(ankle, parent)
      const local = sub(scale(rotationVector(multiply(targets[ankle.id], conjugate(measured.rotation))), ankle.motor.stiffness),
        scale(measured.angularVelocity, ankle.motor.damping))
      const conform = conformAnkleMoment(foot, frame.position, rotate(frame.rotation, local))
      const bounded = foot.contactBlend === 0 ? { moment: { ...ZERO }, residual: { ...ZERO } } :
        sinkSafeAnkleMoment(foot, frame.position, { x: 0, y: foot.normalForceN, z: 0 }, conform)
      diagnostics.jointTorquesNm[ankle.id] = bounded.moment
      diagnostics.ankleResidualNm[foot.id] = bounded.residual
      targets[ankle.id] = torqueTarget(ankle, measured.rotation, measured.angularVelocity, jointTorque(ankle, parent, bounded.moment))
    }
    return { frame: { ...result.frame, targets }, diagnostics }
  }

  private captureStep(o: Observation): { frame: ActuationFrame; diagnostics: BalanceDiagnostics } {
    // Keep the established stance validation and its exact quiet-stance output in one place.
    const standing = this.stance.step(o)
    const diagnostics: BalanceDiagnostics = { version: BALANCE_CONTROL.version, phase: 'no-support', capture: null,
      desiredCMP: null, desiredCOP: null, forceN: { ...ZERO }, residualTrunkMomentNm: { ...ZERO },
      trunkMomentNm: { ...ZERO }, jointTorquesNm: {}, ankleResidualNm: {}, ankleFeet: [], loadShares: {} }
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
    const support = this.sinkSupport.update(o)
    const cmp = add(capture.point, scale(sub(capture.point, capture.centroid), BALANCE_CONTROL.captureGain))
    const cop = projectToPolygon(supportHull(support.flatMap(f => f.points)), cmp)
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
      const safeFoot = support.find(f => f.id === foot.id)
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
        let world = joint.parent === this.model.root ? sub(virtual, scale(torso, share)) : virtual
        if (joint.child === foot.id && safeFoot) {
          const bounded = sinkSafeAnkleMoment(safeFoot, jointFrame(joint, parent).position,
            { ...scale(force, share), y: safeFoot.normalForceN }, world)
          world = bounded.moment
          diagnostics.ankleResidualNm[foot.id] = bounded.residual
        }
        diagnostics.jointTorquesNm[joint.id] = world
        const local = jointTorque(joint, parent, world)
        targets[joint.id] = joint.parent === this.model.root ? torqueTarget(joint, measured.rotation, measured.angularVelocity, local) :
          targetOffset(joint, joint.motor.target, local)
      }
    }
    return { frame: { ...standing.frame, targets }, diagnostics }
  }
}

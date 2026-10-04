/** Fixed-tick SIMBICON requests. All motion is realised by joint targets through the actor's ActuationGate. */
import { STEP, type Joint, type BodyState, type ContactSample } from '../../physics/schema'
import { ZERO, add, sub, scale, dot, cross, norm, capped, clamp, clampCone, angleBetween, rotate, conjugate, multiply, fromRotationVector, rotationVector,
  type Vec3, type Quat } from '../../physics/math'
import { targetsFromAngles, type PhysicalHumanoid } from './model'
import type { Observation } from './observation'
import { MAX_TARGET_RATE, type ActuationFrame } from './contract'
import type { Behaviour, BehaviourMode } from './supervisor'
import { mapIntent, type Intent } from './intent'
import { coupledServo } from '../../physics/coupled-servo'
import { withConstraintResponseMemo } from '../../physics/constraint-response'
import { BalanceController } from './balance'
import { captureState, landingTarget, projectToPolygon, alipLandingCentre, supportHull, chooseSwingFoot, polygonMargin, SinkSafeSupport, sinkSafeAnkleMoment, conformAnkleMoment, type SinkSupportFoot, STEP_TIME_S, STEP_MIN_WIDTH_M } from './stepping'
import { jointFrame, jointTorque, worldTarget, targetOffset, torqueTarget, jacobianTransposeTorque } from './targets'

/** Shape the complete ankle request, including posture impedance, before the coupled reaction prediction. */
function conformContactTargets(model: PhysicalHumanoid, o: Observation, targets: Record<string, Quat>, support: SinkSupportFoot[]) {
  for (const foot of support) {
    const ankle = model.scene.joints.find(j => j.child === foot.id)!, measured = o.joints.find(j => j.id === ankle.id)!
    const parent = o.bodies.find(b => b.id === ankle.parent)!, frame = jointFrame(ankle, parent)
    const local = sub(scale(rotationVector(multiply(targets[ankle.id], conjugate(measured.rotation))), ankle.motor.stiffness),
      scale(measured.angularVelocity, ankle.motor.damping))
    const desired = rotate(frame.rotation, local)
    const conform = conformAnkleMoment(foot, frame.position, desired)
    const moment = foot.contactBlend === 0 ? ZERO : sinkSafeAnkleMoment(foot, frame.position,
      { x: 0, y: foot.normalForceN, z: 0 }, conform).moment
    targets[ankle.id] = torqueTarget(ankle, measured.rotation, measured.angularVelocity, jointTorque(ankle, parent, moment))
  }
}

export const GAIT_CONTROL = Object.freeze({
  liftSeconds: .27, strikeSeconds: .36, liftHipRad: .40, liftKneeRad: 1.10, liftAnkleRad: .20,
  liftStanceKneeRad: .05, strikeKneeRad: .05, strikeStanceKneeRad: .10,
  displacementGain: .5, velocityGain: .2, // SIMBICON: rad/m and rad s/m.
  torsoStiffness: 300, torsoDamping: 30, // SIMBICON: N m/rad and N m s/rad.
  lateralHipRad: .05, // simulation default, rad abduction.
  velocityForceGain: 60, // simulation default, N s/m.
  lateralPositionGain: 30, lateralVelocityGain: 11, // simulation defaults, s^-2 and s^-1.
  startShiftFraction: .4, // simulation default, dimensionless.
  startToleranceM: .005, startSeconds: .80, // simulation defaults, m and s minimum transfer time.
  maxTwistErrorRad: .3, stopSpeedMps: .1, // simulation defaults, rad and m/s.
  maxHeadingLeadRad: .05, // simulation default, rad: a turning foot plan stays near measured pelvis yaw.
  maxFootTurnRadps: 1, // simulation default, rad/s: GBWC ankle-strategy eligibility.
  captureHorizonSeconds: .60, // simulation default, s: landing-plan freeze reference horizon.
  velocityAccelerationMps2: .1, // simulation default, m/s^2 command ramp.
  velocityDecelerationMps2: .5, // simulation default, m/s^2 on release.
  swingClearanceM: .035, // simulation default, m above the contact plane.
  minUp: .8, minHeightFraction: .65, // simulation defaults, dimensionless entry envelope.
})
export type GaitSide = 'left' | 'right'
export type GaitPhase = 'idle' | 'start' | 'lift' | 'strike'
export interface GaitState { phase: GaitPhase; swing: GaitSide; ticks: number; loadedTicks: number; steps: number; cleared?: boolean; contactTicks?: number }
export interface GaitVelocity { velocity: Vec3; yawRateRadps: number }
export interface GaitDiagnostics {
  arenaBlocked?: boolean
  phase: GaitPhase; swing: GaitSide; phaseSeconds: number; steps: number; headingRad: number
  recoveryExit: 'touchdown' | 'timeout' | null
  desiredVelocity: Vec3; swingHipRad: { sagittal: number; lateral: number }
  /** Requested torso/stance moments and estimated swing reaction; not native applied-torque measurements. */
  torsoTorqueNm: Vec3; stanceHipTorqueNm: Vec3; swingHipTorqueNm: Vec3; stanceForceN: Vec3
}
const other = (side: GaitSide): GaitSide => side === 'left' ? 'right' : 'left'
const horizontalSpeed = (v: Vec3) => Math.hypot(v.x, v.z)
const finite = (v: Vec3) => v && [v.x, v.y, v.z].every(Number.isFinite)
const moving = (command: GaitVelocity) => horizontalSpeed(command.velocity) > 0 || command.yawRateRadps !== 0
const yawRotation = (yaw: number) => fromRotationVector({ x: 0, y: yaw, z: 0 })
/** Three non-collinear manifold points give a two-dimensional foot hull; duplicates do not create support. */
export function gaitFootSupported(points: readonly Vec3[]): boolean {
  if (!points.every(finite)) throw new RangeError('Invalid gait foot manifold')
  if (points.length < 3) return false
  for (let i = 1; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
    // 1e-10 m^2 is a numerical degeneracy tolerance, not a changed support margin.
    if (Math.abs(cross(sub(points[i], points[0]), sub(points[j], points[0])).y) > 1e-10) return true
  return false
}
/** State exits use integer ticks, and strike requires two consecutive loaded observations. */
export function advanceGaitState(state: GaitState, loaded: boolean, stop: boolean, acceptTouchdown = true, liftSeconds: number = GAIT_CONTROL.liftSeconds, strikeSeconds: number = GAIT_CONTROL.strikeSeconds): GaitState {
  const cleared = state.cleared || !loaded
  const next = { ...state, ticks: state.ticks + 1, cleared, loadedTicks: loaded && cleared && acceptTouchdown ? state.loadedTicks + 1 : 0 }
  if (state.phase === 'lift' && next.ticks >= Math.round(liftSeconds / STEP))
    return { ...next, phase: 'strike', ticks: 0, loadedTicks: 0 }
  if (state.phase === 'strike' && (next.loadedTicks >= 2 || next.ticks >= Math.round(strikeSeconds / STEP)))
    return { ...next, phase: stop ? 'idle' : 'lift', swing: other(state.swing), ticks: 0, loadedTicks: 0, cleared: false, steps: state.steps + 1 }
  return next
}
/** A released swing finishes on measured contact; an airborne timer cannot hand off to standing. */
export function advanceStoppingGait(state: GaitState, foot: Observation['feet'][number], body: BodyState, liftSeconds: number): GaitState {
  const loaded = foot.normalImpulseNs > 0, cleared = state.cleared || !loaded
  const flat = gaitFootSupported(foot.contactPoints) && Math.acos(clamp(rotate(body.rotation, { x: 0, y: 1, z: 0 }).y, -1, 1)) <= .5 * Math.PI / 180
  const next = { ...state, ticks: state.ticks + 1, cleared,
    contactTicks: loaded && cleared ? (state.contactTicks ?? 0) + 1 : 0,
    loadedTicks: loaded && cleared && flat ? state.loadedTicks + 1 : 0 }
  // Simulation defaults: 0.5 degrees flatness and 0.040 s maximum loaded qualification time.
  if (cleared && (next.loadedTicks >= 2 || next.contactTicks * STEP >= .04))
    return { ...next, phase: 'idle', swing: other(state.swing), ticks: 0, loadedTicks: 0, contactTicks: 0, cleared: false, steps: state.steps + 1 }
  if (state.phase === 'lift' && next.ticks >= Math.round(liftSeconds / STEP)) return { ...next, phase: 'strike', ticks: 0, loadedTicks: 0 }
  return next
}
/** Flexion-positive sagittal angle and signed rightward lateral angle in the desired heading frame. */
export function swingHipFeedback(phase: 'lift' | 'strike', displacement: Vec3, velocity: Vec3, desired: Vec3, side: GaitSide) {
  return { sagittal: (phase === 'lift' ? GAIT_CONTROL.liftHipRad : 0) - GAIT_CONTROL.displacementGain * displacement.z
    - GAIT_CONTROL.velocityGain * (velocity.z - desired.z),
  lateral: (side === 'left' ? -1 : 1) * GAIT_CONTROL.lateralHipRad + GAIT_CONTROL.displacementGain * displacement.x
    + GAIT_CONTROL.velocityGain * (velocity.x - desired.x) }
}
/** Predict the existing gate's target for the reaction estimate only. The external gate remains authoritative. */
export function gaitTargetEstimate(joint: Joint, previous: Quat, requested: Quat): Quat {
  const delta = rotationVector(multiply(clampCone(requested, joint.cone), conjugate(previous)))
  let fraction = Math.min(1, MAX_TARGET_RATE * STEP / Math.max(norm(delta), 1e-30))
  for (let attempt = 0; attempt < 16; attempt++, fraction /= 2) {
    const candidate = clampCone(multiply(fromRotationVector(scale(delta, fraction)), previous), joint.cone)
    if (angleBetween(previous, candidate) <= MAX_TARGET_RATE * STEP + 1e-10) return candidate
  }
  return previous
}

/** Supply the complete GATE-PREVIEWED frame, including every other joint's candidate target.
 * For native floorContacts this uses actual samples. Otherwise it reconstructs equivalent loaded-foot
 * rows for this horizontal plane only. Points and loaded status are measured; per-point impulse is
 * reconstructed, never reported as measurement. constraintResponse only uses its positive-load flag.
 *
 * Foot-only prediction omits non-foot floor support. Do not use it after falling or on other terrain.
 * Body quaternion normalisation and nearly rank-deficient contact rows can cause small discrepancies.
 * Current contacts cannot predict future impacts; no claim about the next integrated pose is made.
 */
export function predictGaitCoupled(model: PhysicalHumanoid, o: Observation, accepted: ReadonlyMap<string, Quat>) {
  checkGaitPrediction(model, o, accepted)
  return gaitPrediction(model, accepted, gaitPredictionInput(model, o))
}
function checkGaitPrediction(model: PhysicalHumanoid, o: Observation, accepted: ReadonlyMap<string, Quat>) {
  if (o.actorId !== model.actorId || o.profileId !== model.profileId || o.modelVersion !== model.version ||
    accepted.size !== model.scene.joints.length || model.scene.joints.some(j => !accepted.has(j.id)))
    throw new RangeError('Coupled gait prediction identity or target mismatch')
}
function gaitPredictionInput(model: PhysicalHumanoid, o: Observation) {
  const floor = model.scene.bodies.find(b => b.id === 'floor')
  if (!floor?.fixed || floor.shape.kind !== 'plane' || rotate(floor.rotation, { x: 0, y: 1, z: 0 }).y < 1 - 1e-10)
    throw new RangeError('Foot-row prediction requires the declared horizontal floor')
  const contacts: ContactSample[] = o.floorContacts ? o.floorContacts : o.feet.flatMap(foot => {
    if (!model.feet.includes(foot.id) || !Number.isFinite(foot.normalImpulseNs) || foot.normalImpulseNs < 0)
      throw new RangeError('Invalid predicted foot load')
    if (foot.normalImpulseNs === 0) return []
    if (!foot.contactPoints.length) throw new RangeError('Loaded predicted foot has no manifold')
    return foot.contactPoints.map(point => ({ a: floor.id, b: foot.id,
      pointA: { x: point.x, y: floor.position.y, z: point.z }, pointB: { ...point },
      normalOnB: { x: 0, y: 1, z: 0 }, distance: 0,
      impulse: foot.normalImpulseNs / foot.contactPoints.length }))
  })
  const fixed: BodyState[] = model.scene.bodies.filter(b => b.fixed).map(b => ({ id: b.id,
    position: { ...b.position }, rotation: { ...b.rotation }, velocity: { ...b.velocity },
    angularVelocity: { ...b.angularVelocity }, sleeping: true }))
  return { states: [...fixed, ...o.bodies], contacts,
    contactSource: o.floorContacts ? 'native-floor' as const : 'observed-foot-rows' as const }
}
function gaitPrediction(model: PhysicalHumanoid, accepted: ReadonlyMap<string, Quat>, input: ReturnType<typeof gaitPredictionInput>) {
  return { ...coupledServo(model.scene, input.states, accepted, input.contacts, STEP), contactSource: input.contactSource }
}
/** Reuse only the target-independent constraint response during one synchronous reaction correction.
 * Contact order and fixed-first state order are unchanged; each requested target map is solved afresh.
 */
export function withGaitPredictions<T>(model: PhysicalHumanoid, o: Observation,
  run: (predict: (accepted: ReadonlyMap<string, Quat>) => ReturnType<typeof predictGaitCoupled>) => T): T {
  const input = gaitPredictionInput(model, o)
  return withConstraintResponseMemo(model.scene, input.states, input.contacts, () => run(accepted => {
    checkGaitPrediction(model, o, accepted)
    return gaitPrediction(model, accepted, input)
  }))
}

export interface GaitOptions { mode?: 'walk' | 'in-place' }
/** Geometry-derived walking simulation defaults. The calibrated leg-length interval is 0.77–0.84 m.
 * Shorter legs use a longer load cycle and a narrower lateral reference; no profile name is inspected.
 * The endpoint velocity factor compensates the measured short-leg sagittal tracking loss.
 */
export function walkingGeometry(model: PhysicalHumanoid) {
  const joint = (part: 'thigh' | 'shin' | 'foot') => model.scene.joints.find(j => j.child === model.parts[`left_${part}`].bodyId)!
  const hip = joint('thigh'), knee = joint('shin'), ankle = joint('foot')
  const legLengthM = norm(sub(knee.anchorParent, hip.anchorChild)) + norm(sub(ankle.anchorParent, knee.anchorChild))
  const compact = clamp((.84 - legLengthM) / (.84 - .77), 0, 1), mix = (long: number, short: number) => long * (1 - compact) + short * compact
  return { legLengthM, liftSeconds: mix(.27, .30), strikeSeconds: mix(.36, .40),
    lateralReferenceM: mix(.20, .15), terminalVelocityFactor: mix(1, 1.30) }
}
export const TURN_CONTROL = Object.freeze({
  liftSeconds: .2777240484976537, strikeSeconds: .39321100291349714, // simulation defaults, s.
  swingClearanceM: .0323046330044233, captureHorizonSeconds: .5077943432166341, // simulation defaults, m and s.
  lateralReferenceM: .15134754691180272, periodicWidthM: .19112127827846948, // simulation defaults, m.
  momentumRetention: .05206005451921607, // simulation default, dimensionless ALIP retention.
  velocityForceGain: 70.38883424635598, // simulation default, N s/m.
})
/** Blend the compact-leg turning defaults without changing straight commands or the long-leg endpoint.
 * Periodic width sets ALIP momentum; the physical landing minimum remains STEP_MIN_WIDTH_M.
 */
export function walkingControl(geometry: ReturnType<typeof walkingGeometry>, yawRateRadps: number) {
  let liftSeconds = geometry.liftSeconds, strikeSeconds = geometry.strikeSeconds, lateralReferenceM = geometry.lateralReferenceM
  let captureHorizonSeconds: number = GAIT_CONTROL.captureHorizonSeconds, swingClearanceM: number = GAIT_CONTROL.swingClearanceM
  let velocityForceGain: number = GAIT_CONTROL.velocityForceGain, periodicWidthM = STEP_MIN_WIDTH_M, momentumRetention = 0
  const compact = clamp((.84 - geometry.legLengthM) / (.84 - .77), 0, 1)
  const yaw = Math.min(1, Math.abs(yawRateRadps)) // simulation default: full turn blend at 1 rad/s.
  if (compact > 0 && yaw > 0) {
    const mix = (a: number, b: number) => yaw === 1 ? b : a * (1 - yaw) + b * yaw
    const geom = (a: number, b: number) => a * (1 - compact) + b * compact
    liftSeconds = mix(liftSeconds, geom(.27, TURN_CONTROL.liftSeconds))
    strikeSeconds = mix(strikeSeconds, geom(.36, TURN_CONTROL.strikeSeconds))
    lateralReferenceM = mix(lateralReferenceM, geom(.20, TURN_CONTROL.lateralReferenceM))
    captureHorizonSeconds = mix(captureHorizonSeconds, geom(GAIT_CONTROL.captureHorizonSeconds, TURN_CONTROL.captureHorizonSeconds))
    swingClearanceM = mix(swingClearanceM, geom(GAIT_CONTROL.swingClearanceM, TURN_CONTROL.swingClearanceM))
    velocityForceGain = mix(velocityForceGain, geom(GAIT_CONTROL.velocityForceGain, TURN_CONTROL.velocityForceGain))
    periodicWidthM = mix(periodicWidthM, geom(STEP_MIN_WIDTH_M, TURN_CONTROL.periodicWidthM))
    momentumRetention = yaw * compact * TURN_CONTROL.momentumRetention
  }
  return { liftSeconds, strikeSeconds, lateralReferenceM, captureHorizonSeconds, swingClearanceM, velocityForceGain, periodicWidthM, momentumRetention }
}
/** Simulation default, rad: transfer lean when midline hip demand exceeds its usable effort cap. */
export const IN_PLACE_SPINE_LEAN_RAD = .12
export const IN_PLACE_CONTROL = Object.freeze({
  preparationSeconds: 2, transferSeconds: 4, dwellSeconds: 1, swingSeconds: 1, // simulation defaults, s.
  stopSeconds: 2, // simulation default, s, recentering before Balance handoff.
  crouchM: .015, clearanceM: .025, // simulation defaults, m.
  turnStepRad: .1, // simulation default, rad between the new foot and the stance foot.
  morrowClearanceM: .039, morrowTurnClearanceM: .040, morrowNarrowM: .010, // simulation defaults, m, measured on the pilot.
  morrowLoadShareSeconds: .025, // simulation default, s, filtering transfer load shares for requested gravity compensation only.
})
export class GaitController implements Behaviour {
  readonly mode = 'walk' as const
  private readonly model: PhysicalHumanoid
  private readonly sinkSupport: SinkSafeSupport
  private readonly balance: BalanceController
  private readonly geometry: ReturnType<typeof walkingGeometry>
  private readonly initialHeight: number
  private state: GaitState = { phase: 'idle', swing: 'left', ticks: 0, loadedTicks: 0, steps: 0 }
  private heading: number | null = null
  private previousTick: number | null = null
  private startCentre: Vec3 = { ...ZERO }
  private startAxis: Vec3 = { x: 1, y: 0, z: 0 }
  private recovery: Vec3 | null = null
  private recoverySeconds = GAIT_CONTROL.liftSeconds + GAIT_CONTROL.strikeSeconds
  private stopBalance: BalanceController | null = null
  private stopIK: MeasuredSupportStop | null = null
  private swingOrigin: Vec3 | null = null
  private landing: Vec3 | null = null
  private velocityCommand: Vec3 = { ...ZERO }
  private fallen = false
  private arenaBlocked = false
  private inPlace: InPlaceController | null = null
  private previousInPlaceYawRate: number | null = null
  private pendingInPlaceTurn = false
  private turnBalanceTick: number | null = null
  private estimatedTargets = new Map<string, Quat>()
  private report: GaitDiagnostics = { phase: 'idle', swing: 'left', phaseSeconds: 0, steps: 0, headingRad: 0, recoveryExit: null,
    desiredVelocity: { ...ZERO }, swingHipRad: { sagittal: 0, lateral: 0 }, torsoTorqueNm: { ...ZERO },
    stanceHipTorqueNm: { ...ZERO }, swingHipTorqueNm: { ...ZERO }, stanceForceN: { ...ZERO } }
  constructor(model: PhysicalHumanoid, private readonly generation: number, private readonly options: GaitOptions = {}) {
    this.model = structuredClone(model); this.balance = new BalanceController(model, generation)
    this.geometry = walkingGeometry(model)
    this.sinkSupport = new SinkSafeSupport(model.scene.bodies, model.feet)
    this.initialHeight = model.scene.bodies.find(b => b.id === model.root)!.position.y
  }
  diagnostics(): GaitDiagnostics { return structuredClone(this.report) }
  gaitDiagnostics(): GaitDiagnostics { return { ...this.diagnostics(), arenaBlocked: this.arenaBlocked } }
  /** Leave room for deceleration and the final touchdown before the intent soft wall. */
  private arenaCommand(o: Observation, intent: Intent): GaitVelocity {
    const command = mapIntent(intent, this.mappingHeading(o), o.com)
    const outward = command.velocity.x * o.com.x > 0 || command.velocity.z * o.com.z > 0
    // Simulation default, m: a 0.6 m stopping buffer inside the 3.3 m soft wall.
    if (outward && (Math.abs(o.com.x) >= 2.7 || Math.abs(o.com.z) >= 2.7)) this.arenaBlocked = true
    if (!outward) this.arenaBlocked = false
    return this.arenaBlocked ? { velocity: { ...ZERO }, yawRateRadps: 0 } : command
  }
  canEnter(o: Observation, intent: Intent): boolean {
    const root = o.bodies.find(b => b.id === this.model.root)
    return !!root && o.schema_version === 1 && o.modelVersion === this.model.version && o.profileId === this.model.profileId &&
      o.actorId === this.model.actorId && o.generation === this.generation &&
      rotate(root.rotation, { x: 0, y: 1, z: 0 }).y >= GAIT_CONTROL.minUp && root.position.y >= this.initialHeight * GAIT_CONTROL.minHeightFraction &&
      moving(this.arenaCommand(o, intent))
  }
  done(o: Observation, intent: Intent): boolean {
    if (this.report.recoveryExit !== null) return true
    return this.state.phase === 'idle' && !this.stopIK && !moving(this.arenaCommand(o, intent)) &&
      horizontalSpeed(o.comVelocity) < GAIT_CONTROL.stopSpeedMps
  }
  step(o: Observation, intent: Intent): ActuationFrame {
    return this.stepVelocity(o, this.arenaCommand(o, intent))
  }
  /** Native unbounded-track command. Phone callers use step(), which applies the arena soft wall. */
  stepVelocity(o: Observation, command: GaitVelocity): ActuationFrame {
    if (!finite(command.velocity) || command.velocity.y !== 0 || !Number.isFinite(command.yawRateRadps)) throw new RangeError('Invalid gait velocity')
    if (!Array.isArray(o.feet) || o.feet.length !== this.model.feet.length || new Set(o.feet.map(f => f.id)).size !== this.model.feet.length ||
      o.feet.some(f => !this.model.feet.includes(f.id) || !Number.isFinite(f.normalImpulseNs) || f.normalImpulseNs < 0 || !finite(f.centre) ||
        !Array.isArray(f.contactPoints) || !f.contactPoints.every(finite) || (f.centreOfPressure !== null && !finite(f.centreOfPressure)) ||
        (f.normalImpulseNs > 0 && (!finite(f.centreOfPressure!) || !f.contactPoints.length)))) throw new RangeError('Invalid gait foot support')
    if (!o.support || !Array.isArray(o.support.points) || !o.support.points.every(finite) ||
      !Array.isArray(o.support.polygon) || !o.support.polygon.every(finite)) throw new RangeError('Invalid gait support points')
    if (o.floorContacts !== undefined && (!Array.isArray(o.floorContacts) || o.floorContacts.some(c =>
      !finite(c.pointA) || !finite(c.pointB) || !finite(c.normalOnB) || !Number.isFinite(c.distance) ||
      !Number.isFinite(c.impulse) || c.impulse < 0))) throw new RangeError('Invalid gait floor contact')
    const balanced = this.balance.step(o), nominal = balanced.frame
    const support = this.sinkSupport.update(o)
    if (this.previousTick !== null && o.stateTick <= this.previousTick) throw new RangeError('Gait observation tick must increase')
    const bodies = new Map(o.bodies.map(b => [b.id, b])), joints = new Map(o.joints.map(j => [j.id, j]))
    for (const b of bodies.values()) if (!finite(b.angularVelocity) || !finite(b.velocity)) throw new RangeError('Invalid gait body velocity')
    if (joints.size !== o.joints.length || joints.size !== this.model.scene.joints.length || this.model.scene.joints.some(j => !joints.has(j.id))) throw new RangeError('Missing or duplicate gait joint')
    for (const j of joints.values()) if (!finite(j.angularVelocity) || !finite(j.rotation) || !Number.isFinite(j.rotation.w) ||
      Math.abs(Math.hypot(j.rotation.x, j.rotation.y, j.rotation.z, j.rotation.w) - 1) > 1e-4) throw new RangeError('Invalid gait joint state')
    if (this.previousTick !== null && o.stateTick !== this.previousTick + 1) {
      this.state = { ...this.state, phase: this.recovery ? 'lift' : 'idle', ticks: 0, loadedTicks: 0, cleared: false }
      this.heading = null; this.estimatedTargets.clear(); this.swingOrigin = null; this.landing = null
      this.velocityCommand = { ...ZERO }; this.fallen = false; this.inPlace = null; this.stopBalance = null; this.stopIK = null
      this.clearInPlaceTransition()
    }
    this.previousTick = o.stateTick
    const requested = moving(command)
    if (requested) this.stopIK = null
    if (this.recovery) command = { velocity: { ...ZERO }, yawRateRadps: 0 }
    else if (this.options.mode === 'in-place') command = { velocity: { ...ZERO }, yawRateRadps: command.yawRateRadps }
    const acceleration = requested ? GAIT_CONTROL.velocityAccelerationMps2 : GAIT_CONTROL.velocityDecelerationMps2
    const velocityChange = capped(sub(command.velocity, this.velocityCommand), acceleration * STEP)
    this.velocityCommand = add(this.velocityCommand, velocityChange)
    command = { ...command, velocity: this.velocityCommand }
    const control = walkingControl(this.geometry, command.yawRateRadps)
    this.heading ??= this.rootHeading(o)
    if (this.options.mode !== 'in-place') this.heading += command.yawRateRadps * STEP
    if (this.options.mode !== 'in-place' && command.yawRateRadps !== 0) {
      const error = Math.atan2(Math.sin(this.heading - this.rootHeading(o)), Math.cos(this.heading - this.rootHeading(o)))
      this.heading += clamp(error, -GAIT_CONTROL.maxHeadingLeadRad, GAIT_CONTROL.maxHeadingLeadRad) - error
    }
    const heading = yawRotation(this.heading), inverse = conjugate(heading), root = bodies.get(this.model.root)!
    if (this.state.phase === 'idle' && requested) {
      const [left, right] = this.model.feet.map(id => o.feet.find(f => f.id === id)!)
      // Simulation default: within 5% load imbalance, a turn starts with the outer foot.
      const outerFirst = Math.abs(command.yawRateRadps) > 1e-8 && Math.abs(left.normalImpulseNs - right.normalImpulseNs) < .05 * (left.normalImpulseNs + right.normalImpulseNs)
      const swing = outerFirst ? command.yawRateRadps > 0 ? 'right' : 'left' : left.normalImpulseNs <= right.normalImpulseNs ? 'left' : 'right'
      this.state = { ...this.state, phase: 'start', swing, ticks: 0, loadedTicks: 0, cleared: false }
      this.startCentre = { ...o.com }; this.startAxis = rotate(heading, { x: 1, y: 0, z: 0 })
      this.report.recoveryExit = null
    }
    this.report = { ...this.report, phase: this.state.phase, swing: this.state.swing, phaseSeconds: this.state.ticks * STEP,
      steps: this.state.steps, headingRad: this.heading, desiredVelocity: { ...command.velocity }, swingHipRad: { sagittal: 0, lateral: 0 },
      torsoTorqueNm: { ...balanced.diagnostics.trunkMomentNm }, stanceHipTorqueNm: { ...ZERO }, swingHipTorqueNm: { ...ZERO }, stanceForceN: { ...ZERO } }
    if (this.fallen || rotate(root.rotation, { x: 0, y: 1, z: 0 }).y < GAIT_CONTROL.minUp || root.position.y < this.initialHeight * GAIT_CONTROL.minHeightFraction) {
      // Walking cannot recover a fallen body. Stop the gait until another behaviour has owned a tick.
      // Measured targets retain damping through the unchanged gate; they do not impose a standing pose.
      this.fallen = true; this.state.phase = 'idle'; this.report.phase = 'idle'
      this.velocityCommand = { ...ZERO }; this.recovery = null; this.swingOrigin = null; this.landing = null; this.inPlace = null
      this.clearInPlaceTransition()
      return this.remember({ ...nominal, source: 'hold', targets: Object.fromEntries(o.joints.map(j => [j.id, j.rotation])) }, joints)
    }
    if (this.options.mode === 'in-place' && !this.recovery) {
      // A turn after stepping starts from settled support, rather than inheriting the prior transfer posture.
      if (requested && command.yawRateRadps !== 0 && this.previousInPlaceYawRate === 0 && this.inPlace)
        this.pendingInPlaceTurn = true
      this.previousInPlaceYawRate = command.yawRateRadps
      if (!requested || command.yawRateRadps === 0) {
        this.pendingInPlaceTurn = false; this.turnBalanceTick = null
      }
      if (this.pendingInPlaceTurn && this.inPlace) {
        this.inPlace.requestStop(o)
        if (this.inPlace.canStop(o)) {
          this.turnBalanceTick ??= o.stateTick
          if ((o.stateTick - this.turnBalanceTick) * STEP < IN_PLACE_CONTROL.preparationSeconds)
            return this.remember(nominal, joints)
          this.inPlace = new InPlaceController(this.model, this.inPlace.standingHeight())
          this.pendingInPlaceTurn = false; this.turnBalanceTick = null
        } else command = { ...command, yawRateRadps: 0 }
      }
      if (requested && !this.pendingInPlaceTurn && this.inPlace?.isStopping())
        this.inPlace = new InPlaceController(this.model, this.inPlace.standingHeight())
      if (!requested && this.inPlace) this.inPlace.requestStop(o)
      if (!requested && (!this.inPlace || this.inPlace.canStop(o))) {
        this.inPlace = null; this.state.phase = 'idle'; this.report.phase = 'idle'
        this.clearInPlaceTransition()
        return this.remember(nominal, joints)
      }
      this.inPlace ??= new InPlaceController(this.model)
      const previous = Object.fromEntries(this.model.scene.joints.map(j => [j.id,
        this.estimatedTargets.get(j.id) ?? clampCone(joints.get(j.id)!.rotation, j.cone)]))
      const result = this.inPlace.step(o, previous, nominal, command.yawRateRadps, support)
      this.report = { ...this.report, ...result.diagnostics, desiredVelocity: { ...ZERO }, stanceForceN: { ...ZERO } }
      this.state.phase = result.diagnostics.phase; this.state.swing = result.diagnostics.swing; this.state.steps = result.diagnostics.steps
      this.heading = result.diagnostics.headingRad
      return this.remember(result.frame, joints)
    }
    if (this.stopIK) {
      const frame = this.stopIK.step(o, nominal, balanced.diagnostics.forceN, support)
      if (this.stopIK.canStop(o)) this.stopIK = null
      return this.remember(frame, joints)
    }
    if (this.stopBalance && !requested) {
      this.report.phase = 'idle'
      return this.remember(this.stopBalance.step(o).frame, joints)
    }
    if (requested) this.stopBalance = null
    if (this.state.phase === 'idle') return this.remember(nominal, joints)
    const swing = this.state.swing, stance = other(swing)
    const leg = (side: GaitSide, part: 'thigh' | 'shin' | 'foot') => this.model.scene.joints.find(j => j.child === this.model.parts[`${side}_${part}`].bodyId)!
    const swingHip = leg(swing, 'thigh'), stanceHip = leg(stance, 'thigh'), swingKnee = leg(swing, 'shin'), swingAnkle = leg(swing, 'foot'), stanceAnkle = leg(stance, 'foot')
    const anklePosition = jointFrame(stanceAnkle, bodies.get(stanceAnkle.parent)!).position
    const swingFoot = o.feet.find(f => f.id === swingAnkle.child)!
    const targets = { ...nominal.targets }
    const capture = captureState(o, -this.model.scene.gravity.y)
    const totalLoad = o.feet.reduce((sum, f) => sum + f.normalImpulseNs, 0)
    const mass = this.model.scene.bodies.reduce((sum, b) => sum + (b.fixed ? 0 : b.mass), 0)
    const rootError = rotationVector(multiply(heading, conjugate(root.rotation)))
    rootError.y = clamp(rootError.y, -GAIT_CONTROL.maxTwistErrorRad, GAIT_CONTROL.maxTwistErrorRad)
    const torso = sub(scale(rootError, GAIT_CONTROL.torsoStiffness), scale(root.angularVelocity, GAIT_CONTROL.torsoDamping))
    torso.y = GAIT_CONTROL.torsoStiffness * rootError.y - GAIT_CONTROL.torsoDamping * root.angularVelocity.y
    let supportHipMoment: Vec3 = { ...ZERO }
    const supportTargets = (force: Vec3) => {
      if (!capture || totalLoad <= 0) return
      const supportAnchor = scale(o.feet.reduce((v, f) => { const j = this.model.scene.joints.find(j => j.child === f.id)!; return add(v, scale(jointFrame(j, bodies.get(j.parent)!).position, f.normalImpulseNs)) }, { ...ZERO }), 1 / totalLoad)
      const cop = { x: o.com.x - force.x / (mass * capture.omega ** 2), y: 0, z: o.com.z - force.z / (mass * capture.omega ** 2) }
      const ankleMoment = scale(cross(sub(cop, supportAnchor), { ...force, y: -mass * this.model.scene.gravity.y }), -1)
      for (const side of ['left', 'right'] as const) {
        const foot = o.feet.find(f => f.id === leg(side, 'foot').child)!, share = foot.normalImpulseNs / totalLoad
        if (share <= 0) continue
        for (const part of ['foot', 'shin', 'thigh'] as const) {
          const joint = leg(side, part), parent = bodies.get(joint.parent)!, measured = joints.get(joint.id)!
          if (part === 'foot' && (!gaitFootSupported(foot.contactPoints) || norm(bodies.get(foot.id)!.angularVelocity) > GAIT_CONTROL.maxFootTurnRadps)) continue
          let moment = jacobianTransposeTorque(jointFrame(joint, parent).position, o.com, scale(force, share), 'foot')
          if (part === 'foot') moment = scale(ankleMoment, share)
          if (part === 'thigh') moment = sub(moment, scale(torso, share))
          if (part === 'thigh') supportHipMoment = add(supportHipMoment, moment)
          const local = jointTorque(joint, parent, moment)
          targets[joint.id] = part !== 'shin' ? torqueTarget(joint, measured.rotation, measured.angularVelocity, local) : targetOffset(joint, joint.motor.target, local)
        }
      }
      this.report.stanceForceN = force; this.report.torsoTorqueNm = torso
    }
    if (this.state.phase === 'start') {
      if (!requested && horizontalSpeed(o.comVelocity) < GAIT_CONTROL.stopSpeedMps) {
        this.state.phase = 'idle'; this.report.phase = 'idle'; return this.remember(nominal, joints)
      }
      this.state.ticks++
      const shift = GAIT_CONTROL.startShiftFraction * dot(sub(anklePosition, this.startCentre), this.startAxis)
      const fraction = .5 - .5 * Math.cos(Math.PI * Math.min(1, this.state.ticks * STEP / GAIT_CONTROL.startSeconds))
      const reference = add(this.startCentre, scale(this.startAxis, shift * fraction / GAIT_CONTROL.startShiftFraction))
      const forwardAxis = rotate(heading, { x: 0, y: 0, z: 1 })
      const footCentre = o.feet.find(f => f.id === stanceAnkle.child)!.centre
      const forwardShift = dot(sub(footCentre, this.startCentre), forwardAxis) + dot(command.velocity, forwardAxis) * STEP_TIME_S
      const forwardReference = add(reference, scale(forwardAxis, forwardShift * fraction))
      if (capture) {
        const cmp = add(capture.point, sub(capture.point, forwardReference))
        const cop = projectToPolygon(supportHull(support.flatMap(foot => foot.points)), cmp)
        if (cop) supportTargets({ x: mass * capture.omega ** 2 * (o.com.x - cop.x), y: 0, z: mass * capture.omega ** 2 * (o.com.z - cop.z) })
      }
      if (this.state.ticks >= Math.round(GAIT_CONTROL.startSeconds / STEP) &&
        Math.abs(dot(sub(o.com, this.startCentre), this.startAxis) - shift) <= GAIT_CONTROL.startToleranceM) {
        this.state = { ...this.state, phase: 'lift', ticks: 0, loadedTicks: 0 }; this.swingOrigin = null; this.landing = null
      }
      conformContactTargets(this.model, o, targets, support)
      return this.remember({ ...nominal, targets }, joints)
    }
    const phase = this.state.phase as 'lift' | 'strike'
    const liftSeconds = this.recovery ? this.recoverySeconds / 2 : control.liftSeconds
    const strikeSeconds = this.recovery ? this.recoverySeconds / 2 : control.strikeSeconds
    const localForce = rotate(inverse, balanced.diagnostics.forceN)
    if (capture) {
      const reference = add(anklePosition, rotate(heading, { x: (swing === 'left' ? -1 : 1) * control.lateralReferenceM, y: 0, z: 0 }))
      const cmp = add(capture.point, sub(capture.point, reference))
      const cop = projectToPolygon(supportHull(support.flatMap(foot => foot.points)), cmp)
      if (cop) localForce.x = rotate(inverse, { x: mass * capture.omega ** 2 * (o.com.x - cop.x), y: 0, z: mass * capture.omega ** 2 * (o.com.z - cop.z) }).x
    }
    localForce.z = control.velocityForceGain * rotate(inverse, sub(command.velocity, o.comVelocity)).z
    const force = rotate(heading, { ...localForce, y: 0 })
    supportTargets(force)
    if (capture) {
      this.swingOrigin ??= jointFrame(swingAnkle, bodies.get(swingAnkle.parent)!).position
      const duration = control.captureHorizonSeconds
      const elapsed = (phase === 'strike' ? liftSeconds : 0) + this.state.ticks * STEP
      const side = swing === 'left' ? -1 : 1
      const cop = { ...o.feet.find(f => f.id === stanceAnkle.child)!.centre, y: 0 }
      const predicted = alipLandingCentre(this.model.scene.bodies, o, stanceAnkle.child, capture.cop, heading, command.velocity, side, elapsed, liftSeconds + strikeSeconds, control.periodicWidthM, this.geometry.terminalVelocityFactor, control.momentumRetention)
      const requestedAnkle = add(predicted, rotate(heading, { ...swingAnkle.anchorChild, y: 0 }))
      const virtualCapture = add(cop, scale(sub(requestedAnkle, cop), Math.exp(-capture.omega * STEP_TIME_S)))
      const planned = landingTarget({ capturePoint: virtualCapture, cop, omega: capture.omega,
        stanceAnkle: anklePosition, swing, yawRad: this.heading, hipHeightM: this.initialHeight, exitDirection: ZERO })
      if (!this.landing || elapsed < duration * .75 && (phase === 'lift' || swingFoot.minSoleY > .015)) this.landing = this.recovery ? { ...this.recovery } : { ...planned.point }
      this.landing.y = swingAnkle.anchorChild.y +
        (this.model.scene.bodies.find(b => b.id === swingAnkle.child)!.shape as { kind: 'box'; half: Vec3 }).half.y - .003
    }
    if (!this.swingOrigin || !this.landing) return this.remember(nominal, joints)
    const progress = phase === 'lift' ? .5 * this.state.ticks * STEP / liftSeconds : .5 + .5 * this.state.ticks * STEP / strikeSeconds
    const u = Math.min(1, progress), blend = u * u * u * (10 + u * (-15 + 6 * u))
    const goal = add(this.swingOrigin, scale(sub(this.landing, this.swingOrigin), blend))
    const apex = Math.max(this.swingOrigin.y, this.landing.y) + control.swingClearanceM, t = progress < .5 ? 2 * progress : Math.min(1, 2 * progress - 1), ease = t * t * t * (10 + t * (-15 + 6 * t))
    goal.y = progress < .5 ? this.swingOrigin.y + (apex - this.swingOrigin.y) * ease : apex + (this.landing.y - apex) * ease
    const ankleBody = bodies.get(stanceAnkle.parent)!, ankleVelocity = add(ankleBody.velocity, cross(ankleBody.angularVelocity, sub(anklePosition, ankleBody.position)))
    const feedback = swingHipFeedback('strike', rotate(inverse, sub(o.com, anklePosition)), rotate(inverse, sub(o.comVelocity, ankleVelocity)), rotate(inverse, command.velocity), swing)
    const weight = Math.sin(Math.PI * Math.min(1, progress)) ** 2
    const upper = norm(sub(swingKnee.anchorParent, swingHip.anchorChild)), lower = norm(sub(swingAnkle.anchorParent, swingKnee.anchorChild))
    const correction = rotate(heading, { x: (upper + lower) * (feedback.lateral - (swing === 'left' ? -1 : 1) * GAIT_CONTROL.lateralHipRad) * weight,
      y: 0, z: -(upper + lower) * feedback.sagittal * weight })
    const hipPosition = jointFrame(swingHip, root).position, delta = rotate(inverse, sub(add(goal, correction), hipPosition))
    const distance = clamp(norm(delta), Math.abs(upper - lower) + 1e-8, upper + lower - 1e-8)
    const knee = Math.acos(clamp((distance * distance - upper * upper - lower * lower) / (2 * upper * lower), -1, 1))
    const hipPitch = Math.atan2(-delta.z, Math.hypot(delta.x, delta.y)) + Math.atan2(lower * Math.sin(knee), upper + lower * Math.cos(knee))
    const hipRoll = Math.atan2(delta.x, -delta.y)
    targets[swingHip.id] = worldTarget(swingHip, root.rotation, multiply(heading, multiply(fromRotationVector({ x: 0, y: 0, z: hipRoll }), fromRotationVector({ x: hipPitch, y: 0, z: 0 }))))
    targets[swingKnee.id] = targetsFromAngles(this.model, { [`${swing}.leg.knee`]: knee })[swingKnee.id]
    targets[swingAnkle.id] = worldTarget(swingAnkle, Math.abs(command.yawRateRadps) > .1 ?
      multiply(multiply(heading, multiply(fromRotationVector({ x: 0, y: 0, z: hipRoll }), fromRotationVector({ x: hipPitch, y: 0, z: 0 }))),
        fromRotationVector({ x: -knee, y: 0, z: 0 })) : bodies.get(swingAnkle.parent)!.rotation, heading)
    for (const joint of [swingHip, swingKnee, swingAnkle]) {
      const previous = this.estimatedTargets.get(joint.id) ?? clampCone(joints.get(joint.id)!.rotation, joint.cone), delta = rotationVector(multiply(targets[joint.id], conjugate(previous)))
      targets[joint.id] = multiply(fromRotationVector(capped(delta, .75 * MAX_TARGET_RATE * STEP)), previous)
    }
    this.report.swingHipRad = { sagittal: hipPitch, lateral: hipRoll }
    conformContactTargets(this.model, o, targets, support)
    const estimate = (joint: Joint, target: Quat) => {
      const measured = joints.get(joint.id)!, parent = bodies.get(joint.parent)!
      const accepted = gaitTargetEstimate(joint, this.estimatedTargets.get(joint.id) ?? clampCone(measured.rotation, joint.cone), target)
      const local = capped(sub(scale(rotationVector(multiply(accepted, conjugate(measured.rotation))), joint.motor.stiffness), scale(measured.angularVelocity, joint.motor.damping)), joint.motor.maxTorque)
      return rotate(jointFrame(joint, parent).rotation, local)
    }
    const swingReaction = estimate(swingHip, targets[swingHip.id])
    const stanceLinks = new Set([stanceHip.child, leg(stance, 'shin').child, stanceAnkle.child])
    const stanceShare = totalLoad > 0 ? o.feet.find(f => f.id === stanceAnkle.child)!.normalImpulseNs / totalLoad : 0
    const hipGravity = this.model.scene.bodies.filter(b => !b.fixed && !stanceLinks.has(b.id)).reduce((sum, b) => add(sum, cross(sub(bodies.get(b.id)!.position, jointFrame(stanceHip, root).position), scale(this.model.scene.gravity, b.mass))), { ...ZERO })
    const stanceRequest = add(sub(supportHipMoment, swingReaction), scale(hipGravity, Math.max(0, 2 * stanceShare - 1)))
    const measured = joints.get(stanceHip.id)!
    targets[stanceHip.id] = torqueTarget(stanceHip, measured.rotation, measured.angularVelocity, jointTorque(stanceHip, root, stanceRequest))
    const desiredReaction = add(supportHipMoment, scale(hipGravity, Math.max(0, 2 * stanceShare - 1)))
    withGaitPredictions(this.model, o, predict => {
      for (let iteration = 0; iteration < 2; iteration++) {
        const accepted = new Map(this.model.scene.joints.map(j => [j.id, gaitTargetEstimate(j,
          this.estimatedTargets.get(j.id) ?? clampCone(joints.get(j.id)!.rotation, j.cone), targets[j.id])]))
        const prediction = predict(accepted)
        const error = sub(desiredReaction, add(prediction.torques.get(stanceHip.id)!, prediction.torques.get(swingHip.id)!))
        targets[stanceHip.id] = targetOffset(stanceHip, targets[stanceHip.id], jointTorque(stanceHip, root, error))
      }
    })
    this.report = { ...this.report, phase, phaseSeconds: this.state.ticks * STEP, stanceHipTorqueNm: stanceRequest, swingHipTorqueNm: swingReaction, stanceForceN: force }
    const recoveryExit = this.recovery && phase === 'strike' && this.state.cleared && swingFoot.normalImpulseNs > 0 && this.state.loadedTicks + 1 >= 2 ? 'touchdown' : 'timeout'
    const previousSteps = this.state.steps
    this.state = !requested && !this.recovery ? advanceStoppingGait(this.state, swingFoot,
      bodies.get(swingFoot.id)!, liftSeconds) :
      advanceGaitState(this.state, swingFoot.normalImpulseNs > 0, !requested, progress >= .85, liftSeconds, strikeSeconds)
    if (this.state.steps !== previousSteps) {
      this.swingOrigin = null; this.landing = null
      if (!requested && !this.recovery) {
        // The same midline COM needs more than usable hip roll torque on compact, wide-hip geometries.
        const hip = this.model.scene.joints.find(j => j.child === this.model.parts.left_thigh.bodyId)!
        if (mass * -this.model.scene.gravity.y * Math.abs(hip.anchorParent.x) > .8 * hip.motor.maxTorque)
          this.stopIK = new MeasuredSupportStop(this.model, o.stateTick, structuredClone(targets), root.position.y)
        else this.stopBalance = new BalanceController(this.model, this.generation)
      }
      if (this.recovery) { this.report.recoveryExit = recoveryExit; this.state.phase = 'idle'; this.recovery = null }
      else if (this.state.phase !== 'idle') {
        this.startCentre = { ...o.com }; this.startAxis = rotate(heading, { x: 1, y: 0, z: 0 })
      }
    }
    return this.remember({ ...nominal, targets }, joints)
  }
  /** One recovery swing; touchdown or timeout hands back for a new capture-point plan. */
  beginRecovery(landing: Vec3, swing: GaitSide, seconds = STEP_TIME_S): void {
    if (!finite(landing) || (swing !== 'left' && swing !== 'right') || !Number.isFinite(seconds) || seconds < .25 || seconds > .45) throw new RangeError('Invalid recovery landing')
    this.recoverySeconds = seconds; this.recovery = { ...landing }; this.state = { ...this.state, phase: 'lift', swing, ticks: 0, loadedTicks: 0, cleared: false }
    this.swingOrigin = null; this.landing = null; this.inPlace = null; this.stopBalance = null; this.stopIK = null; this.report.recoveryExit = null
    this.clearInPlaceTransition()
  }
  private clearInPlaceTransition(): void {
    this.previousInPlaceYawRate = null; this.pendingInPlaceTurn = false; this.turnBalanceTick = null
  }
  private rootHeading(o: Observation): number {
    const root = o.bodies.find(b => b.id === this.model.root)
    if (!root) throw new RangeError('Missing gait root')
    const forward = rotate(root.rotation, { x: 0, y: 0, z: -1 })
    return Math.atan2(-forward.x, -forward.z)
  }
  private mappingHeading(o: Observation): number {
    return this.heading === null || (this.previousTick !== null && o.stateTick !== this.previousTick + 1) ? this.rootHeading(o) : this.heading
  }
  private remember(frame: ActuationFrame, joints: Map<string, Observation['joints'][number]>): ActuationFrame {
    for (const joint of this.model.scene.joints) this.estimatedTargets.set(joint.id,
      gaitTargetEstimate(joint, this.estimatedTargets.get(joint.id) ?? clampCone(joints.get(joint.id)!.rotation, joint.cone), frame.targets[joint.id]))
    return frame
  }
}

const yaw = (q: Quat) => { const forward = rotate(q, { x: 0, y: 0, z: -1 }); return Math.atan2(-forward.x, -forward.z) }
const headingOf = (angle: number) => fromRotationVector({ x: 0, y: angle, z: 0 })
const ease = (x: number) => .5 - .5 * Math.cos(Math.PI * clamp(x, 0, 1))
type Leg = Record<'thigh' | 'shin' | 'foot', Joint>
const SUPPORT_STOP_CONTROL = { minimumKneeRad: .4, flatTiltRad: .5 * Math.PI / 180 } // Simulation defaults, rad.

/** Recenter measured supports without asking either knee to straighten beyond its support reach.
 * Creation follows genuine touchdown. Start on the next observation, then recenter for 2 s after
 * two loaded observations. The caller retains the ordinary 0.1 m/s done gate and Balance handoff.
 */
export class MeasuredSupportStop {
  private readonly legs: Leg[]
  private readonly masses: Map<string, number>
  private readonly mass: number
  private readonly floorY: number
  private startTick = -1
  private previousTick = -1
  private loadedTicks = 0
  private stopTick: number | null = null
  private anchors: Vec3[] = []
  private footYaw: number[] = []
  private initialRoot!: Vec3
  private fromRoot!: Vec3
  private toRoot!: Vec3
  private shares = [.5, .5]

  constructor(private readonly model: PhysicalHumanoid, private readonly entryTick: number,
    private readonly entryTargets: Record<string, Quat>, private readonly restartHeightM: number,
    /** s, simulation default: measured load-share smoothing; 0 uses the current measured shares. */
    private readonly loadShareSeconds = .025) {
    this.legs = (['left', 'right'] as const).map(side => Object.fromEntries((['thigh', 'shin', 'foot'] as const)
      .map(part => [part, model.scene.joints.find(j => j.child === model.parts[`${side}_${part}`].bodyId)!])) as Leg)
    this.masses = new Map(model.scene.bodies.filter(b => !b.fixed).map(b => [b.id, b.mass]))
    this.mass = [...this.masses.values()].reduce((sum, mass) => sum + mass, 0)
    this.floorY = model.scene.bodies.find(b => b.id === 'floor')!.position.y
  }

  canStop(o: Observation) {
    return this.stopTick !== null && (o.stateTick - this.stopTick) * STEP >= IN_PLACE_CONTROL.stopSeconds &&
      this.loadedTicks >= 2 && o.feet.every(foot => foot.normalImpulseNs > 0) &&
      Math.hypot(o.comVelocity.x, o.comVelocity.z) < GAIT_CONTROL.stopSpeedMps &&
      this.model.feet.every(id => Math.acos(clamp(rotate(o.bodies.find(body => body.id === id)!.rotation,
        { x: 0, y: 1, z: 0 }).y, -1, 1)) <= SUPPORT_STOP_CONTROL.flatTiltRad)
  }

  step(o: Observation, nominal: ActuationFrame, balanceForceN: Vec3, support: SinkSupportFoot[]): ActuationFrame {
    const bodies = new Map(o.bodies.map(b => [b.id, b])), feet = this.model.feet.map(id => o.feet.find(f => f.id === id)!)
    const root = bodies.get(this.model.root)!, gravity = -this.model.scene.gravity.y
    const frame = { ...nominal, targets: { ...nominal.targets } }
    if (this.startTick < 0) {
      this.startTick = o.stateTick; this.initialRoot = { ...root.position }
      this.anchors = this.legs.map(leg => jointFrame(leg.foot, bodies.get(leg.foot.parent)!).position)
      const rootYaw = yaw(root.rotation)
      this.footYaw = this.model.feet.map(id => { const error = yaw(bodies.get(id)!.rotation) - rootYaw
        return rootYaw + Math.atan2(Math.sin(error), Math.cos(error)) })
    }
    if (this.previousTick !== o.stateTick) {
      this.loadedTicks = feet.every(f => f.normalImpulseNs > 0) ? (this.previousTick === o.stateTick - 1 ? this.loadedTicks : 0) + 1 : 0
      this.previousTick = o.stateTick
    }
    const elapsed = (o.stateTick - this.startTick) * STEP, heading = headingOf((this.footYaw[0] + this.footYaw[1]) / 2)
    const forward = rotate(heading, { x: 0, y: 0, z: -1 }), desiredRoot = { ...this.initialRoot }
    desiredRoot.y += (this.restartHeightM - IN_PLACE_CONTROL.crouchM - this.initialRoot.y) * ease(elapsed / IN_PLACE_CONTROL.preparationSeconds)
    if (this.stopTick !== null) Object.assign(desiredRoot,
      add(this.fromRoot, scale(sub(this.toRoot, this.fromRoot), ease((o.stateTick - this.stopTick) * STEP / IN_PLACE_CONTROL.stopSeconds))))
    const total = feet.reduce((sum, foot) => sum + foot.normalImpulseNs, 0)
    const torso = sub(scale(rotationVector(multiply(heading, conjugate(root.rotation))), GAIT_CONTROL.torsoStiffness),
      scale(root.angularVelocity, GAIT_CONTROL.torsoDamping))
    if (total > 0) for (let i = 0; i < 2; i++) {
      const leg = this.legs[i], hip = leg.thigh, kneeJoint = leg.shin, ankle = leg.foot, footHeading = headingOf(this.footYaw[i])
      const hipPosition = add(desiredRoot, rotate(heading, hip.anchorParent)), delta = rotate(conjugate(footHeading), sub(this.anchors[i], hipPosition))
      const upper = norm(sub(kneeJoint.anchorParent, hip.anchorChild)), lower = norm(sub(ankle.anchorParent, kneeJoint.anchorChild))
      const distance = clamp(norm(delta), Math.abs(upper - lower) + 1e-8, upper + lower - 1e-8)
      const knee = Math.acos(clamp((distance * distance - upper * upper - lower * lower) / (2 * upper * lower), -1, 1))
      const pitch = Math.atan2(-delta.z, Math.hypot(delta.x, delta.y)) + Math.atan2(lower * Math.sin(knee), upper + lower * Math.cos(knee))
      const thigh = multiply(footHeading, multiply(fromRotationVector({ x: 0, y: 0, z: Math.atan2(delta.x, -delta.y) }), fromRotationVector({ x: pitch, y: 0, z: 0 })))
      const shin = multiply(thigh, fromRotationVector({ x: -knee, y: 0, z: 0 }))
      frame.targets[hip.id] = worldTarget(hip, heading, thigh)
      frame.targets[kneeJoint.id] = targetsFromAngles(this.model, { [`${i ? 'right' : 'left'}.leg.knee`]: knee })[kneeJoint.id]
      frame.targets[ankle.id] = worldTarget(ankle, shin, footHeading)
      const observedShare = feet[i].normalImpulseNs / total
      if (this.loadShareSeconds > 0) this.shares[i] += (observedShare - this.shares[i]) * STEP / (this.loadShareSeconds + STEP)
      else this.shares[i] = observedShare
      const share = this.shares[i], cop = { ...add(feet[i].centre, scale(forward, dot(sub(o.com, feet[i].centre), forward))), y: this.floorY }
      const parts = ['thigh', 'shin', 'foot'] as const
      for (const [depth, part] of parts.entries()) {
        const joint = leg[part], parent = bodies.get(joint.parent)!, anchor = jointFrame(joint, parent).position
        let moment = scale(cross(sub(cop, anchor), { x: 0, y: this.mass * gravity * share, z: 0 }), -1)
        for (const distal of parts.slice(depth)) {
          const body = bodies.get(leg[distal].child)!
          moment = sub(moment, cross(sub(body.position, anchor), { x: 0, y: -this.masses.get(body.id)! * gravity, z: 0 }))
        }
        frame.targets[joint.id] = targetOffset(joint, frame.targets[joint.id], jointTorque(joint, parent, moment))
      }
      frame.targets[hip.id] = targetOffset(hip, frame.targets[hip.id], jointTorque(hip, root, scale(torso, -share)))
    }
    // Latch the recenter reference after producing the initial supported IK target.
    if (this.stopTick === null && this.loadedTicks >= 2) {
      this.stopTick = o.stateTick; this.fromRoot = { ...root.position }
      const midpoint = scale(feet.reduce((sum, foot) => add(sum, foot.centre), { ...ZERO }), .5)
      this.toRoot = add(this.fromRoot, sub(midpoint, o.com))
      // Keep both support knees bent at the midpoint target; unchanged anatomy supplies the reach bound.
      const reachCaps = this.legs.map((leg, index) => {
        const upper = norm(sub(leg.shin.anchorParent, leg.thigh.anchorChild))
        const lower = norm(sub(leg.foot.anchorParent, leg.shin.anchorChild))
        const lengthSquared = upper * upper + lower * lower + 2 * upper * lower * Math.cos(SUPPORT_STOP_CONTROL.minimumKneeRad)
        const hipOffset = rotate(heading, leg.thigh.anchorParent)
        const dx = this.anchors[index].x - this.toRoot.x - hipOffset.x
        const dz = this.anchors[index].z - this.toRoot.z - hipOffset.z
        return this.anchors[index].y - hipOffset.y + Math.sqrt(Math.max(0, lengthSquared - dx * dx - dz * dz))
      })
      this.toRoot.y = Math.min(this.restartHeightM, ...reachCaps)
    }
    if (total > 0) for (let i = 0; i < 2; i++) for (const part of ['foot', 'shin', 'thigh'] as const) {
      const joint = this.legs[i][part], parent = bodies.get(joint.parent)!
      const moment = jacobianTransposeTorque(jointFrame(joint, parent).position, o.com, scale(balanceForceN, feet[i].normalImpulseNs / total), 'foot')
      frame.targets[joint.id] = targetOffset(joint, frame.targets[joint.id], jointTorque(joint, parent, moment))
    }
    const fraction = clamp((o.stateTick - this.entryTick) * STEP / .10, 0, 1), blend = fraction * fraction * (3 - 2 * fraction)
    for (const joint of this.model.scene.joints) {
      const from = this.entryTargets[joint.id], delta = rotationVector(multiply(frame.targets[joint.id], conjugate(from)))
      frame.targets[joint.id] = multiply(fromRotationVector(scale(delta, blend)), from)
    }
    // Hard conform precedes COP feedback: clipping must not add a moment during the zero-moment window.
    for (const foot of support) {
      const ankle = this.model.scene.joints.find(j => j.child === foot.id)!, measured = o.joints.find(j => j.id === ankle.id)!
      const parent = bodies.get(ankle.parent)!, anchor = jointFrame(ankle, parent)
      const local = sub(scale(rotationVector(multiply(frame.targets[ankle.id], conjugate(measured.rotation))), ankle.motor.stiffness), scale(measured.angularVelocity, ankle.motor.damping))
      const conform = conformAnkleMoment(foot, anchor.position, rotate(anchor.rotation, local))
      const moment = foot.contactBlend === 0 ? ZERO :
        sinkSafeAnkleMoment(foot, anchor.position, { x: 0, y: foot.normalForceN, z: 0 }, conform).moment
      frame.targets[ankle.id] = torqueTarget(ankle, measured.rotation, measured.angularVelocity, jointTorque(ankle, parent, moment))
    }
    return frame
  }
}


/** Deliberate transfer, then a lifted step. The desired pelvis is only an IK reference; it is never written to physics.
 * Both pilots pass the isolated native fallback rows; mixed command sequences are measured separately.
 */
class InPlaceController {
  private readonly legs: Record<'thigh' | 'shin' | 'foot', Joint>[]
  private readonly mass: number
  private readonly masses: Map<string, number>
  private readonly floorY: number
  private startTick = -1
  private started = false
  private initialRoot!: Vec3
  private initialCom!: Vec3
  private baseRoot!: Vec3
  private baseCom!: Vec3
  private fromReference!: Vec3
  private toReference!: Vec3
  private anchors: Vec3[] = []
  private footCentres: Vec3[] = []
  private initialAnchors: Vec3[] = []
  private pivot!: Vec3
  private initialFootYaw: number[] = []
  private footYaw: number[] = []
  private nextSwingYaw = 0
  private swingLanding!: Vec3
  private cycle = -1
  private turning = false
  private shares = [.5, .5]
  private stopStartTick: number | null = null
  private stopFromRoot!: Vec3
  private stopToRoot!: Vec3
  private stopTiming: ReturnType<InPlaceController['timing']> | null = null
  private supportTick = -1
  private bothLoadedTicks = 0
  private loadedTicks = [0, 0]
  private activeSwingCycle = -1
  private transferShiftM = 0
  private clearedSwingCycle = -1
  private heldContactCycle = -1
  private spineLeanCycle = -1
  private spineLeanFrom = 0
  private spineLeanTo = 0
  private spineLeanRoll = 0
  private spineStopFrom: number | null = null
  constructor(private readonly model: PhysicalHumanoid, private readonly restartStandingHeight?: number) {
    this.legs = (['left', 'right'] as const).map(side => Object.fromEntries((['thigh', 'shin', 'foot'] as const)
      .map(part => [part, model.scene.joints.find(j => j.child === model.parts[`${side}_${part}`].bodyId)!])) as Record<'thigh' | 'shin' | 'foot', Joint>)
    this.masses = new Map(model.scene.bodies.filter(b => !b.fixed).map(b => [b.id, b.mass]))
    this.mass = [...this.masses.values()].reduce((sum, mass) => sum + mass, 0)
    this.floorY = model.scene.bodies.find(b => b.id === 'floor')!.position.y
  }
  private timing(o: Observation) {
    const p = IN_PLACE_CONTROL, elapsed = !this.started ? 0 : (o.stateTick - this.startTick) * STEP
    const active = Math.max(0, elapsed - p.preparationSeconds), span = p.transferSeconds + p.dwellSeconds + p.swingSeconds
    const index = Math.floor(active / span), stage = active % span
    return { elapsed, index, stage, swing: index % 2, inSwing: elapsed >= p.preparationSeconds && stage >= p.transferSeconds + p.dwellSeconds }
  }
  private observeSupport(o: Observation) {
    if (this.supportTick === o.stateTick) return
    this.loadedTicks = this.model.feet.map((id, index) => o.feet.find(f => f.id === id)!.normalImpulseNs > 0
      ? (this.supportTick === o.stateTick - 1 ? this.loadedTicks[index] : 0) + 1 : 0)
    this.bothLoadedTicks = Math.min(...this.loadedTicks)
    this.supportTick = o.stateTick
  }
  isStopping(): boolean { return this.stopStartTick !== null }
  standingHeight(): number { return this.restartStandingHeight ?? this.initialRoot.y }
  /** Balance receives a recentered body after the arc, two loaded observations and the stop-speed check. */
  canStop(o: Observation): boolean {
    this.observeSupport(o)
    return this.stopStartTick !== null && (o.stateTick - this.stopStartTick) * STEP >= IN_PLACE_CONTROL.stopSeconds &&
      this.bothLoadedTicks >= 2 && horizontalSpeed(o.comVelocity) < GAIT_CONTROL.stopSpeedMps
  }
  /** Move the IK reference toward the measured foot midpoint and restore the initial height; no body state is written. */
  requestStop(o: Observation): void {
    this.observeSupport(o)
    if (this.stopStartTick !== null || this.timing(o).inSwing || this.bothLoadedTicks < 2) return
    this.stopStartTick = o.stateTick; this.stopTiming = this.timing(o)
    const root = o.bodies.find(b => b.id === this.model.root)!
    this.stopFromRoot = { ...root.position }; this.transferShiftM = 0
    // A stop captures measured support again: the prior transfer anchors may have moved during conform.
    this.anchors = this.legs.map(leg => jointFrame(leg.foot, o.bodies.find(body => body.id === leg.foot.parent)!).position)
    const midpoint = scale(this.model.feet.reduce((sum, id) => add(sum, o.feet.find(f => f.id === id)!.centre), { ...ZERO }), .5)
    this.stopToRoot = add(this.stopFromRoot, sub(midpoint, o.com)); this.stopToRoot.y = this.standingHeight()
  }
  step(o: Observation, previous: Record<string, Quat>, balanced: ActuationFrame, yawRate: number, support: SinkSupportFoot[]) {
    const p = IN_PLACE_CONTROL, model = this.model, bodies = new Map(o.bodies.map(b => [b.id, b]))
    const feet = model.feet.map(id => o.feet.find(f => f.id === id)!), root = bodies.get(model.root)!, gravity = -model.scene.gravity.y
    const frame = { ...balanced, targets: { ...balanced.targets } }
    const yawOf = (q: Quat) => { const f = rotate(q, { x: 0, y: 0, z: -1 }); return Math.atan2(-f.x, -f.z) }
    const ease = (x: number) => .5 - .5 * Math.cos(Math.PI * clamp(x, 0, 1))
    const rebase = () => {
      this.baseRoot = { ...root.position }; this.baseCom = { ...o.com }; this.fromReference = { ...o.com }; this.transferShiftM = 0
      this.anchors = this.legs.map(l => jointFrame(l.foot, bodies.get(l.foot.parent)!).position)
      this.footCentres = feet.map(f => ({ ...f.centre }))
    }
    if (!this.started) {
      // Early qualified contact may shift the phase origin before tick zero; it is still initialized.
      this.started = true
      this.startTick = o.stateTick; this.initialRoot = { ...root.position }; this.initialCom = { ...o.com }
      this.toReference = { ...o.com }; rebase()
      this.initialAnchors = this.anchors.map(a => ({ ...a })); this.pivot = scale(add(this.footCentres[0], this.footCentres[1]), .5)
      const initialYaw = yawOf(root.rotation)
      this.initialFootYaw = model.feet.map(id => { const error = yawOf(bodies.get(id)!.rotation) - initialYaw
        return initialYaw + Math.atan2(Math.sin(error), Math.cos(error)) })
      this.footYaw = [...this.initialFootYaw]
    }
    this.observeSupport(o)
    // Hold the final swing target when touchdown is late instead of transferring onto an unloaded foot.
    if (this.cycle >= 0 && this.timing(o).index > this.cycle && this.bothLoadedTicks < 2) this.startTick++
    const proposed = this.timing(o)
    if (proposed.inSwing && this.activeSwingCycle !== proposed.index) {
      // Simulation default: two loaded 240 Hz observations confirm stance before a new swing.
      // Once airborne, transient support loss must not rewind that swing's timeline.
      if (this.loadedTicks[1 - proposed.swing] < 2) this.startTick++
      else this.activeSwingCycle = proposed.index
    }
    const contactTiming = this.timing(o)
    if (this.heldContactCycle === contactTiming.index) this.startTick++
    if (contactTiming.inSwing && this.stopTiming === null) {
      const foot = feet[contactTiming.swing], supported = support.find(f => f.id === foot.id)
      if (foot.normalImpulseNs <= 0) this.clearedSwingCycle = contactTiming.index
      const progress = (contactTiming.stage - p.transferSeconds - p.dwellSeconds) / p.swingSeconds
      // Simulation defaults: descending contact, two loaded ticks and a 0.5 degree supported sole permit transfer.
      if (this.clearedSwingCycle === contactTiming.index && progress >= .5 && this.loadedTicks[contactTiming.swing] >= 2 &&
        supported && supported.tiltRad <= .5 * Math.PI / 180 && gaitFootSupported(foot.contactPoints)) {
        this.startTick -= Math.round((p.transferSeconds + p.dwellSeconds + p.swingSeconds - contactTiming.stage) / STEP)
      } else if (this.clearedSwingCycle === contactTiming.index && progress >= .5 &&
        this.loadedTicks[contactTiming.swing] * STEP >= .04 && this.heldContactCycle !== contactTiming.index) {
        // Simulation default, s: after 40 ms loaded, hold the measured contact while the ankle conforms.
        this.heldContactCycle = contactTiming.index
        const ankle = this.legs[contactTiming.swing].foot
        this.anchors[contactTiming.swing] = jointFrame(ankle, bodies.get(ankle.parent)!).position
      }
    }
    const { elapsed, index, stage, swing, inSwing: scheduledSwing } = this.stopTiming ?? this.timing(o)
    const inSwing = scheduledSwing && this.heldContactCycle !== index
    if (this.cycle !== index) {
      this.cycle = index; this.fromReference = { ...this.toReference }
      if (index > 0) { this.footYaw[1 - swing] = this.nextSwingYaw; rebase() }
      const centre = this.footCentres[1 - swing]
      this.toReference = { x: centre.x, y: this.initialCom.y, z: centre.z }
      this.turning = yawRate !== 0
      this.nextSwingYaw = this.footYaw[1 - swing] + p.turnStepRad * clamp(yawRate, -1, 1)
      this.swingLanding = add(this.pivot, rotate(yawRotation(this.nextSwingYaw - this.initialFootYaw[swing]), sub(this.initialAnchors[swing], this.pivot)))
    }
    const progress = clamp((stage - p.transferSeconds - p.dwellSeconds) / p.swingSeconds, 0, 1)
    const footYaw = [...this.footYaw]
    if (inSwing) footYaw[swing] += (this.nextSwingYaw - footYaw[swing]) * ease(progress)
    const desiredYaw = (footYaw[0] + footYaw[1]) / 2, heading = yawRotation(desiredYaw), forward = rotate(heading, { x: 0, y: 0, z: -1 })
    const reference = add(this.fromReference, scale(sub(this.toReference, this.fromReference), elapsed < p.preparationSeconds ? 0 : ease(stage / p.transferSeconds)))
    const desiredRoot = add(this.baseRoot, sub(reference, this.baseCom))
    desiredRoot.y = index === 0 ? this.initialRoot.y - p.crouchM * ease(elapsed / p.preparationSeconds) :
      this.baseRoot.y + (this.initialRoot.y - p.crouchM - this.baseRoot.y) * ease(stage / p.transferSeconds)
    if (this.restartStandingHeight !== undefined) {
      // Interrupted stops retain the original standing height without jumping from the measured restart pose.
      const blend = ease(index === 0 ? elapsed / p.preparationSeconds : stage / p.transferSeconds)
      desiredRoot.y = this.baseRoot.y + (this.restartStandingHeight - p.crouchM - this.baseRoot.y) * blend
    }
    const morrow = model.profileId === 'morrow-v1'
    // Preserve the initial sagittal pelvis-to-COM offset while restoring the measured transfer pose.
    if (!this.turning && !morrow && index > 0) {
      const offset = sub(sub(this.initialRoot, this.initialCom), sub(this.baseRoot, this.baseCom))
      const correction = scale(forward, dot(offset, forward) * ease(stage / p.transferSeconds))
      desiredRoot.x += correction.x; desiredRoot.z += correction.z
    }
    if (this.stopStartTick !== null) {
      const blend = ease((o.stateTick - this.stopStartTick) * STEP / p.stopSeconds)
      Object.assign(desiredRoot, add(this.stopFromRoot, scale(sub(this.stopToRoot, this.stopFromRoot), blend)))
    }
    const totalImpulse = feet.reduce((sum, foot) => sum + foot.normalImpulseNs, 0)
    if (totalImpulse > 0 && !inSwing) {
      // Simulation defaults: transfer from 50% toward 85% measured receiving-foot load.
      const desiredShare = this.stopStartTick !== null || elapsed < p.preparationSeconds ? .5 : .5 + .35 * ease(stage / p.transferSeconds)
      const actualShare = feet[1 - swing].normalImpulseNs / totalImpulse
      // Simulation defaults: 0.6 m per load-share error, 40 mm maximum and 20 mm/s target-reference slew.
      const shift = this.stopStartTick !== null ? 0 : clamp(.6 * (desiredShare - actualShare), 0, .04)
      this.transferShiftM += clamp(shift - this.transferShiftM, -.02 * STEP, .02 * STEP)
    }
    const lateral = sub(feet[1 - swing].centre, feet[swing].centre), width = Math.hypot(lateral.x, lateral.z)
    if (width > 1e-8) { desiredRoot.x += lateral.x * this.transferShiftM / width; desiredRoot.z += lateral.z * this.transferShiftM / width }
    const clearance = morrow ? this.turning ? p.morrowTurnClearanceM : p.morrowClearanceM : p.clearanceM
    const lift = inSwing ? clearance * Math.sin(Math.PI * progress) ** 2 : 0
    const load = feet.reduce((sum, foot) => sum + foot.normalImpulseNs, 0), staticMoments = new Map<string, Vec3>()
    const torso = sub(scale(rotationVector(multiply(heading, conjugate(root.rotation))), GAIT_CONTROL.torsoStiffness), scale(root.angularVelocity, GAIT_CONTROL.torsoDamping))
    let stanceMoment: Vec3 = { ...ZERO }, swingMoment: Vec3 = { ...ZERO }
    if (load > 0) for (let i = 0; i < 2; i++) {
      const leg = this.legs[i], hip = leg.thigh, kneeJoint = leg.shin, ankle = leg.foot, actualSwing = inSwing && i === swing
      const footHeading = yawRotation(footYaw[i]), hipPosition = actualSwing ? jointFrame(hip, root).position : add(desiredRoot, rotate(heading, hip.anchorParent))
      let goal = actualSwing && this.turning ? add(this.anchors[i], scale(sub(this.swingLanding, this.anchors[i]), ease(progress))) : { ...this.anchors[i] }
      goal.y += i === swing ? lift : 0
      if (actualSwing && morrow && !this.turning) goal = add(goal, rotate(heading, { x: (i ? -1 : 1) * p.morrowNarrowM * ease(progress), y: 0, z: 0 }))
      const delta = rotate(conjugate(footHeading), sub(goal, hipPosition))
      const upper = norm(sub(kneeJoint.anchorParent, hip.anchorChild)), lower = norm(sub(ankle.anchorParent, kneeJoint.anchorChild))
      const distance = clamp(norm(delta), Math.abs(upper - lower) + 1e-8, upper + lower - 1e-8)
      const knee = Math.acos(clamp((distance * distance - upper * upper - lower * lower) / (2 * upper * lower), -1, 1))
      const pitch = Math.atan2(-delta.z, Math.hypot(delta.x, delta.y)) + Math.atan2(lower * Math.sin(knee), upper + lower * Math.cos(knee))
      const thigh = multiply(footHeading, multiply(fromRotationVector({ x: 0, y: 0, z: Math.atan2(delta.x, -delta.y) }), fromRotationVector({ x: pitch, y: 0, z: 0 })))
      const shin = multiply(thigh, fromRotationVector({ x: -knee, y: 0, z: 0 }))
      frame.targets[hip.id] = worldTarget(hip, actualSwing ? root.rotation : heading, thigh)
      frame.targets[kneeJoint.id] = targetsFromAngles(model, { [`${i ? 'right' : 'left'}.leg.knee`]: knee })[kneeJoint.id]
      frame.targets[ankle.id] = worldTarget(ankle, inSwing ? bodies.get(ankle.parent)!.rotation : shin, footHeading)
      const observedShare = feet[i].normalImpulseNs / load
      if (morrow && !this.turning && !inSwing) this.shares[i] += (observedShare - this.shares[i]) * STEP / (p.morrowLoadShareSeconds + STEP)
      else this.shares[i] = observedShare
      const share = this.shares[i], desiredCop = { ...add(feet[i].centre, scale(forward, dot(sub(o.com, feet[i].centre), forward))), y: this.floorY }
      const safeFoot = support.find(f => f.id === feet[i].id)
      const cop = safeFoot ? projectToPolygon(safeFoot.points, desiredCop) ?? safeFoot.centre : desiredCop
      for (const [depth, part] of (['thigh', 'shin', 'foot'] as const).entries()) {
        const joint = leg[part], parent = bodies.get(joint.parent)!, anchor = jointFrame(joint, parent).position
        let moment = scale(cross(sub(cop, anchor), { x: 0, y: this.mass * gravity * share, z: 0 }), -1)
        for (const distal of (['thigh', 'shin', 'foot'] as const).slice(depth)) {
          const body = bodies.get(leg[distal].child)!
          moment = sub(moment, cross(sub(body.position, anchor), { x: 0, y: -this.masses.get(body.id)! * gravity, z: 0 }))
        }
        frame.targets[joint.id] = targetOffset(joint, frame.targets[joint.id], jointTorque(joint, parent, moment)); staticMoments.set(joint.id, moment)
      }
      frame.targets[hip.id] = targetOffset(hip, frame.targets[hip.id], jointTorque(hip, root, scale(torso, -share)))
    }
    const spineBudgetHip = this.legs[0].thigh
    if (this.mass * gravity * Math.abs(spineBudgetHip.anchorParent.x) > .8 * spineBudgetHip.motor!.maxTorque) {
      const leanSide = dot(sub(feet[1 - swing].centre, feet[swing].centre), rotate(heading, { x: 1, y: 0, z: 0 }))
      if (this.spineLeanCycle !== index) {
        this.spineLeanCycle = index; this.spineLeanFrom = this.spineLeanRoll
        this.spineLeanTo = -Math.sign(leanSide) * IN_PLACE_SPINE_LEAN_RAD
      }
      const leanBlend = elapsed < p.preparationSeconds ? 0 : ease(stage / p.transferSeconds)
      let leanRoll = this.spineLeanFrom + (this.spineLeanTo - this.spineLeanFrom) * leanBlend
      if (this.stopStartTick !== null) {
        this.spineStopFrom ??= this.spineLeanRoll
        leanRoll = this.spineStopFrom * (1 - ease((o.stateTick - this.stopStartTick) * STEP / p.stopSeconds))
      }
      this.spineLeanRoll = leanRoll
      const lumbarJoint = model.scene.joints.find(j => j.child === model.parts.lumbar.bodyId)!
      const thoraxJoint = model.scene.joints.find(j => j.child === model.parts.thorax.bodyId)!
      const lumbarTarget = multiply(heading, fromRotationVector({ x: 0, y: 0, z: leanRoll / 2 }))
      const thoraxTarget = multiply(heading, fromRotationVector({ x: 0, y: 0, z: leanRoll }))
      frame.targets[lumbarJoint.id] = worldTarget(lumbarJoint, root.rotation, lumbarTarget)
      frame.targets[thoraxJoint.id] = worldTarget(thoraxJoint, lumbarTarget, thoraxTarget)
    }
    conformContactTargets(model, o, frame.targets, support)
    // Contact conform still needs the coupled reaction from the scheduled swing leg.
    if (scheduledSwing && load > 0) withGaitPredictions(model, o, predictTargets => {
      const predict = () => predictTargets(new Map(model.scene.joints.map(j => [j.id, gaitTargetEstimate(j, previous[j.id], frame.targets[j.id])])))
      const prediction = predict(), swingHip = this.legs[swing].thigh, stanceHip = this.legs[1 - swing].thigh
      swingMoment = prediction.torques.get(swingHip.id)!
      const extraSwing = sub(swingMoment, staticMoments.get(swingHip.id) ?? ZERO)
      stanceMoment = sub(sub(staticMoments.get(stanceHip.id) ?? ZERO, torso), extraSwing)
      const measured = o.joints.find(j => j.id === stanceHip.id)!
      frame.targets[stanceHip.id] = torqueTarget(stanceHip, measured.rotation, measured.angularVelocity, jointTorque(stanceHip, root, stanceMoment))
      frame.targets[stanceHip.id] = targetOffset(stanceHip, frame.targets[stanceHip.id], jointTorque(stanceHip, root, sub(stanceMoment, predict().torques.get(stanceHip.id)!)))
    })
    return { frame, diagnostics: { phase: (inSwing ? progress < .5 ? 'lift' : 'strike' : 'start') as GaitPhase,
      swing: (swing ? 'right' : 'left') as GaitSide, phaseSeconds: this.stopStartTick !== null ? (o.stateTick - this.stopStartTick) * STEP :
        inSwing ? (progress < .5 ? progress : progress - .5) * p.swingSeconds : index === 0 ? elapsed : stage,
      steps: index, headingRad: desiredYaw, torsoTorqueNm: torso, stanceHipTorqueNm: stanceMoment, swingHipTorqueNm: swingMoment } }
  }
}

export const RECOVERY_CONTROL = Object.freeze({
  ankleReserveM: .02, // Simulation default, m retained inside the sink-safe support boundary.
  hipSeconds: .05, stableSeconds: .10, // Simulation defaults, s for hip response and balance handoff.
  minimumStepSeconds: .25, maximumStepSeconds: .45, // Simulation defaults, s to contact.
  nominalStepSeconds: .32, timingErrorM: .10, // Simulation defaults, s and m of capture-point excess.
  maxHipRollMomentNm: 86, // Simulation default, N m: 80% of 120 N m minus a 10 N m reserve.
})
/** Remaining momentum capacity along the measured escape direction, using the actual convex support region. */
export function recoveryAnkleCapacity(polygon: readonly Vec3[], com: Vec3, velocity: Vec3, omega: number, massKg: number) {
  if (![com, velocity].every(finite) || !Number.isFinite(omega) || omega <= 0 || !Number.isFinite(massKg) || massKg <= 0)
    throw new RangeError('Invalid recovery capacity')
  const hull = supportHull(polygon)
  const speed = horizontalSpeed(velocity), direction = speed > 1e-10 ? { x: velocity.x / speed, y: 0, z: velocity.z / speed } : { ...ZERO }
  let marginM = 0
  if (speed > 1e-10 && (polygonMargin(hull, com) ?? -1) >= 0) {
    marginM = Infinity
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length], ex = b.x - a.x, ez = b.z - a.z
      const inward = ex * (com.z - a.z) - ez * (com.x - a.x), derivative = ex * direction.z - ez * direction.x
      if (derivative < -1e-10) marginM = Math.min(marginM, -inward / derivative)
    }
    if (!Number.isFinite(marginM)) marginM = 0
  }
  return { marginM, direction, momentumNs: massKg * speed,
    capacityNs: massKg * omega * Math.max(0, marginM - RECOVERY_CONTROL.ankleReserveM) }
}
/** Large capture errors shorten the swing, bounded by the documented recovery cadence. */
export function recoveryStepSeconds(captureExcessM: number) {
  if (!Number.isFinite(captureExcessM) || captureExcessM < 0) throw new RangeError('Invalid recovery capture excess')
  return clamp(RECOVERY_CONTROL.nominalStepSeconds - (captureExcessM / RECOVERY_CONTROL.timingErrorM) *
    (RECOVERY_CONTROL.nominalStepSeconds - RECOVERY_CONTROL.minimumStepSeconds),
  RECOVERY_CONTROL.minimumStepSeconds, RECOVERY_CONTROL.maximumStepSeconds)
}
export interface RecoveryDiagnostics {
  strategy: 'ankle' | 'hip' | 'step' | 'unsupported'; active: boolean; tick: number
  ankleCapacityNs: number; momentumNs: number; captureExcessM: number; requiredHipMomentNm: number
  stepSeconds: number; plannedSteps: number; completedSteps: number; swing: GaitSide | null
  landing: Vec3 | null; lastExit: GaitDiagnostics['recoveryExit']; waitingForUnload: boolean
}
/** Standing recovery owns no forces. Its ankle/hip requests are balance targets; a step reuses the walking swing. */
export class RecoveryController implements Behaviour {
  readonly mode = 'recover' as const
  private readonly model: PhysicalHumanoid
  private readonly balance: BalanceController
  private readonly support: SinkSafeSupport
  private readonly mass: number
  private readonly height: number
  private gait: GaitController
  private lastTick: number | null = null
  private active = false
  private stepping = false
  private hipStartTick: number | null = null
  private stableTicks = 0
  private capture: ReturnType<typeof captureState> = null
  private escape: Vec3 = { ...ZERO }
  private eligible = false
  private report: RecoveryDiagnostics = { strategy: 'ankle', active: false, tick: -1, ankleCapacityNs: 0, momentumNs: 0,
    captureExcessM: 0, requiredHipMomentNm: 0, stepSeconds: RECOVERY_CONTROL.nominalStepSeconds,
    plannedSteps: 0, completedSteps: 0, swing: null, landing: null, lastExit: null, waitingForUnload: false }
  constructor(model: PhysicalHumanoid, private readonly generation: number) {
    this.model = structuredClone(model); this.balance = new BalanceController(model, generation)
    this.gait = new GaitController(model, generation); this.support = new SinkSafeSupport(model.scene.bodies, model.feet)
    this.mass = model.scene.bodies.reduce((sum, body) => sum + (body.fixed ? 0 : body.mass), 0)
    this.height = model.scene.bodies.find(body => body.id === model.root)!.position.y
  }
  diagnostics(): RecoveryDiagnostics { return structuredClone(this.report) }
  canEnter(o: Observation, intent: Intent, retainedMode?: BehaviourMode): boolean {
    this.inspect(o)
    // This behaviour handles standing disturbances. Ordinary walking retains its own single-support capture plan.
    if (retainedMode === 'walk' || !this.eligible) return false
    const root = o.bodies.find(body => body.id === this.model.root)!, forward = rotate(root.rotation, { x: 0, y: 0, z: -1 })
    const command = mapIntent(intent, Math.atan2(-forward.x, -forward.z), o.com)
    return !moving(command) && this.needsRecovery()
  }
  done(o: Observation, _intent: Intent): boolean {
    this.inspect(o)
    if (!this.active) return true
    if (!this.eligible || !this.stepping && this.stableTicks >= Math.ceil(RECOVERY_CONTROL.stableSeconds / STEP)) {
      this.active = false; this.stepping = false; this.hipStartTick = null; this.report.active = false
      return true
    }
    return false
  }
  step(o: Observation, _intent: Intent): ActuationFrame {
    this.inspect(o)
    if (!this.eligible || !this.capture) return this.balance.step(o).frame
    this.active = true; this.report.active = true
    if (!this.stepping && this.needsRecovery()) {
      this.hipStartTick ??= o.stateTick
      const hipExpired = (o.stateTick - this.hipStartTick) * STEP >= RECOVERY_CONTROL.hipSeconds
      if (hipExpired || this.report.requiredHipMomentNm > RECOVERY_CONTROL.maxHipRollMomentNm) {
        const root = o.bodies.find(body => body.id === this.model.root)!, forward = rotate(root.rotation, { x: 0, y: 0, z: -1 })
        const yaw = Math.atan2(-forward.x, -forward.z), feet = this.model.feet.map(id => o.feet.find(foot => foot.id === id)!)
        const swing = chooseSwingFoot({ left: feet[0].normalImpulseNs, right: feet[1].normalImpulseNs }, this.escape, yaw)
        this.report.waitingForUnload = swing === null
        if (swing) {
          const stanceFoot = feet[swing === 'left' ? 1 : 0], ankle = this.model.scene.joints.find(joint => joint.child === stanceFoot.id)!
          const stanceAnkle = jointFrame(ankle, o.bodies.find(body => body.id === ankle.parent)!).position
          const seconds = recoveryStepSeconds(this.report.captureExcessM)
          const landing = landingTarget({ capturePoint: this.capture.point, cop: this.capture.cop, omega: this.capture.omega,
            stanceAnkle, swing, yawRad: yaw, hipHeightM: this.height, exitDirection: this.escape, stepTimeS: seconds })
          this.gait.beginRecovery(landing.point, swing, seconds)
          this.stepping = true; this.report.plannedSteps++; this.report.swing = swing
          this.report.landing = { ...landing.point }; this.report.stepSeconds = seconds; this.report.lastExit = null
        }
      }
    }
    if (this.stepping) {
      this.report.strategy = 'step'
      const frame = this.gait.stepVelocity(o, { velocity: { ...ZERO }, yawRateRadps: 0 }), gait = this.gait.diagnostics()
      if (gait.recoveryExit !== null) {
        this.report.lastExit = gait.recoveryExit
        if (gait.recoveryExit === 'touchdown') this.report.completedSteps++
        this.stepping = false; this.hipStartTick = null; this.stableTicks = 0
      }
      return frame
    }
    this.report.strategy = this.needsRecovery() ? 'hip' : 'ankle'
    return this.balance.step(o).frame
  }
  private needsRecovery(): boolean {
    return this.report.momentumNs > this.report.ankleCapacityNs + 1e-8 || this.report.captureExcessM > 1e-8
  }
  private inspect(o: Observation): void {
    if (o.schema_version !== 1 || o.modelVersion !== this.model.version || o.profileId !== this.model.profileId || o.actorId !== this.model.actorId ||
      o.generation !== this.generation || !Number.isSafeInteger(o.stateTick) || o.stateTick < 0 || Math.abs(o.timeS - o.stateTick * STEP) > 1e-10)
      throw new RangeError('Recovery observation identity/state mismatch')
    if (this.lastTick === o.stateTick) return
    if (this.lastTick !== null && o.stateTick < this.lastTick) throw new RangeError('Recovery observation tick must increase')
    if (this.lastTick !== null && o.stateTick !== this.lastTick + 1) {
      this.active = false; this.stepping = false; this.hipStartTick = null; this.stableTicks = 0
      this.gait = new GaitController(this.model, this.generation)
    }
    this.lastTick = o.stateTick
    const root = o.bodies.find(body => body.id === this.model.root), support = this.support.update(o)
    this.capture = captureState(o, -this.model.scene.gravity.y)
    this.eligible = !!root && !!this.capture && support.length > 0 && root.position.y >= this.height * .8 &&
      rotate(root.rotation, { x: 0, y: 1, z: 0 }).y >= .8 && !(o.floorContacts ?? []).some(contact => contact.impulse > 0 &&
        !this.model.feet.includes(contact.a === 'floor' ? contact.b : contact.a))
    this.report.tick = o.stateTick; this.report.active = this.active
    if (!this.eligible || !this.capture) { this.report.strategy = 'unsupported'; this.stableTicks = 0; return }
    const polygon = supportHull(support.flatMap(foot => foot.points)), nearest = projectToPolygon(polygon, this.capture.point)
    const capacity = recoveryAnkleCapacity(polygon, o.com, o.comVelocity, this.capture.omega, this.mass)
    this.report.ankleCapacityNs = capacity.capacityNs; this.report.momentumNs = capacity.momentumNs
    this.report.captureExcessM = nearest ? Math.hypot(this.capture.point.x - nearest.x, this.capture.point.z - nearest.z) :
      Math.hypot(this.capture.point.x - this.capture.cop.x, this.capture.point.z - this.capture.cop.z)
    this.report.requiredHipMomentNm = this.mass * -this.model.scene.gravity.y * this.report.captureExcessM
    this.escape = nearest && this.report.captureExcessM > 1e-10 ? sub(this.capture.point, nearest) : capacity.direction
    if (horizontalSpeed(this.escape) <= 1e-10) this.escape = sub(this.capture.point, this.capture.centroid)
    const stable = !this.needsRecovery() && o.feet.every(foot => foot.normalImpulseNs > 0) &&
      root!.position.y >= this.height * .9 && rotate(root!.rotation, { x: 0, y: 1, z: 0 }).y >= .98
    this.stableTicks = stable && !this.stepping ? this.stableTicks + 1 : 0
    if (stable) this.hipStartTick = null
  }
}

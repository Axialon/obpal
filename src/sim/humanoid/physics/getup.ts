/** Contact-gated get-up requests. Native motion, effort, cones and slew remain the single ActuationGate's job. */
import { STEP } from '../../physics/schema'
import { norm, rotate, conjugate, sub, scale, multiply, fromRotationVector, rotationVector, quaternion,
  type Vec3, type Quat } from '../../physics/math'
import { targetsFromAngles, type PhysicalHumanoid } from './model'
import type { Angles } from '../profile'
import type { ActuationFrame } from './contract'
import type { Observation } from './observation'
import type { Intent } from './intent'
import type { Behaviour } from './supervisor'
import { StanceController } from './stance'

/** Original simulation defaults. Distances m, angles rad, speeds m/s and rad/s, durations s. */
export const GETUP = Object.freeze({ fallUpY: .8, fallHeightFraction: .65, settledSpeedMps: .05,
  settledAngularSpeedRadS: .3, settledHoldS: .5, automaticDelayS: 1.5, settleTimeoutS: 3,
  classifyForwardY: .5, rollS: 2, handsS: 1, allFoursS: 1.5, toesS: 1.5, pikeS: 1.5,
  riseS: 2, riseBlendS: 1.2, stanceS: 2, stanceHoldS: 1, minimumPelvisM: .35,
  protectiveEaseS: .3, keyframeEaseS: .5, // simulation defaults, s; reserve contact-response time before timeout.
  pikePitchRad: 1.74, pikeTrunkRad: Math.PI / 3, comHipGainRadM: 1,
  toesShoulderPitchRad: 1.4, // simulation default, rad: retain arm extension while the toe-contact hull develops.
  riseUpY: .95, riseHeightFraction: .85, stanceUpY: .98, stanceHeightFraction: .9,
})
export type GetupPhase = 'idle' | 'protect' | 'settle' | 'roll' | 'hands' | 'all-fours' | 'toes' | 'pike' | 'rise' | 'stance' | 'complete' | 'down'
export interface GetupDiagnostics {
  phase: GetupPhase; failures: number; rollSide: -1 | 1; phaseStartedS: number; settledS: number
  reason: string | null; contactsAvailable: boolean
}
export interface GetupOptions {
  /** World recovery feasibility. The pilot has no stepping controller, so omitted means no step is possible. */
  stepPossible?: (observation: Observation) => boolean
}
const forward = { x: 0, y: 0, z: -1 }, up = { x: 0, y: 1, z: 0 }
const finite = (v: Vec3) => [v.x, v.y, v.z].every(Number.isFinite)
const nominalAngles = { 'left.arm.roll': 20 * Math.PI / 180, 'right.arm.roll': 20 * Math.PI / 180 }
/** World-up x lateral axis preserves yaw through a forward somersault; projected forward flips past 90 degrees. */
export function getupFacing(rotation: Quat, fallback: Vec3 = forward): Vec3 {
  const lateral = rotate(quaternion(rotation), { x: 1, y: 0, z: 0 }), heading = { x: lateral.z, y: 0, z: -lateral.x }, length = norm(heading)
  return length > 1e-8 ? scale(heading, 1 / length) : { ...fallback } // dimensionless numerical heading degeneracy.
}

/** Positive-pressure floor manifolds only. Body height, self-contact and another actor never manufacture a load. */
export function loadedFloorContacts(model: PhysicalHumanoid, o: Observation): Map<string, Vec3[]> | null {
  if (!o.floorContacts) return null
  const contacts = new Map<string, Vec3[]>(), ids = new Set(model.scene.bodies.filter(b => !b.fixed).map(b => b.id))
  const loaded = new Set<string>()
  for (const c of o.floorContacts) {
    if (!Number.isFinite(c.distance) || !Number.isFinite(c.impulse) || c.impulse < 0 ||
      ![c.normalOnB, c.pointA, c.pointB].every(finite)) throw new RangeError('Invalid get-up floor contact')
    const actor = c.a === 'floor' ? c.b : c.b === 'floor' ? c.a : null
    if (!actor || !ids.has(actor) || c.impulse <= 0 || c.distance > (model.scene.contact?.predictionDistance ?? .001)) continue
    const normalY = c.a === 'floor' ? c.normalOnB.y : -c.normalOnB.y
    if (normalY < .5) continue // simulation default: upward floor-normal envelope, dimensionless.
    loaded.add(actor)
  }
  for (const c of o.floorContacts) {
    const actor = c.a === 'floor' ? c.b : c.b === 'floor' ? c.a : null
    const normalY = c.a === 'floor' ? c.normalOnB.y : -c.normalOnB.y
    if (!actor || !loaded.has(actor) || normalY < .5 || c.distance > (model.scene.contact?.predictionDistance ?? .001)) continue
    const points = contacts.get(actor) ?? []; points.push({ ...(c.a === 'floor' ? c.pointB : c.pointA) }); contacts.set(actor, points)
  }
  return contacts
}
/** Fall contacts count any positive floor impulse, including edge normals, but never actor/self contacts. */
export function fallDetected(model: PhysicalHumanoid, o: Observation, stepPossible = false): boolean {
  const root = o.bodies.find(b => b.id === model.root)
  if (!root) throw new RangeError('Missing get-up pelvis')
  const dynamic = model.scene.bodies.filter(b => !b.fixed), h0 = dynamic.reduce((n, b) => n + b.mass * b.position.y, 0) / dynamic.reduce((n, b) => n + b.mass, 0)
  const nonFoot = o.floorContacts?.some(c => {
    const id = c.a === 'floor' ? c.b : c.b === 'floor' ? c.a : null
    return id !== null && model.scene.bodies.some(b => !b.fixed && b.id === id) && !model.feet.includes(id) && c.impulse > 0 &&
      c.distance <= (model.scene.contact?.predictionDistance ?? .001)
  }) ?? false
  return nonFoot || rotate(root.rotation, up).y < GETUP.fallUpY || (!stepPossible && o.com.y < GETUP.fallHeightFraction * h0)
}
export function settled(o: Observation): boolean {
  return norm(o.comVelocity) < GETUP.settledSpeedMps && o.bodies.every(b => norm(b.angularVelocity) < GETUP.settledAngularSpeedRadS)
}
export function fallPosture(model: PhysicalHumanoid, o: Observation): 'prone' | 'supine' | 'side' {
  const thorax = o.bodies.find(b => b.id === model.parts.thorax.bodyId)
  if (!thorax) throw new RangeError('Missing get-up thorax')
  const y = rotate(thorax.rotation, forward).y
  return y < -GETUP.classifyForwardY ? 'prone' : y > GETUP.classifyForwardY ? 'supine' : 'side'
}

/** Convex XZ support from genuine manifold points; collinear or absent contacts cannot support the COM. */
export function supportedBy(points: readonly Vec3[], com: Vec3): boolean {
  const sorted = points.map(p => ({ ...p })).sort((a, b) => a.x - b.x || a.z - b.z)
    .filter((p, i, a) => !i || Math.hypot(p.x - a[i - 1].x, p.z - a[i - 1].z) > 1e-8)
  const cross = (a: Vec3, b: Vec3, c: Vec3) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
  const half = (xs: Vec3[]) => { const out: Vec3[] = []; for (const p of xs) {
    while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop(); out.push(p)
  }; return out }
  const hull = [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
  return hull.length >= 3 && hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], com) >= 0)
}
function ease(a: Quat, b: Quat, fraction: number): Quat {
  const t = (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, fraction)))) / 2
  return quaternion(multiply(fromRotationVector(scale(rotationVector(multiply(b, conjugate(a))), t)), a))
}
function both(model: PhysicalHumanoid, contacts: Map<string, Vec3[]>, part: string): boolean {
  return ['left', 'right'].every(side => contacts.has(model.parts[`${side}_${part}`].bodyId))
}
function pointsOf(model: PhysicalHumanoid, contacts: Map<string, Vec3[]>, parts: string[]): Vec3[] {
  return parts.flatMap(part => ['left', 'right'].flatMap(side => contacts.get(model.parts[`${side}_${part}`].bodyId) ?? []))
}

export class GetupController implements Behaviour {
  readonly mode = 'getup' as const
  private readonly model: PhysicalHumanoid
  private readonly stance: StanceController
  private readonly standingHeightM: number
  private phase: GetupPhase = 'idle'
  private failures = 0
  private rollSide: -1 | 1 = 1
  private rollRetries = 0
  private started = 0
  private fallenAt = 0
  private stableSince: number | null = null
  private stanceSince: number | null = null
  private previousTick: number | null = null
  private entryTargets: ActuationFrame['targets'] = {}
  private reason: string | null = null
  private contactsAvailable = false
  private protectivePitch = 1.2 // simulation default, rad; latched per fall rather than flipped during impact.
  private facing: Vec3 = { ...forward }
  constructor(model: PhysicalHumanoid, private readonly generation: number, private readonly options: GetupOptions = {}) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError('Invalid get-up generation')
    this.model = structuredClone(model); this.stance = new StanceController(this.model, generation)
    this.standingHeightM = model.scene.bodies.find(b => b.id === model.root)!.position.y
    this.facing = getupFacing(model.scene.bodies.find(b => b.id === model.root)!.rotation)
  }
  canEnter(o: Observation, _intent: Intent): boolean {
    this.validate(o)
    return !['idle', 'complete'].includes(this.phase) || this.fallen(o)
  }
  done(o: Observation, _intent: Intent): boolean {
    this.validate(o); return this.phase === 'complete'
  }
  diagnostics(): GetupDiagnostics {
    return { phase: this.phase, failures: this.failures, rollSide: this.rollSide, phaseStartedS: this.started,
      settledS: !['protect', 'settle'].includes(this.phase) || this.stableSince === null || this.previousTick === null ? 0 : this.previousTick * STEP - this.stableSince,
      reason: this.reason, contactsAvailable: this.contactsAvailable }
  }
  private validate(o: Observation) {
    if (o.schema_version !== 1 || o.modelVersion !== this.model.version || o.profileId !== this.model.profileId ||
      o.actorId !== this.model.actorId || o.generation !== this.generation || !Number.isSafeInteger(o.stateTick) || o.stateTick < 0 ||
      !Number.isFinite(o.timeS) || Math.abs(o.timeS - o.stateTick * STEP) > 1e-10 || !finite(o.com) || !finite(o.comVelocity))
      throw new RangeError('Get-up observation identity/state mismatch')
    if (new Set(o.bodies.map(b => b.id)).size !== o.bodies.length || o.bodies.length !== this.model.scene.bodies.filter(b => !b.fixed).length || this.model.scene.bodies.some(b => !b.fixed && !o.bodies.some(s => s.id === b.id)) ||
      o.bodies.some(b => !finite(b.position) || !finite(b.velocity) || !finite(b.angularVelocity) || !finite(b.rotation) || Math.abs(norm(b.rotation) ** 2 + b.rotation.w ** 2 - 1) > 1e-4 || !Number.isFinite(b.rotation.w)))
      throw new RangeError('Invalid get-up body')
    if (o.joints.length !== this.model.scene.joints.length || new Set(o.joints.map(j => j.id)).size !== o.joints.length ||
      o.joints.some(j => !this.model.scene.joints.some(s => s.id === j.id))) throw new RangeError('Missing get-up joint')
    for (const j of o.joints) quaternion(j.rotation)
    if (o.feet.some(f => !finite(f.centre) || !f.contactPoints.every(finite))) throw new RangeError('Invalid get-up foot')
  }
  private fallen(o: Observation) {
    const stepPossible = this.options.stepPossible?.(o) ?? false
    if (typeof stepPossible !== 'boolean') throw new RangeError('Invalid get-up step feasibility')
    return fallDetected(this.model, o, stepPossible)
  }
  private enter(phase: GetupPhase, o: Observation) {
    this.phase = phase; this.started = o.timeS; this.stanceSince = null
    this.entryTargets = Object.fromEntries(o.joints.map(j => [j.id, { ...j.rotation }]))
  }
  private beginFall(o: Observation) {
    const root = o.bodies.find(b => b.id === this.model.root)!, tilt = rotate(root.rotation, up)
    const face = this.facing = getupFacing(root.rotation, this.facing)
    const fall = norm(o.comVelocity) >= GETUP.settledSpeedMps ? o.comVelocity : tilt
    const posture = fallPosture(this.model, o)
    this.protectivePitch = posture === 'prone' ? 1.2 : posture === 'supine' ? -1.2 :
      fall.x * face.x + fall.z * face.z < 0 ? -1.2 : 1.2
    this.stableSince = null; this.fallenAt = o.timeS; this.enter('protect', o)
  }
  private fail(o: Observation, reason: string) {
    this.reason = reason; this.failures++
    if (this.failures >= 2) this.enter('down', o)
    else this.beginFall(o)
  }
  /** One call per native tick. A timeout retries; elapsed time alone never satisfies a phase post-condition. */
  step(o: Observation, intent: Intent): ActuationFrame {
    this.validate(o)
    if (this.previousTick !== null && (o.stateTick <= this.previousTick ||
      (!['idle', 'complete'].includes(this.phase) && o.stateTick !== this.previousTick + 1))) throw new RangeError('Get-up tick is stale or reordered')
    const contacts = loadedFloorContacts(this.model, o), balanceTargets = this.stance.step(o).frame.targets
    const newlyFallen = ['idle', 'complete'].includes(this.phase) && this.fallen(o)
    this.contactsAvailable = contacts !== null
    this.previousTick = o.stateTick
    const root = o.bodies.find(b => b.id === this.model.root)!, rootUp = rotate(root.rotation, up).y
    if (newlyFallen) {
      this.failures = 0; this.rollRetries = 0; this.rollSide = 1; this.reason = null; this.stableSince = null
      this.beginFall(o)
    }
    if (this.phase === 'protect' || this.phase === 'settle') {
      const stable = settled(o), grounded = contacts !== null && [...contacts.keys()].some(id => !this.model.feet.includes(id))
      if (this.phase === 'protect' && (stable || (grounded && o.timeS - this.fallenAt >= GETUP.protectiveEaseS))) this.enter('settle', o)
      if (stable) this.stableSince ??= o.timeS
      else this.stableSince = null
      if (this.stableSince !== null && o.timeS - this.stableSince + 1e-10 >= GETUP.settledHoldS &&
        (intent.command === 'getup' || o.timeS - this.fallenAt + 1e-10 >= GETUP.automaticDelayS)) {
        this.enter(fallPosture(this.model, o) === 'prone' ? 'hands' : 'roll', o)
      } else if (o.timeS - this.fallenAt >= GETUP.settleTimeoutS) this.fail(o, 'fall did not settle')
    }
    const elapsed = o.timeS - this.started
    if (this.phase === 'roll') {
      if (fallPosture(this.model, o) === 'prone') this.enter('hands', o)
      else if (elapsed >= GETUP.rollS) {
        this.reason = 'roll did not reach prone'; this.failures++
        if (this.rollRetries === 0 && this.failures < 2) {
          this.rollRetries++; this.rollSide = this.rollSide === 1 ? -1 : 1; this.enter('roll', o)
        } else this.enter('down', o)
      }
    } else if (['hands', 'all-fours', 'toes', 'pike', 'rise', 'stance'].includes(this.phase)) {
      let passed = false, next: GetupPhase = 'down', timeout = 0
      if (this.phase === 'hands') { passed = contacts !== null && both(this.model, contacts, 'hand'); next = 'all-fours'; timeout = GETUP.handsS }
      if (this.phase === 'all-fours') { passed = contacts !== null && both(this.model, contacts, 'hand') && both(this.model, contacts, 'shin') && root.position.y >= GETUP.minimumPelvisM; next = 'toes'; timeout = GETUP.allFoursS }
      if (this.phase === 'toes') { passed = contacts !== null && both(this.model, contacts, 'foot') && supportedBy(pointsOf(this.model, contacts, ['hand', 'foot']), o.com); next = 'pike'; timeout = GETUP.toesS }
      if (this.phase === 'pike') {
        passed = contacts !== null && both(this.model, contacts, 'foot') && supportedBy(pointsOf(this.model, contacts, ['foot']), o.com)
        next = 'rise'; timeout = GETUP.pikeS
      }
      if (this.phase === 'rise') { passed = elapsed >= GETUP.riseBlendS && rootUp >= GETUP.riseUpY && root.position.y >= GETUP.riseHeightFraction * this.standingHeightM; next = 'stance'; timeout = GETUP.riseS }
      if (this.phase === 'stance') {
        const envelope = rootUp >= GETUP.stanceUpY && root.position.y >= GETUP.stanceHeightFraction * this.standingHeightM &&
          o.feet.every(f => f.normalImpulseNs > 0) && o.support.marginM !== null && o.support.marginM >= 0
        if (envelope) this.stanceSince ??= o.timeS; else this.stanceSince = null
        passed = this.stanceSince !== null && o.timeS - this.stanceSince + 1e-10 >= GETUP.stanceHoldS
        next = 'complete'; timeout = GETUP.stanceS
      }
      // Complete the cosine request before allowing a pre-existing load to skip the keyframe.
      if (passed && (['rise', 'stance'].includes(this.phase) || elapsed + 1e-10 >= GETUP.keyframeEaseS)) this.enter(next, o)
      else if (elapsed >= timeout) this.fail(o, `${this.phase} post-condition timed out${contacts === null ? ': floor contacts unavailable' : ''}`)
    }
    let targets: ActuationFrame['targets']
    if (this.phase === 'down') targets = Object.fromEntries(o.joints.map(j => [j.id, { ...j.rotation }]))
    // After impact, hold the contact-compatible measured pose while damping dissipates motion. Protective
    // reaching must not keep driving hands into the floor throughout the strict all-link settling test.
    else if (this.phase === 'settle') targets = structuredClone(this.entryTargets)
    else if (['idle', 'stance', 'complete'].includes(this.phase)) targets = balanceTargets
    else {
      const desired = this.keyframe(o), duration = this.phase === 'rise' ? GETUP.riseBlendS :
        this.phase === 'roll' ? GETUP.rollS : this.phase === 'protect' ? GETUP.protectiveEaseS : GETUP.keyframeEaseS
      const key = targetsFromAngles(this.model, desired), t = (o.timeS - this.started) / duration
      targets = Object.fromEntries(this.model.scene.joints.map(j => [j.id, ease(this.entryTargets[j.id], key[j.id], t)]))
      if (this.phase === 'rise') {
        for (const j of this.model.scene.joints) if (this.model.feet.includes(j.child)) targets[j.id] = balanceTargets[j.id]
      }
    }
    return { schema_version: 1, profileId: this.model.profileId, actorId: this.model.actorId, generation: this.generation,
      tick: o.stateTick, source: 'classical', targets }
  }
  private keyframe(o: Observation): Angles {
    const q: Angles = { ...nominalAngles }, set = (part: string, angle: string, n: number) => {
      for (const side of ['left', 'right']) q[`${side}.${part}.${angle}`] = n
    }
    if (this.phase === 'protect') {
      set('arm', 'pitch', this.protectivePitch); set('arm', 'elbow', .3); set('leg', 'knee', .4)
    } else if (this.phase === 'roll') {
      const far = this.rollSide === 1 ? 'left' : 'right'
      q['head.yaw'] = this.rollSide * .6; q['spine.yaw'] = this.rollSide * .3
      q[`${far}.arm.pitch`] = 1.2; q[`${far}.arm.roll`] = -.2
      q[`${far}.leg.pitch`] = .8; q[`${far}.leg.roll`] = -.3
    } else {
      set('arm', 'pitch', 1.4); set('arm', 'roll', .3); set('arm', 'elbow', 1.9)
      if (this.phase !== 'hands') {
        set('arm', 'elbow', .15); set('leg', 'pitch', 1.5); set('leg', 'knee', 1.6)
      }
      if (['toes', 'pike', 'rise'].includes(this.phase)) {
        set('leg', 'ankle.pitch', .43); set('leg', 'knee', 1.1)
        set('arm', 'pitch', this.phase === 'toes' ? GETUP.toesShoulderPitchRad : .9)
      }
      if (this.phase === 'pike') {
        const feet = o.feet.map(f => f.centre), centre = scale(feet.reduce((v, p) => ({ x: v.x + p.x, y: v.y + p.y, z: v.z + p.z }), { x: 0, y: 0, z: 0 }), .5)
        const error = sub(o.com, centre), behindM = -(error.x * this.facing.x + error.z * this.facing.z)
        set('leg', 'pitch', GETUP.pikePitchRad + GETUP.comHipGainRadM * behindM)
      }
      if (this.phase === 'rise') { set('leg', 'pitch', 0); set('leg', 'knee', .05); set('leg', 'ankle.pitch', 0); set('arm', 'pitch', 0); set('arm', 'elbow', 0) }
    }
    return q
  }
}

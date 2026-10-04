/** BODY and preset joint targets. Legs own balance; torso pitch/roll are requests to their controller. */
import { STEP } from '../../physics/schema'
import { clamp, conjugate, fromRotationVector, multiply, quaternion, rotationVector, scale, swingTwist, type Quat } from '../../physics/math'
import type { Angles } from '../profile'
import type { Retargeted } from '../retarget'
import type { ActuationFrame } from './contract'
import { targetsFromAngles, type PhysicalHumanoid } from './model'
import type { Observation } from './observation'
import type { BehaviourMode } from './supervisor'

/** Original simulation defaults. Acquisition/loss are seconds; spine clamp is radians; margin is metres. */
export const BODY_CONTROL = Object.freeze({ acquisitionS: .15, lossS: .25, spineClampRad: .15, shoulderMarginM: .04 })
export const BODY_MODE_WEIGHT: Readonly<Record<BehaviourMode, number>> = Object.freeze({
  stance: 1, balance: 1, walk: .8, recover: .3, fall: 0, getup: 0,
})
export interface UpperBodyInput {
  mode: BehaviourMode
  body?: Retargeted | null
  /** Capture-point margin, not the COM margin. Omit to calculate from the observation's loaded footprint. */
  captureMarginM?: number | null
  /** Existing presetPose output; only upper-body angles are consumed. */
  preset?: Angles | null
}
export interface UpperBodyResult {
  frame: ActuationFrame
  /** Add to the desired world torso pitch/roll before calculating stance-hip targets. Never apply to the root. */
  torsoOffset: { pitchRad: number; rollRad: number }
  diagnostics: { trackWeight: number; modeWeight: number; bodyWeight: number; shoulderMarginWeight: number;
    captureMarginM: number | null; inputGeneration: number | null; jointWeights: Record<string, number> }
}
const lerp = (a: number, b: number, w: number) => a + (b - a) * w
const slerp = (a: Quat, b: Quat, w: number) => w <= 0 ? { ...a } : w >= 1 ? { ...b }
  : quaternion(multiply(fromRotationVector(scale(rotationVector(multiply(b, conjugate(a))), w)), a))
const split = (q: Quat) => {
  const s = swingTwist(q)
  return { swing: fromRotationVector({ x: 0, y: s.swingY, z: s.swingZ }), twist: fromRotationVector({ x: s.twist, y: 0, z: 0 }) }
}
/** Signed distance from the measured capture point to the footprint's nearest edge. Null means unavailable support. */
export function bodyCaptureMarginM(o: Observation, gravityMps2 = 9.81): number | null {
  const polygon = o.support.polygon, load = o.feet.reduce((n, f) => n + f.normalImpulseNs, 0)
  if (polygon.length < 3 || !Number.isFinite(load) || load <= 0 || o.feet.some(f => f.normalImpulseNs > 0 && !f.centreOfPressure)) return null
  const copY = o.feet.reduce((n, f) => n + (f.normalImpulseNs > 0 ? f.normalImpulseNs * f.centreOfPressure!.y : 0), 0) / load
  const h = o.com.y - copY
  if (!Number.isFinite(h) || h <= 0 || !Number.isFinite(gravityMps2) || gravityMps2 <= 0) return null
  const omega = Math.sqrt(gravityMps2 / h), x = o.com.x + o.comVelocity.x / omega, z = o.com.z + o.comVelocity.z / omega
  const area = polygon.reduce((n, a, i) => { const b = polygon[(i + 1) % polygon.length]; return n + a.x * b.z - b.x * a.z }, 0)
  if (!Number.isFinite(area) || area === 0 || !Number.isFinite(x) || !Number.isFinite(z)) return null
  const distances = polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length], length = Math.hypot(b.x - a.x, b.z - a.z)
    return Math.sign(area) * ((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)) / length
  })
  return distances.every(Number.isFinite) ? Math.min(...distances) : null
}
export class UpperBodyController {
  private readonly model: PhysicalHumanoid
  private tick: number | null = null
  private inputGeneration: number | null = null
  private trackWeight = 0
  private held: Angles = {}
  private readonly names: Set<string>
  constructor(model: PhysicalHumanoid, private readonly generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError('Invalid upper-body generation')
    this.model = structuredClone(model)
    this.names = new Set(model.drives.flatMap(d => d.axes).filter(n => n.includes('.arm.') || n.startsWith('head.') || n.startsWith('spine.')))
  }
  private angles(q: Angles): Angles {
    const result: Angles = {}
    for (const name of this.names) if (Object.prototype.hasOwnProperty.call(q, name)) {
      if (!Number.isFinite(q[name])) throw new RangeError('Invalid upper-body angle')
      result[name] = q[name]
    }
    return result
  }
  /** Fixed-tick merge only. The caller submits this complete frame through its single ActuationGate. */
  step(o: Observation, legs: ActuationFrame, input: UpperBodyInput): UpperBodyResult {
    const model = this.model, modeWeight = BODY_MODE_WEIGHT[input.mode]
    if (o.schema_version !== 1 || o.modelVersion !== model.version || o.profileId !== model.profileId || o.actorId !== model.actorId || o.generation !== this.generation ||
      !Number.isSafeInteger(o.stateTick) || o.stateTick < 0 || o.stateTick === Number.MAX_SAFE_INTEGER ||
      (this.tick !== null && o.stateTick !== this.tick + 1) || !Number.isFinite(o.timeS) || Math.abs(o.timeS - o.stateTick * STEP) > 1e-10 ||
      legs.schema_version !== 1 || legs.profileId !== model.profileId || legs.actorId !== model.actorId || legs.generation !== this.generation || legs.tick !== o.stateTick ||
      modeWeight === undefined) throw new RangeError('Upper-body identity/state mismatch')
    if (Object.keys(legs.targets).length !== model.drives.length || model.drives.some(d => !Object.prototype.hasOwnProperty.call(legs.targets, d.id)))
      throw new RangeError('Incomplete upper-body base frame')
    for (const target of Object.values(legs.targets)) quaternion(target)
    const margin = input.captureMarginM === undefined ? bodyCaptureMarginM(o, -model.scene.gravity.y) : input.captureMarginM
    if (margin !== null && !Number.isFinite(margin)) throw new RangeError('Invalid BODY margin')
    const shoulderMarginWeight = .5 + .5 * clamp((margin ?? 0) / BODY_CONTROL.shoulderMarginM, 0, 1)
    const preset = this.angles(input.preset ?? {}), body = input.body
    const tracked = !!body?.tracked && (this.inputGeneration === null || body.generation >= this.inputGeneration)
    let held = this.held, trackWeight = this.trackWeight, inputGeneration = this.inputGeneration
    if (tracked) {
      if (!Number.isSafeInteger(body!.generation) || body!.generation < 0) throw new RangeError('Invalid BODY generation')
      held = this.angles(body!.q)
      if (body!.generation !== inputGeneration) { trackWeight = 0; inputGeneration = body!.generation }
      trackWeight = Math.min(1, trackWeight + STEP / BODY_CONTROL.acquisitionS)
    } else {
      // Retargeter already handles packet freshness. Hold the last angles while fading, with no second hold delay.
      trackWeight = Math.max(0, trackWeight - STEP / BODY_CONTROL.lossS)
    }
    const bodyWeight = trackWeight * modeWeight
    const yawTargets = (q: Angles) => targetsFromAngles(model, { ...q, 'spine.pitch': 0, 'spine.roll': 0 })
    const bodyTargets = yawTargets(held), presetTargets = yawTargets(preset), targets = structuredClone(legs.targets), jointWeights: Record<string, number> = {}
    for (const drive of model.drives) {
      if (!drive.axes.some(n => this.names.has(n))) continue
      const spine = drive.axes.includes('spine.yaw'), shoulder = drive.axes.some(n => n.endsWith('.arm.pitch'))
      let base = legs.targets[drive.id]
      const hasPreset = drive.axes.some(n => Object.prototype.hasOwnProperty.call(preset, n))
      if (hasPreset && modeWeight > 0) {
        if (spine) {
          const a = split(base), b = split(presetTargets[drive.id])
          base = quaternion(multiply(a.swing, slerp(a.twist, b.twist, modeWeight)))
        } else base = slerp(base, presetTargets[drive.id], modeWeight)
      }
      if (bodyWeight === 0) {
        targets[drive.id] = { ...base }; jointWeights[drive.id] = 0; continue
      }
      if (spine || shoulder) {
        const a = split(base), b = split(bodyTargets[drive.id])
        const swingWeight = spine ? 0 : bodyWeight * shoulderMarginWeight
        // Joint X is yaw in these authored frames. Shoulder margin attenuates pitch/roll only; spine swing stays with legs.
        targets[drive.id] = quaternion(multiply(slerp(a.swing, b.swing, swingWeight), slerp(a.twist, b.twist, bodyWeight)))
      } else targets[drive.id] = slerp(base, bodyTargets[drive.id], bodyWeight)
      jointWeights[drive.id] = bodyWeight * (shoulder ? shoulderMarginWeight : 1)
    }
    const offset = (name: string) => lerp(clamp(preset[name] ?? 0, -BODY_CONTROL.spineClampRad, BODY_CONTROL.spineClampRad) * modeWeight,
      clamp(held[name] ?? 0, -BODY_CONTROL.spineClampRad, BODY_CONTROL.spineClampRad) * modeWeight, trackWeight)
    const frame: ActuationFrame = { ...legs, source: bodyWeight >= .5 ? 'body' : 'classical', targets }
    this.tick = o.stateTick; this.held = held; this.trackWeight = trackWeight; this.inputGeneration = inputGeneration
    return { frame, torsoOffset: { pitchRad: offset('spine.pitch'), rollRad: offset('spine.roll') }, diagnostics: {
      trackWeight, modeWeight, bodyWeight, shoulderMarginWeight, captureMarginM: margin, inputGeneration, jointWeights,
    } }
  }
}

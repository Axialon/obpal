/** Pure capture and recovery-step geometry. Requests still leave the controller through ActuationGate. */
import { add, sub, scale, cross, rotate, conjugate, clamp, type Vec3, type Quat } from '../../physics/math'
import { STEP, type Body } from '../../physics/schema'
import { bodyInertia } from '../../physics/servo'
import type { Observation } from './observation'

export const SUPPORT_SHRINK_M = .02 // Simulation default, m: inward support margin.
export const STEP_OUTSIDE_M = .03 // Simulation default, m beyond the shrunken support polygon.
export const STEP_SPEED_MPS = .35 // Simulation default, m/s of horizontal COM speed.
export const STEP_TIME_S = .32 // Simulation default, s before the predicted touchdown.
export const STEP_OVERSHOOT_M = .03 // Simulation default, m along the capture exit.
export const STEP_MIN_WIDTH_M = .20 // Simulation default, m from the stance ankle.
export const STEP_MAX_LOAD_SHARE = .6 // Simulation default, dimensionless: exit-side foot may lift.
const EPS = 1e-10 // Numerical tolerance for horizontal geometry, not a control threshold.
const cross2 = (a: Vec3, b: Vec3, c: Vec3) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
const finite = (p: Vec3) => [p.x, p.y, p.z].every(Number.isFinite)

export const CONTACT_CONTROL = Object.freeze({
  cornerFrequencySquared: 142500, // Simulation default, s^-2, fitted to native box-floor contacts.
  sinkBudgetM: .004, rhoCap: .85, // Simulation defaults, m and dimensionless COP radius.
  trimStartM: .0035, trimRatePerS: 4, restoreRatePerS: .05, // Simulation defaults, m and s^-1.
  flatTiltRad: .5 * Math.PI / 180, conformSeconds: .08, blendSeconds: .06, copGain: .5, // Simulation defaults, rad, s and dimensionless.
})
/** Four loaded sole corners. The fitted spring law is validated at the corner-mass inertia bound. */
export function contactSink(foot: Body, normalForceN: number) {
  if (foot.fixed || foot.shape.kind !== 'box' || !Number.isFinite(normalForceN) || normalForceN < 0)
    throw new RangeError('Invalid sole sink input')
  const h = foot.shape.half, inertia = bodyInertia(foot)
  const effectiveMassKg = 1 / (1 / foot.mass + h.z ** 2 / inertia.x + h.x ** 2 / inertia.z)
  const stiffnessNpm = effectiveMassKg * CONTACT_CONTROL.cornerFrequencySquared
  return { effectiveMassKg, stiffnessNpm, centredSinkM: normalForceN / (4 * stiffnessNpm) }
}
/** Load-dependent COP diamond in world XZ, centred on the sole rather than the ankle anchor. */
export function sinkSafeDiamond(foot: Body, normalForceN: number, trim = 1, rhoCap: number = CONTACT_CONTROL.rhoCap) {
  if (!Number.isFinite(trim) || trim < 0 || trim > 1) throw new RangeError('Invalid sink trim')
  if (!Number.isFinite(rhoCap) || rhoCap < 0 || rhoCap > .95) throw new RangeError('Invalid sink radius')
  const sink = contactSink(foot, normalForceN), h = (foot.shape as { kind: 'box'; half: Vec3 }).half
  const rho = clamp(CONTACT_CONTROL.sinkBudgetM / Math.max(sink.centredSinkM, 1e-30) - 1, 0, rhoCap) * trim
  const centre = add(foot.position, rotate(foot.rotation, { x: 0, y: -h.y, z: 0 }))
  const points = [{ x: -h.x * rho, y: 0, z: 0 }, { x: 0, y: 0, z: -h.z * rho },
    { x: h.x * rho, y: 0, z: 0 }, { x: 0, y: 0, z: h.z * rho }]
    .map(p => ({ ...add(centre, rotate(foot.rotation, p)), y: centre.y }))
  return { ...sink, rho, centre, points: supportHull(points) }
}
export interface SinkSupportFoot extends ReturnType<typeof sinkSafeDiamond> {
  id: string; normalForceN: number; trim: number; deepestM: number
  tiltRad: number; contactSeconds: number; contactBlend: number; lateConform: boolean; measuredCop: Vec3
}
/** Observation-only depth trim. Repeated reads cannot advance its clock; missed ticks reset its history. */
export class SinkSafeSupport {
  private readonly feet: Body[]
  private lastTick = -1
  private trims = new Map<string, number>()
  private contacts = new Map<string, { first: number; flat: number | null }>()
  private current: SinkSupportFoot[] = []
  constructor(bodies: readonly Body[], footIds: readonly string[]) {
    this.feet = footIds.map(id => {
      const foot = bodies.find(b => b.id === id)
      if (!foot || foot.fixed || foot.shape.kind !== 'box') throw new RangeError('Missing sink-safe sole')
      return structuredClone(foot)
    })
  }
  update(o: Observation): SinkSupportFoot[] {
    const advance = o.stateTick !== this.lastTick
    if (advance && o.stateTick !== this.lastTick + 1) { this.trims.clear(); this.contacts.clear() }
    this.current = this.feet.flatMap(spec => {
      const measured = o.feet.find(f => f.id === spec.id), body = o.bodies.find(b => b.id === spec.id)
      if (!measured || !body || !Number.isFinite(measured.minSoleY) || !Number.isFinite(measured.normalImpulseNs) || measured.normalImpulseNs < 0)
        throw new RangeError('Invalid sink-safe observation')
      const deepestM = Math.max(0, -measured.minSoleY), previous = this.trims.get(spec.id) ?? 1
      const trim = clamp(previous + (advance ? STEP * (deepestM > CONTACT_CONTROL.trimStartM ? -CONTACT_CONTROL.trimRatePerS : CONTACT_CONTROL.restoreRatePerS) : 0), 0, 1)
      this.trims.set(spec.id, trim)
      if (measured.normalImpulseNs <= 0) { this.contacts.delete(spec.id); return [] }
      const normalForceN = measured.normalImpulseNs / STEP
      const tiltRad = Math.acos(clamp(rotate(body.rotation, { x: 0, y: 1, z: 0 }).y, -1, 1))
      const contact = this.contacts.get(spec.id) ?? { first: o.stateTick, flat: null }
      if (contact.flat === null && tiltRad <= CONTACT_CONTROL.flatTiltRad && supportHull(measured.contactPoints).length >= 3) contact.flat = o.stateTick
      this.contacts.set(spec.id, contact)
      const contactSeconds = (o.stateTick - contact.first) * STEP
      const contactBlend = contact.flat === null ? 0 : clamp((o.stateTick - contact.flat) * STEP / CONTACT_CONTROL.blendSeconds, 0, 1)
      return [{ ...sinkSafeDiamond({ ...spec, ...body }, normalForceN, trim), id: spec.id, normalForceN, trim, deepestM,
        tiltRad, contactSeconds, contactBlend, lateConform: contact.flat === null && contactSeconds >= CONTACT_CONTROL.conformSeconds,
        measuredCop: measured.centreOfPressure ? { ...measured.centreOfPressure } : { ...measured.centre } }]
    })
    this.lastTick = o.stateTick
    return this.current
  }
}
/** Zero-moment landing conform, followed by measured COP feedback. The caller inverts only a target offset. */
export function conformAnkleMoment(foot: SinkSupportFoot, anchor: Vec3, desired: Vec3): Vec3 {
  const measured = scale(cross(sub(foot.measuredCop, anchor), { x: 0, y: foot.normalForceN, z: 0 }), -1)
  return scale(add(desired, scale(sub(desired, measured), CONTACT_CONTROL.copGain)), foot.contactBlend)
}
/** Clip a foot moment through its implied COP, retaining only the bounded ankle share. */
export function sinkSafeAnkleMoment(foot: SinkSupportFoot, anchor: Vec3, force: Vec3, moment: Vec3): { moment: Vec3; residual: Vec3; cop: Vec3 } {
  if (![anchor, force, moment].every(finite) || force.y <= 0) throw new RangeError('Invalid ankle support moment')
  const height = foot.centre.y - anchor.y
  const implied = { x: anchor.x + (-moment.z + height * force.x) / force.y, y: foot.centre.y,
    z: anchor.z + (moment.x + height * force.z) / force.y }
  const cop = projectToPolygon(foot.points, implied) ?? foot.centre
  const bounded = scale(cross(sub(cop, anchor), force), -1)
  bounded.y = moment.y
  return { moment: bounded, residual: sub(moment, bounded), cop }
}

/** Counterclockwise hull in world XZ. Contact heights are carried through, never used to invent support. */
export function supportHull(points: readonly Vec3[]): Vec3[] {
  if (points.some(p => !finite(p))) throw new RangeError('Invalid support point')
  const sorted = points.map(p => ({ ...p })).sort((a, b) => a.x - b.x || a.z - b.z)
    .filter((p, i, a) => !i || Math.hypot(p.x - a[i - 1].x, p.z - a[i - 1].z) > EPS)
  if (sorted.length < 3) return sorted
  const half = (xs: Vec3[]) => {
    const out: Vec3[] = []
    for (const p of xs) { while (out.length >= 2 && cross2(out[out.length - 2], out[out.length - 1], p) <= EPS) out.pop(); out.push(p) }
    return out
  }
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
}

/** Intersect the inward-offset edge half-planes; this preserves rotated and nonrectangular footprints. */
export function shrinkPolygon(points: readonly Vec3[], insetM: number): Vec3[] {
  if (!Number.isFinite(insetM) || insetM < 0) throw new RangeError('Invalid support inset')
  const hull = supportHull(points)
  if (hull.length < 3) return []
  let out = hull
  for (let i = 0; i < hull.length && out.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], length = Math.hypot(b.x - a.x, b.z - a.z)
    const distance = (p: Vec3) => cross2(a, b, p) / length - insetM
    const clipped: Vec3[] = []
    for (let j = 0; j < out.length; j++) {
      const p = out[j], q = out[(j + 1) % out.length], dp = distance(p), dq = distance(q)
      if (dp >= 0) clipped.push({ ...p })
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq)
        clipped.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y), z: p.z + t * (q.z - p.z) })
      }
    }
    out = clipped
  }
  const shrunk = supportHull(out)
  return shrunk.length >= 3 ? shrunk : []
}

export function polygonCentroid(points: readonly Vec3[]): Vec3 | null {
  const hull = supportHull(points)
  if (hull.length < 3) return null
  let area2 = 0, x = 0, z = 0
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], cross = a.x * b.z - b.x * a.z
    area2 += cross; x += (a.x + b.x) * cross; z += (a.z + b.z) * cross
  }
  if (area2 <= EPS) return null
  return { x: x / (3 * area2), y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length, z: z / (3 * area2) }
}

/** Minimum signed edge distance: positive inside, zero on an edge, negative outside. */
export function polygonMargin(points: readonly Vec3[], point: Vec3): number | null {
  if (!finite(point)) throw new RangeError('Invalid polygon query')
  const hull = supportHull(points)
  return hull.length < 3 ? null : Math.min(...hull.map((a, i) => {
    const b = hull[(i + 1) % hull.length]
    return cross2(a, b, point) / Math.hypot(b.x - a.x, b.z - a.z)
  }))
}

/** Euclidean nearest point in the horizontal convex polygon, including its boundary. */
export function projectToPolygon(points: readonly Vec3[], point: Vec3): Vec3 | null {
  const hull = supportHull(points), margin = polygonMargin(hull, point)
  if (margin === null) return null
  if (margin >= 0) return { ...point, y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length }
  let nearest = { ...hull[0] }, distance2 = Infinity
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], dx = b.x - a.x, dz = b.z - a.z
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz)))
    const p = { x: a.x + t * dx, y: a.y + t * (b.y - a.y), z: a.z + t * dz }
    const d2 = (point.x - p.x) ** 2 + (point.z - p.z) ** 2
    if (d2 < distance2) { distance2 = d2; nearest = p }
  }
  return nearest
}

export interface CapturePoint { heightM: number; omega: number; point: Vec3 }
export interface AngularMomentumState {
  /** World angular momentum about the fixed contact pivot, kg m^2/s, including each body's spin. */
  angularMomentum: Vec3
  massKg: number; heightM: number
  /** Horizontal velocity with the same contact angular momentum in the constant-height pendulum, m/s. */
  equivalentVelocity: Vec3
}
/** ALIP state about a stationary pivot. The y-up signs are vx=-Lz/(mH), vz=Lx/(mH). */
export function angularMomentumState(bodies: readonly Body[], o: Pick<Observation, 'bodies' | 'com'>, pivot: Vec3): AngularMomentumState {
  if (![o.com, pivot].every(finite)) throw new RangeError('Invalid angular momentum pivot')
  let angularMomentum: Vec3 = { x: 0, y: 0, z: 0 }, massKg = 0
  for (const spec of bodies) {
    if (spec.fixed) continue
    const body = o.bodies.find(b => b.id === spec.id)
    if (!body || ![body.position, body.velocity, body.angularVelocity, body.rotation].every(finite) ||
      !Number.isFinite(body.rotation.w) || !Number.isFinite(spec.mass) || spec.mass <= 0)
      throw new RangeError('Invalid angular momentum body')
    const inertia = bodyInertia(spec), localVelocity = rotate(conjugate(body.rotation), body.angularVelocity)
    const spin = rotate(body.rotation, { x: inertia.x * localVelocity.x, y: inertia.y * localVelocity.y, z: inertia.z * localVelocity.z })
    angularMomentum = add(angularMomentum, add(cross(sub(body.position, pivot), scale(body.velocity, spec.mass)), spin))
    massKg += spec.mass
  }
  const heightM = o.com.y - pivot.y
  if (!(heightM > 0) || !Number.isFinite(heightM) || !(massKg > 0) || !Number.isFinite(massKg) || !finite(angularMomentum))
    throw new RangeError('Invalid angular momentum state')
  const equivalentVelocity = { x: -angularMomentum.z / (massKg * heightM), y: 0, z: angularMomentum.x / (massKg * heightM) }
  if (!finite(equivalentVelocity)) throw new RangeError('Invalid angular momentum velocity')
  return { angularMomentum, massKg, heightM, equivalentVelocity }
}

/** Invert one constant-height pendulum step after a fixed-pivot touchdown; no impact impulse is assumed. */
export function alipStepPlacement(positionM: number, velocityMps: number, omegaPerS: number, remainingSeconds: number,
  stepSeconds: number, targetVelocityMps: number, momentumRetention = 0) {
  if (![positionM, velocityMps, omegaPerS, remainingSeconds, stepSeconds, targetVelocityMps, momentumRetention].every(Number.isFinite) ||
    omegaPerS <= 0 || remainingSeconds < 0 || stepSeconds <= 0 || momentumRetention < 0 || momentumRetention > 1)
    throw new RangeError('Invalid ALIP step')
  const c = Math.cosh(omegaPerS * remainingSeconds), s = Math.sinh(omegaPerS * remainingSeconds)
  const cT = Math.cosh(omegaPerS * stepSeconds), sT = Math.sinh(omegaPerS * stepSeconds)
  const touchdownPositionM = c * positionM + s * velocityMps / omegaPerS
  const touchdownVelocityMps = omegaPerS * s * positionM + c * velocityMps
  const nextRelativePositionM = ((1 - momentumRetention) * targetVelocityMps + (momentumRetention - cT) * touchdownVelocityMps) / (omegaPerS * sT)
  const footOffsetM = touchdownPositionM - nextRelativePositionM
  const terminalVelocityMps = omegaPerS * sT * nextRelativePositionM + cT * touchdownVelocityMps
  if (![footOffsetM, touchdownPositionM, touchdownVelocityMps, nextRelativePositionM, terminalVelocityMps].every(Number.isFinite))
    throw new RangeError('Invalid ALIP prediction')
  return { footOffsetM, touchdownPositionM, touchdownVelocityMps, nextRelativePositionM, terminalVelocityMps }
}

/** Sole-centre landing under fixed height, a stationary COP and a yaw-only heading. The caller applies reach and gate limits.
 * Gong and Grizzle's ALIP concepts; original implementation. Gravity remains the 9.81 m/s^2 simulation default.
 */
export function alipLandingCentre(bodies: readonly Body[], o: Observation, stanceFootId: string, fallbackCop: Vec3,
  heading: Quat, commandVelocity: Vec3, swingSide: -1 | 1, elapsed: number, stepSeconds: number, width: number,
  sagittalTerminalFactor: number, momentumRetention = 0): Vec3 {
  const foot = o.feet.find(f => f.id === stanceFootId)
  if (!foot || ![fallbackCop, heading, commandVelocity].every(finite) || !Number.isFinite(heading.w) ||
    ![elapsed, stepSeconds, width, sagittalTerminalFactor].every(Number.isFinite) || elapsed < 0 || stepSeconds <= 0 || width < 0 ||
    sagittalTerminalFactor < 0 || (swingSide !== -1 && swingSide !== 1)) throw new RangeError('Invalid ALIP landing')
  const contact = foot.centreOfPressure ?? fallbackCop, state = angularMomentumState(bodies, o, contact), inverse = conjugate(heading)
  const r = rotate(inverse, sub(o.com, contact)), v = rotate(inverse, state.equivalentVelocity), desired = rotate(inverse, commandVelocity)
  const omega = Math.sqrt(9.81 / state.heightM), remaining = Math.max(0, stepSeconds - elapsed)
  desired.z *= sagittalTerminalFactor
  // A new right stance ends with leftward momentum; a new left stance ends with rightward momentum.
  desired.x -= swingSide * .5 * width * omega * Math.tanh(omega * stepSeconds / 2)
  return add(contact, rotate(heading, {
    x: alipStepPlacement(r.x, v.x, omega, remaining, stepSeconds, desired.x, momentumRetention).footOffsetM,
    y: 0,
    z: alipStepPlacement(r.z, v.z, omega, remaining, stepSeconds, desired.z, momentumRetention).footOffsetM,
  }))
}

/** Linear inverted-pendulum capture point; vertical velocity is not part of this horizontal model. */
export function capturePoint(com: Vec3, velocity: Vec3, cop: Vec3, gravityMps2 = 9.81): CapturePoint | null {
  if (![com, velocity, cop].every(finite) || !Number.isFinite(gravityMps2) || gravityMps2 <= 0) return null
  const heightM = com.y - cop.y
  if (!Number.isFinite(heightM) || heightM <= 0) return null
  const omega = Math.sqrt(gravityMps2 / heightM)
  const point = { x: com.x + velocity.x / omega, y: cop.y, z: com.z + velocity.z / omega }
  return Number.isFinite(omega) && omega > 0 && finite(point) ? { heightM, omega, point } : null
}

export interface CaptureState extends CapturePoint {
  cop: Vec3; speedMps: number
  /** Measured support hull shrunk by SUPPORT_SHRINK_M. Empty means no area remains. */
  polygon: Vec3[]
  /** Area centroid of the measured hull, or measured COP when contact support has no area. */
  centroid: Vec3
  marginM: number | null
}
export function captureState(observation: Observation, gravityMps2 = 9.81): CaptureState | null {
  if (observation.support.polygon.some(p => !finite(p)) || observation.feet.some(f => !Number.isFinite(f.normalImpulseNs) ||
    f.normalImpulseNs < 0 || (f.centreOfPressure !== null && !finite(f.centreOfPressure)) || (f.normalImpulseNs > 0 && f.centreOfPressure === null))) return null
  const loaded = observation.feet.filter(f => f.normalImpulseNs > 0)
  const total = loaded.reduce((sum, foot) => sum + foot.normalImpulseNs, 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const cop = loaded.reduce((sum, foot) => {
    const p = foot.centreOfPressure!, share = foot.normalImpulseNs / total
    return { x: sum.x + share * p.x, y: sum.y + share * p.y, z: sum.z + share * p.z }
  }, { x: 0, y: 0, z: 0 })
  const capture = capturePoint(observation.com, observation.comVelocity, cop, gravityMps2)
  if (!capture) return null
  const polygon = shrinkPolygon(observation.support.polygon, SUPPORT_SHRINK_M)
  // Edge/point contact still supplies a measured COP. It creates no support polygon, so stepping can react.
  const centroid = polygonCentroid(observation.support.polygon) ?? { ...cop }
  return { ...capture, cop, speedMps: Math.hypot(observation.comVelocity.x, observation.comVelocity.z),
    polygon, centroid, marginM: polygonMargin(polygon, capture.point) }
}

export interface StepTriggerState { lastTick: number; outsideTicks: number; triggered: boolean; reason: 'capture' | 'speed' | null }
/** Two consecutive observed ticks outside by 3 cm, or immediate speed escape. Repeated reads do not advance time. */
export function advanceStepTrigger(previous: StepTriggerState | null, capture: CaptureState | null, stateTick: number): StepTriggerState {
  if (!Number.isSafeInteger(stateTick) || stateTick < 0) throw new RangeError('Invalid step tick')
  if (previous && stateTick === previous.lastTick) return { ...previous }
  const nearest = capture && projectToPolygon(capture.polygon, capture.point)
  const outside = capture !== null && (!nearest || Math.hypot(capture.point.x - nearest.x, capture.point.z - nearest.z) > STEP_OUTSIDE_M)
  const outsideTicks = outside ? (previous && stateTick === previous.lastTick + 1 ? previous.outsideTicks : 0) + 1 : 0
  const reason = capture && capture.speedMps > STEP_SPEED_MPS ? 'speed' : outsideTicks >= 2 ? 'capture' : null
  return { lastTick: stateTick, outsideTicks, triggered: reason !== null, reason }
}

export type FootSide = 'left' | 'right'
/** A lateral exit waits for its own foot to unload. Returning null requests balance work, never a crossing step. */
export function chooseSwingFoot(loads: Record<FootSide, number>, exitDirection: Vec3, yawRad: number): FootSide | null {
  if (![loads.left, loads.right, yawRad].every(Number.isFinite) || loads.left < 0 || loads.right < 0 || !finite(exitDirection))
    throw new RangeError('Invalid swing selection')
  const total = loads.left + loads.right
  if (!Number.isFinite(total)) throw new RangeError('Invalid total foot load')
  if (total <= 0) return null
  const lateral = exitDirection.x * Math.cos(yawRad) - exitDirection.z * Math.sin(yawRad)
  if (Math.abs(lateral) > EPS) {
    const side = lateral < 0 ? 'left' : 'right'
    return loads[side] / total <= STEP_MAX_LOAD_SHARE ? side : null
  }
  return loads.left <= loads.right ? 'left' : 'right'
}

export interface LandingInput {
  capturePoint: Vec3; cop: Vec3; omega: number; stanceAnkle: Vec3; swing: FootSide
  yawRad: number; hipHeightM: number; exitDirection: Vec3
  /** Simulation default, s: measured or planned remaining time until contact. */
  stepTimeS?: number
}
export interface LandingTarget { point: Vec3; predicted: Vec3; capped: boolean }
/** Capture evolution plus overshoot, constrained to the swing side and the 0.6 L reach disc about the stance ankle. */
export function landingTarget(input: LandingInput): LandingTarget {
  const { capturePoint: capture, cop, omega, stanceAnkle: stance, swing, yawRad: yaw, hipHeightM, exitDirection: exit } = input
  const stepTimeS = input.stepTimeS ?? STEP_TIME_S
  if (![capture, cop, stance, exit].every(finite) || ![omega, yaw, hipHeightM, stepTimeS].every(Number.isFinite) || omega <= 0 || stepTimeS <= 0 ||
    hipHeightM <= 0 || !['left', 'right'].includes(swing)) throw new RangeError('Invalid landing input')
  const reach = .6 * hipHeightM // GBWC maximum step length, m.
  if (reach < STEP_MIN_WIDTH_M) throw new RangeError('Step reach cannot satisfy minimum width')
  const evolution = Math.exp(omega * stepTimeS), exitLength = Math.hypot(exit.x, exit.z)
  const overshoot = exitLength > EPS ? STEP_OVERSHOOT_M / exitLength : 0
  const predicted = { x: cop.x + (capture.x - cop.x) * evolution + exit.x * overshoot, y: cop.y,
    z: cop.z + (capture.z - cop.z) * evolution + exit.z * overshoot }
  if (!finite(predicted)) throw new RangeError('Non-finite landing prediction')
  const side = swing === 'left' ? -1 : 1, c = Math.cos(yaw), s = Math.sin(yaw)
  const dx = predicted.x - stance.x, dz = predicted.z - stance.z
  let lateral = side * (dx * c - dz * s), forward = -dx * s - dz * c
  lateral = Math.max(STEP_MIN_WIDTH_M, lateral)
  const distance = Math.hypot(lateral, forward)
  if (distance > reach) { lateral *= reach / distance; forward *= reach / distance }
  if (lateral < STEP_MIN_WIDTH_M) {
    lateral = STEP_MIN_WIDTH_M
    const maxForward = Math.sqrt(reach * reach - lateral * lateral)
    forward = Math.max(-maxForward, Math.min(maxForward, -dx * s - dz * c))
  }
  const point = { x: stance.x + side * lateral * c - forward * s, y: cop.y,
    z: stance.z - side * lateral * s - forward * c }
  return { point, predicted, capped: Math.hypot(point.x - predicted.x, point.z - predicted.z) > EPS }
}

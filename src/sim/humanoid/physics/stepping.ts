/** Pure capture and recovery-step geometry. Requests still leave the controller through ActuationGate. */
import type { Vec3 } from '../../physics/math'
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
}
export interface LandingTarget { point: Vec3; predicted: Vec3; capped: boolean }
/** Capture evolution plus overshoot, constrained to the swing side and the 0.6 L reach disc about the stance ankle. */
export function landingTarget(input: LandingInput): LandingTarget {
  const { capturePoint: capture, cop, omega, stanceAnkle: stance, swing, yawRad: yaw, hipHeightM, exitDirection: exit } = input
  if (![capture, cop, stance, exit].every(finite) || ![omega, yaw, hipHeightM].every(Number.isFinite) || omega <= 0 ||
    hipHeightM <= 0 || !['left', 'right'].includes(swing)) throw new RangeError('Invalid landing input')
  const reach = .6 * hipHeightM // GBWC maximum step length, m.
  if (reach < STEP_MIN_WIDTH_M) throw new RangeError('Step reach cannot satisfy minimum width')
  const evolution = Math.exp(omega * STEP_TIME_S), exitLength = Math.hypot(exit.x, exit.z)
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

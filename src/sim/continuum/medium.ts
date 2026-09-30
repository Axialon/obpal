/** Continuous submerged fraction, buoyancy and passive drag shared with the sucker contact system. This is not CFD. */
import { Vector3 } from 'three'
import { bounded, clamp, finite, type Section, type Shape } from './profile'
import type { ContactSurface } from './contact'

export interface WaterVolume {
  id: string
  min: Vector3
  max: Vector3
  density: number
}
export interface BodyState {
  position: Vector3
  velocity: Vector3
  radius: number
  mass: number
  volume: number
  airDrag: number
  waterDrag: number
}

/** Sphere-cap fractions are exact at a single flat boundary; their product approximates clipping at tank corners. */
function cap(distance: number, radius: number) {
  const x = clamp(distance / radius, -1, 1)
  return 0.5 + 0.75 * x - 0.25 * x * x * x
}
export function submerged(position: Vector3, radius: number, water: WaterVolume) {
  if (!(radius > 0) || !Number.isFinite(radius)) return 0
  let fraction = 1
  for (let axis = 0; axis < 3; axis++) {
    const p = position.getComponent(axis)
    fraction *= cap(p - water.min.getComponent(axis), radius) * cap(water.max.getComponent(axis) - p, radius)
  }
  return Number.isFinite(fraction) ? fraction : 0
}

/** A fixed tick advances momentum; entering water changes forces continuously and never resets position or velocity. */
export function stepBody(body: BodyState, waters: readonly WaterVolume[], force: Vector3, dt: number) {
  if (!(body.mass > 0) || !Number.isFinite(body.mass) || !Number.isFinite(body.volume) || body.volume < 0 ||
    !Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) return 0
  let fraction = 0,
    density = 0
  for (const water of waters) {
    const f = submerged(body.position, body.radius, water)
    if (f > fraction) {
      fraction = f
      density = water.density
    }
  }
  for (let axis = 0; axis < 3; axis++)
    body.velocity.setComponent(axis, body.velocity.getComponent(axis) + (finite(force.getComponent(axis)) * dt) / body.mass)
  body.velocity.y += 9.81 * ((density * body.volume * fraction) / body.mass - 1) * dt
  const drag = body.airDrag + (body.waterDrag - body.airDrag) * fraction
  body.velocity.multiplyScalar(1 / (1 + (Math.max(0, drag) * body.velocity.length() * dt) / body.mass))
  body.position.addScaledVector(body.velocity, dt)
  return fraction
}

const collision = { point: new Vector3(), normal: new Vector3(), distance: 0 }
const offset = new Vector3()
/** Project only actual penetrations and remove inward momentum. Falling onto the floor dissipates energy rather than anchoring in air. */
export function collideBody(body: BodyState, surfaces: readonly ContactSurface[]) {
  for (const surface of surfaces) {
    surface.sample(body.position, collision)
    const separation = body.position.distanceTo(collision.point)
    if (surface.kind === 'plane') {
      offset.copy(body.position).sub(collision.point).addScaledVector(collision.normal, -collision.distance)
      if (offset.length() > body.radius) continue
    }
    if (collision.distance < 0 || separation < body.radius) {
      offset.copy(body.position).sub(collision.point)
      if (offset.dot(collision.normal) < 0 || offset.lengthSq() < 1e-12) offset.copy(collision.normal)
      else offset.normalize()
      const penetration = collision.distance < 0 ? body.radius - collision.distance : body.radius - separation
      body.position.addScaledVector(offset, Math.min(0.04, Math.max(0, penetration)))
      const inward = body.velocity.dot(offset)
      if (inward < 0) body.velocity.addScaledVector(offset, -inward)
    }
  }
}

/** Distributed transverse fluid load gives cantilever curvature. The result is an elastic target, not a direct pose override. */
export function streamShape(section: Section, flow: Vector3, water: number, rigidity: number, out: Shape) {
  const fraction = clamp(finite(water), 0, 1),
    density = 1.2 + (1000 - 1.2) * fraction,
    transverse = Math.hypot(flow.x, flow.y),
    factor = (0.5 * density * 1.1 * 2 * section.radius * transverse * section.length ** 2) / (2 * Math.max(0.001, finite(rigidity, 1)))
  out.kx = -flow.y * factor
  out.ky = flow.x * factor
  out.strain = 0.1 * fraction * clamp(Math.abs(finite(flow.z)) / 2, 0, 1)
  out.twist = 0
  return bounded(section, out, out)
}

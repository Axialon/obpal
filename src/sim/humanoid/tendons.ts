/** Original sim tendon routing and unit-inertia series elasticity. Hardware receives joint angles unchanged. */
import { bounded, clamp, neutral, type Angles, type RigProfile } from './profile'
import type { Grip } from './fingers'

export function fingerAngles(profile: RigProfile, curl: number) {
  const value = clamp(Number.isFinite(curl) ? curl : 0, 0, 1)
  return (profile.compliance?.fingers ?? [Math.PI / 3, Math.PI / 3, Math.PI / 3]).map((ratio) => value * ratio)
}

export interface Routing {
  joints: readonly [string, string]
  scales: readonly [number, number]
  limits: readonly [readonly [number, number], readonly [number, number]]
  travel: number
}
/** A differential's two tendon strokes share finite travel. The ratios are our sim design, not vendor data. */
export function routePair(a: number, b: number, travel: number): [number, number] {
  return [clamp(a + b, -travel, travel), clamp(a - b, -travel, travel)]
}
export const unroutePair = (a: number, b: number): [number, number] => [(a + b) / 2, (a - b) / 2]

interface Spring {
  x: number
  v: number
}
export class Tendons {
  readonly routes: Routing[] = []
  pose: Angles = neutral(this.profile)
  grip: Grip = { left: 0, right: 0 }
  private springs = new Map<string, Spring>()
  private routed = new Set<string>()
  constructor(readonly profile: RigProfile) {
    for (const chain of profile.chains) {
      const pitch = chain.distal.find((id) => id.endsWith('.pitch')),
        roll = chain.distal.find((id) => id.endsWith('.roll'))
      if (!pitch || !roll || !profile.compliance) continue
      const scale = (id: string) => Math.max(...profile.joints.find((j) => j.id === id)!.limits.map(Math.abs)) || 1
      this.routes.push({
        joints: [pitch, roll],
        scales: [scale(pitch), scale(roll)],
        limits: [profile.joints.find((j) => j.id === pitch)!.limits, profile.joints.find((j) => j.id === roll)!.limits],
        travel: chain.group === 'legs' ? profile.compliance.ankleTravel : profile.compliance.wristTravel,
      })
      this.routed.add(pitch)
      this.routed.add(roll)
    }
  }
  private spring(id: string, target: number, dt: number) {
    let state = this.springs.get(id)
    if (!state) {
      state = { x: 0, v: 0 }
      this.springs.set(id, state)
    }
    const settings = this.profile.compliance!
    state.v += (settings.stiffness * (target - state.x) - settings.damping * state.v) * dt
    state.x += state.v * dt
    return state.x
  }
  /** Fixed substeps give the same integration at 30, 60 and 120 Hz without an iterative solver. */
  step(target: Angles, grip: Grip, dt: number) {
    const q = bounded(this.profile, target)
    if (!this.profile.compliance) {
      this.pose = q
      this.grip = { left: clamp(grip.left, 0, 1), right: clamp(grip.right, 0, 1) }
      return this.pose
    }
    if (!Number.isFinite(dt) || dt <= 0) return this.pose
    const elapsed = Math.min(dt, 1 / 30),
      steps = Math.max(1, Math.ceil(elapsed * 240)),
      h = elapsed / steps,
      strokes = this.routes.map((route) =>
        routePair(q[route.joints[0]] / route.scales[0], q[route.joints[1]] / route.scales[1], route.travel),
      )
    for (let n = 0; n < steps; n++) {
      for (const joint of this.profile.joints) {
        if (this.routed.has(joint.id)) continue
        // Unpaired axes use net antagonistic tendon stroke at a unit moment arm.
        const x = this.spring(joint.id, q[joint.id], h),
          safe = clamp(x, ...joint.limits)
        this.pose[joint.id] = safe
        if (x !== safe) Object.assign(this.springs.get(joint.id)!, { x: safe, v: 0 })
      }
      for (const [i, route] of this.routes.entries()) {
        const stroke = strokes[i]
        const actual = unroutePair(this.spring(`route:${i}:a`, stroke[0], h), this.spring(`route:${i}:b`, stroke[1], h))
        route.joints.forEach((id, axis) => {
          this.pose[id] = clamp(actual[axis] * route.scales[axis], ...route.limits[axis])
        })
      }
      for (const side of ['left', 'right'] as const)
        this.grip[side] = clamp(
          this.spring(`grip:${side}`, clamp(Number.isFinite(grip[side]) ? grip[side] : 0, 0, 1), h),
          0,
          1,
        )
    }
    return this.pose
  }
  /** Contact yields through elastic state; it cannot write a retarget target or a hardware command. */
  contact(joint: string, velocity: number) {
    const state = this.springs.get(joint)
    if (state) state.v = clamp(state.v + clamp(velocity, -0.6, 0.6), -2, 2)
  }
  freeze() {
    for (const state of this.springs.values()) state.v = 0
  }
  reset() {
    this.springs.clear()
    this.pose = neutral(this.profile)
    this.grip = { left: 0, right: 0 }
  }
}

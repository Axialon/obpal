/** Source arbitration: Stop, constraints, selected input, then interruptible presets. */
import { Vector3 } from 'three'
import type { DeviceInput } from '../devices/types'
import { bounded, clamp, neutral, rad, type Angles, type RigProfile } from './profile'
export const PRESETS = ['guard', 'jab', 'cross', 'uppercut', 'block', 'wave'] as const
export type Preset = (typeof PRESETS)[number]
export interface Intent {
  x: number
  z: number
  yaw: number
  preset?: Preset
  manual: boolean
}
export const restIntent = (): Intent => ({ x: 0, z: 0, yaw: 0, manual: false })
export function classical(input: DeviceInput | undefined): Intent {
  if (!input) return restIntent()
  const p = input.pad,
    x = p?.axes[0] ?? input.tilt[0] + input.drag[0] * 0.07,
    z = p?.axes[1] ?? input.tilt[1] + input.drag[1] * 0.07,
    yaw = p?.axes[2] ?? input.twist * 0.03
  const preset =
    PRESETS.find((name) => input.presses.includes(name)) ?? PRESETS.find((_, i) => !!(input.padPressed & (1 << i)))
  return {
    x: clamp(x, -1, 1),
    z: clamp(z, -1, 1),
    yaw: clamp(yaw, -1, 1),
    preset,
    manual: Math.hypot(x, z, yaw) > 0.05,
  }
}
export function presetPose(profile: RigProfile, name: Preset, phase: number): Angles {
  const q = neutral(profile),
    strike = Math.sin(clamp(phase, 0, 1) * Math.PI)
  for (const c of profile.chains.filter((c) => c.group === 'arms')) {
    const lead = c.side < 0
    let pitch = 35,
      roll = 12,
      elbow = 115
    if ((name === 'jab' && lead) || (name === 'cross' && !lead)) {
      pitch += 45 * strike
      elbow -= 108 * strike
      roll -= 22 * strike
    }
    if (name === 'uppercut' && !lead) {
      pitch += 90 * strike
      elbow -= 35 * strike
    }
    if (name === 'block') {
      pitch = 85
      roll = 25
      elbow = 135
    }
    if (name === 'wave') {
      pitch = lead ? 125 : 10
      roll = lead ? 45 : 8
      elbow = lead ? 55 + 25 * Math.sin(phase * Math.PI * 6) : 10
    }
    q[c.joints[0]] = rad(roll)
    q[c.joints[1]] = rad(pitch)
    q[c.joints[3]] = rad(elbow)
  }
  if (name === 'cross' && profile.frame) q[profile.frame.spine[0]] = rad(-25 * strike)
  if (name === 'uppercut' && profile.frame) q[profile.frame.spine[1]] = rad(-12 * strike)
  return bounded(profile, q)
}
export class ActorControl {
  q: Angles
  position = new Vector3()
  yaw = 0
  stopped = false
  moving = false
  preset: Preset | null = null
  private elapsed = 0
  private gait = 0
  private previousBody: Angles | null = null
  private legWeight = 0
  constructor(readonly profile: RigProfile) {
    this.q = neutral(profile)
  }
  stop() {
    this.stopped = true
    this.preset = null
    this.moving = false
    this.previousBody = null
  }
  resume() {
    this.stopped = false
    this.previousBody = null
  }
  resetSource() {
    this.preset = null
    this.previousBody = null
    this.moving = false
    this.legWeight = 0
  }
  play(preset: Preset) {
    if (!this.stopped) {
      this.preset = preset
      this.elapsed = 0
      this.previousBody = null
    }
  }
  step(dt: number, intent: Intent, body: Angles | null) {
    dt = clamp(dt, 0, 0.05)
    if (this.stopped) return this.q
    const bodyMoved =
      body && this.previousBody && Object.keys(body).some((id) => Math.abs(body[id] - this.previousBody![id]) > 0.13)
    this.previousBody = body ? { ...body } : null
    if (intent.manual || bodyMoved) this.preset = null
    if (intent.preset) this.play(intent.preset)
    this.moving = Math.hypot(intent.x, intent.z) > 0.05
    this.yaw += intent.yaw * dt * 1.5
    const move = new Vector3(intent.x, 0, intent.z)
      .applyAxisAngle(new Vector3(0, 1, 0), this.yaw)
      .multiplyScalar(dt * 0.85)
    this.position.add(move)
    this.position.x = clamp(this.position.x, -3.3, 3.3)
    this.position.z = clamp(this.position.z, -3.3, 3.3)
    const target = body ? { ...body } : neutral(this.profile)
    if (this.preset) {
      const duration = this.preset === 'wave' ? 2.2 : this.preset === 'guard' || this.preset === 'block' ? 1.8 : 0.8
      this.elapsed += dt
      const pose = presetPose(this.profile, this.preset, this.elapsed / duration)
      const weight = clamp(Math.min(this.elapsed, duration - this.elapsed) / 0.12, 0, 1)
      for (const id of [
        ...this.profile.chains.filter((c) => c.group === 'arms').flatMap((c) => [...c.joints, ...c.distal]),
        ...(this.profile.frame?.spine ?? []),
      ])
        target[id] += (pose[id] - target[id]) * weight
      if (this.elapsed >= duration) this.preset = null
    }
    this.legWeight = clamp(this.legWeight + ((this.moving ? 1 : -1) * dt) / 0.15, 0, 1)
    if (this.moving) this.gait += dt * 7
    for (const c of this.profile.chains.filter((c) => c.group === 'legs')) {
      const swing = Math.sin(this.gait + (c.side < 0 ? 0 : Math.PI))
      const walk: Angles = {
        [c.joints[1]]: swing * 0.3,
        [c.joints[3]]: Math.max(0, -swing) * 0.5,
        [c.distal[0]]: -swing * 0.12,
      }
      for (const [id, value] of Object.entries(walk)) target[id] += (value - target[id]) * this.legWeight
    }
    // BODY is already filtered at capture. Only presets/classical transitions need this joint easing.
    const safe = bounded(this.profile, target),
      blend = body && !this.preset ? 1 : 1 - Math.exp(-dt / 0.06)
    for (const j of this.profile.joints) this.q[j.id] += (safe[j.id] - this.q[j.id]) * blend
    this.q = bounded(this.profile, this.q)
    return this.q
  }
}

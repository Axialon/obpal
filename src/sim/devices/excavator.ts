/** Excavator pattern: left swing/stick, right bucket/boom. Sand is transferred only at the bucket tip. */
import { Controller, PadButton } from '@obpal/core'
import { action, Machine, timestep } from './common'
import { axis, clamp, down, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const EXCAVATOR_SPEC: DeviceSpec = {
  id: 'excavator',
  name: 'Excavator',
  unit: 'Excavator',
  units: 1,
  kind: 'Machine',
  blurb: 'Work the two sticks, scoop the sand pile and swing a full bucket over the truck.',
  teaches: 'Two sticks operate four independent hydraulic joints',
  controllers: [Controller.gamepad, Controller.hand],
  how: {
    'face.gamepad': 'Left: swing / stick · right: bucket / boom (pull raises) · triggers travel · A curls / dumps',
    'face.hand': 'Hold and move the phone to place the bucket · tap Bucket to curl / dump',
  },
  tray: [{ id: 'bucket', label: 'Bucket', type: 'button', icon: 'hand' }],
  buttons: { 'media:playpause': 'tray:bucket', 'key:Space': 'tray:bucket' },
}
export interface Excavator {
  x: number
  z: number
  swing: number
  boom: number
  stick: number
  curl: number
  load: number
  delivered: number
}
export const BOOM = 1.7,
  STICK = 1.45
export function bucketTip(u: Excavator): [number, number, number] {
  const r = BOOM * Math.cos(u.boom) + STICK * Math.cos(u.boom + u.stick)
  return [
    u.x - Math.sin(u.swing) * r,
    1 + BOOM * Math.sin(u.boom) + STICK * Math.sin(u.boom + u.stick) - 0.25,
    u.z - Math.cos(u.swing) * r,
  ]
}
export function bucketPose(x: number, y: number, z: number) {
  const r = Math.hypot(x, z),
    v = y - 0.75,
    c = clamp((r * r + v * v - BOOM * BOOM - STICK * STICK) / (2 * BOOM * STICK), -1, 1),
    stick = -Math.acos(c)
  return {
    swing: Math.atan2(-x, -z),
    boom: clamp(Math.atan2(v, r) - Math.atan2(STICK * Math.sin(stick), BOOM + STICK * Math.cos(stick)), 0.05, 1.35),
    stick: clamp(stick, -2.4, -0.1),
  }
}
export class ExcavatorLogic extends Machine {
  readonly spec = EXCAVATOR_SPEC
  units: Excavator[] = [{ x: 0, z: 0, swing: 0, boom: 0.65, stick: -1.35, curl: 0.15, load: 0, delivered: 0 }]
  sand = 20
  spilled = 0
  private hand: { p: readonly number[]; tip: [number, number, number]; gen: number } | null = null
  home() {
    const u = this.units[0]
    this.sand += u.load
    Object.assign(u, { x: 0, z: 0, swing: 0, boom: 0.65, stick: -1.35, curl: 0.15, load: 0 })
    this.hand = null
  }
  reset() {
    this.sand = 20
    this.spilled = 0
    this.units[0].load = 0
    this.units[0].delivered = 0
    this.home()
  }
  readonly resetLabel = 'Refill sand'
  readout() {
    const u = this.units[0]
    return `${u.load ? 'Full bucket' : 'Empty bucket'} · ${u.delivered} in truck`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta),
      i = inputs[0],
      u = this.units[0]
    if (!i) {
      this.hand = null
      return
    }
    const was = { ...u }
    if (i.pad) {
      const a = i.pad.axes
      u.swing = wrapPi(u.swing - axis(a[0]) * dt)
      u.stick = clamp(u.stick - axis(a[1]) * dt, -2.4, -0.1)
      u.boom = clamp(u.boom + axis(a[3]) * dt, 0.05, 1.35)
      u.curl = clamp(u.curl - axis(a[2]) * dt, 0, 1)
      u.z = clamp(u.z + (i.pad.triggers[0] - i.pad.triggers[1]) * dt, -2, 3)
      if (down(i.pad.buttons, PadButton.B)) u.curl = 0
    }
    const pose = i.pose
    if (pose?.tracked && pose.touching) {
      if (!this.hand || this.hand.gen !== pose.gen) this.hand = { p: [...pose.p], tip: bucketTip(u), gen: pose.gen }
      const a = this.hand
      if (i.space) {
        const swing = -i.space.aim[0] * Math.PI, radius = clamp(Math.hypot(a.tip[0] - u.x, a.tip[2] - u.z) + (pose.p[2] - a.p[2]) * 4, 0.7, 3)
        Object.assign(u, bucketPose(-Math.sin(swing) * radius, 1.55 + i.space.aim[1] * 1.4, -Math.cos(swing) * radius))
      } else Object.assign(
        u,
        bucketPose(
          a.tip[0] + (pose.p[0] - a.p[0]) * 4 - u.x,
          clamp(a.tip[1] + (pose.p[1] - a.p[1]) * 4, 0.1, 3),
          a.tip[2] + (pose.p[2] - a.p[2]) * 4 - u.z,
        ),
      )
    } else this.hand = null
    if (bucketTip(u)[1] < 0.08) {
      u.boom = was.boom
      u.stick = was.stick
    }
    if (action(i, 'bucket')) u.curl = u.curl > 0.5 ? 0 : 1
    const [x, y, z] = bucketTip(u)
    if (!u.load && u.curl > 0.65 && y < 0.85 && Math.hypot(x, z + 2.5) < 1.35 && this.sand >= 1) {
      u.load = 1
      this.sand--
      this.events.push({ unit: 0, kind: 'tick', text: 'Bucket filled' })
    }
    if (u.load && u.curl < 0.2) {
      if (Math.abs(x - 3) < 0.95 && Math.abs(z) < 1.4 && y > 1) {
        u.delivered += u.load
        this.events.push({ unit: 0, kind: 'score', text: 'Sand delivered' })
      } else this.spilled += u.load
      u.load = 0
    }
  }
}

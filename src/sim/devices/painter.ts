/** A bounded long exposure: movement while held writes light; lifting starts a separate stroke. */
import { Controller, qRotate, type Quat, type Vec3 } from '@obpal/core'
import { Machine, timestep } from './common'
import { clamp } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const PAINTER_SPEC: DeviceSpec = {
  id: 'painter',
  name: 'Light painter',
  unit: 'Light',
  units: 1,
  kind: 'Toy',
  blurb: 'Move a light through a dark studio and leave long-exposure ribbons hanging in the air.',
  teaches: 'The phone’s motion becomes a three-dimensional stroke',
  controllers: [Controller.hand, Controller.mouse, Controller.trackpad],
  how: {
    'face.hand': 'Hold the pad and move the phone to paint · Colour changes the light',
    'face.mouse': 'Point with Left held to paint · the wheel changes depth',
    'face.trackpad': 'Drag to paint · two fingers change depth · Colour changes the light',
  },
  tray: [
    { id: 'colour', label: 'Colour', type: 'button', icon: 'sun' },
    { id: 'clear', label: 'Clear trails', type: 'button', icon: 'reset' },
  ],
  buttons: { 'media:playpause': 'tray:colour', 'key:KeyC': 'tray:colour', 'key:Backspace': 'tray:clear' },
}
export const INKS = ['#77e6ff', '#ffa1df', '#c6ff68', '#ffd28e']
export interface Stroke {
  a: Vec3
  b: Vec3
  colour: number
}
export class PainterLogic extends Machine {
  readonly spec = PAINTER_SPEC
  units = [{ x: 0, y: 1.5, z: 0, q: [0, 0, 0, 1] as Quat, colour: 0, points: 0 }]
  strokes: Stroke[] = []
  private last: Vec3 | null = null
  private anchor: { p: Vec3; at: Vec3; gen: number } | null = null
  home() {
    Object.assign(this.units[0], { x: 0, y: 1.5, z: 0, q: [0, 0, 0, 1] })
    this.last = null
    this.anchor = null
  }
  reset() {
    this.strokes = []
    this.units[0].points = 0
    this.last = null
  }
  readonly resetLabel = 'Clear trails'
  readout() {
    return `${this.strokes.length} light segments`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta),
      i = inputs[0],
      u = this.units[0]
    if (!i) {
      this.last = null
      this.anchor = null
      return
    }
    if (i.presses.includes('colour') || i.presses.includes('pad')) u.colour = (u.colour + 1) % INKS.length
    if (i.presses.includes('clear')) this.reset()
    if (i.recentred) {
      this.home()
      return
    }
    let paint = false,
      target: Vec3 = [u.x, u.y, u.z]
    const pose = i.pose
    if (pose?.tracked && pose.touching) {
      if (!this.anchor || this.anchor.gen !== pose.gen)
        this.anchor = { p: [...pose.p], at: [u.x, u.y, u.z], gen: pose.gen }
      const a = this.anchor
      target = [
        a.at[0] + (pose.p[0] - a.p[0]) * 4,
        a.at[1] + (pose.p[1] - a.p[1]) * 4,
        a.at[2] + (pose.p[2] - a.p[2]) * 4,
      ]
      u.q = [...pose.q]
      paint = true
    } else this.anchor = null
    if (i.point) {
      target = [i.point.yaw * 0.12, 1.5 + i.point.pitch * 0.1, u.z + i.wheel * 0.002]
      paint = i.held.has('mouse-left')
    } else if (i.touching && !pose) {
      target = [u.x + i.drag[0] * 0.012, u.y - i.drag[1] * 0.012, u.z + i.pan[1] * 0.01]
      paint = true
    }
    target = [clamp(target[0], -3.5, 3.5), clamp(target[1], 0.3, 3.5), clamp(target[2], -2, 2)]
    const distance = Math.hypot(target[0] - u.x, target[1] - u.y, target[2] - u.z),
      k = distance ? Math.min(1, (dt * 12) / distance) : 1
    u.x += (target[0] - u.x) * k
    u.y += (target[1] - u.y) * k
    u.z += (target[2] - u.z) * k
    const tip = qRotate(u.q, [0, 0.2, 0]),
      at: Vec3 = [u.x + tip[0], u.y + tip[1], u.z + tip[2]]
    if (paint) {
      if (this.last && Math.hypot(...at.map((v, n) => v - this.last![n])) > 0.025) {
        this.strokes.push({ a: [...this.last], b: [...at], colour: u.colour })
        u.points++
        if (this.strokes.length > 512) this.strokes.shift()
        this.last = at
      } else if (!this.last) this.last = at
    } else this.last = null
  }
}

/** A forgiving trainer: power builds airspeed, bank turns, and low airspeed gently loses height. */
import { Controller, Mode } from '@obpal/core'
import { action, drive, Machine, timestep } from './common'
import { axis, clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const PLANE_SPEC: DeviceSpec = {
  id: 'plane',
  name: 'RC plane',
  unit: 'Plane',
  units: 1,
  kind: 'Flyer',
  blurb: 'Take a gentle trainer off the runway, bank through the rings and glide home.',
  teaches: 'The Flight profile turns a phone into a yoke',
  controllers: [Controller.gamepad, Controller.trackpad],
  profile: 'flight',
  how: {
    'face.gamepad': 'Tilt or right stick banks / pitches · RT power · A engine on / off',
    'face.trackpad': 'Tilt or drag to bank / pitch · tap starts the engine · Home parks',
  },
  tray: [{ id: 'engine', label: 'Engine', type: 'button', icon: 'plane' }],
  buttons: { 'media:playpause': 'tray:engine', 'key:Space': 'tray:engine' },
}
export const FLIGHT_RINGS = [
  [0, 3, -10],
  [-10, 5, -18],
  [-16, 4, 0],
  [0, 3, 18],
  [14, 6, 3],
] as const
export class PlaneLogic extends Machine {
  readonly spec = PLANE_SPEC
  units = [
    {
      x: 0,
      y: 0.23,
      z: 8,
      h: 0,
      v: 0,
      vy: 0,
      bank: 0,
      pitch: 0,
      powered: false,
      throttle: 0,
      next: 0,
      rings: 0,
      prop: 0,
    },
  ]
  private drag = new DragStick()
  home() {
    Object.assign(this.units[0], {
      x: 0,
      y: 0.23,
      z: 8,
      h: 0,
      v: 0,
      vy: 0,
      bank: 0,
      pitch: 0,
      powered: false,
      throttle: 0,
      next: 0,
    })
    this.drag = new DragStick()
  }
  readout() {
    const u = this.units[0]
    return `${u.y.toFixed(1)} m · ${u.rings} rings`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta),
      i = inputs[0] ?? null,
      u = this.units[0]
    if (action(i, 'engine')) u.powered = !u.powered
    const [sx, sy] = drive(i, this.drag),
      roll = i?.pad ? axis(i.pad.axes[2]) : sx,
      pitch = i?.pad ? -axis(i.pad.axes[3]) : sy
    const live = !!i && !i.quiet && (!!i.pad || (i.face === 'face.trackpad' && (i.touching || i.mode === Mode.tilt)))
    u.throttle = live
      ? i?.pad
        ? clamp(Math.max(u.powered ? 0.65 : 0, i.pad.triggers[1]) - i.pad.triggers[0], 0, 1)
        : u.powered
          ? 0.65
          : 0
      : 0
    u.v = clamp(u.v + (u.throttle * 3 - u.v * 0.3) * dt, 0, 7.5)
    u.bank += (-roll * 0.6 - u.bank) * Math.min(1, dt * 3)
    u.pitch += (pitch * 0.35 - u.pitch) * Math.min(1, dt * 3)
    u.h = wrapPi(u.h + u.bank * dt * Math.min(1, u.v / 3))
    if (u.y > 0.24 || u.v > 3.8) {
      const lift = u.v * u.v * 0.055 - 0.72
      u.vy += (clamp(lift + u.pitch * u.v, -0.8, 1.6) - u.vy) * Math.min(1, dt * 2)
      u.y = clamp(u.y + u.vy * dt, 0.23, 12)
    } else u.vy = 0
    if (u.y === 0.23 && u.vy < 0) {
      if (u.vy < -0.2) this.events.push({ unit: 0, kind: 'bump', audio: { speed: -u.vy, materials: ['rubber', 'tile'] } })
      u.vy = 0
      u.bank *= 0.9
    }
    u.x -= Math.sin(u.h) * u.v * dt
    u.z -= Math.cos(u.h) * u.v * dt
    if (Math.abs(u.x) > 30 || Math.abs(u.z) > 38) {
      u.h = wrapPi(u.h + Math.PI)
      u.x = clamp(u.x, -30, 30)
      u.z = clamp(u.z, -38, 38)
      this.events.push({ unit: 0, kind: 'bump', text: 'Airfield boundary: turn back' })
    }
    const r = FLIGHT_RINGS[u.next]
    if (Math.hypot(u.x - r[0], u.y - r[1], u.z - r[2]) < 1.5) {
      u.next = (u.next + 1) % FLIGHT_RINGS.length
      u.rings++
      this.events.push({ unit: 0, kind: 'score', text: 'Ring cleared' })
    }
    u.prop += u.throttle * dt * 60
  }
}

/** Throttle-only racing. Excess lateral acceleration releases a car from its slot. */
import { Controller } from '@obpal/core'
import { action, Machine, timestep } from './common'
import { clamp } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const SLOTCARS_SPEC: DeviceSpec = {
  id: 'slotcars',
  name: 'Slot cars',
  unit: 'Car',
  units: 4,
  kind: 'Game',
  blurb: 'Squeeze one trigger, coast into the bends and see how fast you can keep your car in its lane.',
  teaches: 'One analogue trigger is a complete controller',
  controllers: [Controller.wheel, Controller.gamepad],
  profile: 'driving',
  how: {
    'face.wheel': 'RT is the throttle · release before a bend · A puts your car back',
    'face.gamepad': 'RT is the throttle · steering has no effect · A puts your car back',
  },
  tray: [{ id: 'reslot', label: 'Put back', type: 'button', icon: 'reset' }],
  buttons: { 'media:playpause': 'tray:reslot', 'key:Space': 'tray:reslot' },
}
export const laneRadius = (n: number) => 2.1 + n * 0.45
export const laneLength = (n: number) => 16 + Math.PI * 2 * laneRadius(n)
/** Arc length along two straight eight-metre sections and two semicircles. */
export function slotPose(s: number, n: number) {
  const r = laneRadius(n),
    length = laneLength(n)
  s = ((s % length) + length) % length
  if (s < 8) return { x: s - 4, z: r, h: -Math.PI / 2, curve: 0 }
  s -= 8
  if (s < Math.PI * r) {
    const a = Math.PI / 2 - s / r
    return { x: 4 + r * Math.cos(a), z: r * Math.sin(a), h: -a, curve: 1 / r }
  }
  s -= Math.PI * r
  if (s < 8) return { x: 4 - s, z: -r, h: Math.PI / 2, curve: 0 }
  s -= 8
  const a = -Math.PI / 2 - s / r
  return { x: -4 + r * Math.cos(a), z: r * Math.sin(a), h: -a, curve: 1 / r }
}
export class SlotcarsLogic extends Machine {
  readonly spec = SLOTCARS_SPEC
  units = Array.from({ length: 4 }, (_, n) => ({
    s: 3.8,
    v: 0,
    x: -0.2,
    z: laneRadius(n),
    y: 0.09,
    h: -Math.PI / 2,
    off: false,
    vx: 0,
    vz: 0,
    vy: 0,
    laps: 0,
    actions: 0,
  }))
  home(n: number) {
    Object.assign(this.units[n], { s: 3.8, v: 0, ...slotPose(3.8, n), y: 0.09, off: false, vx: 0, vz: 0, vy: 0 })
  }
  readout(n: number) {
    const u = this.units[n]
    return u.off ? 'Off track · put back' : `${u.v.toFixed(1)} m/s · ${u.laps} laps`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const i = inputs[n] ?? null
      if (action(i, 'reslot')) {
        u.actions++
        this.home(n)
      }
      if (u.off) {
        u.vy -= dt * 5
        u.x = clamp(u.x + u.vx * dt, -10, 10)
        u.z = clamp(u.z + u.vz * dt, -7, 7)
        u.y = Math.max(0.09, u.y + u.vy * dt)
        u.vx *= Math.exp(-dt * (u.y <= 0.09 ? 4 : 0.3))
        u.vz *= Math.exp(-dt * (u.y <= 0.09 ? 4 : 0.3))
        return
      }
      const power = clamp(i?.pad?.triggers[1] ?? 0, 0, 1)
      u.v = clamp(u.v + (power * 10 - u.v * 1.2 - (power ? 0 : 2.5)) * dt, 0, 8)
      const next = u.s + u.v * dt
      if (next >= laneLength(n)) {
        u.laps++
        this.events.push({ unit: n, kind: 'score', text: `Lap ${u.laps}` })
      }
      u.s = next % laneLength(n)
      const p = slotPose(u.s, n)
      u.x = p.x
      u.z = p.z
      u.h = p.h
      if (u.v * u.v * p.curve > 10) {
        u.off = true
        u.vx = -Math.sin(u.h) * u.v
        u.vz = -Math.cos(u.h) * u.v
        u.vy = 1.5
        this.events.push({ unit: n, kind: 'fall', text: 'Too fast into the bend' })
      }
    })
  }
}

/** A buoyant launch with rudder steering, momentum and a marked harbour course. */
import { Controller } from '@obpal/core'
import { action, drive, Machine, timestep } from './common'
import { clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const BOAT_SPEC: DeviceSpec = {
  id: 'boat',
  name: 'Boat',
  unit: 'Boat',
  units: 2,
  kind: 'Vehicle',
  blurb: 'Thread the harbour buoys, leave a wake, and come alongside the dock.',
  teaches: 'A rudder needs water moving past it',
  controllers: [Controller.wheel, Controller.gamepad, Controller.trackpad],
  profile: 'driving',
  how: {
    'face.wheel': 'Tilt steers · RT ahead · LT reverse · A horn',
    'face.gamepad': 'Left stick steers and powers · triggers ahead / reverse',
    'face.trackpad': 'Drag or tilt to steer and power · tap: horn',
  },
  tray: [{ id: 'horn', label: 'Horn', type: 'button', icon: 'sound' }],
  buttons: { 'media:playpause': 'tray:horn', 'key:KeyH': 'tray:horn' },
}
export const BUOYS = [
  [-3, -4],
  [3, -6],
  [7, 0],
  [2, 6],
  [-6, 4],
] as const
export class BoatLogic extends Machine {
  readonly spec = BOAT_SPEC
  units = Array.from({ length: 2 }, (_, n) => ({
    x: -2 + n * 2,
    z: 1,
    h: 0,
    v: 0,
    vx: 0,
    vz: 0,
    rudder: 0,
    horn: 0,
    next: 0,
    laps: 0,
  }))
  private drags = this.units.map(() => new DragStick())
  home(n: number) {
    Object.assign(this.units[n], { x: -2 + n * 2, z: 1, h: 0, v: 0, vx: 0, vz: 0, rudder: 0 })
    this.drags[n] = new DragStick()
  }
  readout(n: number) {
    const b = this.units[n]
    return `${(Math.abs(b.v) * 1.94).toFixed(1)} kn · buoy ${b.next + 1}`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((b, n) => {
      const i = inputs[n] ?? null,
        [steer, throttle] = drive(i, this.drags[n])
      b.rudder += (steer * 0.6 - b.rudder) * Math.min(1, dt * 7)
      b.v = clamp(b.v + (throttle * 2 - b.v * 0.65) * dt, -1.4, 3)
      b.h = wrapPi(b.h - b.rudder * b.v * dt)
      b.vx += (-Math.sin(b.h) * b.v - b.vx) * Math.min(1, dt * 2)
      b.vz += (-Math.cos(b.h) * b.v - b.vz) * Math.min(1, dt * 2)
      b.x += b.vx * dt
      b.z += b.vz * dt
      if (Math.abs(b.x) > 10 || Math.abs(b.z) > 9 || (b.z > 2.6 && b.x < 1.3 && b.x > -5.5)) {
        b.x -= b.vx * dt
        b.z -= b.vz * dt
        b.v *= -0.2
        b.vx *= -0.2
        b.vz *= -0.2
      }
      b.x = clamp(b.x, -10, 10)
      b.z = clamp(b.z, -9, 9)
      b.horn = Math.max(0, b.horn - dt)
      if (action(i, 'horn')) {
        b.horn = 0.7
        this.events.push({ unit: n, kind: 'tick', text: 'Ahoy!' })
      }
      const buoy = BUOYS[b.next]
      if (Math.hypot(b.x - buoy[0], b.z - buoy[1]) < 1.2) {
        b.next = (b.next + 1) % BUOYS.length
        if (!b.next) b.laps++
        this.events.push({ unit: n, kind: 'score', text: `Buoy cleared · ${b.laps} laps` })
      }
    })
  }
}

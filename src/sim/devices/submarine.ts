/** A trimmed submersible: water drag, ballast and expanding sonar pulses over a wreck field. */
import { Controller } from '@obpal/core'
import { action, drive, Machine, timestep } from './common'
import { clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const SUBMARINE_SPEC: DeviceSpec = {
  id: 'submarine', name: 'Submarine', unit: 'Submarine', units: 2, kind: 'Vehicle',
  blurb: 'Trim your ballast, explore the seabed and ping the wrecks with sonar.',
  teaches: 'Ballast changes buoyancy while water drag slows every turn',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left stick steers / thrusts · RT rises · LT dives · A sonar ping',
    'face.trackpad': 'Drag or tilt steers / thrusts · two-finger drag changes ballast · tap: sonar',
  },
  tray: [{ id: 'ping', label: 'Sonar ping', type: 'button', icon: 'sound' }],
  buttons: { 'media:playpause': 'tray:ping', 'key:Space': 'tray:ping' },
}
export const SUBMARINE_WRECKS = [
  { x: -5, y: 0.8, z: -5, name: 'Coastal launch' },
  { x: 7, y: 0.8, z: -8, name: 'Cargo stern' },
  { x: 9, y: 0.8, z: 6, name: 'Survey capsule' },
  { x: -10, y: 0.8, z: 8, name: 'Fishing boat' },
] as const
export const SUBMARINE_LIMITS = { x: 15, z: 14, floor: 0.65, ceiling: 8, sonar: 6 }

export class SubmarineLogic extends Machine {
  readonly spec = SUBMARINE_SPEC
  units = Array.from({ length: 2 }, (_, n) => ({
    x: -1.8 + n * 3.6, y: 4, z: 4, h: 0, v: 0, vx: 0, vy: 0, vz: 0, pitch: 0,
    ballast: 0.12, thrust: 0, prop: 0, ping: 0, cooldown: 0, pingX: 0, pingY: 0, pingZ: 0,
    found: 0, score: 0, actions: 0,
  }))
  private drags = this.units.map(() => new DragStick())
  private waiting = this.units.map(() => false)
  home(n: number) {
    Object.assign(this.units[n], {
      x: -1.8 + n * 3.6, y: 4, z: 4, h: 0, v: 0, vx: 0, vy: 0, vz: 0, pitch: 0,
      ballast: 0.12, thrust: 0, prop: 0, ping: 0, cooldown: 0,
    })
    this.drags[n] = new DragStick()
    this.waiting[n] = true
  }
  readout(n: number) {
    const u = this.units[n]
    return `${(9 - u.y).toFixed(1)} m deep · ${u.score} pts · ${u.score / 100}/${SUBMARINE_WRECKS.length} wrecks`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n] ?? null
      if (!raw || raw.quiet || (!raw.touching && ![...(raw.pad?.axes ?? []), ...(raw.pad?.triggers ?? []), ...raw.tilt, ...raw.pan].some((v) => Math.abs(v) > 0.05))) this.waiting[n] = false
      const i = raw?.quiet || this.waiting[n] ? null : raw
      // Unlike a car, the triggers change ballast; thrust always belongs to the left stick.
      const [steer, dragPower] = drive(i?.pad ? { ...i, pad: { ...i.pad, triggers: [0, 0] } } : i, this.drags[n])
      const rise = i?.pad ? clamp(i.pad.triggers[1] - i.pad.triggers[0], -1, 1) : clamp(-(i?.pan[1] ?? 0) / 30, -1, 1)
      u.thrust = clamp(dragPower, -1, 1)
      u.ballast = clamp(u.ballast + (0.12 - rise - u.ballast) * Math.min(1, dt * 3), -0.88, 1.12)
      u.v = clamp(u.v + (u.thrust * 2.3 - u.v * 1.1) * dt, -1.5, 2.5)
      u.h = wrapPi(u.h - steer * dt * 0.85)
      const gain = Math.min(1, dt * 2)
      u.vx = clamp(u.vx + (-Math.sin(u.h) * u.v - u.vx) * gain, -2.5, 2.5)
      u.vz = clamp(u.vz + (-Math.cos(u.h) * u.v - u.vz) * gain, -2.5, 2.5)
      u.vy = clamp(u.vy + ((0.12 - u.ballast) * 1.6 - u.vy * 1.8) * dt, -1.2, 1.2)
      u.x = clamp(u.x + u.vx * dt, -15, 15)
      u.y = clamp(u.y + u.vy * dt, 0.65, 8)
      u.z = clamp(u.z + u.vz * dt, -14, 14)
      if (Math.abs(u.x) === 15) u.vx = 0
      if (Math.abs(u.z) === 14) u.vz = 0
      if (u.y === 0.65 || u.y === 8) u.vy = 0
      u.pitch += (clamp(u.vy * 0.16, -0.18, 0.18) - u.pitch) * gain
      u.prop = (u.prop + u.v * dt * 16) % (Math.PI * 2)
      u.cooldown = Math.max(0, u.cooldown - dt)
      if ((action(i, 'ping') || (!this.waiting[n] && raw?.presses.includes('ping'))) && u.cooldown === 0) {
        u.ping = 0.01
        u.pingX = u.x; u.pingY = u.y; u.pingZ = u.z
        u.cooldown = 1.8
        u.actions++
        this.events.push({ unit: n, kind: 'tick', text: 'Sonar ping' })
      }
      if (u.ping > 0) {
        u.ping = Math.min(SUBMARINE_LIMITS.sonar, u.ping + dt * 4)
        SUBMARINE_WRECKS.forEach((wreck, w) => {
          if (!(u.found & (1 << w)) && Math.hypot(wreck.x - u.pingX, wreck.y - u.pingY, wreck.z - u.pingZ) <= u.ping) {
            u.found |= 1 << w
            u.score += 100
            this.events.push({ unit: n, kind: 'score', text: `${wreck.name} discovered · ${u.score} points` })
          }
        })
        if (u.ping === SUBMARINE_LIMITS.sonar) u.ping = 0
      }
    })
  }
}

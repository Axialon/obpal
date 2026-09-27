/** Four free-steering karts. A lap requires every gate, crossed in the forward direction. */
import { Controller } from '@obpal/core'
import { action, drive, Machine, timestep } from './common'
import { clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const KART_SPEC: DeviceSpec = {
  id: 'kart', name: 'Kart track', unit: 'Kart', units: 4, kind: 'Vehicle',
  blurb: 'Drift around a bank of bends and race your friends through every checkpoint.',
  teaches: 'Tilt steering and analogue pedals share the same racing controls',
  controllers: [Controller.wheel, Controller.gamepad], profile: 'driving',
  how: {
    'face.wheel': 'Tilt steers · RT accelerates · LT reverses · A drifts',
    'face.gamepad': 'Left stick steers / powers · RT / LT pedals · A drifts',
  },
  tray: [{ id: 'drift', label: 'Drift', type: 'button', icon: 'wheel' }],
  buttons: { 'media:playpause': 'tray:drift', 'key:Space': 'tray:drift' },
}
export const KART_TRACK = { inner: 5.2, outer: 10.2, radius: 7.7, gates: 8 }
export const KART_CHECKPOINTS = Array.from({ length: KART_TRACK.gates }, (_, n) => (n + 1) * Math.PI / 4)
const start = (n: number) => ({ x: -0.7 - Math.floor(n / 2) * 1.7, z: 7 + n % 2 * 1.4, h: -Math.PI / 2 })

export class KartLogic extends Machine {
  readonly spec = KART_SPEC
  units = Array.from({ length: 4 }, (_, n) => ({
    ...start(n), v: 0, vx: 0, vz: 0, steer: 0, drift: 0, next: 0, laps: 0, actions: 0,
  }))
  private drags = this.units.map(() => new DragStick())
  private waiting = this.units.map(() => false)
  home(n: number) {
    Object.assign(this.units[n], { ...start(n), v: 0, vx: 0, vz: 0, steer: 0, drift: 0, next: 0 })
    this.drags[n] = new DragStick()
    this.waiting[n] = true
  }
  leaderboard() {
    return this.units.map((u, n) => ({ unit: n, laps: u.laps, checkpoints: u.next }))
      .sort((a, b) => b.laps - a.laps || b.checkpoints - a.checkpoints || a.unit - b.unit)
  }
  readout(n: number) {
    const u = this.units[n], rank = this.leaderboard().findIndex((r) => r.unit === n) + 1
    return `#${rank} · ${u.laps} laps · gate ${u.next + 1}/8 · ${(Math.abs(u.v) * 3.6).toFixed(0)} km/h`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n] ?? null
      if (!raw || raw.quiet || (!raw.touching && ![...(raw.pad?.axes ?? []), ...(raw.pad?.triggers ?? []), ...raw.tilt, ...raw.pan].some((v) => Math.abs(v) > 0.05))) this.waiting[n] = false
      const i = raw?.quiet || this.waiting[n] ? null : raw
      const [steer, power] = drive(i, this.drags[n])
      u.drift = i ? Math.max(0, u.drift - dt) : 0
      if (action(i, 'drift') || (!this.waiting[n] && raw?.presses.includes('drift'))) {
        u.drift = 0.85
        u.actions++
        this.events.push({ unit: n, kind: 'tick', text: 'Drift: catch the slide with the wheel' })
      }
      u.steer += (steer - u.steer) * Math.min(1, dt * 10)
      u.v = clamp(u.v + (clamp(power, -1, 1) * 6 - u.v * (power ? 0.7 : 2.8)) * dt, -3, 8)
      u.h = wrapPi(u.h - u.steer * u.v * (u.drift ? 0.32 : 0.24) * dt)
      const grip = Math.min(1, dt * (u.drift ? 2.1 : 11))
      u.vx = clamp(u.vx + (-Math.sin(u.h) * u.v - u.vx) * grip, -8, 8)
      u.vz = clamp(u.vz + (-Math.cos(u.h) * u.v - u.vz) * grip, -8, 8)
      const before = Math.atan2(u.x, u.z)
      u.x += u.vx * dt
      u.z += u.vz * dt
      const radius = Math.hypot(u.x, u.z)
      const safe = clamp(radius, KART_TRACK.inner, KART_TRACK.outer)
      if (radius !== safe) {
        const nx = radius ? u.x / radius : 0, nz = radius ? u.z / radius : 1
        u.x = nx * safe
        u.z = nz * safe
        const radial = u.vx * nx + u.vz * nz
        u.vx -= radial * nx
        u.vz -= radial * nz
        u.v *= Math.exp(-dt * 8)
      }
      const after = Math.atan2(u.x, u.z), travel = wrapPi(after - before)
      const distance = (KART_CHECKPOINTS[u.next] - before + Math.PI * 4) % (Math.PI * 2)
      // A bounded frame cannot cross more than one gate. Reverse crossings never award progress.
      if (dt > 0 && travel > 0 && travel < 0.3 && distance > 0 && distance <= travel) {
        u.next = (u.next + 1) % KART_TRACK.gates
        if (!u.next) u.laps++
        this.events.push({ unit: n, kind: 'score', text: u.next ? `Gate ${u.next}/8` : `Lap ${u.laps}` })
      }
    })
  }
}

/** A small helicopter with a stabilised collective and a slow, forgiving cyclic. */
import { Controller, Mode } from '@obpal/core'
import { action, Machine, timestep } from './common'
import { axis, clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'
import { planar } from '../vr/intent'

export const HELICOPTER_SPEC: DeviceSpec = {
  id: 'helicopter', name: 'Helicopter', unit: 'Helicopter', units: 2, kind: 'Flyer',
  blurb: 'Lift into a steady hover, thread the training rings and settle onto your pad.',
  teaches: 'Collective changes height; the cyclic tilts the rotor to travel',
  controllers: [Controller.gamepad, Controller.trackpad], profile: 'flight',
  how: {
    'face.gamepad': 'RT climbs · LT descends · tilt / right stick flies · left stick turns · A takes off / lands',
    'face.trackpad': 'Drag or tilt flies · two-finger drag changes height · tap takes off / lands',
  },
  tray: [{ id: 'fly', label: 'Take off / land', type: 'button', icon: 'plane' }],
  buttons: { 'media:playpause': 'tray:fly', 'key:KeyT': 'tray:fly' },
}
export const HELICOPTER_PADS = [[-2, 4], [2, 4]] as const
export const HELICOPTER_RINGS = [
  { x: -2, y: 2, z: 0, face: 0 },
  { x: -2, y: 3.5, z: -5, face: 0 },
  { x: 3, y: 3.5, z: -5, face: Math.PI / 2 },
  { x: 3, y: 2, z: 1, face: 0 },
] as const
export const HELICOPTER_LIMITS = { x: 11, z: 10, floor: 0.22, ceiling: 8 }

export class HelicopterLogic extends Machine {
  readonly spec = HELICOPTER_SPEC
  units = HELICOPTER_PADS.map(([x, z]) => ({
    x: Number(x), z: Number(z), y: 0.22, h: 0, vx: 0, vy: 0, vz: 0, pitch: 0, roll: 0, collective: 0,
    flying: false, targetY: 1.6, rotor: 0, spin: 0, next: 0, rings: 0, landings: 0, departed: false, actions: 0,
  }))
  private drags = this.units.map(() => new DragStick())
  private waiting = this.units.map(() => false)
  home(n: number) {
    const [x, z] = HELICOPTER_PADS[n]
    Object.assign(this.units[n], {
      x, z, y: 0.22, h: 0, vx: 0, vy: 0, vz: 0, pitch: 0, roll: 0, collective: 0,
      flying: false, targetY: 1.6, rotor: 0, spin: 0, next: 0, departed: false,
    })
    this.drags[n] = new DragStick()
    this.waiting[n] = true
  }
  readout(n: number) {
    const u = this.units[n]
    return `${u.y.toFixed(1)} m · ${u.rings} rings · next ${u.next + 1} · ${u.landings} landings`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n] ?? null
      if (!raw || raw.quiet || (!raw.touching && ![...(raw.pad?.axes ?? []), ...(raw.pad?.triggers ?? []), ...raw.tilt, ...raw.pan].some((v) => Math.abs(v) > 0.05))) this.waiting[n] = false
      const i = raw?.quiet || this.waiting[n] ? null : raw
      const [dx, dy] = this.drags[n].update(!!i?.touching, i?.drag ?? [0, 0])
      const [right, back] = planar(i?.controlFrame,
        i?.pad ? axis(i.pad.axes[2]) : clamp(dx + (i?.mode === Mode.tilt ? i.tilt[0] : 0), -1, 1),
        i?.pad ? axis(i.pad.axes[3]) : clamp(dy + (i?.mode === Mode.tilt ? i.tilt[1] : 0), -1, 1), true)
      const forward = -back
      const climb = i?.pad ? clamp(i.pad.triggers[1] - i.pad.triggers[0], -1, 1) : clamp(-(i?.pan[1] ?? 0) / 30, -1, 1)
      if (!i) u.flying = false
      if (action(i, 'fly') || (!this.waiting[n] && raw?.presses.includes('fly'))) {
        u.flying = !u.flying
        u.targetY = Math.max(1.6, u.y)
        u.actions++
        this.events.push({ unit: n, kind: 'tick', text: u.flying ? 'Lift into hover' : 'Landing' })
      }
      if (climb > 0.08 && !u.flying) { u.flying = true; u.targetY = Math.max(1.6, u.y) }
      u.collective = u.flying ? climb : 0
      u.targetY = clamp(u.targetY + u.collective * dt * 1.8, HELICOPTER_LIMITS.floor, HELICOPTER_LIMITS.ceiling)
      const gain = Math.min(1, dt * 3)
      u.h = wrapPi(u.h - (i?.pad ? axis(i.pad.axes[0]) : 0) * dt * 1.4)
      const tx = u.flying ? (right * Math.cos(u.h) - forward * Math.sin(u.h)) * 2.7 : 0
      const tz = u.flying ? (-forward * Math.cos(u.h) - right * Math.sin(u.h)) * 2.7 : 0
      u.vx = clamp(u.vx + (tx - u.vx) * gain, -3.8, 3.8)
      u.vz = clamp(u.vz + (tz - u.vz) * gain, -3.8, 3.8)
      u.vy = clamp(u.vy + ((u.flying ? clamp((u.targetY - u.y) * 2, -1.4, 1.4) : -0.7) - u.vy) * gain, -1.4, 1.4)
      const before = [u.x, u.y, u.z]
      u.x = clamp(u.x + u.vx * dt, -11, 11)
      u.z = clamp(u.z + u.vz * dt, -10, 10)
      u.y = clamp(u.y + u.vy * dt, 0.22, 8)
      const contact = Math.max(Math.abs(u.x) === 11 ? Math.abs(u.vx) : 0, Math.abs(u.z) === 10 ? Math.abs(u.vz) : 0, u.y === 0.22 || u.y === 8 ? Math.abs(u.vy) : 0)
      if (contact > 0.3) this.events.push({ unit: n, kind: 'bump', audio: { speed: contact } })
      if (Math.abs(u.x) === 11) u.vx = 0
      if (Math.abs(u.z) === 10) u.vz = 0
      if (u.y === 8) u.vy = Math.min(0, u.vy)
      if (u.y > 1) u.departed = true
      if (u.y === 0.22) {
        u.vy = 0
        if (u.collective < 0) u.flying = false
        if (!u.flying) {
          u.vx = u.vz = 0
          const pad = HELICOPTER_PADS[n]
          if (u.departed && Math.hypot(u.x - pad[0], u.z - pad[1]) < 1.2) {
            u.landings++
            this.events.push({ unit: n, kind: 'score', text: 'Back on your landing pad' })
          }
          u.departed = false
        }
      }
      u.pitch += ((u.flying ? -forward * 0.22 : 0) - u.pitch) * gain
      u.roll += ((u.flying ? -right * 0.22 : 0) - u.roll) * gain
      u.rotor += ((u.flying || u.y > 0.22 ? 1 : 0) - u.rotor) * gain
      u.spin = (u.spin + u.rotor * dt * 42) % (Math.PI * 2)
      const r = HELICOPTER_RINGS[u.next], nx = Math.sin(r.face), nz = Math.cos(r.face)
      const a = (before[0] - r.x) * nx + (before[2] - r.z) * nz
      const b = (u.x - r.x) * nx + (u.z - r.z) * nz
      if (a !== b && a * b <= 0) {
        const t = a / (a - b), x = before[0] + (u.x - before[0]) * t - r.x
        const y = before[1] + (u.y - before[1]) * t - r.y, z = before[2] + (u.z - before[2]) * t - r.z
        if (Math.hypot(x, y, z) < 1) {
          u.next = (u.next + 1) % HELICOPTER_RINGS.length
          u.rings++
          this.events.push({ unit: n, kind: 'score', text: `Ring ${u.rings} · next ${u.next + 1}` })
        }
      }
    })
  }
}

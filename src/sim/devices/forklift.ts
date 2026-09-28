/** A warehouse truck: forks lift and tilt, pallets attach only when approached level and low. */
import { Controller } from '@obpal/core'
import { action, blocked, drive, Machine, timestep } from './common'
import { axis, clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const FORKLIFT_SPEC: DeviceSpec = {
  id: 'forklift',
  name: 'Forklift',
  unit: 'Forklift',
  units: 1,
  kind: 'Machine',
  blurb: 'Pick up the pallets, carry them through the warehouse and stack them on the racks.',
  teaches: 'Drive and lift with independent sticks',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left stick drives · right up lifts / sideways tilts · A picks up or releases',
    'face.trackpad': 'Pick a part on the strip, then drag · tap loads',
  },
  tray: [{ id: 'load', label: 'Pallet', type: 'button', icon: 'cube' }],
  buttons: { 'media:playpause': 'tray:load', 'key:Space': 'tray:load' },
  // Driving on its own, or the forks: the strip hands the one finger to either, and the truck coasts to a stop meanwhile.
  parts: [
    { id: 'drive', name: 'Drive', icon: 'wheel', channels: ['drag.x', 'drag.y'], stick: true },
    { id: 'lift', name: 'Lift', icon: 'slide', channels: ['pan.y'] },
    { id: 'tilt', name: 'Tilt', icon: 'nod', channels: ['twist'] },
  ],
  sets: [{ id: 'forks', name: 'Forks', icon: 'lift', parts: ['tilt', 'lift'] }],
}
export const RACKS = [-3, 3]
/** Shared fork frame and pallet bearing plane, metres. */
export const FORKS = { mastZ: -.79, loadZ: -.56, top: .03, deckBottom: .0125, runnerDepth: .12, halfDepth: .425 }
export function forkLoad(u: { x: number; z: number; h: number; lift: number; tilt: number }) {
  const c = Math.cos(u.tilt), s = Math.sin(u.tilt), y = u.lift + FORKS.top - FORKS.deckBottom
  const z = FORKS.mastZ + y * s + FORKS.loadZ * c
  return { x: u.x + Math.sin(u.h) * z, y: y * c - FORKS.loadZ * s, z: u.z + Math.cos(u.h) * z }
}
export const PALLETS = [
  [0, 0],
  [2, 1],
  [-2, 0],
  [1, -3],
] as const
export class ForkliftLogic extends Machine {
  readonly spec = FORKLIFT_SPEC
  units = [{ x: 0, z: 2, h: 0, v: 0, lift: 0.12, tilt: 0, load: -1, actions: 0, delivered: 0 }]
  pallets: { x: number; y: number; z: number; vy: number; stored: boolean }[] = PALLETS.map(([x, z]) => ({
    x,
    y: 0.12,
    z,
    vy: 0,
    stored: false,
  }))
  private drag = new DragStick()
  home() {
    const u = this.units[0]
    if (u.load >= 0) {
      this.pallets[u.load].y = 0.12
      this.pallets[u.load].vy = 0
    }
    Object.assign(u, { x: 0, z: 2, h: 0, v: 0, lift: 0.12, tilt: 0, load: -1 })
    this.drag = new DragStick()
  }
  reset() {
    this.pallets = PALLETS.map(([x, z]) => ({ x, y: 0.12, z, vy: 0, stored: false }))
    this.units[0].load = -1
    this.units[0].delivered = 0
    this.home()
  }
  readonly resetLabel = 'Pallets back'
  readout() {
    const u = this.units[0]
    return `${u.lift.toFixed(1)} m · ${u.delivered} stored`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta),
      i = inputs[0] ?? null,
      u = this.units[0],
      [steer, power] = drive(i, this.drag, true)
    const speed = u.lift > 1 ? 0.6 : u.load >= 0 ? 1.2 : 2
    u.v += (power * speed - u.v) * Math.min(1, dt * 7)
    u.h = wrapPi(u.h - steer * u.v * dt * 0.7)
    const obstacles = RACKS.flatMap((x) => [-1, 1].map((s) => ({ x: x + s * 1, z: -3.1, w: 0.16, d: 1.8 })))
    const x = clamp(u.x - Math.sin(u.h) * u.v * dt, -5.3, 5.3),
      z = clamp(u.z - Math.cos(u.h) * u.v * dt, -4.6, 4.6)
    if (!blocked(x, z, 0.62, obstacles)) {
      u.x = x
      u.z = z
    } else u.v = 0
    if (i) {
      u.lift = clamp(u.lift + (i.pad ? -axis(i.pad.axes[3]) * dt * 0.8 : -i.pan[1] * 0.008), 0.08, 2.1)
      u.tilt = clamp(u.tilt + (i.pad ? axis(i.pad.axes[2]) * dt * 0.3 : i.twist * 0.006), -0.22, 0.25)
    }
    const c = Math.cos(u.tilt), s = Math.sin(u.tilt)
    const forkFloor = .03 + Math.max(0, -.975 * s / c)
    const loadFloor = FORKS.runnerDepth - FORKS.top + FORKS.deckBottom + (FORKS.halfDepth * Math.abs(s) + FORKS.loadZ * s) / c
    u.lift = Math.max(u.lift, forkFloor, u.load >= 0 ? loadFloor : 0)
    const tip = forkLoad(u)
    if (action(i, 'load')) {
      u.actions++
      if (u.load >= 0) {
        const p = this.pallets[u.load]
        if (RACKS.some((x) => Math.abs(p.x - x) < 0.7) && Math.abs(p.z + 3.1) < 0.7 && Math.abs(u.lift - 1.4) < 0.22) {
          p.stored = true
          p.y = 1.4
          u.delivered++
          this.events.push({ unit: 0, kind: 'score', text: 'Pallet stored' })
        }
        u.load = -1
      } else if (u.lift < 0.25 && Math.abs(u.tilt) < 0.15) {
        u.load = this.pallets.findIndex((p) => !p.stored && Math.hypot(p.x - tip.x, p.z - tip.z) < 0.55)
        if (u.load >= 0) this.events.push({ unit: 0, kind: 'tick', text: 'Pallet on the forks' })
      }
    }
    if (u.load >= 0) {
      const p = this.pallets[u.load]
      p.x = tip.x
      p.z = tip.z
      p.y = tip.y
      p.vy = 0
      if (u.tilt < -0.18) {
        u.load = -1
        this.events.push({ unit: 0, kind: 'bump', text: 'Pallet slipped off' })
      }
    }
    this.pallets.forEach((p, n) => {
      if (n === u.load || p.stored) return
      p.vy -= dt * 4
      p.y = Math.max(0.12, p.y + p.vy * dt)
      if (p.y === 0.12) {
        if (p.vy < -0.3) this.events.push({ unit: 0, kind: 'bump', audio: { at: [p.x, p.y, p.z], speed: -p.vy, materials: ['wood', 'tile'] } })
        p.vy = 0
      }
    })
  }
}

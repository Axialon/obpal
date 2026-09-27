/** Four independently claimed appliances share one room; a scene deliberately changes all four. */
import { Controller } from '@obpal/core'
import { Machine, timestep } from './common'
import { approach, clamp } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const SMARTHOME_SPEC: DeviceSpec = {
  id: 'smarthome', name: 'Smart home room', unit: 'Appliance', units: 4,
  unitNames: ['Blinds', 'Ceiling fan', 'Television', 'Thermostat'], kind: 'Home',
  blurb: 'Share a furnished room: open the blinds, spin the fan, tune the TV and set the temperature.',
  teaches: 'One phone per appliance, with room scenes that coordinate them',
  controllers: [Controller.trackpad, Controller.mouse],
  how: {
    'face.trackpad': 'Drag up or twist to raise your setting · tap switches it · Movie and Morning change the whole room',
    'face.mouse': 'Wheel changes your setting · Left switches it · Movie and Morning change the whole room',
  },
  tray: [
    { id: 'power', label: 'On / off', type: 'button', icon: 'sun' },
    { id: 'lower', label: 'Lower', type: 'button', icon: 'arrow-down' },
    { id: 'raise', label: 'Raise', type: 'button', icon: 'arrow-up' },
    { id: 'movie', label: 'Movie', type: 'button', icon: 'view' },
    { id: 'morning', label: 'Morning', type: 'button', icon: 'sun' },
  ],
  buttons: { 'media:playpause': 'tray:power', 'key:KeyM': 'tray:movie', 'key:KeyD': 'tray:morning' },
}

export interface RoomAppliance {
  on: boolean
  /** Normalised setting and its visible, mechanically eased position. */
  target: number
  level: number
  phase: number
  actions: number
}
const HOME = [0.7, 0.35, 0, 3 / 7]
export const roomSetpoint = (u: RoomAppliance) => Math.round((16 + u.target * 14) * 2) / 2
export const roomChannel = (u: RoomAppliance) => Math.min(3, Math.floor(u.target * 4))

export class SmarthomeLogic extends Machine {
  readonly spec = SMARTHOME_SPEC
  readonly units: RoomAppliance[] = HOME.map((target, n) => ({ on: n !== 2, target, level: target, phase: 0, actions: 0 }))
  temperature = 22
  scene = 'Custom'

  home(n: number) {
    Object.assign(this.units[n], { on: n !== 2, target: HOME[n], level: HOME[n], phase: 0 })
    this.scene = 'Custom'
  }

  private setScene(id: 'movie' | 'morning', n: number) {
    const levels = id === 'movie' ? [0, 0.18, 0.35, 3 / 7] : [1, 0.55, 0.75, 0.5]
    this.units.forEach((u, index) => { u.target = levels[index]; u.on = id === 'movie' || index !== 2 })
    this.scene = id === 'movie' ? 'Movie' : 'Morning'
    this.units[n].actions++
    this.events.push({ unit: n, kind: 'tick', text: `${this.scene}: the whole room` })
  }

  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const i = inputs[n]
      if (i) {
        for (const p of i.presses) {
          if (p === 'movie' || p === 'morning') { this.setScene(p, n); continue }
          if (p === 'power' || (!i.quiet && ['pad', 'mouse-left', 'wii-a'].includes(p))) {
            u.on = !u.on
            u.actions++
            this.scene = 'Custom'
            this.events.push({ unit: n, kind: 'tick', text: `${this.spec.unitNames![n]} ${u.on ? 'on' : 'off'}` })
          }
          if (p === 'raise' || p === 'lower') {
            u.target = clamp(u.target + (p === 'raise' ? 0.1 : -0.1), 0, 1)
            u.on = true
            u.actions++
            this.scene = 'Custom'
          }
        }
        if (!i.quiet) {
          const change = -i.drag[1] / 240 + i.twist / 360 - i.wheel / 1200
          if (Number.isFinite(change) && change) {
            u.target = clamp(u.target + change, 0, 1)
            u.on = true
            this.scene = 'Custom'
          }
        }
      }
      u.level = approach(u.level, u.on ? u.target : 0, n === 0 ? 0.6 : 1.5, dt)
      if (n === 1) u.phase = (u.phase + dt * u.level * 16) % (Math.PI * 2)
    })
    this.temperature = approach(this.temperature, this.units[3].on ? roomSetpoint(this.units[3]) : 22, 0.15, dt)
  }

  readout(n: number) {
    const u = this.units[n]
    if (n === 0) return `${Math.round(u.level * 100)}% open`
    if (n === 1) return u.on ? `${Math.round(u.level * 100)}% fan` : 'Fan off'
    if (n === 2) return u.on ? ['Nature', 'Cinema', 'Music', 'Weather'][roomChannel(u)] : 'TV off'
    return `${this.temperature.toFixed(1)} °C · ${u.on ? `set ${roomSetpoint(u)} °C` : 'off'}`
  }
}

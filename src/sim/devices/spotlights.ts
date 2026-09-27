/** Moving heads aim at the stage floor; mechanical pan and tilt stay within their stops. */
import { Controller } from '@obpal/core'
import { action, Machine, timestep } from './common'
import { approach, clamp, panTiltOf } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const SPOTLIGHTS_SPEC: DeviceSpec = {
  id: 'spotlights',
  name: 'Stage spotlights',
  unit: 'Head',
  units: 4,
  kind: 'Show',
  blurb: 'Point a moving head across the stage. Mix colours and patterned beams in the haze.',
  teaches: 'Pointing aims a physical light',
  controllers: [Controller.wii, Controller.trackpad],
  how: {
    'face.wii': 'Point to aim · A changes colour · Gobo changes the pattern',
    'face.trackpad': 'Drag or turn 1:1 to aim · tap changes colour',
  },
  tray: [
    { id: 'colour', label: 'Colour', type: 'button', icon: 'sun' },
    { id: 'gobo', label: 'Gobo', type: 'button', icon: 'frame' },
  ],
  buttons: { 'media:playpause': 'tray:colour', 'key:KeyC': 'tray:colour', 'key:KeyG': 'tray:gobo' },
}
export const LIGHT_COLOURS = ['#76d9ff', '#ee91ff', '#ffd580', '#83ffb8', '#ffffff']
export class SpotlightsLogic extends Machine {
  readonly spec = SPOTLIGHTS_SPEC
  units = Array.from({ length: 4 }, (_, n) => ({ x: (n - 1.5) * 2, z: 1, pan: 0, tilt: 0, colour: n, gobo: n % 3 }))
  private points = this.units.map(() => [0, 0])
  private zeros = this.units.map(() => [0, 0])
  home(n: number) {
    Object.assign(this.units[n], { x: (n - 1.5) * 2, z: 1, pan: 0, tilt: 0 })
    this.zeros[n] = [...this.points[n]]
  }
  readout(n: number) {
    const h = this.units[n]
    return `${Math.round(h.pan * 57.3)}° · gobo ${h.gobo + 1}`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((h, n) => {
      const i = inputs[n]
      if (!i) return
      if (!i.quiet) {
        if (i.point) this.points[n] = [i.point.yaw, i.point.pitch]
        if (i.recentred) this.home(n)
        else if (i.point) {
          h.x = clamp((n - 1.5) * 2 + (i.point.yaw - this.zeros[n][0]) * 0.15, -5, 5)
          h.z = clamp(1 - (i.point.pitch - this.zeros[n][1]) * 0.12, -1, 4)
        } else if (i.hold) {
          const [pan, tilt] = panTiltOf(i.hold)
          h.x = clamp(-pan * 4, -5, 5)
          h.z = clamp(1 - tilt * 4, -1, 4)
        } else {
          h.x = clamp(h.x + i.drag[0] * 0.015, -5, 5)
          h.z = clamp(h.z + i.drag[1] * 0.015, -1, 4)
        }
        h.pan = approach(h.pan, Math.atan2(h.x - (n - 1.5) * 2, 3.6), 2, dt)
        h.tilt = approach(h.tilt, Math.atan2(h.z + 1.5, 3.6), 2, dt)
      }
      if (action(i, 'colour')) {
        h.colour = (h.colour + 1) % LIGHT_COLOURS.length
        this.events.push({ unit: n, kind: 'tick' })
      }
      if (i.presses.includes('gobo')) h.gobo = (h.gobo + 1) % 3
    })
  }
}

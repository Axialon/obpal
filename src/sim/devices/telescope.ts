/** A curated, fixed sky for learning to point a mount. Angles are a play chart, not a current ephemeris. */
import { Controller } from '@obpal/core'
import { Machine, action, timestep } from './common'
import { axis, clamp, panTiltOf } from './input'
import type { DeviceInput, DeviceSpec } from './types'
import { panSign } from '../vr/intent'

export const TELESCOPE_SPEC: DeviceSpec = {
  category: 'space-science',
  id: 'telescope', name: 'Telescope mount', unit: 'Telescope', units: 2, kind: 'Science',
  blurb: 'Point into a named star field, zoom through the eyepiece and log each object you find.',
  teaches: 'Absolute pointing and gyro 1:1 aim the same pan and elevation mount',
  controllers: [Controller.wii, Controller.trackpad, Controller.gamepad],
  how: {
    'face.wii': 'Point to aim · + / − zoom · A checks the object at the crosshair · Home centres the mount',
    'face.trackpad': 'Pick a part on the strip, then drag · tap checks',
    'face.gamepad': 'Right stick aims · triggers zoom · A checks the object at the crosshair',
  },
  tray: [{ id: 'find', label: 'Found it', type: 'button', icon: 'tap' }, { id: 'in', label: 'Zoom in', type: 'button', icon: 'plus' }, { id: 'out', label: 'Zoom out', type: 'button', icon: 'minus' }],
  buttons: { 'key:Space': 'tray:find', 'media:playpause': 'tray:find' },
  // Aim the mount, or one axis at a time, or zoom with a drag while the aim holds.
  parts: [
    { id: 'pan', name: 'Pan', icon: 'turn', channels: ['drag.x'], turn: true },
    { id: 'elevation', name: 'Elevation', icon: 'lift', channels: ['drag.y'], turn: true },
    { id: 'zoom', name: 'Zoom', icon: 'zoom-in', channels: ['pinch'] },
  ],
  sets: [{ id: 'aim', name: 'Aim', icon: 'point', parts: ['pan', 'elevation'] }],
}
export const SKY_OBJECTS = [
  { name: 'Moon', pan: 0, elevation: 0.4, color: '#e9dfc1' },
  { name: 'Saturn', pan: -0.45, elevation: 0.62, color: '#d8b779' },
  { name: 'Orion nebula', pan: 0.6, elevation: 0.3, color: '#c49aca' },
  { name: 'Sirius', pan: -0.9, elevation: 0.24, color: '#bcd7ff' },
]
export class TelescopeLogic extends Machine {
  readonly spec = TELESCOPE_SPEC
  readonly units = [0, 1].map(() => ({ pan: 0, elevation: 0.4, zoom: 1, found: [] as number[], actions: 0, message: 'Centre Moon, then Found it' }))
  private angles = [[0, 0], [0, 0]]
  private zeros = [[0, 0], [0, 0]]
  home(n: number) { Object.assign(this.units[n], { pan: 0, elevation: 0.4, zoom: 1 }); this.zeros[n] = [...this.angles[n]] }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null
      if (i) {
        const direction = panSign(i.controlFrame, u.pan)
        if (i.point && !i.point.off) this.angles[n] = [-i.point.yaw * Math.PI / 180, i.point.pitch * Math.PI / 180]
        else if (i.hold) this.angles[n] = panTiltOf(i.hold)
        if (i.recentred) { this.zeros[n] = [...this.angles[n]]; u.pan = 0; u.elevation = 0.4 }
        if (i.space && !i.pad) {
          const [x, y] = i.space.aim
          u.pan = -x * 1.45 * (i.controlFrame?.immersive ? 1 : panSign(i.controlFrame, 0)); u.elevation = 0.4 + y * (y >= 0 ? 0.8 : 0.32)
        } else if (i.hold || i.point && !i.point.off) {
          u.pan = (this.angles[n][0] - this.zeros[n][0]) * (i.controlFrame?.immersive ? 1 : panSign(i.controlFrame, 0)); u.elevation = 0.4 + this.angles[n][1] - this.zeros[n][1]
        } else { u.pan -= (i.pad ? axis(i.pad.axes[2]) * dt * 0.6 / u.zoom : i.drag[0] * 0.004 / u.zoom) * direction; u.elevation += i.pad ? -axis(i.pad.axes[3]) * dt * 0.6 / u.zoom : -i.drag[1] * 0.004 / u.zoom }
        u.zoom *= Math.exp(i.pinch * 0.5 + (i.pad ? (i.pad.triggers[1] - i.pad.triggers[0]) * dt : 0))
        if (i.presses.includes('wii-plus')) u.zoom *= 1.3
        if (i.presses.includes('wii-minus')) u.zoom /= 1.3
      }
      if (raw?.presses.includes('in')) u.zoom *= 1.3
      if (raw?.presses.includes('out')) u.zoom /= 1.3
      u.pan = clamp(u.pan, -1.45, 1.45); u.elevation = clamp(u.elevation, 0.08, 1.2); u.zoom = clamp(u.zoom, 1, 8)
      if (raw?.presses.includes('find') || action(i, 'find')) {
        u.actions++
        const at = SKY_OBJECTS.findIndex(s => Math.hypot((s.pan - u.pan) * Math.cos(u.elevation), s.elevation - u.elevation) < 0.045)
        if (at >= 0 && !u.found.includes(at)) { u.found.push(at); u.message = `${SKY_OBJECTS[at].name} found`; this.events.push({ unit: n, kind: 'score', text: u.message }) }
        else { u.message = at >= 0 ? 'Already in your log' : 'Centre a named object in the crosshair'; this.events.push({ unit: n, kind: 'tick', text: u.message }) }
      }
    })
  }
  readout(n: number) { const u = this.units[n], next = SKY_OBJECTS.find((_, j) => !u.found.includes(j)); return `${u.found.length}/${SKY_OBJECTS.length} · ${u.zoom.toFixed(1)}× · ${next?.name ?? 'All found'}` }
}

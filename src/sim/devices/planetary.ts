/** Low-gravity driving, an articulated sampler and finite rocks in a bounded crater field. */
import { Controller, PadButton } from '@obpal/core'
import { Machine, action, drive, timestep } from './common'
import { axis, clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const PLANETARY_SPEC: DeviceSpec = {
  category: 'space-science',
  id: 'planetary', name: 'Planetary rover', unit: 'Explorer', units: 2, kind: 'Science',
  blurb: 'Explore a dusty low-gravity crater, work the sampling arm and scout through the mast camera.',
  teaches: 'Drive and operate a robot arm from twin sticks, with a separate mast camera',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left drives · right moves arm · A samples · B switches right stick to mast',
    'face.trackpad': 'Drag or tilt drives · two fingers swing and raise the arm or mast · Sample collects a nearby rock · Mast / arm switches',
  },
  tray: [{ id: 'sample', label: 'Sample', type: 'button', icon: 'tap' }, { id: 'mast', label: 'Mast / arm', type: 'button', icon: 'camera' }],
  buttons: { 'key:Space': 'tray:sample', 'key:KeyM': 'tray:mast', 'media:playpause': 'tray:sample' },
}
const elevation = (x: number, z: number) => 0.16 * Math.sin(x * 0.7) * Math.cos(z * 0.6) + 0.09 * Math.sin(z * 1.7 + x * 0.4)
/** The same two triangles as the rendered 70 by 70 height field. */
export function terrain(x: number, z: number) {
  const step = 18 / 70, ix = Math.floor((x + 9) / step), iz = Math.floor((z + 9) / step)
  const x0 = ix * step - 9, z0 = iz * step - 9, a = (x - x0) / step, b = (z - z0) / step
  return a + b <= 1
    ? elevation(x0, z0) * (1 - a - b) + elevation(x0 + step, z0) * a + elevation(x0, z0 + step) * b
    : elevation(x0 + step, z0 + step) * (a + b - 1) + elevation(x0 + step, z0) * (1 - b) + elevation(x0, z0 + step) * (1 - a)
}
export const sampleRocks = () => [[-2, 1.6], [2, 1.6], [-4, -2], [3, -3.5], [0, -5], [5, 3]].map(([x, z], n) => ({ x, z, y: terrain(x, z), sampled: false, name: ['Basalt', 'Breccia', 'Olivine', 'Shale', 'Quartz', 'Gabbro'][n] }))
export interface Explorer { x: number; y: number; z: number; h: number; v: number; vy: number; swing: number; boom: number; mastPan: number; mastTilt: number; mast: boolean; samples: number; actions: number; sampling: number }
export function sampleTip(u: Explorer) { const a = u.h + u.swing, reach = 0.55 + Math.cos(u.boom) * 0.7; return { x: u.x - Math.sin(a) * reach, y: u.y + 0.62 + Math.sin(u.boom) * 0.7, z: u.z - Math.cos(a) * reach } }
export class PlanetaryLogic extends Machine {
  readonly spec = PLANETARY_SPEC
  readonly units: Explorer[] = [-2, 2].map(x => ({ x, y: terrain(x, 3), z: 3, h: 0, v: 0, vy: 0, swing: 0, boom: -0.6, mastPan: 0, mastTilt: -0.14, mast: false, samples: 0, actions: 0, sampling: 0 }))
  readonly rocks = sampleRocks()
  private drags = [new DragStick(), new DragStick()]
  readonly resetLabel = 'Restore samples'
  reset() { this.rocks.forEach(r => { r.sampled = false }); this.units.forEach((u, n) => { u.samples = 0; this.home(n) }) }
  home(n: number) { const x = n ? 2 : -2; Object.assign(this.units[n], { x, y: terrain(x, 3), z: 3, h: 0, v: 0, vy: 0, swing: 0, boom: -0.6, mastPan: 0, mastTilt: -0.14, mast: false, sampling: 0 }); this.drags[n] = new DragStick() }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null
      if (raw?.presses.includes('mast') || i && (i.padPressed & (1 << PadButton.B))) u.mast = !u.mast
      const [steer, throttle] = drive(i, this.drags[n])
      u.v += (throttle * 1.7 - u.v * (i ? 1.2 : 4)) * dt
      u.v = clamp(u.v, -0.8, 1.6); u.h = wrapPi(u.h - steer * dt * 1.2)
      u.x = clamp(u.x - Math.sin(u.h) * u.v * dt, -8, 8); u.z = clamp(u.z - Math.cos(u.h) * u.v * dt, -8, 8)
      // Low gravity still acts in flight. A settled contact must not inject an upward impulse every frame.
      u.vy -= 1.62 * dt; u.y += u.vy * dt
      if (u.y < terrain(u.x, u.z)) { u.y = terrain(u.x, u.z); u.vy = 0 }
      const pan = i?.pad ? axis(i.pad.axes[2]) * dt : (i?.pan[0] ?? 0) * 0.008
      const tilt = i?.pad ? -axis(i.pad.axes[3]) * dt : -(i?.pan[1] ?? 0) * 0.008
      if (u.mast) { u.mastPan = clamp(u.mastPan - pan, -Math.PI, Math.PI); u.mastTilt = clamp(u.mastTilt + tilt, -0.7, 0.8) }
      else { u.swing = clamp(u.swing - pan, -1.4, 1.4); u.boom = clamp(u.boom + tilt, -0.9, 0.9) }
      u.sampling = Math.max(0, u.sampling - dt)
      if (raw?.presses.includes('sample') || action(i, 'sample')) {
        u.actions++; u.sampling = 0.5
        const tip = sampleTip(u), rock = this.rocks.find(r => !r.sampled && Math.hypot(r.x - tip.x, r.z - tip.z, r.y + 0.15 - tip.y) < 0.55)
        if (rock) { rock.sampled = true; u.samples++; this.events.push({ unit: n, kind: 'score', text: `${rock.name} sampled` }) }
        else this.events.push({ unit: n, kind: 'tick', text: 'Move the tool close to an unsampled rock' })
      }
    })
  }
  readout(n: number) { const u = this.units[n]; return `${u.samples} samples · ${Math.abs(u.v).toFixed(1)} m/s · ${u.mast ? 'mast' : 'arm'}` }
}

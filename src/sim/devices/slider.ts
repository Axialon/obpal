/** Phone-authored camera keyframes, played with zero velocity and acceleration at each end. */
import { Controller, PadButton } from '@obpal/core'
import { Machine, action, timestep } from './common'
import { axis, clamp } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const SLIDER_SPEC: DeviceSpec = {
  category: 'camera-stage',
  id: 'slider', name: 'Camera slider', unit: 'Slider', units: 2, kind: 'Camera',
  blurb: 'Set travel, pan and tilt from your phone, save keyframes and play a smooth shot of the subject.',
  teaches: 'Relative gestures program a repeatable camera move with an actual live camera view',
  controllers: [Controller.trackpad, Controller.gamepad],
  how: {
    'face.trackpad': 'Drag travels · two fingers aim · tap saves a key · Play runs · move stops',
    'face.gamepad': 'Left stick travels · right stick aims · A saves a keyframe · X plays / stops · B clears keys',
  },
  tray: [{ id: 'key', label: 'Set keyframe', type: 'button', icon: 'tap' }, { id: 'play', label: 'Play / stop', type: 'button', icon: 'play' }, { id: 'clear', label: 'Clear keys', type: 'button', icon: 'reset' }, { id: 'duration', label: 'Duration', type: 'select', options: [{ value: '4', label: '4 seconds' }, { value: '8', label: '8 seconds' }, { value: '12', label: '12 seconds' }] }],
  buttons: { 'key:Space': 'tray:key', 'key:KeyP': 'tray:play', 'key:Backspace': 'tray:clear', 'media:playpause': 'tray:play' },
}
export interface CameraKey { x: number; pan: number; tilt: number }
export const easeShot = (t: number) => { const u = clamp(t, 0, 1); return u * u * u * (u * (u * 6 - 15) + 10) }
export class SliderLogic extends Machine {
  private lastAim: ([number, number] | null)[] = [null, null]
  readonly spec = SLIDER_SPEC
  readonly units = [0, 1].map(() => ({ x: 0, pan: 0, tilt: 0, keys: [] as CameraKey[], playing: false, elapsed: 0, duration: 8, takes: 0, actions: 0 }))
  home(n: number) { Object.assign(this.units[n], { x: 0, pan: 0, tilt: 0, playing: false, elapsed: 0 }) }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null
      if (raw?.positioned) this.lastAim[n] = null
      const x = i?.pad ? axis(i.pad.axes[0]) * dt : (i?.drag[0] ?? 0) * 0.006
      const pan = i?.pad ? -axis(i.pad.axes[2]) * dt * 0.7 : -(i?.pan[0] ?? 0) * 0.005
      const tilt = i?.pad ? -axis(i.pad.axes[3]) * dt * 0.7 : -(i?.pan[1] ?? 0) * 0.005
      if (x || pan || tilt) u.playing = false
      u.x = clamp(u.x + x, -1.7, 1.7); u.pan = clamp(u.pan + pan, -1.2, 1.2); u.tilt = clamp(u.tilt + tilt, -0.65, 0.8)
      if (i?.space && !i.pad) {
        const [ax, ay] = i.space.aim
        const last = this.lastAim[n]
        if (last && Math.hypot(ax - last[0], ay - last[1]) > 0.025) u.playing = false
        if (!u.playing) { u.x = ax * 1.7; u.tilt = ay * (ay >= 0 ? 0.8 : 0.65) }
        this.lastAim[n] = [ax, ay]
      } else this.lastAim[n] = null
      for (const v of raw?.values ?? []) if (v.id === 'duration' && ['4', '8', '12'].includes(String(v.v))) { u.duration = Number(v.v); u.playing = false }
      if (raw?.presses.includes('clear') || i && (i.padPressed & (1 << PadButton.B))) { u.keys = []; u.playing = false; u.elapsed = 0 }
      if (raw?.presses.includes('key') || action(i, 'key')) {
        u.actions++; u.playing = false
        if (u.keys.length < 6) { u.keys.push({ x: u.x, pan: u.pan, tilt: u.tilt }); this.events.push({ unit: n, kind: 'tick', text: `Keyframe ${u.keys.length} saved` }) }
        else this.events.push({ unit: n, kind: 'tick', text: 'Six keys saved · Clear keys starts a new move' })
      }
      if (raw?.presses.includes('play') || i && (i.padPressed & (1 << PadButton.X))) {
        if (u.playing) u.playing = false
        else if (u.keys.length >= 2) { u.playing = true; u.elapsed = 0 }
        else this.events.push({ unit: n, kind: 'tick', text: 'Save at least two keyframes first' })
      }
      if (u.playing) {
        u.elapsed = Math.min(u.duration, u.elapsed + dt)
        const at = u.elapsed / u.duration * (u.keys.length - 1), index = Math.min(u.keys.length - 2, Math.floor(at)), a = u.keys[index], b = u.keys[index + 1], k = easeShot(at - index)
        u.x = a.x + (b.x - a.x) * k; u.pan = a.pan + (b.pan - a.pan) * k; u.tilt = a.tilt + (b.tilt - a.tilt) * k
        if (u.elapsed >= u.duration) { u.playing = false; u.takes++; this.events.push({ unit: n, kind: 'score', text: 'Camera move complete' }) }
      }
    })
  }
  readout(n: number) { const u = this.units[n]; return `${u.x.toFixed(2)} m · ${u.keys.length}/6 keys · ${u.playing ? `${u.elapsed.toFixed(1)} / ${u.duration} s` : `${u.takes} takes`}` }
}

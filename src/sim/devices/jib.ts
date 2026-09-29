/** A levelled camera head at the end of a swinging, counterbalanced jib. */
import { Controller } from '@obpal/core'
import { Machine, action, timestep } from './common'
import { axis, clamp, panTiltOf } from './input'
import type { DeviceInput, DeviceSpec } from './types'
import { rail, panSign } from '../vr/intent'

export const JIB_SPEC: DeviceSpec = {
  category: 'camera-stage',
  id: 'jib', name: 'Jib crane', unit: 'Jib', units: 2, kind: 'Camera',
  blurb: 'Swing and boom a camera over a small stage, then pan and tilt its levelled head to frame a take.',
  teaches: 'Two sticks separate the crane arm from its camera head; gyro 1:1 can aim the head',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left stick swings and booms · right stick pans and tilts the head · A starts / ends a take',
    'face.trackpad': 'Pick a part on the strip, then drag · tap records',
  },
  tray: [{ id: 'record', label: 'Record / stop', type: 'button', icon: 'camera' }],
  buttons: { 'key:Space': 'tray:record', 'key:KeyR': 'tray:record', 'media:playpause': 'tray:record' },
  // The crane arm and the camera head, each a set on the phone's strip, or any one of the four alone.
  parts: [
    { id: 'swing', name: 'Swing', icon: 'turn', channels: ['drag.x'] },
    { id: 'boom', name: 'Boom', icon: 'lift', channels: ['drag.y'] },
    { id: 'pan', name: 'Pan', icon: 'look-x', channels: ['pan.x'], turn: true },
    { id: 'tilt', name: 'Tilt', icon: 'look-y', channels: ['pan.y'], turn: true },
  ],
  sets: [
    { id: 'crane', name: 'Crane', icon: 'reach', parts: ['swing', 'boom'] },
    { id: 'head', name: 'Head', icon: 'camera', parts: ['pan', 'tilt'] },
  ],
}
export const jibTip = (swing: number, boom: number) => ({ x: -Math.sin(swing) * Math.cos(boom) * 2.5, y: 1.5 + Math.sin(boom) * 2.5, z: -Math.cos(swing) * Math.cos(boom) * 2.5 })
export class JibLogic extends Machine {
  readonly spec = JIB_SPEC
  readonly units = [0, 1].map(() => ({ swing: 0, boom: 0.15, pan: 0, tilt: -0.3, recording: false, takes: 0, time: 0, actions: 0 }))
  private angles = [[0, 0], [0, 0]]
  private zeros = [[0, 0], [0, 0]]
  actionState(n: number) { return { 'action.record': this.units[n].recording } }
  home(n: number) { Object.assign(this.units[n], { swing: 0, boom: 0.15, pan: 0, tilt: -0.3, recording: false, time: 0 }); this.zeros[n] = [...this.angles[n]] }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null
      if (i) {
        u.swing -= (i.pad ? axis(i.pad.axes[0]) * dt * 0.6 : i.drag[0] * 0.004) * rail(i.controlFrame, Math.cos(u.swing), -Math.sin(u.swing))
        u.boom += i.pad ? -axis(i.pad.axes[1]) * dt * 0.45 : -i.drag[1] * 0.003
        const heading = u.swing + (n ? 0.825 : -0.825)
        if (i.space && !i.pad) { const [x, y] = i.space.aim; u.pan = -x * 1.5 * (i.controlFrame?.immersive ? 1 : panSign(i.controlFrame, heading)); u.tilt = -0.3 + y * (y >= 0 ? 1 : 0.8) }
        else if (i.hold) { this.angles[n] = panTiltOf(i.hold); u.pan = (this.angles[n][0] - this.zeros[n][0]) * (i.controlFrame?.immersive ? 1 : panSign(i.controlFrame, heading)); u.tilt = -0.3 + this.angles[n][1] - this.zeros[n][1] }
        else { u.pan -= (i.pad ? axis(i.pad.axes[2]) * dt * 0.8 : i.pan[0] * 0.004) * panSign(i.controlFrame, heading + u.pan); u.tilt += i.pad ? -axis(i.pad.axes[3]) * dt * 0.6 : -i.pan[1] * 0.004 }
      }
      u.swing = clamp(u.swing, -1.1, 1.1); u.boom = clamp(u.boom, -0.15, 0.9); u.pan = clamp(u.pan, -1.5, 1.5); u.tilt = clamp(u.tilt, -1.1, 0.7)
      if (raw?.presses.includes('record') || action(i, 'record')) { u.actions++; u.recording = !u.recording; if (u.recording) u.time = 0; else u.takes++; this.events.push({ unit: n, kind: 'tick', text: u.recording ? 'Take started' : 'Take complete' }) }
      if (u.recording) u.time = Math.min(3600, u.time + dt)
    })
  }
  readout(n: number) { const u = this.units[n]; return `${jibTip(u.swing, u.boom).y.toFixed(1)} m head · ${u.recording ? `REC ${u.time.toFixed(1)} s` : `${u.takes} takes`}` }
}

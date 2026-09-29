/** A three-axis camera follows the phone's quaternion exactly, relative to its last Home. */
import { Controller, poseRelativeInView, qConj, qMul, qAxisAngle, type Quat } from '@obpal/core'
import { action, Machine, timestep } from './common'
import { axis, clamp, panTiltOf } from './input'
import { panSign } from '../vr/intent'
import type { DeviceInput, DeviceSpec } from './types'
export const GIMBAL_SPEC: DeviceSpec = {
  id: 'gimbal',
  name: 'Camera gimbal',
  unit: 'Gimbal',
  units: 1,
  kind: 'Camera',
  blurb: 'Hold a camera steady or roll it through a shot: its three axes follow your phone one for one.',
  teaches: 'A quaternion keeps yaw, pitch and roll together',
  controllers: [Controller.trackpad, Controller.hand],
  how: {
    'face.trackpad': 'Pick a part on the strip, then drag · gyro 1:1',
    'face.hand': 'Hold the pad and turn the phone · Record starts a take',
  },
  tray: [{ id: 'record', label: 'Record', type: 'button', icon: 'frame' }],
  buttons: { 'media:playpause': 'tray:record', 'key:KeyR': 'tray:record' },
  // One axis at a time, or the aim (pan and tilt) with the roll held level; all three follow a 1:1 turn together.
  parts: [
    { id: 'pan', name: 'Pan', icon: 'look-x', channels: ['drag.x'], turn: true },
    { id: 'tilt', name: 'Tilt', icon: 'look-y', channels: ['drag.y'], turn: true },
    { id: 'roll', name: 'Roll', icon: 'roll', channels: ['twist'], turn: true },
  ],
  sets: [{ id: 'aim', name: 'Aim', icon: 'point', parts: ['pan', 'tilt'] }],
}
export function unitQuaternion(q: Quat): Quat {
  const length = Math.hypot(...q)
  return length > 0 && Number.isFinite(length) ? (q.map((v) => v / length) as Quat) : [0, 0, 0, 1]
}
export class GimbalLogic extends Machine {
  readonly spec = GIMBAL_SPEC
  units = [{ q: [0, 0, 0, 1] as Quat, pan: 0, pitch: 0, roll: 0, recording: false, takes: 0 }]
  private zero: Quat = [0, 0, 0, 1]
  private last: Quat = [0, 0, 0, 1]
  private hand: { gen: number; zero: Quat; at: Quat } | null = null
  actionState() { return { 'action.record': this.units[0].recording } }
  home() {
    this.zero = [...this.last]
    this.hand = null
    Object.assign(this.units[0], { q: [0, 0, 0, 1], pan: 0, pitch: 0, roll: 0 })
  }
  readout() {
    const u = this.units[0]
    return `${u.recording ? 'Recording' : 'Ready'} · ${Math.round(u.pan * 57.3)}°`
  }
  step(inputs: readonly (DeviceInput | null)[], delta = 1 / 60) {
    const i = inputs[0],
      u = this.units[0]
    if (!i) return
    const pose = i.pose?.tracked && i.pose.touching ? i.pose : null
    if (!pose) this.hand = null
    let q = i.hold
    if (!q && pose) {
      if (!this.hand || this.hand.gen !== pose.gen) {
        let at = [...u.q] as Quat
        // Undo the overview pan mapping before capturing a new input origin; it is applied once below.
        if (i.controlFrame && !i.controlFrame.immersive) at = qMul(qAxisAngle(0, 1, 0, (panSign(i.controlFrame, 0) - 1) * panTiltOf(at)[0]), at)
        this.hand = { gen: pose.gen, zero: unitQuaternion(pose.q), at }
      }
      q = qMul(poseRelativeInView(this.hand.zero, unitQuaternion(pose.q)), this.hand.at)
    }
    if (i.space && !i.pad && !i.pose?.touching) {
      u.pan = -i.space.aim[0] * Math.PI * (i.controlFrame?.immersive ? 1 : panSign(i.controlFrame, 0)); u.pitch = i.space.aim[1] * 1.3
      u.q = qMul(qMul(qAxisAngle(0, 1, 0, u.pan), qAxisAngle(1, 0, 0, u.pitch)), qAxisAngle(0, 0, 1, u.roll))
    } else if (q) {
      this.last = unitQuaternion(q)
      if (i.recentred) this.zero = [0, 0, 0, 1]
      u.q = pose ? this.last : unitQuaternion(qMul(this.last, qConj(this.zero)))
      ;[u.pan, u.pitch] = panTiltOf(u.q)
      const [x, y, z, w] = u.q
      u.roll = Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z))
      if (i.controlFrame && !i.controlFrame.immersive) {
        const pan = u.pan
        u.pan *= panSign(i.controlFrame, 0)
        // Keep the view's pan direction without rebuilding a quaternion from singular upright Euler angles.
        u.q = qMul(qAxisAngle(0, 1, 0, u.pan - pan), u.q)
      }
    } else if (i.pad || i.drag.some((v) => v !== 0) || i.twist) {
      const dt = timestep(delta)
      u.pan -= (i.pad ? axis(i.pad.axes[2]) * dt : i.drag[0] * 0.008) * panSign(i.controlFrame, u.pan)
      u.pitch = clamp(u.pitch - (i.pad ? axis(i.pad.axes[3]) * dt : i.drag[1] * 0.008), -1.5, 1.5)
      u.roll += (i.twist * Math.PI) / 180
      u.q = qMul(qMul(qAxisAngle(0, 1, 0, u.pan), qAxisAngle(1, 0, 0, u.pitch)), qAxisAngle(0, 0, 1, u.roll))
    }
    if (i.recentred && !q && !i.space) this.home()
    if (action(i, 'record')) {
      u.recording = !u.recording
      if (u.recording) u.takes++
      this.events.push({ unit: 0, kind: 'tick', text: u.recording ? 'Recording a take' : 'Take complete' })
    }
  }
}

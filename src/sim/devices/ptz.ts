/**
 * PTZ camera: two pan-tilt-zoom cameras on a little set with a toy train going round, each with its picture on the
 * screen. The Wii remote suits it best: the camera looks where the phone points (⌂ brings it back to the middle), − and +
 * zoom, A takes a picture. The trackpad drags it round and pinches to zoom, or with the gyro on (1:1) turns it as the
 * phone turns, like a gimbal; the gamepad's right stick and triggers too. (It takes the air mouse's wheel as a zoom as
 * well, for a screen whose Point face is the mouse: a host offers one of the two.)
 *
 * Each camera turns and zooms at a real PTZ head's speed, within its stops. A picture of the train in the middle of the
 * frame counts.
 */
import { Controller, Mode, PadButton, type Quat } from '@obpal/core'
import { clamp, padStick, panTiltOf, readable } from './input'
import type { DeviceEvent, DeviceInput, DeviceLogic, DeviceSpec } from './types'
import { panSign } from '../vr/intent'

export const PTZ_SPEC: DeviceSpec = {
  id: 'ptz',
  name: 'PTZ camera',
  unit: 'Cam',
  units: 2,
  kind: 'Camera',
  blurb: 'Point your phone and the camera looks there. Zoom in and catch the train.',
  teaches: 'Pointing, dragging and 1:1: three ways to aim, and three ways to zoom',
  controllers: [Controller.wii, Controller.trackpad, Controller.gamepad],
  how: {
    'face.wii': 'Point where it looks · − + zoom · A takes a picture · ⌂ centre',
    'face.trackpad': 'Pick a part on the strip, then drag · tap snaps',
    'face.gamepad': 'Right stick turns it · triggers zoom · A takes a picture',
  },
  tray: [{ id: 'snap', label: 'Picture', type: 'button', icon: 'frame' }],
  // A headset press or a keyboard's Space takes a picture, on every controller.
  buttons: { 'media:playpause': 'tray:snap', 'key:Space': 'tray:snap' },
  // Aim (pan and tilt together), or one of pan, tilt and zoom alone: a drag then zooms, with the aim held steady.
  parts: [
    { id: 'pan', name: 'Pan', icon: 'look-x', channels: ['drag.x'], turn: true },
    { id: 'tilt', name: 'Tilt', icon: 'look-y', channels: ['drag.y'], turn: true },
    { id: 'zoom', name: 'Zoom', icon: 'zoom-in', channels: ['pinch'] },
  ],
  sets: [{ id: 'aim', name: 'Aim', icon: 'point', parts: ['pan', 'tilt'] }],
}

const D2R = Math.PI / 180

export const PTZ = {
  /** Stops (rad) and top speeds (rad/s) of the head, and the zoom's range. */
  pan: 150 * D2R,
  tiltUp: 30 * D2R,
  tiltDown: -50 * D2R,
  panRate: 140 * D2R,
  tiltRate: 100 * D2R,
  zoomMin: 1,
  zoomMax: 8,
  /** The lens's field of view at 1×, vertically (rad). */
  fov: 46 * D2R,
  /** Pointing: how far the camera turns for a degree the phone does, at 1× (less when zoomed in, for a steady aim). */
  gain: 1.5,
  /** Dragging: radians per px at 1×. */
  drag: 0.0022,
}

export interface Cam {
  /** Where it stands, and where it looks when centred (pan, tilt). */
  at: [number, number, number]
  home: [number, number]
  pan: number
  tilt: number
  zoom: number
  /** Where it's headed (the head eases there within its speeds). */
  goal: [number, number]
  /** The picture just taken: seconds since (for the flash), and how many. */
  flash: number
  shots: number
  /** 1:1: the camera's aim when the gyro came on. */
  anchor: { pan: number; tilt: number } | null
}

/** The train's way round the set: an oval, its middle and radii. */
export const TRACK = { x: 0, z: -0.6, rx: 3.2, rz: 2, y: 0.12 }
/** Where the train is at time t (s): it takes about 17 s a lap. */
export function trainAt(t: number): [number, number, number] {
  const a = t * 0.37
  return [TRACK.x + Math.cos(a) * TRACK.rx, TRACK.y, TRACK.z + Math.sin(a) * TRACK.rz]
}

/** Where a camera looks: the unit vector for its pan (+ left of −z) and tilt (+ up). */
export function lookOf(pan: number, tilt: number): [number, number, number] {
  return [-Math.sin(pan) * Math.cos(tilt), Math.sin(tilt), -Math.cos(pan) * Math.cos(tilt)]
}

/** The pan and tilt that look from `from` at `to`. */
export function aimAt(from: [number, number, number], to: [number, number, number]): [number, number] {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
  return [Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))]
}

/** How far off the middle of a camera's picture a point is, as a fraction of half its height (0: dead centre). */
export function offCentre(c: Cam, p: [number, number, number]): number {
  const f = lookOf(c.pan, c.tilt)
  const d = [p[0] - c.at[0], p[1] - c.at[1], p[2] - c.at[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  const cos = (f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / len
  const half = PTZ.fov / c.zoom / 2
  return Math.acos(clamp(cos, -1, 1)) / half
}

const clampAim = (pan: number, tilt: number): [number, number] => [clamp(pan, -PTZ.pan, PTZ.pan), clamp(tilt, PTZ.tiltDown, PTZ.tiltUp)]

/** A camera's goal and zoom from its operator's input, by the controller in use. Returns whether a picture was asked for. */
export function ptzControl(c: Cam, inp: DeviceInput, dt: number): boolean {
  const P = PTZ
  const direction = panSign(inp.controlFrame, c.pan)
  const pressed = (b: number) => ((inp.padPressed >>> b) & 1) === 1
  const snap = inp.presses.includes('snap') || inp.presses.includes('wii-a') || inp.presses.includes('mouse-left') || inp.presses.includes('pad') || pressed(PadButton.A)
  const zoomBy = (k: number) => { c.zoom = clamp(c.zoom * k, P.zoomMin, P.zoomMax) }
  if (inp.space && (!inp.pad || inp.space.pointer)) {
    const [ax, y] = inp.space.aim, x = ax * (inp.controlFrame?.immersive ? 1 : panSign(inp.controlFrame, c.home[0]))
    c.goal = [c.home[0] - x * (x >= 0 ? c.home[0] + P.pan : P.pan - c.home[0]), c.home[1] + y * (y >= 0 ? P.tiltUp - c.home[1] : c.home[1] - P.tiltDown)]
    for (const p of inp.presses) {
      if (p === 'wii-plus') zoomBy(1.25)
      if (p === 'wii-minus') zoomBy(0.8)
    }
    if (inp.wheel) zoomBy(Math.pow(2, -inp.wheel / 1200))
    if (inp.pinch) zoomBy(Math.pow(2, inp.pinch))
  } else if (inp.point) {
    // The camera looks where the phone points, from centre (⌂ puts the phone's aim back there).
    const k = P.gain / Math.sqrt(c.zoom)
    c.goal = clampAim(c.home[0] + -inp.point.yaw * D2R * k * (inp.controlFrame?.immersive ? 1 : panSign(inp.controlFrame, c.home[0])), c.home[1] + inp.point.pitch * D2R * k)
    for (const p of inp.presses) {
      if (p === 'wii-plus') zoomBy(1.25)
      if (p === 'wii-minus') zoomBy(0.8)
    }
    if (inp.wheel) zoomBy(Math.pow(2, -inp.wheel / 1200))
  } else if (inp.pad) {
    const [rx, ry] = padStick(inp.pad, 'right')
    const [lx, ly] = padStick(inp.pad, 'left')
    const x = rx || lx, y = ry || ly
    const k = 1 / c.zoom
    c.goal = clampAim(c.goal[0] - x * P.panRate * 0.7 * k * dt * direction, c.goal[1] - y * P.tiltRate * 0.7 * k * dt)
    const [lt, rt] = inp.pad.triggers
    if (Math.abs(rt - lt) > 0.05) zoomBy(Math.pow(2, (rt - lt) * 1.6 * dt))
    if (pressed(PadButton.Up)) zoomBy(1.25)
    if (pressed(PadButton.Down)) zoomBy(0.8)
  } else if (inp.hold) {
    // 1:1: it turns as the phone turns, from where it was aiming when the gyro came on.
    if (!c.anchor) c.anchor = { pan: c.goal[0], tilt: c.goal[1] }
    const [yaw, pitch] = panTiltOf(inp.hold as Quat)
    c.goal = clampAim(c.anchor.pan + yaw * (inp.controlFrame?.immersive ? 1 : panSign(inp.controlFrame, c.anchor.pan)), c.anchor.tilt + pitch)
    if (inp.pinch) zoomBy(Math.pow(2, inp.pinch))
  } else {
    // Dragging turns it by hand; with the gyro on in Tilt, tilting turns it like a stick.
    c.anchor = null
    const k = P.drag / c.zoom
    let [pan, tilt] = [c.goal[0] - inp.drag[0] * k * direction, c.goal[1] - inp.drag[1] * k]
    if (inp.mode === Mode.tilt) { pan -= inp.tilt[0] * P.panRate * 0.6 * dt / c.zoom * direction; tilt -= inp.tilt[1] * P.tiltRate * 0.6 * dt / c.zoom }
    c.goal = clampAim(pan, tilt)
    if (inp.pinch) zoomBy(Math.pow(2, inp.pinch))
  }
  if (!inp.hold) c.anchor = null
  if (inp.recentred && !inp.point && !inp.space) { c.goal = [...c.home]; c.anchor = null }
  return snap
}

/** One step of a camera's head toward its goal, at its speeds. */
export function stepCam(c: Cam, dt: number) {
  const move = (cur: number, to: number, rate: number) => cur + clamp((to - cur) * 10 * dt, -rate * dt, rate * dt)
  c.pan = move(c.pan, c.goal[0], PTZ.panRate)
  c.tilt = move(c.tilt, c.goal[1], PTZ.tiltRate)
  c.flash = c.flash ? c.flash + dt : 0
  if (c.flash > 0.6) c.flash = 0
}

/** The cameras stand at the back of the set, looking in (and out at the screen). */
const CAMS: { at: [number, number, number] }[] = [{ at: [-1.75, 1.45, -2.25] }, { at: [1.75, 1.45, -2.25] }]

export class PtzLogic implements DeviceLogic {
  readonly spec = PTZ_SPEC
  readonly cams: Cam[]
  /** The set's clock (the train goes round on it). */
  time = 0
  private events: DeviceEvent[] = []

  constructor(count = PTZ_SPEC.units) {
    this.cams = Array.from({ length: count }, (_, n) => {
      const at = CAMS[n % CAMS.length].at
      const home = aimAt(at, [TRACK.x, 0.3, TRACK.z])
      return { at, home, pan: home[0], tilt: home[1], zoom: 1.4, goal: [...home], flash: 0, shots: 0, anchor: null }
    })
  }

  get train() { return trainAt(this.time) }

  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    this.time += dt
    this.cams.forEach((c, n) => {
      const inp = inputs[n]
      if (inp && ptzControl(c, inp, dt)) this.snap(n)
      if (!inp) c.anchor = null
      stepCam(c, dt)
    })
  }

  /** A picture: it flashes, and one with the train in the middle of the frame counts. */
  snap(n: number) {
    const c = this.cams[n]
    c.flash = 1e-6
    c.shots++
    const off = offCentre(c, this.train)
    if (off < 0.35) this.events.push({ unit: n, kind: 'score', text: c.zoom >= 3 ? 'Got it: the train, close up and centred' : 'Got it: the train, centred' })
    else this.events.push({ unit: n, kind: 'tick', text: off < 1 ? 'In the picture, off centre' : 'Missed the train' })
  }

  home(n: number) {
    const c = this.cams[n]
    c.goal = [...c.home]
    c.zoom = 1.4
    c.anchor = null
  }

  readout(n: number) { const c = this.cams[n]; return `${readable(c.zoom)}× · ${c.shots} shot${c.shots === 1 ? '' : 's'}` }

  drain() { const e = this.events; this.events = []; return e }
}

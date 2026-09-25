import * as THREE from 'three'
import { PadButton, type PadState } from '@obpal/host'

/** What the viewer lends the gamepad mapping: its camera rig, the model holder and a few view actions. */
export interface GamepadContext {
  /** The subset of camera-controls used here. */
  controls: {
    rotate(azimuth: number, polar: number, smooth?: boolean): unknown
    dolly(distance: number, smooth?: boolean): unknown
    readonly distance: number
  }
  camera: THREE.Camera
  holder: THREE.Object3D
  /** Apply a world-space turn from the right stick; defaults to turning the holder. */
  turn?(q: THREE.Quaternion): void
  frame(): void
  reset(): void
  step(dir: 1 | -1): void
  toggle(what: 'spin' | 'glow' | 'grid'): void
  toggleCatalog(): void
}

/** Full left-stick deflection orbits the camera this fast, radians/second: [azimuth, polar]. */
const ORBIT_RATE = [2.4, 1.7] as const
/** Full right-stick deflection turns the model 180°/s, so gyro aim at 1x sensitivity feels close to 1:1. */
const MODEL_RATE = Math.PI
/** A fully pressed trigger dollies by this share of the camera distance per second. */
const DOLLY_RATE = 1.6
/** D-pad up / down: distance ratio per press. */
const ZOOM_STEP = 1.2
/** Axis values this small are quantization noise. */
const NOISE = 0.02
/** After this long without a frame (the pad reconnected, the tab was hidden) button history starts fresh. */
const STALE_MS = 500

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const camRight = new THREE.Vector3()
const turn = new THREE.Quaternion()
const history = new WeakMap<GamepadContext, { buttons: number; at: number }>()

/** Buttons that went down between two bitmasks. */
export const pressedEdges = (prev: number, now: number) => (now & ~prev) >>> 0

/**
 * Drive the viewer from a phone in gamepad mode; call once per rendered frame while remote.pad is non-null.
 * Sticks and triggers act continuously (scaled by dt, seconds); buttons act once per press.
 *   left stick: orbit the camera · right stick: turn the model · LT / RT: dolly out / in
 *   A frame · B back (release a selected part, else reset view) · X spin · Y glow · LB / RB and D-pad left / right: previous / next model
 *   D-pad up / down: zoom steps · Menu: catalogue · View: grid
 */
export function applyGamepad(pad: PadState, dt: number, ctx: GamepadContext) {
  const now = performance.now()
  const last = history.get(ctx)
  const prev = last && now - last.at < STALE_MS ? last.buttons : 0
  history.set(ctx, { buttons: pad.buttons, at: now })
  const down = pressedEdges(prev, pad.buttons)
  const hit = (b: number) => (down & (1 << b)) !== 0
  const { controls } = ctx

  if (down) {
    if (hit(PadButton.A)) ctx.frame()
    if (hit(PadButton.B)) ctx.reset()
    if (hit(PadButton.X)) ctx.toggle('spin')
    if (hit(PadButton.Y)) ctx.toggle('glow')
    if (hit(PadButton.LB) || hit(PadButton.Left)) ctx.step(-1)
    if (hit(PadButton.RB) || hit(PadButton.Right)) ctx.step(1)
    if (hit(PadButton.Up)) void controls.dolly(controls.distance * (1 - 1 / ZOOM_STEP), true)
    if (hit(PadButton.Down)) void controls.dolly(controls.distance * (1 - ZOOM_STEP), true)
    if (hit(PadButton.Menu)) ctx.toggleCatalog()
    if (hit(PadButton.View)) ctx.toggle('grid')
  }

  if (!(dt > 0)) return
  const [lx, ly, rx, ry] = pad.axes.map((v) => (Math.abs(v) < NOISE ? 0 : v))
  // Left stick orbits the camera: right looks right and up looks up, as in games. The model's visible surface
  // then moves the way the stick points, the same as dragging on the phone's trackpad.
  if (lx || ly) void controls.rotate(-lx * ORBIT_RATE[0] * dt, -ly * ORBIT_RATE[1] * dt, true)
  // Right stick turns the model itself: about the world vertical, and about the camera's right axis.
  if (rx || ry) {
    camRight.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion)
    const apply = ctx.turn ?? ((q: THREE.Quaternion) => void ctx.holder.quaternion.premultiply(q))
    apply(turn.setFromAxisAngle(WORLD_UP, rx * MODEL_RATE * dt))
    apply(turn.setFromAxisAngle(camRight, ry * MODEL_RATE * dt))
  }
  // Triggers: RT dollies in, LT out, in proportion to how far each is pulled.
  const zoom = pad.triggers[1] - pad.triggers[0]
  if (Math.abs(zoom) > NOISE) void controls.dolly(controls.distance * zoom * DOLLY_RATE * dt, true)
}

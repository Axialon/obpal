/**
 * Rover: little four-wheeled rovers in a fenced yard with cones to push about, one per phone. The steering wheel suits
 * it best (tilt the phone to steer, the triggers as pedals: the Driving profile), then the gamepad, the trackpad (tilt,
 * or a floating stick under the thumb) and the Wii remote (point at a spot and hold B: it drives there).
 *
 * The model is a bicycle: the front wheels turn at a servo's speed, less far the faster it goes; the motor pulls
 * hardest from standstill; it coasts to a stop. It bumps off the fence and the other rovers, and shoves cones.
 */
import { Controller, Mode, PadButton } from '@obpal/core'
import { axis, clamp, down, DragStick, readable, wrapPi } from './input'
import { InputSmoother, servo } from '../kit/motion'
import type { DeviceEvent, DeviceInput, DeviceLogic, DeviceSpec } from './types'

export const ROVER_SPEC: DeviceSpec = {
  id: 'rover',
  name: 'Rover',
  unit: 'Rover',
  units: 4,
  kind: 'Vehicle',
  blurb: 'Drive a little rover round the yard and knock the cones about.',
  teaches: 'The steering wheel: tilt steers, the triggers are pedals',
  controllers: [Controller.wheel, Controller.gamepad, Controller.trackpad, Controller.wii],
  how: {
    'face.wheel': 'Tilt to steer · RT go · LT brake',
    'face.gamepad': 'Left stick drives · A horn · B brake · X lights',
    'face.trackpad': 'Tilt, or drag from your thumb · tap: horn',
    'face.wii': 'Point at a spot, hold B: it drives there',
  },
  tray: [
    { id: 'horn', label: 'Horn', type: 'button', icon: 'sound' },
    { id: 'lights', label: 'Lights', type: 'button', icon: 'sun' },
  ],
  // A headset press or a keyboard's H honks, L switches the lights; Space is the brake (B) on the pad faces.
  buttons: { 'media:playpause': 'tray:horn', 'key:KeyH': 'tray:horn', 'key:KeyL': 'tray:lights', 'key:Space': 'b' },
}

/** Metres, seconds, radians. */
export const ROVER = {
  wheelbase: 0.42,
  radius: 0.34,
  vmax: 3.6,
  vrev: 1.4,
  accel: 3.2,
  brake: 6.5,
  handbrake: 9,
  coast: 1,
  drag: 0.25,
  steerMax: 0.52,
  steerRate: 3.2,
  /** The yard: half its width (x) and depth (z). */
  yard: [9.2, 6] as const,
}

/** Low traversable bridges. The same profile places the deck, wheels and chassis. */
export const RAMPS = [
  { x: -5.7, z: -1.8, halfWidth: 0.85, halfLength: 2, height: 0.46 },
  { x: 5.7, z: -1.8, halfWidth: 0.85, halfLength: 2, height: 0.46 },
]
export const GATES = [{ x: -3.3, z: -4.4, width: 1.8 }, { x: 3.3, z: -4.4, width: 1.8 }]
/** Ground height at a wheel, continuous at both ends of a ramp. */
export function roverGround(x: number, z: number) {
  for (const r of RAMPS) if (Math.abs(x - r.x) <= r.halfWidth && Math.abs(z - r.z) <= r.halfLength) {
    return r.height * Math.min(1, (1 - Math.abs(z - r.z) / r.halfLength) * 2)
  }
  return 0
}

export interface Rover {
  x: number
  z: number
  /** Heading: 0 faces −z (away from the screen's camera), + turns left. */
  h: number
  /** Along the heading, m/s (− reversing). */
  v: number
  /** The front wheels, rad (+ right). */
  steer: number
  lights: boolean
  /** Seconds left of the horn. */
  honk: number
  braking: boolean
  /** How far the wheels have turned (rad), for the view. */
  roll: number
  /** Where it parks. */
  home: [number, number, number]
}

export interface Cone { x: number; z: number; vx: number; vz: number; home: [number, number] }

/** What a driver asks for: steer −1…1 (+ right), throttle −1…1 (+ forward; back brakes, then reverses), the brake. */
export interface RoverIntent { steer: number; throttle: number; brake: boolean }

export const CONE_R = 0.12

/**
 * A driver's input as steering and pedals, by the controller it uses. `drive` is where to drive to (the Wii remote with
 * B held, or the air mouse's Left); `stick` is the trackpad's floating stick.
 */
export function roverIntent(inp: DeviceInput, r: Rover, stick: DragStick): RoverIntent {
  if (inp.pad) {
    // The gamepad and the wheel: the left stick steers (the wheel's tilt arrives there), the triggers are the pedals,
    // and with no trigger pressed the stick's forward and back drive too.
    const [lt, rt] = inp.pad.triggers
    const pedals = rt - lt
    const throttle = Math.abs(pedals) > 0.04 ? pedals : -axis(inp.pad.axes[1])
    return { steer: axis(inp.pad.axes[0], 0.08), throttle, brake: down(inp.pad.buttons, PadButton.B) }
  }
  const going = inp.held.has('wii-b') || inp.held.has('mouse-left')
  if (inp.point && going && inp.spot) return driveTo(r, inp.spot[0], inp.spot[1])
  if (inp.point) return { steer: 0, throttle: 0, brake: false }
  // The trackpad: with the gyro on in its Tilt style, tilting steers and tipping it forward goes; either way, a thumb
  // dragged from where it lands is a stick.
  const [sx, sy] = stick.update(inp.touching, inp.drag)
  const tilt = inp.mode === Mode.tilt ? inp.tilt : [0, 0]
  return { steer: clamp(tilt[0] + sx, -1, 1), throttle: clamp(-tilt[1] * 1.2 - sy, -1, 1), brake: false }
}

/** Steering and throttle that take a rover to a spot: turn toward it, and ease off as it arrives or turns hard. */
export function driveTo(r: Rover, tx: number, tz: number): RoverIntent {
  const dx = tx - r.x
  const dz = tz - r.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.22) return { steer: 0, throttle: 0, brake: Math.abs(r.v) > 0.3 }
  // The heading that faces the spot, and how far left (+) of the rover's it lies.
  const err = wrapPi(Math.atan2(-dx, -dz) - r.h)
  const steer = clamp(-err * 2.2, -1, 1)
  const throttle = clamp(dist * 1.1, 0.25, 0.85) * (1 - Math.min(1, Math.abs(err) / 1.6) * 0.6)
  return { steer, throttle, brake: false }
}

/** One step of a rover's motion (not its collisions). */
const steering = new WeakMap<Rover, number>()
export function stepRover(r: Rover, i: RoverIntent, dt: number) {
  if (dt <= 0) return
  const R = ROVER
  // The steering servo; at speed the wheels turn less far, so it stays on its wheels.
  const reach = R.steerMax * (1 - 0.45 * Math.min(1, Math.abs(r.v) / R.vmax))
  const joint = servo(r.steer, steering.get(r) ?? 0, clamp(i.steer, -1, 1) * reach, dt, { min: -R.steerMax, max: R.steerMax, vmax: R.steerRate, amax: R.steerRate * 10 }, .13)
  r.steer = joint.position; steering.set(r, joint.velocity)
  const t = clamp(i.throttle, -1, 1)
  let a: number
  const slow = (rate: number) => -Math.sign(r.v) * Math.min(Math.abs(r.v) / dt, rate)
  // The throttle sets a speed, as an RC car's does: the motor pulls toward it (hardest from standstill) and the car
  // coasts down to it. Pressed the other way, it brakes first, then goes.
  const toward = (target: number) => {
    const d = target - r.v
    const pull = d > 0 === target >= 0 ? R.accel * (1 - 0.5 * Math.abs(r.v) / R.vmax) : R.coast + R.drag * Math.abs(r.v)
    return Math.sign(d) * Math.min(Math.abs(d) / dt, pull)
  }
  if (i.brake) a = slow(R.handbrake)
  else if (t > 0.02) a = r.v < -0.05 ? R.brake * t : toward(t * R.vmax)
  else if (t < -0.02) a = r.v > 0.05 ? R.brake * t : toward(t * R.vrev)
  else a = slow(R.coast + R.drag * Math.abs(r.v))
  r.v = clamp(r.v + a * dt, -R.vrev, R.vmax)
  r.braking = i.brake || (t < -0.02 && r.v > 0.05) || (t > 0.02 && r.v < -0.05)
  r.h = wrapPi(r.h - (r.v / R.wheelbase) * Math.tan(r.steer) * dt)
  r.x += -Math.sin(r.h) * r.v * dt
  r.z += -Math.cos(r.h) * r.v * dt
  r.roll += (r.v / 0.088) * dt
  r.honk = Math.max(0, r.honk - dt)
}

/**
 * Rovers park in a row on the near side, facing into the yard, away from the screen's camera: steering right then turns
 * right on the screen too.
 */
function parked(n: number, count: number): Rover {
  const x = (n - (count - 1) / 2) * 1.5
  return { x, z: 1.7, h: 0, v: 0, steer: 0, lights: false, honk: 0, braking: false, roll: 0, home: [x, 1.7, 0] }
}

/** The yard: rovers, their fence, and the cones. */
export class RoverLogic implements DeviceLogic {
  readonly spec = ROVER_SPEC
  readonly rovers: Rover[]
  readonly cones: Cone[]
  private sticks: DragStick[]
  private filters: InputSmoother[]
  private events: DeviceEvent[] = []
  /** Bumps already reported, so one knock rumbles once (pair key -> seconds left). */
  private touching = new Map<string, number>()

  constructor(count = ROVER_SPEC.units) {
    this.rovers = Array.from({ length: count }, (_, n) => parked(n, count))
    this.sticks = this.rovers.map(() => new DragStick())
    this.filters = this.rovers.map(() => new InputSmoother())
    // A slalom of cones across the yard, and two further back.
    const spots: [number, number][] = [[-3, -0.7], [-1.5, -1.2], [0, -0.7], [1.5, -1.2], [3, -0.7], [-2.2, -2.2], [2.2, -2.2], [-7.8, -3.8], [-7.8, 0], [7.8, -3.8], [7.8, 0]]
    this.cones = spots.map(([x, z]) => ({ x, z, vx: 0, vz: 0, home: [x, z] }))
  }

  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    this.rovers.forEach((r, n) => {
      const inp = inputs[n]
      let intent: RoverIntent = { steer: 0, throttle: 0, brake: false }
      if (inp) {
        intent = roverIntent(inp, r, this.sticks[n])
        const pressed = (b: number) => (inp.padPressed >>> b) & 1
        if (inp.presses.includes('horn') || inp.presses.includes('pad') || inp.presses.includes('wii-a') || pressed(PadButton.A)) this.horn(n)
        if (inp.presses.includes('lights') || pressed(PadButton.X)) r.lights = !r.lights
      } else this.sticks[n].update(false, [0, 0])
      const filter = this.filters[n]
      const released = inp?.point && !inp.held.has('wii-b') && !inp.held.has('mouse-left')
      if (!inp || intent.brake || inp.recentred || released || (!inp.pad && !inp.touching && !inp.spot && inp.mode !== Mode.tilt)) filter.reset()
      else {
        intent.steer = filter.sample('steer', intent.steer, dt)
        intent.throttle = filter.sample('throttle', intent.throttle, dt)
      }
      stepRover(r, intent, dt)
    })
    this.collide(dt)
    for (const [k, left] of this.touching) { if (left - dt <= 0) this.touching.delete(k); else this.touching.set(k, left - dt) }
  }

  horn(n: number) {
    this.rovers[n].honk = 0.45
    this.events.push({ unit: n, kind: 'tick' })
  }

  private bump(key: string, n: number, speed: number) {
    if (this.touching.has(key)) { this.touching.set(key, 0.3); return }
    this.touching.set(key, 0.3)
    if (speed > 0.4) this.events.push({ unit: n, kind: 'bump', strength: Math.min(1, speed / ROVER.vmax) })
  }

  private collide(dt: number) {
    const [X, Z] = ROVER.yard
    const R = ROVER.radius
    const fwd = (r: Rover): [number, number] => [-Math.sin(r.h), -Math.cos(r.h)]
    // The fence: the rover stops against it, with a little bounce back.
    this.rovers.forEach((r, n) => {
      const [fx, fz] = fwd(r)
      let vx = fx * r.v
      let vz = fz * r.v
      let hit = 0
      for (const gate of GATES) for (const side of [-1, 1]) {
        const x = gate.x + side * gate.width / 2, dx = r.x - x, dz = r.z - gate.z
        const distance = Math.hypot(dx, dz), clearance = R + 0.055
        if (distance < clearance) {
          const nx = distance > 1e-6 ? dx / distance : 1, nz = distance > 1e-6 ? dz / distance : 0
          r.x = x + nx * clearance; r.z = gate.z + nz * clearance
          const speed = vx * nx + vz * nz
          if (speed < 0) { hit = Math.max(hit, -speed); vx -= nx * speed * 1.25; vz -= nz * speed * 1.25 }
        }
      }
      if (Math.abs(r.x) > X - R) { r.x = Math.sign(r.x) * (X - R); if (vx * Math.sign(r.x) > 0) { hit = Math.abs(vx); vx *= -0.25 } }
      if (Math.abs(r.z) > Z - R) { r.z = Math.sign(r.z) * (Z - R); if (vz * Math.sign(r.z) > 0) { hit = Math.max(hit, Math.abs(vz)); vz *= -0.25 } }
      if (hit) { r.v = vx * fx + vz * fz; this.bump(`f${n}`, n, hit) }
    })
    // Rovers against each other: pushed apart, trading the speed between them.
    for (let i = 0; i < this.rovers.length; i++) {
      for (let j = i + 1; j < this.rovers.length; j++) {
        const a = this.rovers[i], b = this.rovers[j]
        const dx = b.x - a.x, dz = b.z - a.z
        const d = Math.hypot(dx, dz)
        if (d >= 2 * R || d < 1e-6) continue
        const nx = dx / d, nz = dz / d
        const push = (2 * R - d) / 2
        a.x -= nx * push; a.z -= nz * push
        b.x += nx * push; b.z += nz * push
        const [ax, az] = fwd(a), [bx, bz] = fwd(b)
        const rel = (a.v * ax - b.v * bx) * nx + (a.v * az - b.v * bz) * nz
        if (rel <= 0) continue
        const k = rel * 0.7
        a.v -= k * (ax * nx + az * nz)
        b.v += k * (bx * nx + bz * nz)
        this.bump(`r${i}-${j}`, i, rel)
        this.bump(`r${j}-${i}`, j, rel)
      }
    }
    // Cones: shoved along by whatever hits them, sliding to a stop, kept in the yard.
    for (const c of this.cones) {
      for (const r of this.rovers) {
        const dx = c.x - r.x, dz = c.z - r.z
        const d = Math.hypot(dx, dz)
        if (d >= R + CONE_R || d < 1e-6) continue
        const nx = dx / d, nz = dz / d
        c.x = r.x + nx * (R + CONE_R)
        c.z = r.z + nz * (R + CONE_R)
        const [fx, fz] = fwd(r)
        const into = (fx * nx + fz * nz) * r.v
        if (into > 0) { c.vx += nx * into * 1.4; c.vz += nz * into * 1.4; r.v *= 0.92 }
      }
      const sp = Math.hypot(c.vx, c.vz)
      if (sp > 0) {
        const k = Math.max(0, sp - 3 * dt) / sp
        c.vx *= k
        c.vz *= k
      }
      c.x += c.vx * dt
      c.z += c.vz * dt
      if (Math.abs(c.x) > X - CONE_R) { c.x = Math.sign(c.x) * (X - CONE_R); c.vx *= -0.4 }
      if (Math.abs(c.z) > Z - CONE_R) { c.z = Math.sign(c.z) * (Z - CONE_R); c.vz *= -0.4 }
    }
  }

  home(n: number) {
    const r = this.rovers[n]
    ;[r.x, r.z, r.h] = r.home
    r.v = r.steer = 0
    steering.delete(r); this.filters[n].reset()
    r.braking = false
    this.sticks[n].update(false, [0, 0])
  }

  /** Every cone back where it stood (the panel's Reset). */
  reset() { for (const c of this.cones) { [c.x, c.z] = c.home; c.vx = c.vz = 0 } }
  readonly resetLabel = 'Cones back'

  readout(n: number) { return `${readable(Math.abs(this.rovers[n].v) * 3.6)} km/h` }

  drain() { const e = this.events; this.events = []; return e }
}

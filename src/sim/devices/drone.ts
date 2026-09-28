/**
 * Drone: quadcopters in a netted cage with rings to fly through, one per phone. The gamepad flies it as a real drone's
 * transmitter does (Mode 2: the left stick climbs and turns, the right stick flies), with the Flight profile suggested:
 * it switches Steer on, which tilts the right stick, so tilting the phone flies it. The 3D hand makes it follow your hand;
 * the trackpad tilts it and drags it up and down.
 *
 * It flies by velocity: the sticks ask for a speed and it eases toward it (a drone's inertia), holding its height when
 * nothing climbs, tipping toward where it's going. It takes off to a hover and lands on the floor, bumps off the net and
 * the other drones, and Home flies it back to its pad and lands it.
 */
import { Controller, Mode, PadButton } from '@obpal/core'
import { handMove, headingOf } from '@obpal/host'
import { axis, clamp, DragStick, padStick, readable, wrapPi } from './input'
import type { DeviceEvent, DeviceInput, DeviceLogic, DeviceSpec } from './types'
import { InputSmoother, Spring } from '../kit/motion'

export const DRONE_SPEC: DeviceSpec = {
  id: 'drone',
  name: 'Drone',
  unit: 'Drone',
  units: 4,
  kind: 'Flyer',
  blurb: 'Take off, fly through the rings, land back on your pad.',
  teaches: 'Twin sticks and the Flight profile: with Steer on, tilting the phone flies it',
  controllers: [Controller.gamepad, Controller.hand, Controller.trackpad],
  profile: 'flight',
  how: {
    'face.gamepad': 'Left stick climbs and turns · tilt the phone or the right stick to fly · A takes off, lands',
    'face.hand': 'Hold the pad and move your phone: it follows your hand',
    'face.trackpad': 'Tilt to fly · drag up to climb, sideways to turn · tap: take off',
  },
  tray: [{ id: 'fly', label: 'Take off', type: 'button', icon: 'plane' }],
  // A headset press or a keyboard's T takes off and lands on every controller.
  buttons: { 'media:playpause': 'tray:fly', 'key:KeyT': 'tray:fly' },
}

/** Metres, seconds, radians. */
export const DRONE = {
  radius: 0.36,
  /** Top speeds: across, up and down, and turning. */
  vh: 2.6,
  vv: 1.4,
  yawRate: 2,
  /** How quickly it reaches the speed asked for. */
  tau: 0.35,
  hover: 1.1,
  ceiling: 5.4,
  /** The cage: half its width (x) and depth (z). */
  cage: [7.2, 5.4] as const,
  /** The 3D hand: metres the drone moves per metre of hand. */
  handScale: 3,
  maxTilt: 0.42,
}

export type DronePhase = 'landed' | 'takeoff' | 'flying' | 'landing' | 'home'

export interface Drone {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Heading: 0 faces −z, + turns left. */
  yaw: number
  phase: DronePhase
  /** How it's tipped (rad, for the view): forward, and to the right. */
  pitch: number
  roll: number
  /** The rotors' speed, 0 (stopped) to 1, and their turn so far. */
  rotor: number
  spin: number
  /** The next ring, and how many it has flown through. */
  next: number
  rings: number
  home: [number, number]
  /** Where it's landing: it holds over the spot on the way down. */
  spot: [number, number] | null
}

/** A ring to fly through: its middle, which way it faces (rad about the vertical), and its radius. */
export interface Ring { x: number; y: number; z: number; face: number; r: number }

export const RINGS: Ring[] = [
  { x: -2.4, y: 1.5, z: -1.3, face: 0.5, r: 0.55 },
  { x: 1, y: 2.1, z: -1.8, face: -0.3, r: 0.55 },
  { x: 2.9, y: 1.3, z: 0.3, face: Math.PI / 2, r: 0.55 },
  { x: -0.4, y: 1.8, z: 0.4, face: 0, r: 0.6 },
  { x: -5, y: 3.4, z: -2.8, face: 0.5, r: 0.8 },
  { x: 0, y: 4.2, z: -3.5, face: -0.4, r: 0.8 },
  { x: 5.1, y: 2.6, z: -2.4, face: Math.PI / 2, r: 0.8 },
]

/** Training pylons; pilots can fly around them or over their tops. */
export const PYLONS = [{ x: -4.8, z: 1, radius: 0.32, height: 2.1 }, { x: 4.8, z: 1, radius: 0.32, height: 2.8 }]

/** What a pilot asks for: speeds −1…1 forward, right, up and turning right; or a place to be (the 3D hand). */
export interface DroneIntent { fwd: number; right: number; climb: number; turn: number; goal: [number, number, number] | null; toggle: boolean }

const none = (): DroneIntent => ({ fwd: 0, right: 0, climb: 0, turn: 0, goal: null, toggle: false })

/** Where a 3D-hand drive began: the phone's place and heading, and the drone's. */
export interface HandAnchor { gen: number; p: [number, number, number]; heading: number; at: [number, number, number] }

/** A pilot's input as the drone takes it, by the controller in use. */
export function droneIntent(inp: DeviceInput, d: Drone, stick: DragStick, hand: { anchor: HandAnchor | null }): DroneIntent {
  const i = none()
  const pressed = (b: number) => ((inp.padPressed >>> b) & 1) === 1
  i.toggle = inp.presses.includes('fly') || pressed(PadButton.A) || (inp.pad === null && inp.presses.includes('pad') && inp.mode !== Mode.track)
  if (inp.pad) {
    // Mode 2: the left stick is climb (up) and turn, the right stick flies; with the Flight profile's Steer on, the
    // phone's tilt arrives on the right stick too.
    const [lx, ly] = padStick(inp.pad, 'left')
    const [rx, ry] = padStick(inp.pad, 'right', 0.1)
    i.climb = -ly
    i.turn = lx
    i.fwd = -ry
    i.right = rx
    // The triggers climb and descend too, and the D-pad nudges.
    const [lt, rt] = inp.pad.triggers
    if (Math.abs(rt - lt) > 0.05) i.climb = clamp(i.climb + rt - lt, -1, 1)
    return i
  }
  if (inp.pose && inp.mode === Mode.track) {
    const pose = inp.pose
    // Recentre (or the thumb lifting) starts the hand's moves afresh from where the drone is.
    if (!pose.tracked || !pose.touching || inp.recentred) { hand.anchor = null; return i }
    if (!hand.anchor || hand.anchor.gen !== pose.gen) hand.anchor = { gen: pose.gen, p: [...pose.p], heading: headingOf(pose.q), at: [d.x, d.y, d.z] }
    const a = hand.anchor
    const m = handMove([pose.p[0] - a.p[0], pose.p[1] - a.p[1], pose.p[2] - a.p[2]], a.heading)
    // The stage's camera looks toward −z: right is +x, forward (toward the screen) is −z.
    const k = DRONE.handScale
    i.goal = [a.at[0] + m.right * k, a.at[1] + m.up * k, a.at[2] - m.forward * k]
    return i
  }
  hand.anchor = null
  // The trackpad: tilt flies (gyro on); a thumb dragged up climbs and sideways turns; two fingers fly too.
  const [sx, sy] = stick.update(inp.touching, inp.drag)
  i.turn = axis(sx, 0.15)
  i.climb = axis(-sy, 0.15)
  if (inp.mode === Mode.tilt) { i.right = inp.tilt[0]; i.fwd = -inp.tilt[1] }
  if (inp.pan[0] || inp.pan[1]) { i.right = clamp(i.right + inp.pan[0] / 40, -1, 1); i.fwd = clamp(i.fwd - inp.pan[1] / 40, -1, 1) }
  return i
}

const ease = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / tau))
const motion = new WeakMap<Drone, { pitch: Spring; roll: Spring; rotor: Spring }>()

/** One step of a drone's flight (not its collisions). */
export function stepDrone(d: Drone, i: DroneIntent, dt: number) {
  const D = DRONE
  let m = motion.get(d)
  if (!m) { m = { pitch: new Spring(d.pitch, .16), roll: new Spring(d.roll, .16), rotor: new Spring(d.rotor, .35) }; motion.set(d, m) }
  if (i.toggle) {
    if (d.phase === 'landed') d.phase = 'takeoff'
    else if (d.phase !== 'landing') { d.phase = 'landing'; d.spot = [d.x, d.z] }
  }
  // Pushing up to climb from the pad takes off too.
  if (d.phase === 'landed' && i.climb > 0.6) d.phase = 'takeoff'
  let tx = 0, ty = 0, tz = 0, turn = 0
  const moving = Math.abs(i.fwd) + Math.abs(i.right) + Math.abs(i.climb) + Math.abs(i.turn) > 0.2 || !!i.goal
  if (d.phase === 'home' && moving) d.phase = 'flying'
  switch (d.phase) {
    case 'landed':
      d.vx = d.vy = d.vz = 0
      break
    case 'takeoff':
      ty = D.vv * 0.8
      if (d.y >= D.hover) d.phase = 'flying'
      break
    case 'landing':
      ty = -D.vv * 0.6
      if (d.spot) { tx = clamp((d.spot[0] - d.x) * 2.5, -D.vh / 2, D.vh / 2); tz = clamp((d.spot[1] - d.z) * 2.5, -D.vh / 2, D.vh / 2) }
      break
    case 'home': {
      const dx = d.home[0] - d.x
      const dz = d.home[1] - d.z
      const dist = Math.hypot(dx, dz)
      ty = clamp((1.6 - d.y) * 2, -D.vv, D.vv)
      if (dist > 0.08) { const s = Math.min(D.vh * 0.8, dist * 1.5); tx = (dx / dist) * s; tz = (dz / dist) * s }
      else { d.phase = 'landing'; d.spot = [...d.home] }
      break
    }
    case 'flying':
      if (i.goal) {
        // Follow the hand: fly toward the place it asks for, fast when far.
        tx = clamp((i.goal[0] - d.x) * 3, -D.vh, D.vh)
        ty = clamp((i.goal[1] - d.y) * 3, -D.vv, D.vv)
        tz = clamp((i.goal[2] - d.z) * 3, -D.vh, D.vh)
      } else {
        const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw)
        tx = (i.fwd * fx + i.right * -fz) * D.vh
        tz = (i.fwd * fz + i.right * fx) * D.vh
        ty = clamp(i.climb, -1, 1) * D.vv
        turn = clamp(i.turn, -1, 1)
      }
      break
  }
  const was = [d.vx, d.vz]
  if (d.phase !== 'landed') {
    d.vx = ease(d.vx, tx, dt, D.tau)
    d.vz = ease(d.vz, tz, dt, D.tau)
    d.vy = ease(d.vy, ty, dt, D.tau * 0.7)
    d.yaw = wrapPi(d.yaw - turn * D.yawRate * dt)
    d.x += d.vx * dt
    d.y += d.vy * dt
    d.z += d.vz * dt
  }
  // On the floor: landing ends there; flying, it skims it.
  if (d.y <= 0) {
    d.y = 0
    if (d.vy < 0) d.vy = 0
    if (d.phase === 'landing' || (d.phase === 'flying' && i.climb < -0.5 && !i.goal)) { d.phase = 'landed'; d.vx = d.vz = 0; d.spot = null }
  }
  // It tips toward where it's speeding up and where it's going, as a quadcopter does.
  const ax = dt > 0 ? (d.vx - was[0]) / dt : 0
  const az = dt > 0 ? (d.vz - was[1]) / dt : 0
  const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw)
  const fwdA = ax * fx + az * fz + (d.vx * fx + d.vz * fz) * 0.9
  const rightA = ax * -fz + az * fx + (d.vx * -fz + d.vz * fx) * 0.9
  d.pitch = m.pitch.step(clamp(-fwdA * 0.09, -D.maxTilt, D.maxTilt), dt)
  d.roll = m.roll.step(clamp(rightA * 0.09, -D.maxTilt, D.maxTilt), dt)
  d.rotor = m.rotor.step(d.phase === 'landed' ? 0 : 1, dt)
  d.spin += m.rotor.travel * 60
}

/** Drones on their pads in a row at the front of the cage. */
function onPad(n: number, count: number): Drone {
  const x = (n - (count - 1) / 2) * 1.7
  return { x, y: 0, z: 1.9, vx: 0, vy: 0, vz: 0, yaw: 0, phase: 'landed', pitch: 0, roll: 0, rotor: 0, spin: 0, next: 0, rings: 0, home: [x, 1.9], spot: null }
}

/** Whether the path from a to b went through a ring's disc. */
export function throughRing(r: Ring, a: [number, number, number], b: [number, number, number]): boolean {
  // The ring's plane: its normal is its facing, about the vertical.
  const nx = -Math.sin(r.face), nz = -Math.cos(r.face)
  const da = (a[0] - r.x) * nx + (a[2] - r.z) * nz
  const db = (b[0] - r.x) * nx + (b[2] - r.z) * nz
  if (da === db || Math.sign(da) === Math.sign(db)) return false
  const t = da / (da - db)
  const px = a[0] + (b[0] - a[0]) * t - r.x
  const py = a[1] + (b[1] - a[1]) * t - r.y
  const pz = a[2] + (b[2] - a[2]) * t - r.z
  return Math.hypot(px, py, pz) < r.r
}

export class DroneLogic implements DeviceLogic {
  readonly spec = DRONE_SPEC
  readonly drones: Drone[]
  readonly rings = RINGS
  private sticks: DragStick[]
  private hands: { anchor: HandAnchor | null }[]
  private filters: InputSmoother[]
  private events: DeviceEvent[] = []
  private touching = new Map<string, number>()

  constructor(count = DRONE_SPEC.units) {
    this.drones = Array.from({ length: count }, (_, n) => onPad(n, count))
    this.sticks = this.drones.map(() => new DragStick())
    this.hands = this.drones.map(() => ({ anchor: null }))
    this.filters = this.drones.map(() => new InputSmoother())
  }

  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    this.drones.forEach((d, n) => {
      const inp = inputs[n]
      const intent = inp ? droneIntent(inp, d, this.sticks[n], this.hands[n]) : none()
      // Taking over Home is an action: respond to the raw intent before filtering its continuous axes.
      if (d.phase === 'home' && (Math.abs(intent.fwd) + Math.abs(intent.right) + Math.abs(intent.climb) + Math.abs(intent.turn) > .2 || intent.goal)) d.phase = 'flying'
      const filter = this.filters[n]
      if (!inp || (inp.pose && (!inp.pose.touching || !inp.pose.tracked)) || inp.recentred) filter.reset()
      else {
        for (const key of ['fwd', 'right', 'climb', 'turn'] as const) intent[key] = filter.sample(key, intent[key], dt)
        if (intent.goal) intent.goal = intent.goal.map((v, j) => filter.sample(`goal${j}`, v, dt, [d.x, d.y, d.z][j])) as [number, number, number]
      }
      if (!inp) { this.sticks[n].update(false, [0, 0]); this.hands[n].anchor = null }
      const before = d.phase
      const from: [number, number, number] = [d.x, d.y, d.z]
      stepDrone(d, intent, dt)
      if (before === 'landed' && d.phase === 'takeoff') this.events.push({ unit: n, kind: 'tick', text: 'Taking off', audio: { action: 'launch' } })
      if (before !== 'landed' && d.phase === 'landed') this.events.push({ unit: n, kind: 'tick', text: 'Landed', audio: { action: 'dock' } })
      const ring = this.rings[d.next]
      if (ring && d.phase !== 'landed' && throughRing(ring, from, [d.x, d.y, d.z])) {
        d.rings++
        d.next = (d.next + 1) % this.rings.length
        this.events.push({ unit: n, kind: 'score', text: d.next === 0 ? `A lap of the rings! ${d.rings} in all` : `Ring ${d.rings}: on to the next` })
      }
    })
    this.collide()
    for (const [k, left] of this.touching) { if (left - dt <= 0) this.touching.delete(k); else this.touching.set(k, left - dt) }
  }

  private bump(key: string, n: number, speed: number) {
    const known = this.touching.has(key)
    this.touching.set(key, 0.3)
    if (!known && speed > 0.3) this.events.push({ unit: n, kind: 'bump', strength: Math.min(1, speed / DRONE.vh), audio: { speed, impulse: speed * 0.6 } })
  }

  private collide() {
    const [X, Z] = DRONE.cage
    const R = DRONE.radius
    this.drones.forEach((d, n) => {
      let hit = 0
      for (const p of PYLONS) {
        const dx = d.x - p.x, dz = d.z - p.z, distance = Math.hypot(dx, dz)
        if (d.y >= p.height + R || distance >= p.radius + R) continue
        if (d.y > p.height && d.vy < 0) { d.y = p.height + R; hit = Math.abs(d.vy); d.vy = 0; continue }
        const nx = distance > 1e-6 ? dx / distance : 1, nz = distance > 1e-6 ? dz / distance : 0
        d.x = p.x + nx * (p.radius + R); d.z = p.z + nz * (p.radius + R)
        const into = d.vx * nx + d.vz * nz
        if (into < 0) { hit = Math.max(hit, -into); d.vx -= nx * into * 1.3; d.vz -= nz * into * 1.3 }
      }
      if (Math.abs(d.x) > X - R) { d.x = Math.sign(d.x) * (X - R); hit = Math.abs(d.vx); d.vx *= -0.3 }
      if (Math.abs(d.z) > Z - R) { d.z = Math.sign(d.z) * (Z - R); hit = Math.max(hit, Math.abs(d.vz)); d.vz *= -0.3 }
      if (d.y > DRONE.ceiling) { d.y = DRONE.ceiling; hit = Math.max(hit, Math.abs(d.vy)); d.vy = Math.min(0, d.vy) }
      if (hit) this.bump(`c${n}`, n, hit)
    })
    for (let i = 0; i < this.drones.length; i++) {
      for (let j = i + 1; j < this.drones.length; j++) {
        const a = this.drones[i], b = this.drones[j]
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
        const dist = Math.hypot(dx, dy, dz)
        if (dist >= 2 * R || dist < 1e-6) continue
        const nx = dx / dist, ny = dy / dist, nz = dz / dist
        const push = (2 * R - dist) / 2
        a.x -= nx * push; a.y -= ny * push; a.z -= nz * push
        b.x += nx * push; b.y += ny * push; b.z += nz * push
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny + (a.vz - b.vz) * nz
        if (rel > 0) {
          a.vx -= rel * nx; a.vy -= rel * ny; a.vz -= rel * nz
          b.vx += rel * nx; b.vy += rel * ny; b.vz += rel * nz
        }
        this.bump(`d${i}-${j}`, i, Math.abs(rel))
        this.bump(`d${j}-${i}`, j, Math.abs(rel))
        a.y = Math.max(0, a.y)
        b.y = Math.max(0, b.y)
      }
    }
  }

  /** Home: fly back to the pad and land (from the pad, it's already there). */
  home(n: number) {
    const d = this.drones[n]
    this.filters[n].reset()
    if (d.phase === 'landed') { d.x = d.home[0]; d.z = d.home[1]; d.yaw = 0; return }
    d.phase = 'home'
  }

  readout(n: number) {
    const d = this.drones[n]
    if (d.phase === 'landed') return d.rings ? `Landed · ${d.rings} rings` : 'Landed'
    return `${readable(d.y)} m · ${d.rings} rings`
  }

  drain() { const e = this.events; this.events = []; return e }
}

/**
 * The octopus (/sim/octopus/): Cove, a soft eight-arm robot on a dry studio floor, driven by one phone. Each arm is a
 * soft, damped rod (../continuum/rod.ts) whose stiffness falls toward the tip and whose section thins as it elongates.
 * The arms are not stepped like legs. Following the published octopus mechanics (docs/OCTOPUS.md):
 *
 *   - Crawling is pushing by elongation (Levy, Flash and Hochner 2015). An arm holds the floor with its suckers and
 *     elongates as the body glides away from that hold; at the end of its range it peels from the tip back toward the
 *     base, shortens and is drawn in, then reaches out again. Which arms push follows the moment's travel direction,
 *     so there is no gait or fixed phase order, several arms are at different phases at once, and the body's heading
 *     is steered separately from its crawl direction.
 *   - Reaching, including Grab, is a bend that travels from the base to the tip and unrolls the arm toward its target
 *     (Gutfreund et al. 1996; Sumbre et al. 2001). The bend's progress comes from the foundation's force-driven bend
 *     dynamics (../continuum/primitives.ts), so its speed rises and falls in a bell-shaped profile.
 *   - Free parts of the arms carry slow travelling waves and curled tips; held parts stay still.
 *
 * Grab wraps two arms round the ball and carries it; Pulse squeezes the mantle through the jet cycle and, on this dry
 * floor, pushes off by elongating the holding arms; Curl coils the arms and the body settles on them; Stop holds
 * everything. This is a reduced, kinematically stable soft-body model: rod stiffness, damping, ranges and timings
 * are design values, not measured animal or hardware parameters. Logic is pure (three.js maths only) and advances in
 * fixed 120 Hz ticks, so 30, 60 and 120 Hz screens replay alike.
 */
import { Controller, PadButton } from '@obpal/core'
import { Vector3 } from 'three'
import { BendDynamics, JetMantle, REFERENCE_BEND, REFERENCE_JET, type JetSettings } from '../continuum/primitives'
import { ArmRod, FLOOR, FREE, OBJECT, ROD_SEGMENTS, surfaceRadius } from '../continuum/rod'
import { ContinuumClock } from '../continuum/tendons'
import { action, drive, Machine, timestep } from './common'
import { approach, axis, clamp, DragStick, wrapPi } from './input'
import type { DeviceEvent, DeviceInput, DeviceSpec } from './types'
import {
  ARM_POINTS, OCTOPUS_ARMS, OCTOPUS_CUPS, OCTOPUS_PROFILE as PROFILE, armRoot, pointAt, profileYaw,
  type ArmRole, type Octopus,
} from './octopus-types'

export const OCTOPUS_SPEC: DeviceSpec = {
  id: 'octopus',
  name: 'Octopus',
  unit: 'Octopus',
  units: 1,
  kind: 'Robot',
  category: 'robotics',
  blurb: 'Crawl a soft eight-armed robot across the floor, wrap its arms round a ball and carry it to the ring.',
  teaches: 'One stick and a few buttons coordinate eight soft arms',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left stick crawls and turns · right stick crawls sideways · A grabs or lets go · B curls · X pulses · Y stops',
    'face.trackpad': 'Drag or tilt to crawl · two fingers crawl sideways · tap grabs or lets go · Curl, Pulse and Stop in the tray',
  },
  tray: [
    { id: 'grab', label: 'Grab', type: 'button', icon: 'grip-close' },
    { id: 'curl', label: 'Curl', type: 'button', icon: 'bend' },
    { id: 'pulse', label: 'Pulse', type: 'button', icon: 'speed' },
    { id: 'stop', label: 'Stop', type: 'button', tone: 'stop' },
  ],
  buttons: { 'media:playpause': 'tray:grab', 'key:Space': 'tray:grab', 'key:KeyC': 'tray:curl', 'key:KeyP': 'tray:pulse' },
}

/** Body choices (metres, seconds). Design values for this studio, not hardware measurements. */
export const OCTOPUS_LIMITS = { x: 3.1, z: 2.1, crawlHeight: 0.15, restHeight: 0.085, speed: 0.24, turn: 0.6, accel: 0.45 }
/**
 * How far a holding arm may elongate or shorten between its root and its first hold before it peels, as a fraction of
 * its rest length (a muscular hydrostat both elongates and shortens; these bounds are design values).
 */
export const ELONGATION = { shortest: 0.62, longest: 1.32, slip: 1.42 }
/** Where an arm first holds the floor, as a fraction along it: the proximal part stays free to push. */
export const HOLD_FROM = 0.44
/** Reach targets: distance from the body's centre at rest and how far travel moves them ahead. */
const REACH = { radius: 0.68, lead: 0.5 }
export const BALL_RADIUS = 0.09
const DEN_RADIUS = 0.3
const BALL_ROUTE = [[0.15, -0.55], [-1.6, -0.9], [1.5, -1.2], [-0.9, -1.5], [1.8, 0.4]] as const
const START = { x: 0, z: 0.9 }
const DEN: [number, number] = [-1.7, 0.5]
/**
 * The reach's travelling bend: the foundation's Gutfreund 1998 force model at 1.8 times the reference effort, so a
 * Cove arm's bend runs base to tip in about two thirds of a second (a design choice; the bell-shaped speed profile is the model's).
 */
const REACHING = { ...REFERENCE_BEND, force: REFERENCE_BEND.force * 1.8 }
/** Seconds without a holder before the octopus starts showing itself. */
export const SHOWCASE_AFTER = 4

/** The Renda 2015 cycle shape, scaled to Cove's mantle cavity (design values): four litres, a 2 cm siphon. */
export const COVE_JET: JetSettings = { ...REFERENCE_JET, period: 0.9, contraction: 0.3, capacity: 4e-3, nozzle: Math.PI * 0.02 ** 2, thrustCap: 45 }

const smooth = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x) }
/** A small deterministic sequence for idle exploration (no wall clock, no Math.random). */
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s) }
const particle = (fraction: number) => Math.round(clamp(fraction, 0, 1) * ROD_SEGMENTS)

type GrabPhase = 'none' | 'reach' | 'hold' | 'gesture'

interface Arm {
  index: number
  /** Root azimuth in the profile frame and side (-1, +1). */
  angle: number
  side: number
  neighbours: [number, number]
  rod: ArmRod
  role: ArmRole
  time: number
  /** Seal at each particle, 0…1. */
  seal: Float64Array
  /** Where a held object particle sits relative to the ball's centre. */
  offset: Float64Array
  /** The bend the controller wants at each joint; the rod's own targets ease toward it, so no change is a snap. */
  oral: Float64Array
  lateral: Float64Array
  /** The travelling bend of a reach, its target and its own wave phase. */
  bend: BendDynamics
  target: Vector3
  phase: number
}

interface Runtime {
  arms: Arm[]
  clock: ContinuumClock
  mantle: JetMantle
  drag: DragStick
  time: number
  ticks: number
  /** Body velocity (world, m/s) and vertical speed. */
  velocity: Vector3
  vy: number
  /** Commanded crawl (body frame: forward, right) and turn, held through a frame's ticks. */
  forward: number
  right: number
  steer: number
  grab: GrabPhase
  grabTime: number
  grabbers: number[]
  idle: number
  explore: number
  explored: number
  rearm: boolean
  nobody: number
  show: { phase: 'seek' | 'carry' | 'curl' | 'pulse'; time: number }
  ballVy: number
  route: number
  slips: number
  pending: { grab: boolean; curl: boolean; pulse: boolean; stop: boolean }
}

const scratch = { a: new Vector3(), b: new Vector3(), c: new Vector3(), root: new Vector3(), out: new Vector3(), dorsal: new Vector3() }

export class OctopusLogic extends Machine {
  readonly spec = OCTOPUS_SPEC
  units: Octopus[] = [this.fresh()]
  private run: Runtime[] = [this.runtime()]

  constructor() {
    super()
    this.home(0)
  }

  private fresh(): Octopus {
    return {
      x: START.x, y: OCTOPUS_LIMITS.crawlHeight, z: START.z, h: 0, v: 0, turn: 0, mode: 'crawl', stopped: false, mantle: 1,
      arms: new Array(OCTOPUS_ARMS * ARM_POINTS * 3).fill(0),
      cups: new Array(OCTOPUS_ARMS * OCTOPUS_CUPS).fill(0),
      roles: new Array<ArmRole>(OCTOPUS_ARMS).fill('plant'),
      ball: { x: START.x + BALL_ROUTE[0][0], y: BALL_RADIUS, z: BALL_ROUTE[0][1], held: false },
      den: [...DEN], score: 0, actions: 0, showing: false,
    }
  }

  private runtime(): Runtime {
    const arms = PROFILE.arms.map((profile, index): Arm => ({
      index,
      angle: Math.atan2(profile.position.x, profile.position.z),
      side: Math.sign(profile.position.x) || 1,
      neighbours: [0, 0],
      rod: new ArmRod(profile),
      role: 'plant', time: 0,
      seal: new Float64Array(ARM_POINTS),
      oral: new Float64Array(ARM_POINTS), lateral: new Float64Array(ARM_POINTS),
      offset: new Float64Array(ARM_POINTS * 3),
      bend: new BendDynamics(REACHING),
      target: new Vector3(),
      phase: hash(index * 3.1) * Math.PI * 2,
    }))
    const ring = [...arms].sort((a, b) => a.angle - b.angle)
    ring.forEach((arm, i) => { arm.neighbours = [ring[(i + ring.length - 1) % ring.length].index, ring[(i + 1) % ring.length].index] })
    return {
      arms, clock: new ContinuumClock(), mantle: new JetMantle(COVE_JET), drag: new DragStick(), time: 0, ticks: 0,
      velocity: new Vector3(), vy: 0, forward: 0, right: 0, steer: 0, grab: 'none', grabTime: 0, grabbers: [],
      idle: 0, explore: 0, explored: 0, rearm: false, nobody: 0, show: { phase: 'seek', time: 0 }, ballVy: 0, route: 0,
      slips: 0, pending: { grab: false, curl: false, pulse: false, stop: false },
    }
  }

  /** Sucker slips: holds dragged because an arm reached its elongation limit before it could peel. */
  get slips() { return this.run[0].slips }

  home(n: number) {
    if (n !== 0) return
    // Keep the state's own objects: views and snapshots hold references to them.
    const u = this.units[0], fresh = this.fresh()
    Object.assign(u, { ...fresh, arms: u.arms, cups: u.cups, roles: u.roles, ball: u.ball, den: u.den, score: u.score, actions: u.actions })
    Object.assign(u.ball, fresh.ball)
    u.cups.fill(0)
    const run = this.run[0] = this.runtime()
    // Lay each arm out from its root, let it settle onto the floor, then hold where it rests.
    for (const arm of run.arms) {
      armRoot(u, arm.index, scratch.root, scratch.out, scratch.dorsal)
      arm.rod.place(scratch.root, scratch.out, scratch.dorsal)
    }
    for (let i = 0; i < 240; i++) for (const arm of run.arms) {
      this.relax(arm, 0, 0)
      this.shape(arm, 1)
      armRoot(u, arm.index, scratch.root, scratch.out, scratch.dorsal)
      arm.rod.step(1 / 120, scratch.root, scratch.out, scratch.dorsal, 0)
    }
    for (const arm of run.arms) {
      for (let i = particle(HOLD_FROM); i < particle(0.72); i++) if (arm.rod.contact[i]) { arm.rod.hold(i); arm.seal[i] = 1 }
      arm.role = 'plant'
    }
    this.publish(u, run)
  }

  readout(n: number) {
    const u = this.units[n]
    if (!u) return 'Octopus'
    const what = u.stopped ? 'Stopped' : u.mode === 'curl' ? 'Curled' : u.ball.held ? 'Holding the ball'
      : Math.abs(u.v) > 0.04 || Math.abs(u.turn) > 0.1 ? 'Crawling' : 'Resting'
    return `${what} · ${u.score} ${u.score === 1 ? 'ball' : 'balls'}`
  }

  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta), u = this.units[0], run = this.run[0], input = inputs[0] ?? null
    if (!(dt > 0)) return
    this.read(u, run, input, dt)
    run.clock.advance(dt, (h) => this.tick(u, run, h))
    this.publish(u, run)
  }

  /** One frame's intention: presses become pending commands; the sticks a crawl and a turn, held through its ticks. */
  private read(u: Octopus, run: Runtime, input: DeviceInput | null, dt: number) {
    const live = input && !input.quiet ? input : null
    run.nobody = input ? 0 : run.nobody + dt
    const showing = run.nobody > SHOWCASE_AFTER
    if (showing !== u.showing) {
      u.showing = showing
      if (showing) run.show = { phase: 'seek', time: 0 }
    }
    if (showing) { this.showcase(u, run, dt); return }
    const pressed = live?.padPressed ?? 0
    const grab = !!live && action(live, 'grab')
    const curl = !!live && (live.presses.includes('curl') || !!(pressed & (1 << PadButton.B)))
    const pulse = !!live && (live.presses.includes('pulse') || !!(pressed & (1 << PadButton.X)))
    const stop = !!input && (input.presses.includes('stop') || !!((input.padPressed ?? 0) & (1 << PadButton.Y)))
    const [steer, power] = drive(live, run.drag)
    // Sideways crawl: the right stick across, or a two-finger pan, with the heading left as it is.
    const across = live?.pad ? axis(live.pad.axes[2]) : live ? clamp((live.pan?.[0] ?? 0) / 40, -1, 1) : 0
    run.forward = Number.isFinite(power) ? clamp(power, -1, 1) : 0
    run.steer = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0
    run.right = Number.isFinite(across) ? clamp(across, -1, 1) : 0
    if (stop) { run.pending.stop = true; return }
    if (u.stopped) {
      const moving = Math.abs(run.forward) > 0.05 || Math.abs(run.steer) > 0.05 || Math.abs(run.right) > 0.05
      if (!moving) run.rearm = true
      if (grab || curl || pulse || (run.rearm && moving)) {
        u.stopped = false
        this.events.push({ unit: 0, kind: 'tick', text: 'Moving again' })
      }
      run.forward = run.steer = run.right = 0
      return
    }
    run.pending.grab ||= grab
    run.pending.curl ||= curl
    run.pending.pulse ||= pulse
  }

  /**
   * Nobody holds it: it crawls toward the ball (its heading turning more slowly than its course, as an octopus's
   * does), wraps it, carries it into the ring, curls and pulses, without scoring or events.
   */
  private showcase(u: Octopus, run: Runtime, dt: number) {
    const show = run.show
    show.time += dt
    const target = show.phase === 'carry' ? scratch.a.set(u.den[0], 0, u.den[1]) : scratch.a.set(u.ball.x, 0, u.ball.z)
    const dx = target.x - u.x, dz = target.z - u.z, distance = Math.hypot(dx, dz)
    // Course in the body frame: forward is (-sin h, -cos h), right is (cos h, -sin h).
    const fx = -Math.sin(u.h), fz = -Math.cos(u.h), rx = Math.cos(u.h), rz = -Math.sin(u.h)
    const ahead = (dx * fx + dz * fz) / (distance || 1), across = (dx * rx + dz * rz) / (distance || 1)
    const bearing = Math.atan2(across, ahead)
    run.steer = clamp(bearing * 0.8, -0.6, 0.6) * (u.mode === 'crawl' ? 1 : 0)
    run.forward = run.right = 0
    const go = (speed: number) => { run.forward = ahead * speed; run.right = across * speed }
    if (show.phase === 'seek') {
      go(clamp((distance - 0.6) * 1.5, 0, 0.8))
      if (u.mode === 'curl') run.pending.curl = true
      else if (distance < 0.8 && run.grab === 'none') run.pending.grab = true
      if (u.ball.held) show.phase = 'carry', show.time = 0
      if (show.time > 30) show.phase = 'curl', show.time = 0
    } else if (show.phase === 'carry') {
      const over = Math.hypot(u.ball.x - u.den[0], u.ball.z - u.den[1])
      go(clamp(over * 1.6, 0.25, 0.7))
      if (over < DEN_RADIUS * 0.6 && u.ball.held) run.pending.grab = true
      if (!u.ball.held && run.grab === 'none') show.phase = 'curl', show.time = 0
      if (show.time > 30) { if (u.ball.held) run.pending.grab = true; show.phase = 'curl'; show.time = 0 }
    } else if (show.phase === 'curl') {
      if (show.time < 0.1 && u.mode === 'crawl') run.pending.curl = true
      if (show.time > 2.6 && u.mode === 'curl') run.pending.curl = true
      if (show.time > 4.2) show.phase = 'pulse', show.time = 0
    } else {
      if (show.time > 0.6 && show.time < 0.7) run.pending.pulse = true
      if (show.time > 2.5) show.phase = 'seek', show.time = 0
    }
  }

  private tick(u: Octopus, run: Runtime, dt: number) {
    run.time += dt
    run.ticks++
    const pending = run.pending
    if (pending.stop) {
      pending.stop = pending.grab = pending.curl = pending.pulse = false
      if (!u.stopped) {
        u.stopped = true
        run.rearm = false
        u.v = u.turn = 0
        run.velocity.set(0, 0, 0)
        this.emit({ unit: 0, kind: 'tick', text: 'Stopped' }, u)
      }
    }
    if (u.stopped) return
    if (pending.curl) { pending.curl = false; this.toggleCurl(u, run) }
    if (pending.grab) { pending.grab = false; this.toggleGrab(u, run) }
    if (pending.pulse) {
      pending.pulse = false
      if (run.mantle.pulse()) {
        u.actions++
        // On a dry floor the squeeze's push comes from the holding arms elongating all at once.
        if (u.mode === 'crawl' && this.holding(run) >= 3)
          run.velocity.addScaledVector(scratch.c.set(-Math.sin(u.h), 0, -Math.cos(u.h)), 0.42)
        this.emit({ unit: 0, kind: 'tick', text: 'Pulse', audio: { action: 'pulse' } }, u)
      }
    }
    run.mantle.step(dt)
    this.moveBody(u, run, dt)
    this.grabStep(u, run, dt)
    this.arms(u, run, dt)
    this.ballStep(u, run, dt)
  }

  private emit(event: DeviceEvent, u: Octopus) {
    if (!u.showing) this.events.push(event)
  }

  /** Arms holding the floor. */
  private holding(run: Runtime) {
    let count = 0
    for (const arm of run.arms) if (arm.role === 'plant' && this.firstHold(arm) >= 0) count++
    return count
  }
  private firstHold(arm: Arm) {
    for (let i = 2; i < ARM_POINTS; i++) if (arm.rod.held[i] === FLOOR) return i
    return -1
  }

  private toggleCurl(u: Octopus, run: Runtime) {
    u.actions++
    if (u.mode === 'curl') {
      u.mode = 'crawl'
      // Uncoil by reaching back down to the floor, each arm with its own travelling bend.
      for (const arm of run.arms) this.beginReach(u, run, arm, 0.18 * hash(arm.index + run.ticks))
      this.emit({ unit: 0, kind: 'tick', text: 'Uncurled' }, u)
      return
    }
    if (u.ball.held || run.grab !== 'none') this.release(u, run, false)
    u.mode = 'curl'
    for (const arm of run.arms) { arm.role = 'free'; arm.time = 0 }
    this.emit({ unit: 0, kind: 'tick', text: 'Curled' }, u)
  }

  /** The two arms whose roots point most nearly toward a world point. */
  private nearest(u: Octopus, run: Runtime, x: number, z: number) {
    const yaw = profileYaw(u.h), bx = x - u.x, bz = z - u.z
    // World to profile frame: rotate by -yaw.
    const c = Math.cos(-yaw), s = Math.sin(-yaw), px = c * bx + s * bz, pz = -s * bx + c * bz
    const bearing = Math.atan2(px, pz)
    return [...run.arms].sort((a, b) => Math.abs(wrapPi(a.angle - bearing)) - Math.abs(wrapPi(b.angle - bearing)) || a.index - b.index)
      .slice(0, 2).map((a) => a.index)
  }

  private toggleGrab(u: Octopus, run: Runtime) {
    if (u.mode !== 'crawl') return
    u.actions++
    if (run.grab === 'reach' || run.grab === 'hold') { this.release(u, run, true); return }
    if (run.grab === 'gesture') return
    const distance = Math.hypot(u.ball.x - u.x, u.ball.z - u.z), reachable = distance > 0.3 && distance < 0.95 && u.ball.y < 0.4
    run.grab = reachable ? 'reach' : 'gesture'
    run.grabTime = 0
    // The pair nearest the ball reaches for it, whichever way the body faces; out of reach, the pair ahead gestures.
    run.grabbers = reachable ? this.nearest(u, run, u.ball.x, u.ball.z)
      : this.nearest(u, run, u.x - Math.sin(u.h), u.z - Math.cos(u.h))
    for (const index of run.grabbers) {
      const arm = run.arms[index]
      this.peelAll(arm)
      if (reachable) arm.target.set(u.ball.x, u.ball.y, u.ball.z)
      else arm.target.set(u.x - Math.sin(u.h) * 0.95, 0.3, u.z - Math.cos(u.h) * 0.95)
      this.beginReach(u, run, arm, 0, reachable ? 'wrap' : 'reach')
    }
    this.emit({ unit: 0, kind: 'tick', text: reachable ? 'Grabbing' : 'Reaching' }, u)
  }

  private release(u: Octopus, run: Runtime, say: boolean) {
    const held = u.ball.held
    u.ball.held = false
    run.ballVy = 0
    run.grab = 'none'
    for (const index of run.grabbers) {
      const arm = run.arms[index]
      arm.rod.wrapRadius = 0
      arm.role = 'peel'
      arm.time = 0
      arm.rod.sync()
    }
    run.grabbers = []
    if (say) this.emit({ unit: 0, kind: 'tick', text: held ? 'Let go' : 'Grab cancelled' }, u)
  }

  /** The body glides: its velocity eases toward the command as far as the holding, pushing arms allow. */
  private moveBody(u: Octopus, run: Runtime, dt: number) {
    const limits = OCTOPUS_LIMITS, crawling = u.mode === 'crawl'
    const fx = -Math.sin(u.h), fz = -Math.cos(u.h), rx = Math.cos(u.h), rz = -Math.sin(u.h)
    const want = scratch.a.set(fx * run.forward + rx * run.right, 0, fz * run.forward + rz * run.right)
    if (want.length() > 1) want.normalize()
    want.multiplyScalar(limits.speed)
    // Pushers hold the floor behind the course: they are what moves the body (pushing by elongation).
    let pushers = 0, holders = 0
    const course = want.lengthSq() > 1e-6 ? scratch.b.copy(want).normalize() : null
    for (const arm of run.arms) {
      const hold = arm.role === 'plant' ? this.firstHold(arm) : -1
      if (hold < 0) continue
      holders++
      const k = hold * 3, ax = arm.rod.position[k] - u.x, az = arm.rod.position[k + 2] - u.z
      // Only an arm with elongation left to give can push; one at the end of its range waits to be relieved.
      if ((!course || ax * course.x + az * course.z < 0.15) && this.need(arm, hold) < ELONGATION.longest - 0.04) pushers++
    }
    const capacity = crawling ? clamp(pushers / 2.5, 0, 1) * clamp((holders - 1) / 2, 0, 1) : 0
    want.multiplyScalar(capacity)
    const change = scratch.c.subVectors(want, run.velocity), most = limits.accel * dt
    if (change.length() > most) change.setLength(most)
    run.velocity.add(change)
    if (!crawling) run.velocity.multiplyScalar(Math.exp(-dt * 6))
    u.turn = approach(u.turn, crawling ? -run.steer * limits.turn * clamp(holders / 4, 0, 1) : 0, 1.6, dt)
    u.h = wrapPi(u.h + u.turn * dt)
    const x = u.x + run.velocity.x * dt, z = u.z + run.velocity.z * dt
    u.x = clamp(x, -limits.x, limits.x)
    u.z = clamp(z, -limits.z, limits.z)
    if (x !== u.x || z !== u.z) {
      if (run.velocity.length() > 0.15) this.emit({ unit: 0, kind: 'bump', strength: 0.3, audio: { speed: run.velocity.length() } }, u)
      if (x !== u.x) run.velocity.x = 0
      if (z !== u.z) run.velocity.z = 0
    }
    u.v = run.velocity.x * fx + run.velocity.z * fz
    // Holding arms carry the body at crawl height; without them it settles onto its arms and web.
    const supported = crawling && holders >= 3
    const target = supported ? limits.crawlHeight : limits.restHeight
    if (supported || u.y < target) run.vy += (40 * (target - u.y) - 2 * Math.sqrt(40) * run.vy) * dt
    else run.vy -= 9.81 * dt
    u.y += run.vy * dt
    if (u.y < limits.restHeight) {
      if (run.vy < -0.6) this.emit({ unit: 0, kind: 'bump', strength: clamp(-run.vy / 2, 0, 1), audio: { speed: -run.vy } }, u)
      u.y = limits.restHeight
      run.vy = Math.max(0, run.vy)
    }
  }

  private grabStep(u: Octopus, run: Runtime, dt: number) {
    if (run.grab === 'none') return
    run.grabTime += dt
    if (run.grab === 'gesture') {
      if (run.grabTime > 1.3) {
        run.grab = 'none'
        for (const index of run.grabbers) { const arm = run.arms[index]; arm.role = 'peel'; arm.time = 0 }
        run.grabbers = []
      }
      return
    }
    let held = 0
    for (const index of run.grabbers) for (let i = 0; i < ARM_POINTS; i++) if (run.arms[index].rod.held[i] === OBJECT) held++
    if (run.grab === 'reach' && held >= 5) {
      run.grab = 'hold'
      u.ball.held = true
      for (const index of run.grabbers) run.arms[index].role = 'hold'
      this.emit({ unit: 0, kind: 'tick', text: 'Holding the ball', audio: { action: 'grab' } }, u)
    }
    if (run.grab === 'reach' && run.grabTime > 2.2) { this.release(u, run, true); return }
    if (u.ball.held) {
      // Carried beside the body on the holding pair's side, lifted clear of the floor.
      let ax = 0, az = 0
      for (const index of run.grabbers) {
        armRoot(u, index, scratch.root, scratch.out, scratch.dorsal)
        ax += scratch.out.x; az += scratch.out.z
      }
      const length = Math.hypot(ax, az) || 1
      const k = 1 - Math.exp(-dt / 0.35)
      u.ball.x += (u.x + (ax / length) * 0.46 - u.ball.x) * k
      u.ball.y += (u.y + 0.08 - u.ball.y) * k
      u.ball.z += (u.z + (az / length) * 0.46 - u.ball.z) * k
    }
  }

  /** Begin a reach: the arm shortens a little and a bend starts travelling from its base toward the tip. */
  private beginReach(u: Octopus, run: Runtime, arm: Arm, delay = 0, role: ArmRole = 'reach') {
    arm.role = role
    arm.time = -delay
    arm.bend.position = arm.bend.velocity = 0
    if (!run.grabbers.includes(arm.index)) this.reachTarget(u, run, arm)
  }

  /** Where a crawling arm reaches: outward from its root, swung toward the course, ahead by the travel. */
  private reachTarget(u: Octopus, run: Runtime, arm: Arm) {
    armRoot(u, arm.index, scratch.root, scratch.out, scratch.dorsal)
    const speed = run.velocity.length(), course = speed > 0.02 ? scratch.c.copy(run.velocity).multiplyScalar(1 / speed) : scratch.c.set(0, 0, 0)
    // Each arm keeps to its own sector: the course swings its reach by at most 45 degrees, so no arm sweeps round
    // the body like a leg.
    const own = Math.atan2(scratch.out.x, scratch.out.z)
    let bias = 0
    if (speed > 0.02) {
      const toward = Math.atan2(course.x, course.z), off = wrapPi(toward - own)
      bias = clamp(off, -Math.PI / 4, Math.PI / 4) * clamp(speed / 0.15, 0, 1) * Math.cos(off / 2)
    }
    const ox = Math.sin(own + bias), oz = Math.cos(own + bias)
    // Idle exploration nudges the spot a little, deterministically.
    const jitter = run.explore > 0 ? (hash(run.explored * 7.31 + arm.index) - 0.5) * 0.12 : 0
    const reach = REACH.radius + speed * REACH.lead + jitter
    arm.target.set(u.x + ox * reach, surfaceRadius(arm.rod.arm, 0.6) * 0.85, u.z + oz * reach)
  }

  private peelAll(arm: Arm) {
    for (let i = 0; i < ARM_POINTS; i++) arm.rod.held[i] = FREE
  }

  /**
   * The relaxed shape every arm returns to where nothing else holds it: a slight droop at the root, a gentle S across
   * the floor mirrored left and right, and a tip curled back, with a slow wave travelling from root to tip whose bend
   * tapers toward the tip. `life` scales the wave (idle drift is larger than crawling's).
   */
  private relax(arm: Arm, time: number, life: number) {
    const side = arm.side
    for (let j = 1; j < ROD_SEGMENTS; j++) {
      const f = j / ROD_SEGMENTS, taper = 1 - 0.65 * f
      const wave = Math.sin(1.7 * time - 7.5 * f + arm.phase)
      arm.oral[j] = 0.03 * (1 - f) - (f > 0.72 ? 0.2 * smooth((f - 0.72) / 0.2) : 0) + 0.055 * life * taper * Math.cos(1.7 * time - 7.5 * f + arm.phase)
      arm.lateral[j] = (f < 0.35 ? 0.04 : f < 0.7 ? -0.05 : 0.07) * side + 0.11 * life * taper * wave
    }
  }

  private arms(u: Octopus, run: Runtime, dt: number) {
    const moving = run.velocity.length() > 0.03 || Math.abs(u.turn) > 0.08
    const commanded = Math.abs(run.forward) + Math.abs(run.right) + Math.abs(run.steer) > 0.05
    run.idle = commanded || moving || run.grab !== 'none' ? 0 : run.idle + dt
    const idle = run.idle > 1.2
    // Idle life: now and then one arm lets go and reaches somewhere close by.
    if (idle && u.mode === 'crawl') {
      run.explore += dt
      if (run.explore > 2.1) {
        run.explore = 0.001
        const order = [5, 2, 7, 0, 3, 6, 1, 4], arm = run.arms[order[run.explored++ % order.length]]
        if (arm.role === 'plant' && !run.grabbers.includes(arm.index)) { arm.role = 'peel'; arm.time = 0; arm.rod.sync() }
      }
    } else run.explore = 0
    if (u.mode === 'crawl') this.recruit(u, run)
    const life = idle ? 1 : 0.6 + 0.4 * clamp(run.velocity.length() / OCTOPUS_LIMITS.speed, 0, 1)
    for (const arm of run.arms) {
      arm.time += dt
      const rod = arm.rod
      this.relax(arm, run.time, life)
      rod.aimStrength = 0
      if (!run.grabbers.includes(arm.index)) rod.wrapRadius = 0
      switch (arm.role) {
        case 'plant': this.plant(u, run, arm, dt); break
        case 'peel': this.peel(arm, dt); break
        case 'recover': this.recover(u, run, arm, dt); break
        case 'reach': case 'wrap': this.reach(u, run, arm, dt); break
        case 'hold': this.hold(u, run, arm, dt); break
        case 'free': this.coil(arm, run.time, dt); break
      }
      this.shape(arm, dt)
      // Object holds ride on the ball.
      for (let i = 0; i < ARM_POINTS; i++) if (rod.held[i] === OBJECT) {
        const k = i * 3
        rod.anchor[k] = u.ball.x + arm.offset[k]; rod.anchor[k + 1] = u.ball.y + arm.offset[k + 1]; rod.anchor[k + 2] = u.ball.z + arm.offset[k + 2]
      }
      armRoot(u, arm.index, scratch.root, scratch.out, scratch.dorsal)
      rod.step(dt, scratch.root, scratch.out, scratch.dorsal, 0)
      this.seals(arm, dt)
    }
  }

  /**
   * Which holding arms let go now: those carried to the end of their elongation range or swung far round by a turn,
   * most urgent first, never so many that fewer than four keep hold, and never beside an arm already letting go.
   */
  private recruit(u: Octopus, run: Runtime) {
    const busy = run.arms.filter((a) => a.role !== 'plant').length
    const holding = run.arms.filter((a) => a.role === 'plant' && this.firstHold(a) >= 0).length
    const candidates: { arm: Arm; urgency: number }[] = []
    for (const arm of run.arms) {
      if (arm.role !== 'plant' || run.grabbers.includes(arm.index)) continue
      const hold = this.firstHold(arm)
      if (hold < 0) { candidates.push({ arm, urgency: 2 }); continue }
      const need = this.need(arm, hold)
      armRoot(u, arm.index, scratch.root, scratch.out, scratch.dorsal)
      const k = hold * 3, hx = arm.rod.position[k] - scratch.root.x, hz = arm.rod.position[k + 2] - scratch.root.z
      const swing = Math.acos(clamp((hx * scratch.out.x + hz * scratch.out.z) / (Math.hypot(hx, hz) * Math.hypot(scratch.out.x, scratch.out.z) || 1), -1, 1))
      const urgency = Math.max((need - (ELONGATION.longest - 0.05)) * 4, (ELONGATION.shortest + 0.08 - need) * 4, swing - 1.15)
      if (urgency > 0) candidates.push({ arm, urgency })
    }
    candidates.sort((a, b) => b.urgency - a.urgency || a.arm.index - b.arm.index)
    let letting = busy, kept = holding
    for (const { arm } of candidates) {
      if (letting >= 4 || kept <= 4 && this.firstHold(arm) >= 0) break
      if (arm.neighbours.some((n) => run.arms[n].role === 'peel')) continue
      arm.role = 'peel'
      arm.time = 0
      arm.rod.sync()
      letting++
      if (this.firstHold(arm) >= 0) kept--
    }
  }

  /** The elongation a holding arm needs to span from its root to its first hold. */
  private need(arm: Arm, hold: number) {
    const p = arm.rod.position, k = hold * 3
    const span = Math.hypot(p[k] - p[3], p[k + 1] - p[4], p[k + 2] - p[5])
    return span / ((hold - 1) * arm.rod.rest)
  }

  /**
   * Holding: the proximal arm's muscle elongates or shortens to span from the root to the hold, so as the body moves
   * away the arm pushes it by lengthening, and thins as it does. Past its range the hold slips rather than tear.
   */
  private plant(u: Octopus, run: Runtime, arm: Arm, dt: number) {
    const rod = arm.rod, hold = this.firstHold(arm)
    if (hold < 0) {
      // Nothing held: settle what touches the floor.
      for (let i = particle(HOLD_FROM); i < ARM_POINTS; i++) if (rod.contact[i] && !rod.held[i]) rod.hold(i)
      this.ease(rod, 1, dt)
      return
    }
    let need = this.need(arm, hold)
    if (need > ELONGATION.slip) {
      // A sucker slip: the whole hold slides toward the root, at most three centimetres a step, until back within range.
      const k = hold * 3, p = rod.position
      const dx = p[3] - rod.anchor[k], dz = p[5] - rod.anchor[k + 2], d = Math.hypot(dx, dz) || 1
      const slide = Math.min(0.03, (need - ELONGATION.slip) * (hold - 1) * rod.rest) / d
      for (let i = hold; i < ARM_POINTS; i++) if (rod.held[i]) {
        const m = i * 3
        rod.anchor[m] += dx * slide
        rod.anchor[m + 2] += dz * slide
      }
      run.slips++
      need = ELONGATION.slip
    }
    // The muscle always spans what it holds with a little slack, so the rod is never stretched between two fixed ends
    // and curves into its hold rather than meeting it at an angle.
    const target = clamp(need * 1.06, ELONGATION.shortest, 1.6)
    for (let s = 1; s < ROD_SEGMENTS; s++) {
      const value = s < hold ? target : 1
      rod.stretch[s] = s < hold && value > rod.stretch[s] ? value : rod.stretch[s] + (value - rod.stretch[s]) * (1 - Math.exp(-dt / 0.06))
    }
    // The held stretch keeps still; the free end beyond it curls and drifts.
    // A few suckers past the first take hold too; the last third of the arm stays free to curl and drift.
    for (let i = hold; i < Math.min(hold + 4, particle(0.72)); i++) if (!rod.held[i] && rod.contact[i]) rod.hold(i)
  }

  /** Letting go: suckers release from the tip back toward the base, and the freed end curls back as it lifts. */
  private peel(arm: Arm, dt: number) {
    const rod = arm.rod
    let last = -1
    for (let i = ARM_POINTS - 1; i >= 0; i--) if (rod.held[i]) { last = i; break }
    if (last >= 0 && arm.time >= 0.025) { rod.held[last] = FREE; arm.time = 0 }
    for (let j = 1; j < ROD_SEGMENTS; j++) if (j >= last) arm.oral[j] -= 0.12
    // Behind the remaining holds the muscle keeps the length it has, so nothing is left in tension to snap free.
    rod.sync()
    if (last < 0) { arm.role = 'recover'; arm.time = 0 }
  }

  /** Recovering: shortened and thickened, drawn in toward the body, then reaching out again. */
  private recover(u: Octopus, run: Runtime, arm: Arm, dt: number) {
    const rod = arm.rod
    this.ease(rod, 0.8, dt, 0.3)
    for (let j = 1; j < ROD_SEGMENTS; j++) {
      const f = j / ROD_SEGMENTS
      arm.oral[j] -= 0.07 * smooth((f - 0.3) / 0.4)
    }
    if (arm.time > 0.2) this.beginReach(u, run, arm)
  }

  /**
   * Reaching: the bend's place along the arm comes from the foundation's force-driven bend dynamics. Behind the bend
   * the arm straightens toward its target; ahead of it the arm is still rolled up. Suckers that touch the floor near
   * the target take hold as the arm unrolls; for Grab, those that touch the ball hold it and the end wraps round.
   */
  private reach(u: Octopus, run: Runtime, arm: Arm, dt: number) {
    const rod = arm.rod
    if (arm.time < 0) { this.ease(rod, 0.85, dt); return }
    const grab = run.grabbers.includes(arm.index) && run.grab !== 'gesture'
    if (grab) arm.target.set(u.ball.x, u.ball.y, u.ball.z)
    arm.bend.step(dt)
    // The force-driven bend coasts after its muscle stops at 70% (the model's withdrawal); 85% counts as arrived.
    const front = clamp(arm.bend.position / (arm.bend.settings.length * 0.85), 0, 1)
    this.ease(rod, grab ? 1.05 : 1.06, dt)
    for (let j = 1; j < ROD_SEGMENTS; j++) {
      const f = j / ROD_SEGMENTS
      if (f <= front) { arm.oral[j] *= 0.3; arm.lateral[j] *= 0.3 }
      else arm.oral[j] = -0.2 * smooth((f - front) / 0.28)
    }
    rod.aim.copy(arm.target)
    if (grab) {
      // Aim beside the ball on this arm's side, then wrap round it.
      armRoot(u, arm.index, scratch.root, scratch.out, scratch.dorsal)
      const tx = arm.target.x - scratch.root.x, tz = arm.target.z - scratch.root.z, l = Math.hypot(tx, tz) || 1
      const sx = -tz / l * arm.side * (BALL_RADIUS + 0.03), sz = tx / l * arm.side * (BALL_RADIUS + 0.03)
      rod.aim.set(arm.target.x + sx, arm.target.y, arm.target.z + sz)
      rod.wrapCentre.set(u.ball.x, u.ball.y, u.ball.z)
      rod.wrapRadius = front > 0.55 ? BALL_RADIUS + 0.02 : 0
      rod.wrapFrom = particle(0.5)
    }
    rod.aimUntil = Math.max(2, Math.floor(front * ROD_SEGMENTS))
    rod.aimStrength = 0.14
    // Holds form where the unrolled arm touches down near its target, or on the ball.
    if (front > 0.5) for (let i = particle(HOLD_FROM); i <= Math.min(ROD_SEGMENTS, particle(front) + 1); i++) {
      if (rod.held[i]) continue
      const k = i * 3, p = rod.position
      if (grab) {
        const r = surfaceRadius(rod.arm, i / ROD_SEGMENTS)
        if (Math.hypot(p[k] - u.ball.x, p[k + 1] - u.ball.y, p[k + 2] - u.ball.z) < BALL_RADIUS + r + 0.015) {
          rod.hold(i, OBJECT)
          arm.offset[k] = p[k] - u.ball.x; arm.offset[k + 1] = p[k + 1] - u.ball.y; arm.offset[k + 2] = p[k + 2] - u.ball.z
        }
      } else if (rod.contact[i] && Math.hypot(p[k] - arm.target.x, p[k + 2] - arm.target.z) < 0.08) rod.hold(i)
    }
    if (!grab && (front >= 1 || arm.time > 1.2) && arm.role === 'reach' && !(run.grab === 'gesture' && run.grabbers.includes(arm.index))) {
      for (let i = particle(HOLD_FROM); i < ARM_POINTS; i++) if (rod.contact[i] && !rod.held[i]) rod.hold(i)
      arm.role = 'plant'
      arm.time = 0
    }
  }

  /** Holding the ball: wrapped round it and carried; the rest of the arm follows softly. */
  private hold(u: Octopus, run: Runtime, arm: Arm, dt: number) {
    const rod = arm.rod
    this.ease(rod, 1, dt)
    rod.wrapCentre.set(u.ball.x, u.ball.y, u.ball.z)
    rod.wrapRadius = BALL_RADIUS + 0.02
    rod.wrapFrom = particle(0.5)
  }

  /** Curl: shortened and coiled back over itself, swaying a little. */
  private coil(arm: Arm, time: number, dt: number) {
    const rod = arm.rod
    for (let i = 0; i < ARM_POINTS; i++) rod.held[i] = FREE
    this.ease(rod, 0.82, dt)
    const sway = 0.04 * Math.sin(1.1 * time + arm.phase)
    for (let j = 1; j < ROD_SEGMENTS; j++) {
      const f = j / ROD_SEGMENTS
      arm.oral[j] = -(0.08 + 0.42 * smooth((f - 0.1) / 0.5)) + sway * (1 - f)
      arm.lateral[j] = 0.05 * arm.side * f
    }
  }

  /** Ease the rod's joint targets toward the controller's, at a muscle's finite rate. */
  private shape(arm: Arm, dt: number) {
    const k = 1 - Math.exp(-dt / 0.09), rod = arm.rod
    for (let j = 1; j < ROD_SEGMENTS; j++) {
      rod.bendOral[j] += (arm.oral[j] - rod.bendOral[j]) * k
      rod.bendSide[j] += (arm.lateral[j] - rod.bendSide[j]) * k
    }
  }

  /** Ease every segment's elongation toward a value (a muscle's finite rate). */
  private ease(rod: ArmRod, value: number, dt: number, seconds = 0.15) {
    const k = 1 - Math.exp(-dt / seconds)
    for (let s = 1; s < ROD_SEGMENTS; s++) rod.stretch[s] += (value - rod.stretch[s]) * k
  }

  /** Seals form over the profile's seal time where a sucker holds, and release over its release time. */
  private seals(arm: Arm, dt: number) {
    const suction = PROFILE.suction
    for (let i = 0; i < ARM_POINTS; i++)
      arm.seal[i] = arm.rod.held[i] ? Math.min(1, arm.seal[i] + dt / suction.sealTime) : Math.max(0, arm.seal[i] - dt / suction.releaseTime)
  }

  private ballStep(u: Octopus, run: Runtime, dt: number) {
    const ball = u.ball
    if (ball.held) return
    run.ballVy -= 9.81 * dt
    ball.y += run.ballVy * dt
    if (ball.y <= BALL_RADIUS) {
      ball.y = BALL_RADIUS
      if (run.ballVy < -0.4) this.emit({ unit: 0, kind: 'bump', strength: clamp(-run.ballVy / 3, 0, 1), audio: { speed: -run.ballVy } }, u)
      run.ballVy = 0
      if (Math.hypot(ball.x - u.den[0], ball.z - u.den[1]) < DEN_RADIUS) {
        run.route++
        const [x, z] = BALL_ROUTE[run.route % BALL_ROUTE.length]
        Object.assign(ball, { x, z, y: BALL_RADIUS + 0.4 })
        if (!u.showing) {
          u.score++
          this.events.push({ unit: 0, kind: 'score', text: `Ball home · ${u.score} so far` })
        }
      }
    }
    // The body pushes a loose ball aside instead of passing through it.
    const dx = ball.x - u.x, dz = ball.z - u.z, d = Math.hypot(dx, dz), clear = 0.26 + BALL_RADIUS
    if (d < clear && ball.y < u.y + 0.2) {
      const k = d > 1e-6 ? (clear - d) / d : 0
      ball.x += dx * k
      ball.z += dz * k
    }
    ball.x = clamp(ball.x, -OCTOPUS_LIMITS.x - 0.6, OCTOPUS_LIMITS.x + 0.6)
    ball.z = clamp(ball.z, -OCTOPUS_LIMITS.z - 0.6, OCTOPUS_LIMITS.z + 0.6)
  }

  /** Copy rod positions, cup seals and roles into the presentation state. */
  private publish(u: Octopus, run: Runtime) {
    u.mantle = run.mantle.fraction
    for (const arm of run.arms) {
      u.roles[arm.index] = arm.role
      const p = arm.rod.position
      for (let i = 0; i < ARM_POINTS; i++) {
        const k = pointAt(arm.index, i)
        u.arms[k] = p[i * 3]; u.arms[k + 1] = p[i * 3 + 1]; u.arms[k + 2] = p[i * 3 + 2]
      }
      const cups = PROFILE.arms[arm.index].cups
      for (let c = 0; c < OCTOPUS_CUPS; c++) u.cups[arm.index * OCTOPUS_CUPS + c] = arm.seal[particle(cups[c].fraction)]
    }
  }
}

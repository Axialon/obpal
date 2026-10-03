/**
 * The octopus (/sim/octopus/): Cove, a soft eight-arm robot on a dry studio floor, driven by one phone. Its arms are the
 * continuum foundation's (src/sim/continuum): four piecewise-constant-curvature sections each, within the profile's
 * bend and strain limits, moved through the routed tendon elasticity.
 *
 * Crawling plants each arm's contact site on the floor and holds it there while the body moves. An arm re-plants only
 * when the travel has stretched or displaced it too far, and only while at least four other arms stay planted (the
 * plan's support policy), so the stepping follows contact and direction rather than a fixed rhythm. Planted arms are
 * placed by a bounded damped least-squares solve (../continuum/solve.ts); free arms (curl) follow the tendon layer.
 * Grab wraps the front pair round the ball; Pulse squeezes the mantle through the jet cycle and pushes off by arm
 * elongation, since there is no water here; Curl rolls the arms up and the body settles on them.
 *
 * This is kinematic placement with elastic smoothing: there is no rod dynamics, friction or contact-force solve, and
 * dimensions, speeds and timings are simulation choices, not measured hardware. Logic is pure (three.js maths only)
 * and advances in fixed 120 Hz ticks, so 30, 60 and 120 Hz screens replay alike.
 */
import { Controller, PadButton } from '@obpal/core'
import { Quaternion, Vector3 } from 'three'
import { ArmKinematics } from '../continuum/kinematics'
import { JetMantle, REFERENCE_JET, type JetSettings } from '../continuum/primitives'
import { bounded, straight, type ContinuumArm, type Shape } from '../continuum/profile'
import { ArmSolver, surfaceRadius } from '../continuum/solve'
import { ArmTendons, ContinuumClock, route, unroute } from '../continuum/tendons'
import { action, drive, Machine, timestep } from './common'
import { approach, clamp, DragStick, wrapPi } from './input'
import type { DeviceEvent, DeviceInput, DeviceSpec } from './types'
import {
  OCTOPUS_ARMS, OCTOPUS_CUPS, OCTOPUS_PROFILE as PROFILE, OCTOPUS_SECTIONS, SHAPE_STRIDE, profileYaw, shapeAt,
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
  teaches: 'One stick and a few buttons coordinate eight continuum arms',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left stick crawls and turns · A grabs or lets go · B curls · X pulses · Y stops',
    'face.trackpad': 'Drag or tilt to crawl · tap grabs or lets go · Curl, Pulse and Stop in the tray',
  },
  tray: [
    { id: 'grab', label: 'Grab', type: 'button', icon: 'grip-close' },
    { id: 'curl', label: 'Curl', type: 'button', icon: 'bend' },
    { id: 'pulse', label: 'Pulse', type: 'button', icon: 'speed' },
    { id: 'stop', label: 'Stop', type: 'button', tone: 'stop' },
  ],
  buttons: { 'media:playpause': 'tray:grab', 'key:Space': 'tray:grab', 'key:KeyC': 'tray:curl', 'key:KeyP': 'tray:pulse' },
}

/** Body and stepping choices (metres, seconds). Design values for this studio, not hardware measurements. */
export const OCTOPUS_LIMITS = { x: 3.1, z: 2.1, crawlHeight: 0.2, speed: 0.3, turn: 0.6 }
/**
 * The planted contact site's band, as a radius from the body's centre. The body stops `edge` inside it until an arm
 * there re-plants, and across that working band the solver places the site within a centimetre (tests/octopus.test.ts).
 */
export const REACH = { home: 0.64, near: 0.57, far: 0.72, edge: 0.015 }
/** Seconds of travel a step looks ahead, and how far ahead that may put it. */
const LEAD = 0.25, LEAD_MAX = 0.06
/** The planted material point, inside the third section: cups from here to the tip carry the arm's contact. */
export const CONTACT = 0.55
const STEP_MOVING = 0.075, STEP_IDLE = 0.045
export const BALL_RADIUS = 0.09
const DEN_RADIUS = 0.3
const BALL_ROUTE = [[0.15, -0.55], [-1.6, -0.9], [1.5, -1.2], [-0.9, -1.5], [1.8, 0.4]] as const
const START = { x: 0, z: 0.9 }
const DEN: [number, number] = [-1.7, 0.5]
/** Underside of the oral web below the collar: what the body rests on when nothing else touches. */
const UNDERSIDE = 0.05
/** Seconds without a holder before the octopus starts showing itself. */
export const SHOWCASE_AFTER = 4

/** The Renda 2015 cycle shape, scaled to Cove's mantle cavity (design values): four litres, a 2 cm siphon. */
export const COVE_JET: JetSettings = { ...REFERENCE_JET, period: 0.9, contraction: 0.3, capacity: 4e-3, nozzle: Math.PI * 0.02 ** 2, thrustCap: 45 }

const smooth = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x) }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** A small deterministic sequence for idle exploration (no wall clock, no Math.random). */
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s) }

type GrabPhase = 'none' | 'reach' | 'wrap' | 'hold' | 'gesture'

/** The front pair: the two arms whose roots point most nearly forward (the profile's +z). */
export const FRONT: readonly number[] = PROFILE.arms
  .map((arm, index) => ({ index, off: Math.abs(Math.atan2(arm.position.x, arm.position.z)) }))
  .sort((a, b) => a.off - b.off || a.index - b.index).slice(0, 2).map((a) => a.index)

interface Arm {
  index: number
  profile: ContinuumArm
  /** Root azimuth in the profile frame, and which side of the body it is on (-1 or +1). */
  angle: number
  side: number
  neighbours: [number, number]
  solver: ArmSolver
  tendons: ArmTendons
  kinematics: ArmKinematics
  role: ArmRole
  /** Placed by the solver (1) or by the tendon layer alone (0), eased between. */
  blend: number
  anchor: Vector3
  from: Vector3
  to: Vector3
  progress: number
  duration: number
  lift: number
  shown: Shape[]
  free: Shape[]
  /** Idle exploration: a small body-frame offset from home that this arm next steps to. */
  jitter: Vector3
  /** Its contact cups touch the floor: a planted arm then bears weight. */
  touching: boolean
  start: [Vector3, Vector3]
}

interface Runtime {
  arms: Arm[]
  clock: ContinuumClock
  mantle: JetMantle
  drag: DragStick
  time: number
  ticks: number
  vy: number
  surge: number
  power: number
  steer: number
  grab: GrabPhase
  grabTime: number
  idle: number
  explore: number
  explored: number
  /** Stop latches until the drive returns to neutral and then moves, or another command arrives. */
  rearm: boolean
  nobody: number
  show: { phase: 'seek' | 'carry' | 'curl' | 'pulse'; time: number }
  ballVy: number
  route: number
  pending: { grab: boolean; curl: boolean; pulse: boolean; stop: boolean }
}

const scratch = { a: new Vector3(), b: new Vector3(), c: new Vector3(), d: new Vector3(), q: new Quaternion(), inverse: new Quaternion(), up: new Vector3(0, 1, 0) }

/** Hold the tendon layer exactly at a pose, at rest. */
function holdTendons(tendons: ArmTendons, shapes: readonly Shape[]) {
  tendons.state.forEach((state, i) => {
    const section = tendons.arm.sections[i]
    route(section, shapes[i], state.targets)
    state.springs.forEach((spring, j) => { spring.x = state.targets[j]; spring.v = 0 })
    state.strokes.splice(0, 4, ...state.targets)
    state.torsion.x = shapes[i].twist
    state.torsion.v = 0
    unroute(section, state.strokes, shapes[i].twist, tendons.pose[i])
  })
}

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
      shapes: new Array(OCTOPUS_ARMS * OCTOPUS_SECTIONS * SHAPE_STRIDE).fill(0),
      cups: new Array(OCTOPUS_ARMS * OCTOPUS_CUPS).fill(0),
      roles: new Array<ArmRole>(OCTOPUS_ARMS).fill('plant'),
      ball: { x: START.x + BALL_ROUTE[0][0], y: BALL_RADIUS, z: BALL_ROUTE[0][1], held: false },
      den: [...DEN], score: 0, actions: 0, showing: false,
    }
  }

  private runtime(): Runtime {
    const arms = PROFILE.arms.map((profile, index): Arm => ({
      index, profile,
      angle: Math.atan2(profile.position.x, profile.position.z),
      side: Math.sign(profile.position.x) || 1,
      neighbours: [0, 0],
      solver: new ArmSolver(profile, 2),
      tendons: new ArmTendons(PROFILE, profile),
      kinematics: new ArmKinematics(profile, 3),
      role: 'plant', blend: 1,
      anchor: new Vector3(), from: new Vector3(), to: new Vector3(), progress: 0, duration: 0.4, lift: 0,
      shown: profile.sections.map(straight), free: profile.sections.map(straight),
      jitter: new Vector3(), touching: true, start: [new Vector3(), new Vector3()],
    }))
    // Ring order by root azimuth gives each arm its two neighbours, across the back as well.
    const ring = [...arms].sort((a, b) => a.angle - b.angle)
    ring.forEach((arm, i) => { arm.neighbours = [ring[(i + ring.length - 1) % ring.length].index, ring[(i + 1) % ring.length].index] })
    return {
      arms, clock: new ContinuumClock(), mantle: new JetMantle(COVE_JET), drag: new DragStick(), time: 0, ticks: 0, vy: 0, surge: 0,
      power: 0, steer: 0, grab: 'none', grabTime: 0, idle: 0, explore: 0, explored: 0, rearm: false, nobody: 0,
      show: { phase: 'seek', time: 0 }, ballVy: 0, route: 0, pending: { grab: false, curl: false, pulse: false, stop: false },
    }
  }

  private pose(u: Octopus) {
    scratch.q.setFromAxisAngle(scratch.up, profileYaw(u.h))
    scratch.inverse.copy(scratch.q).invert()
  }
  private toBody(u: Octopus, world: Vector3, out: Vector3) {
    return out.set(world.x - u.x, world.y - u.y, world.z - u.z).applyQuaternion(scratch.inverse)
  }
  private toWorld(u: Octopus, body: Vector3, out: Vector3) {
    out.copy(body).applyQuaternion(scratch.q)
    return out.set(out.x + u.x, out.y + u.y, out.z + u.z)
  }
  /** An arm's home: its contact site's resting place on the floor, in the body frame. */
  private homeOf(u: Octopus, arm: Arm, out: Vector3) {
    return out.set(Math.sin(arm.angle) * REACH.home, -u.y, Math.cos(arm.angle) * REACH.home)
  }

  home(n: number) {
    if (n !== 0) return
    // Keep the state's own objects: views and snapshots hold references to them.
    const u = this.units[0], fresh = this.fresh()
    Object.assign(u, { ...fresh, shapes: u.shapes, cups: u.cups, roles: u.roles, ball: u.ball, den: u.den, score: u.score, actions: u.actions })
    Object.assign(u.ball, fresh.ball)
    u.cups.fill(0)
    const run = this.run[0] = this.runtime()
    this.pose(u)
    for (const arm of run.arms) {
      this.toWorld(u, this.homeOf(u, arm, scratch.a), arm.anchor)
      arm.anchor.y = 0
      this.plantGoals(u, arm)
      this.bias(arm, 0, false)
      for (let i = 0; i < 10; i++) arm.solver.solve(6)
      holdTendons(arm.tendons, arm.solver.shapes)
      arm.shown.forEach((s, i) => Object.assign(s, arm.solver.shapes[i]))
    }
    this.publish(u, run)
    for (const arm of run.arms) for (let c = 0; c < OCTOPUS_CUPS; c++) {
      const cup = arm.profile.cups[c]
      u.cups[arm.index * OCTOPUS_CUPS + c] = cup.fraction >= CONTACT - 0.02 ? 1 : 0
    }
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

  /** One frame's intention: presses become pending commands, the stick a power and a steer, held through its ticks. */
  private read(u: Octopus, run: Runtime, input: DeviceInput | null, dt: number) {
    const live = input && !input.quiet ? input : null
    run.nobody = input ? 0 : run.nobody + dt
    const showing = run.nobody > SHOWCASE_AFTER
    if (showing !== u.showing) {
      u.showing = showing
      if (showing) run.show = { phase: 'seek', time: 0 }
    }
    if (showing) { this.showcase(u, run, dt); return }
    const pad = live?.pad ?? null, pressed = live?.padPressed ?? 0
    const grab = !!live && action(live, 'grab')
    const curl = !!live && (live.presses.includes('curl') || !!(pressed & (1 << PadButton.B)))
    const pulse = !!live && (live.presses.includes('pulse') || !!(pressed & (1 << PadButton.X)))
    const stop = !!input && (input.presses.includes('stop') || !!((input.padPressed ?? 0) & (1 << PadButton.Y)))
    const [steer, power] = drive(live, run.drag)
    run.power = Number.isFinite(power) ? clamp(power, -1, 1) : 0
    run.steer = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0
    if (pad && Math.abs(run.power) < 0.02 && Math.abs(run.steer) < 0.02) { run.power = 0; run.steer = 0 }
    if (stop) { run.pending.stop = true; return }
    if (u.stopped) {
      const moving = Math.abs(run.power) > 0.05 || Math.abs(run.steer) > 0.05
      if (!moving) run.rearm = true
      if (grab || curl || pulse || (run.rearm && moving)) {
        u.stopped = false
        this.events.push({ unit: 0, kind: 'tick', text: 'Moving again' })
      }
      run.power = run.steer = 0
      return
    }
    run.pending.grab ||= grab
    run.pending.curl ||= curl
    run.pending.pulse ||= pulse
  }

  /** Nobody holds it: it seeks the ball, carries it to the ring, curls and pulses, without scoring or events. */
  private showcase(u: Octopus, run: Runtime, dt: number) {
    const show = run.show
    show.time += dt
    this.pose(u)
    const target = show.phase === 'carry' ? scratch.a.set(u.den[0], 0, u.den[1]) : scratch.a.set(u.ball.x, 0, u.ball.z)
    const body = this.toBody(u, target, scratch.b)
    const bearing = Math.atan2(body.x, body.z), distance = Math.hypot(body.x, body.z)
    run.steer = clamp(-bearing * 1.6, -1, 1) * (u.mode === 'crawl' ? 1 : 0)
    run.power = 0
    if (show.phase === 'seek') {
      run.power = Math.abs(bearing) < 0.6 ? clamp((distance - 0.62) * 1.4, 0, 0.8) : 0
      if (u.mode === 'curl') run.pending.curl = true
      else if (this.reachable(u, scratch.c) && distance < 0.75 && run.grab === 'none') run.pending.grab = true
      if (u.ball.held) show.phase = 'carry', show.time = 0
      if (show.time > 25) show.phase = 'curl', show.time = 0
    } else if (show.phase === 'carry') {
      // Head for the ring until the held ball, carried ahead of the body, is over it; then let go.
      const over = Math.hypot(u.ball.x - u.den[0], u.ball.z - u.den[1])
      run.power = Math.abs(bearing) < 0.6 ? clamp(over * 2, 0.2, 0.7) : 0
      if (over < DEN_RADIUS * 0.6 && u.ball.held) run.pending.grab = true
      if (!u.ball.held && run.grab === 'none') show.phase = 'curl', show.time = 0
      if (show.time > 25) { if (u.ball.held) run.pending.grab = true; show.phase = 'curl'; show.time = 0 }
    } else if (show.phase === 'curl') {
      if (show.time < 0.1 && u.mode === 'crawl') run.pending.curl = true
      if (show.time > 2.6 && u.mode === 'curl') run.pending.curl = true
      if (show.time > 4) show.phase = 'pulse', show.time = 0
    } else {
      run.power = 0.5
      if (show.time > 0.6 && show.time < 0.7) run.pending.pulse = true
      if (show.time > 2.5) show.phase = 'seek', show.time = 0
    }
  }

  /** The ball, in the body frame, if the front pair can take it from here. */
  private reachable(u: Octopus, out: Vector3) {
    this.toBody(u, scratch.d.set(u.ball.x, u.ball.y, u.ball.z), out)
    const across = Math.hypot(out.x, out.z)
    return out.z > 0.25 && across > 0.32 && across < 0.95 && Math.abs(Math.atan2(out.x, out.z)) < 0.95
  }

  private tick(u: Octopus, run: Runtime, dt: number) {
    run.time += dt
    run.ticks++
    this.pose(u)
    const pending = run.pending
    if (pending.stop) {
      pending.stop = pending.grab = pending.curl = pending.pulse = false
      if (!u.stopped) {
        u.stopped = true
        run.rearm = false
        u.v = u.turn = run.surge = 0
        for (const arm of run.arms) arm.tendons.freeze()
        this.emit({ unit: 0, kind: 'tick', text: 'Stopped' }, u)
      }
    }
    if (u.stopped) return
    if (pending.curl) { pending.curl = false; this.toggleCurl(u, run) }
    if (pending.grab) { pending.grab = false; this.toggleGrab(u, run) }
    if (pending.pulse) {
      pending.pulse = false
      if (run.mantle.pulse()) {
        if (u.mode === 'crawl') run.surge = 0.5
        u.actions++
        this.emit({ unit: 0, kind: 'tick', text: 'Pulse', audio: { action: 'pulse' } }, u)
      }
    }
    run.mantle.step(dt)
    this.moveBody(u, run, dt)
    this.pose(u)
    this.grabStep(u, run, dt)
    this.stepArms(u, run, dt)
    this.ballStep(u, run, dt)
  }

  private emit(event: DeviceEvent, u: Octopus) {
    if (!u.showing) this.events.push(event)
  }

  private toggleCurl(u: Octopus, run: Runtime) {
    u.actions++
    if (u.mode === 'curl') {
      u.mode = 'crawl'
      this.pose(u)
      for (const arm of run.arms) {
        arm.solver.seed(arm.shown)
        this.toWorld(u, this.homeOf(u, arm, scratch.a), arm.anchor)
        arm.anchor.y = 0
        arm.role = 'plant'
      }
      this.emit({ unit: 0, kind: 'tick', text: 'Uncurled' }, u)
      return
    }
    if (u.ball.held || run.grab !== 'none') this.release(u, run, false)
    u.mode = 'curl'
    for (const arm of run.arms) arm.role = 'free'
    this.emit({ unit: 0, kind: 'tick', text: 'Curled' }, u)
  }

  private toggleGrab(u: Octopus, run: Runtime) {
    if (u.mode !== 'crawl') return
    u.actions++
    if (run.grab === 'reach' || run.grab === 'wrap' || run.grab === 'hold') { this.release(u, run, true); return }
    if (run.grab === 'gesture') return
    const reachable = this.reachable(u, scratch.c)
    run.grab = reachable ? 'reach' : 'gesture'
    run.grabTime = 0
    for (const index of FRONT) {
      const arm = run.arms[index]
      arm.role = 'reach'
      arm.solver.pointAt(0.62, arm.start[0])
      arm.solver.pointAt(0.92, arm.start[1])
    }
    this.emit({ unit: 0, kind: 'tick', text: reachable ? 'Grabbing' : 'Reaching' }, u)
  }

  private release(u: Octopus, run: Runtime, say: boolean) {
    const held = u.ball.held
    u.ball.held = false
    run.ballVy = 0
    run.grab = 'none'
    this.pose(u)
    for (const index of FRONT) this.beginStep(u, run.arms[index], scratch.a.set(0, 0, 0))
    if (say) this.emit({ unit: 0, kind: 'tick', text: held ? 'Let go' : 'Grab cancelled' }, u)
  }

  /** The body moves only while it is carried: travel is kinematic, height follows support or falls onto the arms. */
  private moveBody(u: Octopus, run: Runtime, dt: number) {
    const limits = OCTOPUS_LIMITS
    // Bearing weight needs contact, not suction: a planted arm whose contact cups touch the floor supports the body.
    const planted = run.arms.filter((a) => a.role === 'plant' && a.touching).length
    const supported = u.mode === 'crawl' && planted >= PROFILE.support.minimumArms
    const crawling = u.mode === 'crawl'
    // The body goes only as fast as its planted arms allow: it slows as one is stretched or carried toward the edge
    // of the reach band, and waits there while that arm re-plants. Arms pull the body; they do not slide.
    let strain = 0, edge = -1
    for (const arm of run.arms) if (arm.role === 'plant') {
      strain = Math.max(strain, arm.solver.residual)
      const anchor = this.toBody(u, arm.anchor, scratch.a), radius = Math.hypot(anchor.x, anchor.z)
      edge = Math.max(edge, REACH.near + REACH.edge - radius, radius - REACH.far + REACH.edge)
    }
    const allowed = supported ? Math.min(clamp(1 - (strain - 0.01) / 0.025, 0.15, 1), clamp(-edge / 0.03, 0, 1)) : 0
    u.v = approach(u.v, crawling ? run.power * limits.speed * allowed : 0, 0.9, dt)
    u.turn = approach(u.turn, crawling ? -run.steer * limits.turn * allowed : 0, 2, dt)
    run.surge *= Math.exp(-dt / 0.35)
    if (!supported) run.surge = 0
    u.h = wrapPi(u.h + u.turn * dt)
    const speed = u.v + run.surge
    const x = u.x - Math.sin(u.h) * speed * dt, z = u.z - Math.cos(u.h) * speed * dt
    u.x = clamp(x, -limits.x, limits.x)
    u.z = clamp(z, -limits.z, limits.z)
    if ((x !== u.x || z !== u.z) && Math.abs(speed) > 0.15) {
      this.emit({ unit: 0, kind: 'bump', strength: 0.3, audio: { speed: Math.abs(speed) } }, u)
      u.v = 0
      run.surge = 0
    }
    // Planted arms carry the body at crawl height; otherwise it falls and rests on whatever touches the floor.
    if (supported) {
      const target = limits.crawlHeight + 0.012 * Math.min(1, Math.abs(speed) / limits.speed)
      run.vy += (60 * (target - u.y) - 2 * Math.sqrt(60) * run.vy) * dt
    } else run.vy -= 9.81 * dt
    u.y += run.vy * dt
    const ground = this.ground(run, supported)
    if (u.y < ground) {
      u.y = ground
      if (run.vy < 0) {
        if (run.vy < -0.6) this.emit({ unit: 0, kind: 'bump', strength: clamp(-run.vy / 2, 0, 1), audio: { speed: -run.vy } }, u)
        run.vy = 0
      }
    }
  }

  /** The collar height at which the body's underside or a free arm's surface meets the floor. */
  private ground(run: Runtime, supported: boolean) {
    let lowest = -UNDERSIDE
    if (!supported) for (const arm of run.arms) {
      if (arm.blend > 0.5 && arm.role !== 'free') continue
      const samples = arm.kinematics.update(arm.shown), per = arm.kinematics.samplesPerSection
      for (let i = 1; i < samples.length; i++) {
        const section = arm.shown[Math.min(OCTOPUS_SECTIONS - 1, Math.floor((i - 1) / per))]
        lowest = Math.min(lowest, samples[i].position.y - surfaceRadius(arm.profile, i / (samples.length - 1), section.strain))
      }
    }
    // A few millimetres of tolerance keep a resting body from creeping on its own contact.
    return -lowest - 0.003
  }

  private grabStep(u: Octopus, run: Runtime, dt: number) {
    if (run.grab === 'none') return
    run.grabTime += dt
    if (run.grab === 'gesture') {
      if (run.grabTime > 1.1) {
        run.grab = 'none'
        for (const index of FRONT) this.beginStep(u, run.arms[index], scratch.a.set(0, 0, 0))
      }
      return
    }
    if (!u.ball.held && !this.reachable(u, scratch.c) && run.grab === 'reach' && run.grabTime > 0.2) {
      // The ball went out of reach mid-grab: give up rather than stretch past the profile's limits.
      this.release(u, run, true)
      return
    }
    if (run.grab === 'reach' && run.grabTime > 0.55) { run.grab = 'wrap'; run.grabTime = 0 }
    else if (run.grab === 'wrap' && run.grabTime > 0.3) {
      run.grab = 'hold'
      run.grabTime = 0
      u.ball.held = true
      this.emit({ unit: 0, kind: 'tick', text: 'Holding the ball', audio: { action: 'grab' } }, u)
    }
    const role: ArmRole = run.grab === 'wrap' ? 'wrap' : run.grab === 'hold' ? 'hold' : 'reach'
    for (const index of FRONT) run.arms[index].role = role
    if (u.ball.held) {
      // Carried ahead of the mouth, between the front pair.
      this.toWorld(u, scratch.a.set(0, -u.y + 0.2, 0.46), scratch.b)
      const k = 1 - Math.exp(-dt / 0.18)
      u.ball.x += (scratch.b.x - u.ball.x) * k
      u.ball.y += (scratch.b.y - u.ball.y) * k
      u.ball.z += (scratch.b.z - u.ball.z) * k
    }
  }

  /** Begin re-planting an arm at its home plus `offset` (body frame), looking ahead along the travel. */
  private beginStep(u: Octopus, arm: Arm, offset: Vector3) {
    const run = this.run[0]
    arm.solver.pointAt(CONTACT, scratch.c)
    this.toWorld(u, scratch.c, arm.from)
    arm.from.y = Math.max(0, arm.from.y - surfaceRadius(arm.profile, CONTACT))
    const target = this.ahead(u, run, arm, LEAD + 0.5 * arm.duration, scratch.c).add(offset)
    const across = Math.hypot(target.x, target.z), radius = clamp(across, REACH.near + 0.02, REACH.far - 0.02)
    if (across > 1e-6) { target.x *= radius / across; target.z *= radius / across }
    this.toWorld(u, target, arm.to)
    arm.to.y = 0
    arm.to.x = clamp(arm.to.x, -OCTOPUS_LIMITS.x - 0.75, OCTOPUS_LIMITS.x + 0.75)
    arm.to.z = clamp(arm.to.z, -OCTOPUS_LIMITS.z - 0.75, OCTOPUS_LIMITS.z + 0.75)
    const distance = arm.from.distanceTo(arm.to)
    arm.duration = clamp(0.36 - Math.abs(u.v) * 0.5, 0.22, 0.36) + distance * 0.2
    arm.lift = 0.05 + 0.18 * Math.min(0.5, distance)
    arm.progress = 0
    arm.role = 'step'
  }

  /** Where an arm's home will be after `seconds` of the current travel and turn, in today's body frame. */
  private ahead(u: Octopus, run: Runtime, arm: Arm, seconds: number, out: Vector3) {
    const home = this.homeOf(u, arm, out), turn = clamp(u.turn * seconds, -0.3, 0.3)
    const cos = Math.cos(turn), sin = Math.sin(turn), x = home.x, z = home.z
    out.x = cos * x + sin * z
    out.z = -sin * x + cos * z + clamp((u.v + run.surge) * seconds, -LEAD_MAX, LEAD_MAX)
    return out
  }

  /** Goals for a planted or stepping arm: the contact site on its anchor, resting on the floor. */
  private plantGoals(u: Octopus, arm: Arm) {
    const solver = arm.solver, goal = solver.goals[0]
    let at = arm.anchor
    if (arm.role === 'step') {
      const s = smooth(arm.progress)
      at = scratch.c.lerpVectors(arm.from, arm.to, s)
      at.y += arm.lift * Math.sin(Math.PI * clamp(arm.progress, 0, 1))
    }
    goal.fraction = CONTACT
    goal.weight = 400
    goal.active = true
    this.toBody(u, scratch.d.copy(at), goal.target)
    goal.target.y += surfaceRadius(arm.profile, CONTACT) + 0.006
    solver.goals[1].active = false
    solver.floorNormal.set(0, 1, 0)
    solver.floorOffset = -u.y
  }

  /**
   * The shape the solver relaxes toward where goals and the floor leave freedom: a raised then descending root, a gentle
   * S across the floor (mirrored left and right) and a curled tip that slowly explores. Radians across each section.
   * A travelling wave runs from root to tip, each section a fixed phase behind the last and each arm offset from its
   * neighbours; its bend tapers toward the tip, livelier while the body moves or the arm swings. A planted arm's floor
   * section keeps no wave, so what lies on the floor stays still while the solver holds the contact.
   */
  private bias(arm: Arm, time: number, idle: boolean, moving = 0) {
    const phase = arm.index * 1.37, life = idle ? 1 : 0.6, side = arm.side, s = arm.solver
    const lively = arm.role === 'step' ? 1.8 : 1 + moving, planted = arm.role === 'plant'
    const wave = (i: number, amplitude: number) => amplitude * lively * Math.sin(1.6 * time - 1.2 * i + phase)
    s.relax(0, 0.2 + wave(0, 0.06), 0.12 * side + wave(0.4, 0.1), 0, 0.02)
    s.relax(1, 0.1 + wave(1, 0.05), -0.42 * side + wave(1.4, 0.08), 0, 0.02)
    s.relax(2, -0.1 + (planted ? 0 : wave(2, 0.04)), 0.5 * side + (planted ? 0 : wave(2.4, 0.06)), 0, 0.02)
    s.relax(3, -0.85 + 0.3 * life * Math.sin(0.8 * time + phase) + wave(3, 0.03),
      (0.45 + 0.35 * life * Math.sin(0.55 * time + 1.7 * phase)) * side + wave(3.4, 0.04), 0, 0.4)
  }

  private wrapGoals(u: Octopus, run: Runtime, arm: Arm) {
    const solver = arm.solver, ball = this.toBody(u, scratch.d.set(u.ball.x, u.ball.y, u.ball.z), scratch.a)
    const radius = BALL_RADIUS + 0.024
    // Toward the ball from the body, and across it on this arm's own side.
    const forward = scratch.b.set(ball.x, 0, ball.z)
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1)
    forward.normalize()
    const across = scratch.c.set(forward.z, 0, -forward.x).multiplyScalar(-arm.side)
    const a = solver.goals[0], b = solver.goals[1]
    a.fraction = 0.62
    a.target.copy(ball).addScaledVector(across, radius * 0.96).addScaledVector(forward, -radius * 0.28)
    b.fraction = 0.92
    b.target.copy(ball).addScaledVector(forward, radius * 0.9).addScaledVector(across, -radius * 0.42)
    b.target.y -= radius * 0.15
    a.weight = 300
    b.weight = 120
    a.active = b.active = true
    if (run.grab === 'reach') {
      // Arc over from where the arm was, the bend leading toward the ball.
      const t = smooth(run.grabTime / 0.55), lift = 0.14 * Math.sin(Math.PI * t)
      a.target.lerpVectors(arm.start[0], a.target, t)
      a.target.y += lift
      b.target.lerpVectors(arm.start[1], b.target, t)
      b.target.y += lift * 1.4
    }
    solver.floorNormal.set(0, 1, 0)
    solver.floorOffset = -u.y
    solver.relax(3, -0.9, 0, 0, 0.05)
  }

  private gestureGoals(u: Octopus, run: Runtime, arm: Arm) {
    const solver = arm.solver, t = smooth(run.grabTime / 0.45) * (1 - smooth((run.grabTime - 0.75) / 0.35))
    const a = solver.goals[0], b = solver.goals[1]
    a.active = false
    b.fraction = 1
    b.weight = 150 * t + 1
    b.active = true
    b.target.set(arm.side * 0.3, 0.22, 0.86)
    b.target.lerpVectors(arm.start[1], b.target, t)
    solver.floorOffset = -u.y
  }

  /** Curl: proximal shortening, then the arm rolls up into a spiral that ends near the mantle, breathing slightly. */
  private curlShapes(arm: Arm, time: number) {
    const turn = arm.index % 2 ? 1 : -1, sway = 0.06 * Math.sin(1.1 * time + arm.index * 1.37)
    arm.profile.sections.forEach((section, i) => {
      const angle = [-0.15, -1.0, -1.3, -1.3][i] + sway * (1 - i / 4), across = [0, 0.12, 0.2, 0.25][i] * turn
      Object.assign(arm.free[i], { kx: angle / section.length, ky: across / section.length, strain: -0.08, twist: 0 })
      bounded(section, arm.free[i], arm.free[i])
    })
  }

  private stepArms(u: Octopus, run: Runtime, dt: number) {
    const moving = Math.abs(u.v) + Math.abs(run.surge) > 0.03 || Math.abs(u.turn) > 0.08
    const commanded = Math.abs(run.power) > 0.05 || Math.abs(run.steer) > 0.05
    run.idle = commanded || moving || run.grab !== 'none' ? 0 : run.idle + dt
    const idle = run.idle > 1.5
    const front = FRONT
    // Choose which planted arms re-plant this tick: the most displaced first, never a neighbour of a stepping arm,
    // and never so many that fewer than four remain planted.
    if (u.mode === 'crawl') {
      if (idle) {
        run.explore += dt
        if (run.explore > 2.4) {
          run.explore = 0
          const order = [5, 2, 7, 0, 3, 6, 1, 4], arm = run.arms[order[run.explored++ % order.length]]
          if (!(front.includes(arm.index) && run.grab !== 'none')) {
            const k = run.explored * 7.31
            arm.jitter.set((hash(k) - 0.5) * 0.16, 0, (hash(k + 1) - 0.5) * 0.16)
          }
        }
      } else run.explore = 0
      const crawlers = run.arms.filter((a) => a.role === 'plant' || a.role === 'step')
      let stepping = crawlers.filter((a) => a.role === 'step').length
      const limit = Math.max(0, crawlers.length - PROFILE.support.minimumArms), trigger = idle ? STEP_IDLE : STEP_MOVING
      const candidates: { arm: Arm; urgency: number }[] = []
      for (const arm of crawlers) {
        if (arm.role !== 'plant') continue
        const anchor = this.toBody(u, arm.anchor, scratch.a)
        const want = this.ahead(u, run, arm, LEAD, scratch.b).add(arm.jitter)
        const off = Math.hypot(anchor.x - want.x, anchor.z - want.z), radius = Math.hypot(anchor.x, anchor.z)
        // Nearing the edge of the reach band is the most urgent of all: the body slows there until this arm re-plants.
        const edge = Math.max(REACH.near + REACH.edge - radius, radius - REACH.far + REACH.edge)
        const urgency = Math.max(off - trigger, arm.solver.residual - 0.02, edge > -0.03 ? 1 + edge : -1)
        if (urgency > 0) candidates.push({ arm, urgency })
      }
      candidates.sort((a, b) => b.urgency - a.urgency || a.arm.index - b.arm.index)
      let started = 0
      for (const { arm } of candidates) {
        if (stepping >= limit || started >= (idle ? 1 : 3)) break
        if (arm.neighbours.some((n) => run.arms[n].role === 'step')) continue
        this.beginStep(u, arm, arm.jitter)
        arm.jitter.set(0, 0, 0)
        stepping++
        started++
      }
    }
    const strain = run.surge > 0.05 ? 0.1 : 0
    for (const arm of run.arms) {
      const placed = arm.role !== 'free'
      if (arm.role === 'step') {
        arm.progress += dt / arm.duration
        if (arm.progress >= 1) { arm.role = 'plant'; arm.anchor.copy(arm.to) }
      }
      // Planted arms move slowly relative to the body, so they are solved on alternate ticks (every fourth at rest),
      // staggered across the arms; moving roles are solved every tick. The count is of ticks, so replays agree.
      const due = arm.role !== 'plant' || arm.blend < 1 || (run.ticks + arm.index) % (idle ? 4 : 2) === 0
      if (placed && due) {
        this.bias(arm, run.time, idle, Math.min(1, Math.abs(u.v) / OCTOPUS_LIMITS.speed + Math.abs(u.turn)))
        if (strain) for (let s = 0; s < 3; s++) arm.solver.bias[s * 3 + 2] = strain
        if (arm.role === 'plant' || arm.role === 'step') this.plantGoals(u, arm)
        else if (run.grab === 'gesture') this.gestureGoals(u, run, arm)
        else this.wrapGoals(u, run, arm)
        arm.solver.solve(1)
      } else if (!placed) this.curlShapes(arm, run.time)
      arm.blend = approach(arm.blend, placed ? 1 : 0, placed ? 2 : 3.5, dt)
      arm.tendons.step(placed ? arm.solver.shapes : arm.free, dt, 0)
      const b = smooth(arm.blend)
      for (let s = 0; s < OCTOPUS_SECTIONS; s++) {
        const from = arm.tendons.pose[s], to = arm.solver.shapes[s], out = arm.shown[s]
        out.kx = lerp(from.kx, to.kx, b)
        out.ky = lerp(from.ky, to.ky, b)
        out.strain = lerp(from.strain, to.strain, b)
        out.twist = lerp(from.twist, to.twist, b)
      }
      this.cupStep(u, run, arm, dt)
    }
  }

  /** Cups seal where they touch the floor or the ball and release distal-first as an arm lifts away. */
  private cupStep(u: Octopus, run: Runtime, arm: Arm, dt: number) {
    const suction = PROFILE.suction
    arm.kinematics.update(arm.shown)
    const ball = this.toBody(u, scratch.d.set(u.ball.x, u.ball.y, u.ball.z), scratch.b)
    const peeling = arm.role === 'step' ? 1 - clamp(arm.progress / 0.35, 0, 1) : 1
    arm.touching = false
    for (let c = 0; c < OCTOPUS_CUPS; c++) {
      const cup = arm.profile.cups[c], i = arm.index * OCTOPUS_CUPS + c
      const p = arm.kinematics.at(cup.fraction, frameScratch).position
      const radius = surfaceRadius(arm.profile, cup.fraction)
      const onFloor = p.y + u.y - radius < 0.016
      const onBall = (arm.role === 'wrap' || arm.role === 'hold') && p.distanceTo(ball) < BALL_RADIUS + radius + 0.02
      const touching = (onFloor && arm.role !== 'free') || onBall
      if (onFloor && cup.fraction >= CONTACT - 0.02 && cup.fraction <= CONTACT + 0.2) arm.touching = true
      const seal = u.cups[i]
      u.cups[i] = touching && (arm.role !== 'step' || cup.fraction <= peeling)
        ? Math.min(1, seal + dt / suction.sealTime)
        : Math.max(0, seal - dt / suction.releaseTime)
    }
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
    const dx = ball.x - u.x, dz = ball.z - u.z, d = Math.hypot(dx, dz), clear = 0.3 + BALL_RADIUS
    if (d < clear && ball.y < u.y + 0.2) {
      const k = d > 1e-6 ? (clear - d) / d : 0
      ball.x += dx * k
      ball.z += dz * k
    }
    ball.x = clamp(ball.x, -OCTOPUS_LIMITS.x - 0.6, OCTOPUS_LIMITS.x + 0.6)
    ball.z = clamp(ball.z, -OCTOPUS_LIMITS.z - 0.6, OCTOPUS_LIMITS.z + 0.6)
  }

  /** Copy the shown pose and roles into the presentation state. */
  private publish(u: Octopus, run: Runtime) {
    u.mantle = run.mantle.fraction
    for (const arm of run.arms) {
      u.roles[arm.index] = arm.role
      for (let s = 0; s < OCTOPUS_SECTIONS; s++) {
        const i = shapeAt(arm.index, s), shape = arm.shown[s]
        u.shapes[i] = shape.kx
        u.shapes[i + 1] = shape.ky
        u.shapes[i + 2] = shape.strain
        u.shapes[i + 3] = shape.twist
      }
    }
  }
}

const frameScratch = { position: new Vector3(), orientation: new Quaternion() }

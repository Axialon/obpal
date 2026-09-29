/**
 * Claw machine: two cabinets full of prizes, a claw each. The Wii remote suits it best: point over a prize and the claw
 * rides there, A drops it. The gamepad's left stick moves it and A drops; the trackpad drags it and a tap drops; the 3D
 * hand makes it follow the phone. Down it goes, closes, lifts, and carries what it caught to the chute, as a real one
 * does; a prize caught off centre may slip on the way up.
 */
import { Controller, Mode, PadButton } from '@obpal/core'
import { handMove, headingOf } from '@obpal/host'
import { clamp, padStick } from './input'
import { seeded } from './maze'
import type { DeviceEvent, DeviceInput, DeviceLogic, DeviceSpec } from './types'
import { planar } from '../vr/intent'

export const CLAW_SPEC: DeviceSpec = {
  id: 'claw',
  name: 'Claw machine',
  unit: 'Claw',
  units: 2,
  kind: 'Game',
  blurb: 'Point over a prize, drop the claw, and hope it holds on.',
  teaches: 'Pointing to place, one button to act, and timing',
  controllers: [Controller.wii, Controller.gamepad, Controller.trackpad, Controller.hand],
  how: {
    'face.wii': 'Point over a prize: the claw rides there · A drops it',
    'face.gamepad': 'Left stick moves the claw · A drops it',
    'face.trackpad': 'Drag to move the claw · tap to drop it',
    'face.hand': 'Hold the pad and move the phone: the claw follows it · tap to drop',
  },
  tray: [{ id: 'drop', label: 'Drop', type: 'button', icon: 'grip' }],
  // A headset press or a keyboard's Space drops the claw, on every controller.
  buttons: { 'media:playpause': 'tray:drop', 'key:Space': 'tray:drop' },
}

/** Metres and seconds, in a cabinet's own frame (its middle at x = z = 0; y up from the room's floor). */
export const CLAW = {
  /** The pit: half its side, its floor, and the gantry's height. */
  half: 0.65,
  floor: 0.62,
  top: 1.48,
  /** The chute in the near left corner: prizes let go over it are won. */
  chute: { x: -0.53, z: 0.53, half: 0.1 },
  speed: 0.5,
  drop: 0.55,
  lift: 0.45,
  carry: 0.35,
  /** How far off a prize's middle the claw may close and still catch it, and hold it for sure. */
  catch: 0.075,
  sure: 0.55,
  /** The claw's reach below its hub. */
  reach: 0.1,
}

/** Where each cabinet stands in the room. */
export const CABINETS: [number, number][] = [[-1, 0], [1, 0]]

export type ClawPhase = 'idle' | 'drop' | 'close' | 'lift' | 'carry' | 'open'

export interface Prize { x: number; y: number; z: number; r: number; kind: 'orb' | 'cube'; color: string; held: boolean; won: number }

/** Quasi-static piles settle centred on their supporting prize, using the same half-height as the visible shape. */
export function prizeSupport(p: Prize, all: readonly Prize[]) {
  return all.filter(o => o !== p && !o.held && !o.won && o.y < p.y - 1e-5 && Math.hypot(o.x - p.x, o.z - p.z) < (o.r + p.r) * .75)
    .sort((a, b) => b.y + b.r - a.y - a.r)[0]
}

export interface Claw {
  /** The gantry over the pit, and the hub's height. */
  x: number
  z: number
  y: number
  /** 0 open … 1 closed. */
  close: number
  phase: ClawPhase
  /** The prize it holds (index), how sure its grip is, and where it would slip. */
  held: number
  grip: number
  slipAt: number | null
  /** Where the gantry is headed (pointing, the 3D hand). */
  goal: [number, number] | null
  won: number
  since: number
}

const PRIZE_COLORS = ['#c6ff34', '#b3a4ff', '#38bdf8', '#fb7185', '#fcd34d', '#6ee7b7']

/** A cabinet's prize bed, with a loose second layer in the middle, clear of the chute. */
function prizes(seed: number): Prize[] {
  const rnd = seeded(seed)
  const out: Prize[] = []
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const x = -0.53 + i * 0.148 + (rnd() - 0.5) * 0.025
      const z = -0.53 + j * 0.148 + (rnd() - 0.5) * 0.025
      if (Math.abs(x - CLAW.chute.x) < CLAW.chute.half + 0.07 && Math.abs(z - CLAW.chute.z) < CLAW.chute.half + 0.07) continue
      const kind = rnd() < 0.6 ? 'orb' : 'cube'
      const r = kind === 'orb' ? 0.055 : 0.048
      out.push({ x, y: CLAW.floor + r, z, r, kind, color: PRIZE_COLORS[out.length % PRIZE_COLORS.length], held: false, won: 0 })
    }
  }
  const middle = out.filter(p => Math.abs(p.x) < 0.36 && Math.abs(p.z) < 0.36)
  for (let i = 0; i < middle.length; i += 2) {
    const base = middle[i], r = 0.055
    out.push({ x: base.x, y: base.y + base.r + r, z: base.z,
      r, kind: 'orb', color: PRIZE_COLORS[(i + 3) % PRIZE_COLORS.length], held: false, won: 0 })
  }
  return out
}

/** A claw's input: where its gantry should go (or how fast), and whether to drop, by the controller in use. */
export interface ClawIntent { goal: [number, number] | null; move: [number, number]; drop: boolean }

/** Where a 3D-hand drive began: the phone's place and heading, and the claw's. */
export interface ClawHand { anchor: { gen: number; p: [number, number, number]; heading: number; at: [number, number] } | null }

export function clawIntent(inp: DeviceInput, c: Claw, at: [number, number], hand: ClawHand): ClawIntent {
  const pressed = (b: number) => ((inp.padPressed >>> b) & 1) === 1
  const drop = inp.presses.includes('drop') || inp.presses.includes('wii-a') || inp.presses.includes('mouse-left') || inp.presses.includes('pad') || pressed(PadButton.A)
  const i: ClawIntent = { goal: null, move: [0, 0], drop }
  if (inp.pad) {
    i.move = planar(inp.controlFrame, ...padStick(inp.pad, 'left'))
    return i
  }
  if (inp.point) {
    // Over where the phone points in the pit, in this cabinet's frame.
    if (inp.spot) i.goal = [inp.spot[0] - at[0], inp.spot[1] - at[1]]
    return i
  }
  if (inp.pose && inp.mode === Mode.track) {
    const pose = inp.pose
    if (!pose.tracked || !pose.touching || inp.recentred) { hand.anchor = null; return i }
    if (!hand.anchor || hand.anchor.gen !== pose.gen) hand.anchor = { gen: pose.gen, p: [...pose.p], heading: headingOf(pose.q), at: [c.x, c.z] }
    const m = handMove([pose.p[0] - hand.anchor.p[0], pose.p[1] - hand.anchor.p[1], pose.p[2] - hand.anchor.p[2]], hand.anchor.heading)
    i.goal = [hand.anchor.at[0] + m.right * 1.2, hand.anchor.at[1] - m.forward * 1.2]
    return i
  }
  hand.anchor = null
  if (inp.mode === Mode.tilt && (inp.tilt[0] || inp.tilt[1])) i.move = planar(inp.controlFrame, ...inp.tilt)
  // Dragging moves the claw with the thumb (a floating stick would overshoot a prize).
  if (inp.drag[0] || inp.drag[1]) { const [x, z] = planar(inp.controlFrame, ...inp.drag); i.goal = [c.x + x * 0.0022, c.z + z * 0.0022] }
  return i
}

export class ClawLogic implements DeviceLogic {
  readonly spec = CLAW_SPEC
  readonly claws: Claw[]
  readonly prizes: Prize[][]
  private hands: ClawHand[]
  private events: DeviceEvent[] = []

  constructor(count = CLAW_SPEC.units) {
    this.claws = Array.from({ length: count }, () => ({ x: CLAW.chute.x, z: CLAW.chute.z, y: CLAW.top, close: 0, phase: 'idle', held: -1, grip: 0, slipAt: null, goal: null, won: 0, since: 0 }))
    this.prizes = this.claws.map((_, n) => prizes(11 + n))
    this.hands = this.claws.map(() => ({ anchor: null }))
  }

  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    this.claws.forEach((c, n) => {
      const inp = inputs[n]
      const i = inp ? clawIntent(inp, c, CABINETS[n] ?? [0, 0], this.hands[n]) : null
      if (!inp) this.hands[n].anchor = null
      this.stepClaw(c, n, i, dt)
      this.settle(n, dt)
    })
  }

  private stepClaw(c: Claw, n: number, i: ClawIntent | null, dt: number) {
    const C = CLAW
    c.since += dt
    const toward = (tx: number, tz: number, speed: number) => {
      const dx = tx - c.x, dz = tz - c.z
      const d = Math.hypot(dx, dz)
      const s = Math.min(d, speed * dt)
      if (d > 1e-6) { c.x += (dx / d) * s; c.z += (dz / d) * s }
      return d <= speed * dt
    }
    const lim = C.half - 0.06
    switch (c.phase) {
      case 'idle':
        if (i?.goal) c.goal = [clamp(i.goal[0], -lim, lim), clamp(i.goal[1], -lim, lim)]
        if (i && (i.move[0] || i.move[1])) { c.goal = null; c.x += i.move[0] * C.speed * dt; c.z += i.move[1] * C.speed * dt }
        if (c.goal) toward(c.goal[0], c.goal[1], C.speed)
        c.x = clamp(c.x, -lim, lim)
        c.z = clamp(c.z, -lim, lim)
        if (i?.drop) { c.phase = 'drop'; c.since = 0; c.goal = null; this.events.push({ unit: n, kind: 'tick' }) }
        break
      case 'drop': {
        // Down until the fingers reach the floor or the top of what's under the claw.
        const under = this.prizes[n].filter((p) => !p.held && !p.won && Math.hypot(p.x - c.x, p.z - c.z) < p.r + 0.12)
        // Open fingers sweep wider than the hub. Stop above the top of every prize under that sweep.
        const stop = Math.max(C.floor + 0.025, ...under.map((p) => p.y + p.r + .007)) + C.reach
        c.y = Math.max(stop, c.y - C.drop * dt)
        if (c.y <= stop + 1e-6) { c.phase = 'close'; c.since = 0 }
        break
      }
      case 'close':
        c.close = Math.min(1, c.close + dt / 0.4)
        if (c.close >= 1) { this.grab(c, n); c.phase = 'lift'; c.since = 0 }
        break
      case 'lift':
        c.y = Math.min(C.top, c.y + C.lift * dt)
        if (c.held >= 0 && c.slipAt !== null && c.y >= c.slipAt) {
          this.letGo(c, n)
          this.events.push({ unit: n, kind: 'bump', strength: 0.4, text: 'It slipped!' })
        }
        if (c.y >= C.top) { c.phase = c.held >= 0 ? 'carry' : 'open'; c.since = 0 }
        break
      case 'carry':
        if (toward(C.chute.x, C.chute.z, C.carry)) { c.phase = 'open'; c.since = 0 }
        break
      case 'open':
        c.close = Math.max(0, c.close - dt / 0.35)
        if (c.held >= 0 && c.close < 0.6) {
          const p = this.prizes[n][c.held]
          this.letGo(c, n)
          if (this.overChute(p)) {
            p.won = 1e-6
            c.won++
            this.events.push({ unit: n, kind: 'score', text: `Won a ${p.kind === 'orb' ? 'glass orb' : 'cube'}! ${c.won} so far` })
          }
        }
        if (c.close <= 0) { c.phase = 'idle'; c.since = 0 }
        break
    }
    // Closed finger plates extend 124 mm below the hub; the old 100 mm gameplay reach was not a collision envelope.
    c.y = Math.max(C.floor + .125, c.y)
    // What it holds hangs under the claw.
    if (c.held >= 0) {
      const p = this.prizes[n][c.held]
      p.x = c.x
      p.z = c.z
      p.y = c.y - C.reach - p.r * 0.2
    }
  }

  private overChute(p: Prize) { return Math.abs(p.x - CLAW.chute.x) < CLAW.chute.half && Math.abs(p.z - CLAW.chute.z) < CLAW.chute.half }

  /** Closing: the prize nearest the claw's middle, if it's near enough; one caught off centre may slip on the way up. */
  private grab(c: Claw, n: number) {
    let best = -1
    let d = CLAW.catch
    this.prizes[n].forEach((p, k) => {
      if (p.held || p.won) return
      const e = Math.hypot(p.x - c.x, p.z - c.z)
      if (e < d && p.y + p.r > c.y - CLAW.reach - 0.02) { best = k; d = e }
    })
    if (best < 0) { this.events.push({ unit: n, kind: 'bump', strength: 0.3, text: 'Missed' }); return }
    c.held = best
    c.grip = 1 - d / CLAW.catch
    this.prizes[n][best].held = true
    // Held for sure, or it slips somewhere on the way up (the weaker the grip, the sooner).
    c.slipAt = c.grip >= CLAW.sure ? null : CLAW.floor + 0.25 + c.grip * 0.9
  }

  private letGo(c: Claw, n: number) {
    const p = this.prizes[n][c.held]
    p.held = false
    c.held = -1
    c.slipAt = null
  }

  /** Prizes fall to the floor, or onto a prize under them; a won one drops out of sight down the chute and comes back. */
  private settle(n: number, dt: number) {
    const all = this.prizes[n]
    for (const p of all) {
      if (p.held) continue
      if (p.won) {
        p.won += dt
        p.y -= dt * 1.2
        if (p.won > 1.6) this.respawn(p, n)
        continue
      }
      const support = prizeSupport(p, all)
      const rest = support ? support.y + support.r + p.r : CLAW.floor + p.r
      if (support) { p.x = support.x; p.z = support.z }
      if (p.y > rest) p.y = Math.max(rest, p.y - dt * 1.4)
      else p.y = rest
    }
  }

  /** A won prize comes back in the pit: somewhere free, clear of the chute. */
  private respawn(p: Prize, n: number) {
    const rnd = seeded(Math.floor(p.x * 1e4) ^ this.claws[n].won)
    for (let k = 0; k < 20; k++) {
      const x = (rnd() - 0.5) * 0.66
      const z = (rnd() - 0.5) * 0.66
      if (Math.abs(x - CLAW.chute.x) < CLAW.chute.half + 0.07 && Math.abs(z - CLAW.chute.z) < CLAW.chute.half + 0.07) continue
      if (this.prizes[n].some((o) => o !== p && Math.hypot(o.x - x, o.z - z) < o.r + p.r)) continue
      Object.assign(p, { x, z, y: CLAW.floor + p.r + 0.3, won: 0 })
      return
    }
    Object.assign(p, { x: 0, z: -0.3, y: CLAW.floor + p.r + 0.3, won: 0 })
  }

  /** Home: the claw back over the chute, open, at the top (what it held drops). */
  home(n: number) {
    const c = this.claws[n]
    if (c.held >= 0) this.letGo(c, n)
    Object.assign(c, { x: CLAW.chute.x, z: CLAW.chute.z, y: CLAW.top, close: 0, phase: 'idle', goal: null, since: 0 })
  }

  readout(n: number) {
    const c = this.claws[n]
    const busy = c.phase === 'idle' ? '' : c.held >= 0 ? 'Holding · ' : c.phase === 'drop' || c.phase === 'close' ? 'Dropping · ' : ''
    return `${busy}${c.won} won`
  }

  drain() { const e = this.events; this.events = []; return e }
}

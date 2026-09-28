/** Two compact pinball tables. All collisions use bounded substeps on the table plane. */
import { Controller, Mode, PadButton } from '@obpal/core'
import { Machine, timestep } from './common'
import { approach, clamp, down } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const PINBALL_SPEC: DeviceSpec = {
  id: 'pinball', name: 'Pinball', unit: 'Table', units: 2, kind: 'Game',
  blurb: 'Pull the plunger, work both flippers and nudge a steel ball through a field of bumpers.',
  teaches: 'Held buttons, analogue pull and release, and a bound cabinet nudge',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'LB / A: left flipper · RB / B: right · pull RT, release to launch · Y nudges',
    'face.trackpad': 'Drag down and lift to launch · tap flips both · Gyro Tilt: rock side to side to nudge',
  },
  tray: [
    { id: 'left', label: 'Left flipper', type: 'button', icon: 'left' },
    { id: 'right', label: 'Right flipper', type: 'button', icon: 'right' },
    { id: 'launch', label: 'Launch', type: 'button', icon: 'tap' },
    { id: 'nudge', label: 'Nudge', type: 'button', icon: 'tilt' },
  ],
  // There is no shake input in the catalogue: these real inputs press the same cabinet-nudge action.
  buttons: { 'key:ArrowLeft': 'tray:left', 'key:ArrowRight': 'tray:right', 'key:Space': 'tray:launch', 'key:KeyN': 'tray:nudge', 'pad:b3': 'tray:nudge', 'media:nexttrack': 'tray:nudge' },
}

export const PINBALL = { halfWidth: 0.7, halfLength: 1.3, ball: 0.035, maxSpeed: 7, lane: 0.59, drain: 0.22 }
export const PINBALL_BUMPERS = [{ x: -0.28, z: -0.63, r: 0.13 }, { x: 0.21, z: -0.5, r: 0.13 }, { x: -0.08, z: -0.12, r: 0.12 }]
export interface PinballTable {
  x: number; z: number; vx: number; vz: number
  active: boolean
  left: number; right: number; leftPulse: number; rightPulse: number
  plunger: number; pulling: boolean
  score: number; balls: number; actions: number
  nudge: number; cooldown: number
  bumperCooldown: number[]
}
const fresh = (): PinballTable => ({ x: PINBALL.lane, z: 1.05, vx: 0, vz: 0, active: false, left: 0, right: 0, leftPulse: 0, rightPulse: 0, plunger: 0, pulling: false, score: 0, balls: 0, actions: 0, nudge: 0, cooldown: 0, bumperCooldown: [0, 0, 0] })

/** The flipper's pivot and tip, shared with its visual model. */
export function flipper(side: -1 | 1, amount: number): [number, number, number, number] {
  const angle = 0.4 - amount * 0.92
  return [side * 0.43, 0.91, side * (0.43 - Math.cos(angle) * 0.36), 0.91 + Math.sin(angle) * 0.36]
}

/** Resolve a capsule rail and return the incoming normal speed. */
function rail(u: PinballTable, ax: number, az: number, bx: number, bz: number, radius = 0.018, kick = 0) {
  const dx = bx - ax, dz = bz - az
  const t = clamp(((u.x - ax) * dx + (u.z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1)
  const px = ax + dx * t, pz = az + dz * t
  let nx = u.x - px, nz = u.z - pz
  const d = Math.hypot(nx, nz), r = PINBALL.ball + radius
  if (d >= r) return 0
  if (d > 1e-8) { nx /= d; nz /= d } else { nx = 0; nz = -1 }
  u.x = px + nx * r
  u.z = pz + nz * r
  const into = u.vx * nx + u.vz * nz
  if (into < 0) { u.vx -= 1.85 * into * nx; u.vz -= 1.85 * into * nz }
  if (kick && nz < 0) { u.vz = Math.min(u.vz, -kick); u.vx += -Math.sign(ax) * kick * 0.25 }
  return Math.max(0, -into)
}

export class PinballLogic extends Machine {
  readonly spec = PINBALL_SPEC
  readonly units = [fresh(), fresh()]
  private rocks = [{ side: 0, age: 0 }, { side: 0, age: 0 }]
  private neutral = [false, false]

  home(n: number) {
    const u = this.units[n]
    Object.assign(u, fresh(), { score: u.score, balls: u.balls, actions: u.actions })
    this.rocks[n] = { side: 0, age: 0 }
    this.neutral[n] = true
  }

  private launch(n: number, strength: number) {
    const u = this.units[n]
    if (u.active) return
    u.active = true
    u.x = PINBALL.lane
    u.z = 1.05
    u.vx = 0
    u.vz = -(3.2 + clamp(strength, 0, 1) * 3.8)
    u.plunger = 0
    u.pulling = false
    u.balls++
    u.actions++
    this.events.push({ unit: n, kind: 'tick', text: 'Ball launched' })
  }

  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const i = inputs[n], candidate = i && !i.quiet ? i : null
      const held = candidate?.pad?.buttons ?? 0
      const flippersHeld = held & ((1 << PadButton.A) | (1 << PadButton.B) | (1 << PadButton.LB) | (1 << PadButton.RB))
      // Home may arrive in the same frame as held controls. Require their release before accepting another pull.
      if (this.neutral[n] && (!i || (candidate && !candidate.touching && !flippersHeld && (candidate.pad?.triggers[1] ?? 0) <= 0.02))) this.neutral[n] = false
      const live = this.neutral[n] ? null : candidate
      const presses = i?.presses ?? []
      u.cooldown = Math.max(0, u.cooldown - dt)
      u.nudge = Math.max(0, u.nudge - dt * 4)
      const pad = live?.pad?.buttons ?? 0
      if (presses.includes('left')) { u.leftPulse = 0.16; u.actions++ }
      if (presses.includes('right')) { u.rightPulse = 0.16; u.actions++ }
      if (live?.presses.includes('pad')) { u.leftPulse = u.rightPulse = 0.16; u.actions++ }
      const left = !!live && (down(pad, PadButton.LB) || down(pad, PadButton.A))
      const right = !!live && (down(pad, PadButton.RB) || down(pad, PadButton.B))
      if (!live && !presses.includes('left')) u.leftPulse = 0
      if (!live && !presses.includes('right')) u.rightPulse = 0
      u.left = approach(u.left, left || u.leftPulse > 0 ? 1 : 0, 16, dt)
      u.right = approach(u.right, right || u.rightPulse > 0 ? 1 : 0, 16, dt)
      u.leftPulse = Math.max(0, u.leftPulse - dt)
      u.rightPulse = Math.max(0, u.rightPulse - dt)
      if (!live) { u.pulling = false; u.plunger = 0 }
      else if (!u.active) {
        const trigger = clamp(live.pad?.triggers[1] ?? 0, 0, 1)
        const pulling = trigger > 0.02 || (!live.pad && live.touching)
        if (trigger > 0.02) u.plunger = trigger
        else if (pulling && Number.isFinite(live.drag[1])) u.plunger = clamp(u.plunger + live.drag[1] / 160, 0, 1)
        if (u.pulling && !pulling && u.plunger > 0.02) this.launch(n, u.plunger)
        u.pulling = pulling
      }
      if (presses.includes('launch')) this.launch(n, u.plunger || 0.75)
      // A deliberate quick reversal of the existing Tilt signal shakes the cabinet once.
      const rock = this.rocks[n]
      rock.age += Number.isFinite(delta) ? Math.max(0, delta) : 0.35
      let shook = false
      if (live?.mode === Mode.tilt) {
        const side = Math.abs(live.tilt[0]) > 0.6 ? Math.sign(live.tilt[0]) : 0
        if (side && side !== rock.side) {
          shook = rock.side !== 0 && rock.age < 0.35
          rock.side = side; rock.age = 0
        }
      } else { rock.side = 0; rock.age = 0 }
      if ((shook || presses.includes('nudge') || !!(live && down(live.padPressed, PadButton.Y))) && u.cooldown === 0) {
        u.nudge = 1
        u.cooldown = 0.45
        u.actions++
        if (u.active) { u.vx += u.actions % 2 ? 0.8 : -0.8; u.vz -= 0.7 }
        this.events.push({ unit: n, kind: 'bump', strength: 0.25, text: 'Nudge' })
      }
      if (!u.active || !dt) return
      const steps = Math.ceil(dt * 240), h = dt / steps
      for (let step = 0; step < steps && u.active; step++) this.integrate(u, n, h)
    })
  }

  private integrate(u: PinballTable, n: number, dt: number) {
    const M = PINBALL, r = M.ball
    const vx = u.vx, vz = u.vz
    u.vz += 1.8 * dt
    const speed = Math.hypot(u.vx, u.vz)
    const scale = Math.min(1, M.maxSpeed / (speed || 1)) * Math.exp(-dt * 0.025)
    u.vx *= scale; u.vz *= scale
    u.x += u.vx * dt; u.z += u.vz * dt
    if (u.x < -M.halfWidth + r) { u.x = -M.halfWidth + r; u.vx = Math.abs(u.vx) * 0.9 }
    if (u.x > M.halfWidth - r) { u.x = M.halfWidth - r; u.vx = -Math.abs(u.vx) * 0.9 }
    if (u.z < -M.halfLength + r) {
      u.z = -M.halfLength + r; u.vz = Math.abs(u.vz) * 0.75
      if (u.x > 0.45) u.vx = -2.6
    }
    rail(u, 0.49, -0.78, 0.49, 1.3, 0.012)
    rail(u, -0.65, 0.38, -0.43, 0.89)
    rail(u, 0.45, 0.38, 0.43, 0.89)
    rail(u, ...flipper(-1, u.left), 0.035, u.left > 0.5 ? 4.8 : 0)
    rail(u, ...flipper(1, u.right), 0.035, u.right > 0.5 ? 4.8 : 0)
    PINBALL_BUMPERS.forEach((b, index) => {
      u.bumperCooldown[index] = Math.max(0, u.bumperCooldown[index] - dt)
      const hit = rail(u, b.x, b.z, b.x, b.z, b.r)
      if (hit > 0.15 && !u.bumperCooldown[index]) {
        const d = Math.hypot(u.x - b.x, u.z - b.z) || 1
        u.vx += (u.x - b.x) / d * 0.65; u.vz += (u.z - b.z) / d * 0.65
        u.score = Math.min(999999, u.score + 100)
        u.bumperCooldown[index] = 0.12
        this.events.push({ unit: n, kind: 'score', text: `${u.score} points` })
      }
    })
    if (u.z > M.halfLength - r) {
      if (Math.abs(u.x) < M.drain || u.x > 0.5) {
        u.active = false; u.x = M.lane; u.z = 1.05; u.vx = u.vz = 0
        this.events.push({ unit: n, kind: 'fall', text: 'Ball drained · pull to play again' })
      } else { u.z = M.halfLength - r; u.vz = -Math.abs(u.vz) * 0.8 }
    }
    const endSpeed = Math.hypot(u.vx, u.vz)
    const contactSpeed = Math.hypot(u.vx - vx, u.vz - vz) / 1.8
    if (u.active && contactSpeed > 0.3) this.events.push({ unit: n, kind: 'bump', audio: { speed: contactSpeed, impulse: contactSpeed } })
    if (endSpeed > M.maxSpeed) { u.vx *= M.maxSpeed / endSpeed; u.vz *= M.maxSpeed / endSpeed }
    u.x = clamp(u.x, -M.halfWidth + r, M.halfWidth - r)
    u.z = clamp(u.z, -M.halfLength + r, M.halfLength - r)
  }

  readout(n: number) { const u = this.units[n]; return `${u.score} points · ${u.active ? `ball ${u.balls}` : u.plunger ? `${Math.round(u.plunger * 100)}% pull` : 'pull to launch'}` }
}

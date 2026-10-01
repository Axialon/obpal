/** Buildable channels on two tilt tables. Times belong to the current track, not to a previous layout. */
import { Controller, Mode, PadButton } from '@obpal/core'
import { Machine, action, timestep } from './common'
import { axis, clamp, slopeOf } from './input'
import type { DeviceInput, DeviceSpec } from './types'
import { planar } from '../vr/intent'
import { FixedWorld } from '../physics/world'
import { MarblerunAdapter, cupSurface } from '../physics/marblerun'

export const MARBLERUN_SPEC: DeviceSpec = {
  category: 'games',
  id: 'marblerun', name: 'Marble run', unit: 'Track', units: 2, kind: 'Game',
  blurb: 'Build a channel across the board, then tilt your phone to race a marble to the finish.',
  teaches: 'Touch places track pieces; Tilt or 1:1 guides a timed marble run',
  controllers: [Controller.trackpad, Controller.gamepad],
  how: {
    'face.trackpad': 'Drag selects · tap places · Piece / Turn choose · Run: tap pushes, drag flicks, tilt rolls',
    'face.gamepad': 'Build: left stick selects, A places, B turns, X changes piece · Y runs · left stick guides the marble',
  },
  tray: [{ id: 'push', label: 'Push', type: 'button', icon: 'tap' }, { id: 'place', label: 'Place', type: 'button', icon: 'tap' }, { id: 'turn', label: 'Turn', type: 'button', icon: 'reset' }, { id: 'piece', label: 'Piece', type: 'button', icon: 'tap' }, { id: 'remove', label: 'Remove piece', type: 'button', icon: 'reset' }, { id: 'run', label: 'Run / build', type: 'button', icon: 'play' }],
  buttons: { 'key:Space': 'tray:place', 'key:KeyR': 'tray:run', 'key:KeyT': 'tray:turn', 'key:KeyP': 'tray:piece', 'media:playpause': 'tray:run' },
}
export interface TrackPiece { kind: number; turn: number }
export const trackEnds = (p: TrackPiece) => p.kind === 0 ? [p.turn % 4, (p.turn + 2) % 4] : [p.turn % 4, (p.turn + 1) % 4]
export const RUN = { cell: 0.58, half: 1.45, radius: 0.055, channel: 0.18, speed: 1.5 }
export const runTrack = (): (TrackPiece | null)[] => Array.from({ length: 25 }, (_, n) => n >= 10 && n <= 14 && n !== 12 ? { kind: 0, turn: 0 } : null)
export interface Marble {
  id: number; x: number; z: number; vx: number; vz: number
  radius: number; mass: number; detune: number; spinX: number; spinZ: number; rollX: number; rollZ: number; slip: number; normalForce: number
}
const marble = (id: number, x: number, radius = RUN.radius): Marble => ({
  id, x, z: 0, vx: 0, vz: 0, radius, mass: 2500 * 4 / 3 * Math.PI * radius ** 3,
  detune: (Math.random() - 0.5) * 0.035, spinX: 0, spinZ: 0, rollX: 0, rollZ: 0, slip: 0, normalForce: 0,
})
/** A glass sphere's size and inertia set its resonance; detuning belongs to the body, not the hit. */
export const marblePitch = (m: Marble) => clamp((RUN.radius / m.radius) ** 0.65 * (marbleMass / m.mass) ** 0.08 * 2 ** m.detune, 0.7, 1.5)
const marbleMass = 2500 * 4 / 3 * Math.PI * RUN.radius ** 3
export function marblePosition(n: number, m: Marble, tiltX: number, tiltZ: number): [number, number, number] {
  const rz = -tiltX * 0.08, rx = tiltZ * 0.08
  const height = m.radius + cupSurface(m.x, m.z).height
  const x = m.x * Math.cos(rz) - height * Math.sin(rz), y = m.x * Math.sin(rz) + height * Math.cos(rz)
  return [n * 3.8 + x, 0.9 + y * Math.cos(rx) - m.z * Math.sin(rx), y * Math.sin(rx) + m.z * Math.cos(rx)]
}
/** Directions run right, down, left, up on the board. The centre joins two channel arms. */
export function inChannel(track: readonly (TrackPiece | null)[], x: number, z: number, radius = RUN.radius) {
  const col = Math.round(x / RUN.cell) + 2, row = Math.round(z / RUN.cell) + 2
  if (col < 0 || col > 4 || row < 0 || row > 4) return false
  const p = track[row * 5 + col]
  if (!p) return false
  const dx = x - (col - 2) * RUN.cell, dz = z - (row - 2) * RUN.cell, w = RUN.channel - radius
  if (Math.abs(dx) <= w && Math.abs(dz) <= w) return true
  return trackEnds(p).some(d => d === 0 ? dx >= 0 && Math.abs(dz) <= w : d === 1 ? dz >= 0 && Math.abs(dx) <= w : d === 2 ? dx <= 0 && Math.abs(dz) <= w : dz <= 0 && Math.abs(dx) <= w)
}
const companions = () => [marble(1, -0.99, 0.05), marble(2, -0.82, 0.06)]
const fresh = () => ({ ...marble(0, -1.16), marbles: companions(), track: runTrack(), cursorX: 2, cursorZ: 2, kind: 0, turn: 0, tiltX: 0, tiltZ: 0, running: false, time: 0, best: 0, finished: false, actions: 0, revision: 0 })
export class MarblerunLogic extends Machine {
  readonly spec = MARBLERUN_SPEC
  readonly units = [fresh(), fresh()]
  private slopes = [[0, 0], [0, 0]]
  private zeros = [[0, 0], [0, 0]]
  private readonly adapter = new MarblerunAdapter(this.units,
    (n, x, z, radius) => inChannel(this.units[n].track, x, z, radius),
    ({ board: n, source, a, b, speed }) => {
      const u = this.units[n], at = marblePosition(n, b ? { ...a, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } : a, u.tiltX, u.tiltZ)
      this.events.push({ unit: n, kind: 'bump', audio: { source, glass: b ? 'clack' : 'track', materials: ['glass', 'glass'], speed, pitch: b ? Math.sqrt(marblePitch(a) * marblePitch(b)) : marblePitch(a), at } })
    }, dt => this.units.forEach((u, n) => {
      if (u.running) u.time += dt
      if (u.running && Math.hypot(u.x - 1.16, u.z) < .13) {
        u.finished = true; u.running = false
        u.best = u.best ? Math.min(u.best, u.time) : u.time
        this.events.push({ unit: n, kind: 'score', text: `Finished in ${u.time.toFixed(2)} s` })
      }
    }))
  private readonly world = new FixedWorld(this.adapter, { maxBodies: 6 })
  private simulated = this.adapter.capture()
  renderState() {
    const live = this.adapter.capture()
    // Shared guests apply presentation snapshots without advancing the host's clock.
    const changed = live.some((u, n) => u.tiltX !== this.simulated[n].tiltX || u.tiltZ !== this.simulated[n].tiltZ || u.marbles.some((m, j) => {
      const old = this.simulated[n].marbles[j]
      return !old || m.x !== old.x || m.z !== old.z || m.rollX !== old.rollX || m.rollZ !== old.rollZ
    }))
    return changed ? live : this.world.render()
  }
  physicsDiagnostics() { return this.world.diagnostics() }
  /** A bounded additive impulse preserves existing momentum, including repeated taps. */
  push(n: number, x = .42, z = 0) {
    const u = this.units[n], speed = Math.hypot(u.vx, u.vz), reserve = Math.max(0, 1 - (speed / 2.8) ** 2)
    const length = Math.hypot(x, z), scale = length > .65 ? .65 / length : 1
    if (!Number.isFinite(length)) return
    u.vx += x * scale * reserve; u.vz += z * scale * reserve; u.actions++
  }
  home(n: number) {
    Object.assign(this.units[n], { cursorX: 2, cursorZ: 2, x: -1.16, z: 0, vx: 0, vz: 0, spinX: 0, spinZ: 0, rollX: 0, rollZ: 0, slip: 0, normalForce: 0, marbles: companions(), tiltX: 0, tiltZ: 0, running: false, time: 0, finished: false })
    this.adapter.reset(n); this.world.snap(); this.simulated = this.adapter.capture()
    this.zeros[n] = [...this.slopes[n]]
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null
      if (i) this.slopes[n] = i.hold ? slopeOf(i.hold) : i.mode === Mode.tilt ? [...i.tilt] : [0, 0]
      if (raw?.presses.includes('run') || i && (i.padPressed & (1 << PadButton.Y))) {
        u.running = !u.running; u.actions++
        if (u.running) { u.finished = false; u.time = 0; this.zeros[n] = [...this.slopes[n]] }
        const run = u.running
        if (run) this.events.push({ unit: n, kind: 'tick', audio: { action: 'glass-launch', at: marblePosition(n, u, 0, 0) } })
      }
      if (raw?.presses.includes('push')) this.push(n)
      if (!u.running) {
        if (i) {
          const [x, z] = planar(i.controlFrame, i.pad ? axis(i.pad.axes[0]) * dt * 3 : i.drag[0] * 0.025, i.pad ? axis(i.pad.axes[1]) * dt * 3 : i.drag[1] * 0.025)
          u.cursorX = clamp(u.cursorX + x, 0, 4); u.cursorZ = clamp(u.cursorZ + z, 0, 4)
          if (i.space && !i.pad) { const [ax, az] = planar(i.controlFrame, i.space.aim[0] * 2, -i.space.aim[1] * 2); u.cursorX = clamp(2 + ax, 0, 4); u.cursorZ = clamp(2 + az, 0, 4) }
        }
        if (raw?.presses.includes('turn') || i && (i.padPressed & (1 << PadButton.B))) u.turn = (u.turn + 1) % 4
        if (raw?.presses.includes('piece') || i && (i.padPressed & (1 << PadButton.X))) u.kind = (u.kind + 1) % 2
        if (raw?.presses.includes('place') || action(i, 'place')) {
          const at = Math.round(u.cursorZ) * 5 + Math.round(u.cursorX)
          if (at !== 10 && at !== 14) {
            if (u.track[at] || u.track.filter(Boolean).length < 10) { u.track[at] = { kind: u.kind, turn: u.turn }; u.best = 0; u.revision++ }
            else this.events.push({ unit: n, kind: 'tick', text: 'Ten pieces placed · remove or replace a piece to revise the track' })
          }
          u.actions++
        }
        if (raw?.presses.includes('remove')) {
          const at = Math.round(u.cursorZ) * 5 + Math.round(u.cursorX)
          if (at !== 10 && at !== 14) { u.track[at] = null; u.best = 0; u.revision++ }
        }
      } else {
        if (raw?.presses.includes('place') || action(i, 'place')) this.push(n)
        if (i && !i.pad && (i.drag[0] || i.drag[1])) {
          const [x, z] = planar(i.controlFrame, i.drag[0] * .02, i.drag[1] * .02)
          this.push(n, x, z)
        }
      }
      let x = 0, z = 0
      if (u.running && i) {
        x = clamp(i.pad ? axis(i.pad.axes[0]) : this.slopes[n][0] - (i.space ? 0 : this.zeros[n][0]), -1, 1)
        z = clamp(i.pad ? axis(i.pad.axes[1]) : this.slopes[n][1] - (i.space ? 0 : this.zeros[n][1]), -1, 1)
        ;[x, z] = planar(i.controlFrame, x, z)
      }
      const follow = 1 - Math.exp(-12 * dt)
      u.tiltX += (x - u.tiltX) * follow; u.tiltZ += (z - u.tiltZ) * follow
    })
    this.world.advance(delta)
    this.simulated = this.adapter.capture()
  }
  readout(n: number) { const u = this.units[n]; return `${u.running ? 'Run' : u.finished ? 'Finished' : `${u.kind ? 'Bend' : 'Straight'} ${u.turn * 90}°`} · ${u.time.toFixed(1)} s${u.best ? ` · best ${u.best.toFixed(1)}` : ''}` }
}

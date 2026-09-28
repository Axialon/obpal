/** Buildable channels on two tilt tables. Times belong to the current track, not to a previous layout. */
import { Controller, Mode, PadButton } from '@obpal/core'
import { Machine, action, timestep } from './common'
import { axis, clamp, slopeOf } from './input'
import type { DeviceInput, DeviceSpec } from './types'
import { planar } from '../vr/intent'

export const MARBLERUN_SPEC: DeviceSpec = {
  category: 'games',
  id: 'marblerun', name: 'Marble run', unit: 'Track', units: 2, kind: 'Game',
  blurb: 'Build a channel across the board, then tilt your phone to race a marble to the finish.',
  teaches: 'Touch places track pieces; Tilt or 1:1 guides a timed marble run',
  controllers: [Controller.trackpad, Controller.gamepad],
  how: {
    'face.trackpad': 'Drag selects · tap places · Piece / Turn choose · Run: tilt or drag to roll',
    'face.gamepad': 'Build: left stick selects, A places, B turns, X changes piece · Y runs · left stick guides the marble',
  },
  tray: [{ id: 'place', label: 'Place', type: 'button', icon: 'tap' }, { id: 'turn', label: 'Turn', type: 'button', icon: 'reset' }, { id: 'piece', label: 'Piece', type: 'button', icon: 'tap' }, { id: 'remove', label: 'Remove piece', type: 'button', icon: 'reset' }, { id: 'run', label: 'Run / build', type: 'button', icon: 'play' }],
  buttons: { 'key:Space': 'tray:place', 'key:KeyR': 'tray:run', 'key:KeyT': 'tray:turn', 'key:KeyP': 'tray:piece', 'media:playpause': 'tray:run' },
}
export interface TrackPiece { kind: number; turn: number }
export const trackEnds = (p: TrackPiece) => p.kind === 0 ? [p.turn % 4, (p.turn + 2) % 4] : [p.turn % 4, (p.turn + 1) % 4]
export const RUN = { cell: 0.58, half: 1.45, radius: 0.055, channel: 0.18, speed: 1.5 }
export const runTrack = (): (TrackPiece | null)[] => Array.from({ length: 25 }, (_, n) => n >= 10 && n <= 14 && n !== 12 ? { kind: 0, turn: 0 } : null)
/** Directions run right, down, left, up on the board. The centre joins two channel arms. */
export function inChannel(track: readonly (TrackPiece | null)[], x: number, z: number) {
  const col = Math.round(x / RUN.cell) + 2, row = Math.round(z / RUN.cell) + 2
  if (col < 0 || col > 4 || row < 0 || row > 4) return false
  const p = track[row * 5 + col]
  if (!p) return false
  const dx = x - (col - 2) * RUN.cell, dz = z - (row - 2) * RUN.cell, w = RUN.channel - RUN.radius
  if (Math.abs(dx) <= w && Math.abs(dz) <= w) return true
  return trackEnds(p).some(d => d === 0 ? dx >= 0 && Math.abs(dz) <= w : d === 1 ? dz >= 0 && Math.abs(dx) <= w : d === 2 ? dx <= 0 && Math.abs(dz) <= w : dz <= 0 && Math.abs(dx) <= w)
}
const fresh = () => ({ track: runTrack(), cursorX: 2, cursorZ: 2, kind: 0, turn: 0, x: -1.16, z: 0, vx: 0, vz: 0, tiltX: 0, tiltZ: 0, running: false, time: 0, best: 0, finished: false, actions: 0, revision: 0 })
export class MarblerunLogic extends Machine {
  readonly spec = MARBLERUN_SPEC
  readonly units = [fresh(), fresh()]
  private slopes = [[0, 0], [0, 0]]
  private zeros = [[0, 0], [0, 0]]
  home(n: number) {
    Object.assign(this.units[n], { cursorX: 2, cursorZ: 2, x: -1.16, z: 0, vx: 0, vz: 0, tiltX: 0, tiltZ: 0, running: false, time: 0, finished: false })
    this.zeros[n] = [...this.slopes[n]]
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null
      if (i) this.slopes[n] = i.hold ? slopeOf(i.hold) : i.mode === Mode.tilt ? [...i.tilt] : [0, 0]
      if (raw?.presses.includes('run') || i && (i.padPressed & (1 << PadButton.Y))) {
        const run = !u.running; this.home(n); u.running = run; u.actions++
      }
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
        u.tiltX = u.tiltZ = 0; return
      }
      // A lost phone pauses the clock and marble, so reconnecting cannot lose the run.
      if (!i) { u.vx = u.vz = u.tiltX = u.tiltZ = 0; return }
      u.tiltX = clamp(i.pad ? axis(i.pad.axes[0]) : this.slopes[n][0] - (i.space ? 0 : this.zeros[n][0]) + i.drag[0] * 0.03, -1, 1)
      u.tiltZ = clamp(i.pad ? axis(i.pad.axes[1]) : this.slopes[n][1] - (i.space ? 0 : this.zeros[n][1]) + i.drag[1] * 0.03, -1, 1)
      ;[u.tiltX, u.tiltZ] = planar(i.controlFrame, u.tiltX, u.tiltZ)
      const steps = Math.ceil(dt * 240), h = steps ? dt / steps : 0
      for (let s = 0; s < steps; s++) {
        u.time += h
        u.vx = clamp((u.vx + u.tiltX * 3 * h) * Math.exp(-1.2 * h), -RUN.speed, RUN.speed)
        u.vz = clamp((u.vz + u.tiltZ * 3 * h) * Math.exp(-1.2 * h), -RUN.speed, RUN.speed)
        if (inChannel(u.track, u.x + u.vx * h, u.z)) u.x += u.vx * h; else {
          if (Math.abs(u.vx) > 0.15) this.events.push({ unit: n, kind: 'bump', audio: { speed: Math.abs(u.vx) } })
          u.vx *= -0.25
        }
        if (inChannel(u.track, u.x, u.z + u.vz * h)) u.z += u.vz * h; else {
          if (Math.abs(u.vz) > 0.15) this.events.push({ unit: n, kind: 'bump', audio: { speed: Math.abs(u.vz) } })
          u.vz *= -0.25
        }
        if (Math.hypot(u.x - 1.16, u.z) < 0.13) {
          u.finished = true; u.running = false; u.vx = u.vz = 0
          u.best = u.best ? Math.min(u.best, u.time) : u.time
          this.events.push({ unit: n, kind: 'score', text: `Finished in ${u.time.toFixed(2)} s` }); break
        }
      }
    })
  }
  readout(n: number) { const u = this.units[n]; return `${u.running ? 'Run' : u.finished ? 'Finished' : `${u.kind ? 'Bend' : 'Straight'} ${u.turn * 90}°`} · ${u.time.toFixed(1)} s${u.best ? ` · best ${u.best.toFixed(1)}` : ''}` }
}

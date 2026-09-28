/** Four rod stations share one ball. With two phones, each also drives its vacant team station. */
import { Controller } from '@obpal/core'
import { Machine, action, timestep } from './common'
import { axis, clamp, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const FOOTBALL_SPEC: DeviceSpec = {
  category: 'games',
  id: 'football', name: 'Table football', unit: 'Station', units: 4,
  unitNames: ['Amber defence', 'Blue defence', 'Amber attack', 'Blue attack'], kind: 'Game',
  blurb: 'Slide the rods, spin to kick and play doubles on one shared table.',
  teaches: 'Two sticks or touch drags operate independent rods for two to four players',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Each stick: slide sideways, spin vertically · A serves · 2–4 players',
    'face.trackpad': 'Drag sideways to slide, vertically to spin · two fingers move the second rod · tap serves',
  },
  tray: [{ id: 'serve', label: 'Serve', type: 'button', icon: 'tap' }],
  buttons: { 'key:Space': 'tray:serve', 'media:playpause': 'tray:serve' },
}
export const FOOTBALL = { width: 1, length: 1.7, goal: 0.65, ball: 0.055, height: 1.02, speed: 6 }
export const RODS = [
  { z: 1.45, seat: 0, stick: 0, count: 1 }, { z: 1.05, seat: 0, stick: 1, count: 2 },
  { z: 0.65, seat: 3, stick: 0, count: 3 }, { z: 0.22, seat: 2, stick: 0, count: 3 },
  { z: -0.22, seat: 3, stick: 1, count: 3 }, { z: -0.65, seat: 2, stick: 1, count: 3 },
  { z: -1.05, seat: 1, stick: 1, count: 2 }, { z: -1.45, seat: 1, stick: 0, count: 1 },
]
export const footballMen = (count: number) => Array.from({ length: count }, (_, j) => (j - (count - 1) / 2) * 0.55)
export class FootballLogic extends Machine {
  readonly spec = FOOTBALL_SPEC
  readonly units = Array.from({ length: 4 }, () => ({ x: 0, angle: 0, actions: 0 }))
  readonly rods = RODS.map(() => ({ x: 0, angle: 0, spin: 0 }))
  readonly ball = { x: 0, z: 0, vx: 0, vz: 0, ready: true }
  readonly scores = [0, 0]
  home(n: number) {
    RODS.forEach((r, j) => { if (r.seat === n) Object.assign(this.rods[j], { x: 0, angle: 0, spin: 0 }) })
    Object.assign(this.units[n], { x: 0, angle: 0 })
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta), M = FOOTBALL
    RODS.forEach((r, j) => {
      const own = inputs[r.seat], other = inputs[(r.seat + 2) % 4]
      const i = own ?? other, live = i && !i.quiet ? i : null, rod = this.rods[j]
      const dx = live?.pad ? axis(live.pad.axes[r.stick * 2]) * dt * 1.2 : (r.stick ? live?.pan[0] : live?.drag[0]) ?? 0
      const gesture = live?.pad ? -axis(live.pad.axes[r.stick * 2 + 1]) * dt * 16 : -((r.stick ? live?.pan[1] : live?.drag[1]) ?? 0) * 0.035
      const turn = gesture * (r.seat % 2 ? -1 : 1)
      rod.x = clamp(rod.x + dx * (live?.pad ? 1 : 0.006), -0.3, 0.3)
      rod.spin = dt && turn ? clamp(turn / dt, -20, 20) : 0
      rod.angle = wrapPi(rod.angle + rod.spin * dt)
      if (r.stick === 0) { this.units[r.seat].x = rod.x; this.units[r.seat].angle = rod.angle }
    })
    inputs.forEach((i, n) => {
      if (n < 4 && (i?.presses.includes('serve') || action(i && !i.quiet ? i : null, 'serve'))) {
        this.units[n].actions++
        if (this.ball.ready || Math.hypot(this.ball.vx, this.ball.vz) < 0.2) Object.assign(this.ball, { x: 0, z: 0, ready: false, vx: 0.7, vz: n % 2 ? 1.4 : -1.4 })
      }
    })
    if (!dt || this.ball.ready) return
    const steps = Math.ceil(dt * 300), h = dt / steps, b = this.ball
    for (let s = 0; s < steps; s++) {
      b.x += b.vx * h; b.z += b.vz * h
      b.vx *= Math.exp(-0.24 * h); b.vz *= Math.exp(-0.24 * h)
      RODS.forEach((r, j) => {
        const rod = this.rods[j]
        if (Math.cos(rod.angle) < 0.35) return
        for (const x of footballMen(r.count)) {
          if (Math.abs(b.x - rod.x - x) > 0.12 || Math.abs(b.z - r.z) > 0.105) continue
          const side = b.z >= r.z ? 1 : -1
          this.events.push({ unit: inputs[r.seat] ? r.seat : (r.seat + 2) % 4, kind: 'bump', audio: { at: [b.x, FOOTBALL.height, b.z], speed: Math.max(Math.abs(b.vz), Math.abs(rod.spin) * 0.2), materials: ['plastic', 'wood'] } })
          b.z = r.z + side * 0.106
          b.vz = Math.abs(rod.spin) > 1 ? -Math.sign(rod.spin) * Math.min(6, 1.5 + Math.abs(rod.spin) * 0.3) : side * Math.abs(b.vz) * 0.8
          b.vx += (b.x - rod.x - x) * 4
        }
      })
      if (Math.abs(b.x) > M.width - M.ball) { b.x = Math.sign(b.x) * (M.width - M.ball); b.vx *= -0.9 }
      if (Math.abs(b.z) > M.length - M.ball) {
        if (Math.abs(b.x) < M.goal / 2 - M.ball) {
          const team = b.z < 0 ? 0 : 1
          this.scores[team] = Math.min(999, this.scores[team] + 1)
          this.events.push({ unit: team, kind: 'score', text: `Goal · ${this.scores.join('–')}` })
          Object.assign(b, { x: 0, z: 0, vx: 0, vz: 0, ready: true }); break
        }
        b.z = Math.sign(b.z) * (M.length - M.ball); b.vz *= -0.9
      }
      const k = Math.min(1, M.speed / (Math.hypot(b.vx, b.vz) || 1)); b.vx *= k; b.vz *= k
    }
  }
  readout(n: number) { return `${n % 2 ? 'Blue' : 'Amber'} ${this.scores[n % 2]} · ${this.ball.ready ? 'serve' : 'in play'}` }
}

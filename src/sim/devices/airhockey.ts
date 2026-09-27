/** A shared table: each phone owns one mallet and stays on its side of the centre line. */
import { Controller } from '@obpal/core'
import { Machine, timestep } from './common'
import { clamp } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const AIRHOCKEY_SPEC: DeviceSpec = {
  id: 'airhockey', name: 'Air hockey', unit: 'Mallet', units: 2, unitNames: ['Near mallet', 'Far mallet'], kind: 'Game',
  blurb: 'Slide a mallet from your phone and send the puck into the other player’s goal.',
  teaches: 'Relative touch and absolute pointing control the same two-player table',
  controllers: [Controller.trackpad, Controller.mouse],
  how: {
    'face.trackpad': 'Drag to slide your mallet · stay on your half · tap serves a waiting puck',
    'face.mouse': 'Point to place your mallet on your half · Left serves a waiting puck',
  },
  tray: [{ id: 'serve', label: 'Serve', type: 'button', icon: 'tap' }],
  buttons: { 'media:playpause': 'tray:serve', 'key:Space': 'tray:serve' },
}
export const AIRHOCKEY = { halfWidth: 1, halfLength: 1.6, goal: 0.62, puck: 0.055, mallet: 0.14, malletSpeed: 5, puckSpeed: 7, height: 0.94 }
export interface HockeyMallet { x: number; z: number; tx: number; tz: number; vx: number; vz: number; score: number; hits: number; actions: number }
const startZ = (n: number) => n === 0 ? 1.05 : -1.05

export class AirhockeyLogic extends Machine {
  readonly spec = AIRHOCKEY_SPEC
  readonly units: HockeyMallet[] = [0, 1].map((n) => ({ x: 0, z: startZ(n), tx: 0, tz: startZ(n), vx: 0, vz: 0, score: 0, hits: 0, actions: 0 }))
  readonly puck = { x: 0, z: 0, vx: 0, vz: 0, ready: true }
  private spots: ([number, number] | null)[] = [null, null]
  private zeros: ([number, number] | null)[] = [null, null]
  private angles: [number, number][] = [[0, 0], [0, 0]]
  private angleZeros: [number, number][] = [[0, 0], [0, 0]]
  private hitCooldown = [0, 0]

  home(n: number) {
    Object.assign(this.units[n], { x: 0, z: startZ(n), tx: 0, tz: startZ(n), vx: 0, vz: 0 })
    this.zeros[n] = this.spots[n] ? [...this.spots[n]!] : null
    this.angleZeros[n] = [...this.angles[n]]
    this.hitCooldown[n] = 0
  }

  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta), M = AIRHOCKEY
    this.units.forEach((u, n) => {
      const i = inputs[n], live = i && !i.quiet ? i : null
      if (live?.point) this.angles[n] = [live.point.yaw, live.point.pitch]
      if (live?.recentred) {
        if (live.spot) this.spots[n] = [...live.spot]
        this.home(n)
        return
      }
      if (!live) { u.tx = u.x; u.tz = u.z; u.vx = u.vz = 0 }
      else {
        if (live.spot && live.spot.every(Number.isFinite)) {
          this.spots[n] = [...live.spot]
          const zero = this.zeros[n]
          u.tx = live.spot[0] - (zero?.[0] ?? 0)
          u.tz = zero ? startZ(n) + live.spot[1] - zero[1] : live.spot[1]
        } else if (live.point && !live.point.off) {
          u.tx = (live.point.yaw - this.angleZeros[n][0]) * 0.04
          u.tz = startZ(n) - (live.point.pitch - this.angleZeros[n][1]) * 0.035
        } else if (live.drag.every(Number.isFinite)) {
          u.tx += live.drag[0] * 0.008
          u.tz += live.drag[1] * 0.008
        }
        u.tx = clamp(u.tx, -M.halfWidth + M.mallet, M.halfWidth - M.mallet)
        u.tz = n === 0 ? clamp(u.tz, M.mallet, M.halfLength - M.mallet) : clamp(u.tz, -M.halfLength + M.mallet, -M.mallet)
      }
      if (this.puck.ready && (i?.presses.includes('serve') || live?.presses.some((p) => p === 'pad' || p === 'mouse-left'))) {
        this.puck.ready = false
        this.puck.vx = n === 0 ? 0.4 : -0.4
        this.puck.vz = n === 0 ? -2 : 2
        u.actions++
        this.events.push({ unit: n, kind: 'tick', text: 'Puck served' })
      }
    })
    if (!dt) return
    const steps = Math.ceil(dt * 300), h = dt / steps
    for (let step = 0; step < steps; step++) {
      this.units.forEach((u, n) => {
        const dx = u.tx - u.x, dz = u.tz - u.z, distance = Math.hypot(dx, dz)
        const k = Math.min(1, M.malletSpeed * h / (distance || 1))
        u.vx = dx * k / h; u.vz = dz * k / h
        u.x += u.vx * h; u.z += u.vz * h
        this.hitCooldown[n] = Math.max(0, this.hitCooldown[n] - h)
      })
      const p = this.puck
      const speed = Math.hypot(p.vx, p.vz)
      const k = Math.min(1, M.puckSpeed / (speed || 1)) * Math.exp(-0.08 * h)
      p.vx *= k; p.vz *= k
      p.x += p.vx * h; p.z += p.vz * h
      this.units.forEach((u, n) => {
        let nx = p.x - u.x, nz = p.z - u.z
        const distance = Math.hypot(nx, nz), radius = M.puck + M.mallet
        if (distance >= radius) return
        if (distance > 1e-8) { nx /= distance; nz /= distance } else { nx = 0; nz = n === 0 ? -1 : 1 }
        p.x = u.x + nx * radius; p.z = u.z + nz * radius
        const into = (p.vx - u.vx) * nx + (p.vz - u.vz) * nz
        if (into < 0) {
          p.vx -= 1.92 * into * nx; p.vz -= 1.92 * into * nz
          p.ready = false
          if (!this.hitCooldown[n] && -into > 0.12) {
            u.hits++; this.hitCooldown[n] = 0.1
            this.events.push({ unit: n, kind: 'bump', strength: Math.min(0.8, -into / 6) })
          }
        }
      })
      if (Math.abs(p.x) > M.halfWidth - M.puck) { p.x = Math.sign(p.x) * (M.halfWidth - M.puck); p.vx = -Math.sign(p.x) * Math.abs(p.vx) * 0.96 }
      if (Math.abs(p.z) > M.halfLength - M.puck) {
        if (Math.abs(p.x) < M.goal / 2 - M.puck) {
          if (Math.abs(p.z) > M.halfLength + M.puck) {
            const scorer = p.z > 0 ? 1 : 0
            this.units[scorer].score = Math.min(999, this.units[scorer].score + 1)
            Object.assign(p, { x: 0, z: 0, vx: 0, vz: 0, ready: true })
            this.events.push({ unit: scorer, kind: 'score', text: `Goal · ${this.units[0].score}–${this.units[1].score}` })
          }
        } else { p.z = Math.sign(p.z) * (M.halfLength - M.puck); p.vz = -Math.sign(p.z) * Math.abs(p.vz) * 0.96 }
      }
      const endSpeed = Math.hypot(p.vx, p.vz)
      if (endSpeed > M.puckSpeed) { p.vx *= M.puckSpeed / endSpeed; p.vz *= M.puckSpeed / endSpeed }
    }
  }

  readout(n: number) { return `${this.units[n].score} goals · ${this.units[n].hits} hits${this.puck.ready ? ' · serve' : ''}` }
}

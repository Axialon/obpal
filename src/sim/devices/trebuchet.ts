/** A small counterweight experiment with bounded ballistic shots and per-player target scores. */
import { Controller } from '@obpal/core'
import { Machine, action, timestep } from './common'
import { axis, clamp } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const TREBUCHET_SPEC: DeviceSpec = {
  category: 'space-science',
  id: 'trebuchet', name: 'Trebuchet', unit: 'Trebuchet', units: 2, kind: 'Science',
  blurb: 'Tune the counterweight and release angle, launch down the range and follow the arc to the targets.',
  teaches: 'Two analogue adjustments control a visible ballistic experiment',
  controllers: [Controller.trackpad, Controller.gamepad],
  how: {
    'face.trackpad': 'Drag across: weight; up: release angle · tap launches · Overview shows the arc',
    'face.gamepad': 'Left stick up / down changes counterweight · right stick up / down changes release angle · A launches',
  },
  tray: [{ id: 'launch', label: 'Launch', type: 'button', icon: 'tap' }],
  buttons: { 'key:Space': 'tray:launch', 'media:playpause': 'tray:launch' },
}
export const RANGE_TARGETS = [8, 14, 22]
export const shotSpeed = (weight: number) => Math.sqrt(9.81 * weight * 0.65)
export interface Launcher { weight: number; angle: number; arm: number; phase: 'ready' | 'winding' | 'flight'; clock: number; x: number; y: number; z: number; vy: number; vz: number; score: number; shots: number; actions: number; last: number; arc: [number, number][]; hits: number[]; release: number; power: number }
export class TrebuchetLogic extends Machine {
  readonly spec = TREBUCHET_SPEC
  readonly units: Launcher[] = [0, 1].map(() => ({ weight: 25, angle: 45, arm: -0.65, phase: 'ready', clock: 0, x: 0, y: 1.7, z: -1.8, vy: 0, vz: 0, score: 0, shots: 0, actions: 0, last: 0, arc: [], hits: [], release: 45, power: 25 }))
  home(n: number) { Object.assign(this.units[n], { weight: 25, angle: 45, arm: -0.65, phase: 'ready', clock: 0, x: 0, y: 1.7, z: -1.8, vy: 0, vz: 0, arc: [] }) }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null
      if (i && u.phase === 'ready') {
        u.weight = clamp(u.weight + (i.pad ? -axis(i.pad.axes[1]) * dt * 15 : i.drag[0] * 0.1), 5, 50)
        u.angle = clamp(u.angle + (i.pad ? -axis(i.pad.axes[3]) * dt * 20 : -i.drag[1] * 0.15), 20, 75)
      }
      if (raw?.presses.includes('launch') || action(i, 'launch')) {
        u.actions++
        if (u.phase === 'ready') { u.phase = 'winding'; u.clock = 0; u.arc = []; u.power = u.weight; u.release = u.angle; u.shots++ }
      }
      if (u.phase === 'winding') {
        u.clock += dt; u.arm = -0.65 + Math.min(1, u.clock / 0.65) * 1.8
        if (u.clock >= 0.65) {
          this.events.push({ unit: n, kind: 'tick', audio: { action: 'launch' } })
          u.phase = 'flight'; u.y = 1.7; u.z = -1.8
          const speed = shotSpeed(u.power), a = u.release * Math.PI / 180
          u.vy = Math.sin(a) * speed; u.vz = -Math.cos(a) * speed
        }
      } else if (u.phase === 'flight') {
        // Exact constant-gravity displacement makes the arc independent of frame rate.
        u.y += u.vy * dt - 0.5 * 9.81 * dt * dt; u.vy -= 9.81 * dt; u.z += u.vz * dt
        if (u.arc.length < 240) u.arc.push([u.z, Math.max(0.12, u.y)])
        if (u.y <= 0.12 || u.z < -42) {
          this.events.push({ unit: n, kind: 'bump', audio: { at: [n * 5, 0.12, u.z], speed: Math.abs(u.vy), materials: ['wood', 'tile'] } })
          u.y = 0.12; u.phase = 'ready'; u.vy = u.vz = 0; u.last = -u.z
          const target = RANGE_TARGETS.findIndex(d => Math.abs(d + u.z) < 1.25)
          if (target >= 0) { const points = (target + 1) * 10; u.score = Math.min(9999, u.score + points); if (!u.hits.includes(target)) u.hits.push(target); this.events.push({ unit: n, kind: 'score', text: `Target ${target + 1} · +${points}` }) }
          else this.events.push({ unit: n, kind: 'tick', text: `Landed ${u.last.toFixed(1)} m downrange` })
        }
      }
    })
  }
  readout(n: number) { const u = this.units[n]; return `${u.weight.toFixed(0)} kg · ${u.angle.toFixed(0)}° · ${u.score} points${u.phase !== 'ready' ? ` · ${u.phase}` : u.last ? ` · ${u.last.toFixed(1)} m` : ''}` }
}

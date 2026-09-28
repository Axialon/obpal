/** The studio's instrument seats and damped visual envelopes; sound is scheduled outside the frame loop. */
import { Controller } from '@obpal/core'
import { DRUMS, type MusicEvent } from '../../music'
import type { DeviceInput, DeviceLogic, DeviceSpec } from './types'
import { musicTarget, STATION_NAMES } from '../../music-space'

export const STATIONS = STATION_NAMES
export const STUDIO_SPEC: DeviceSpec = {
  id: 'studio', name: 'Music studio', unit: 'Instrument', units: 8, unitNames: [...STATIONS], kind: 'Music',
  blurb: 'Eight phones. One room. Find a rhythm together.',
  teaches: 'Touch velocity, strike gestures and scale-locked tones over the same live connection.',
  controllers: [Controller.drums, Controller.keys],
  how: { 'face.drums': 'Set position, hold Strike and flick down. Object plays your instrument; Scene reaches the studio.', 'face.keys': 'Play a scale. Hold sustain, tilt to bend, or hold Air and aim across your reach.' },
  tray: [],
}

export class StudioLogic implements DeviceLogic {
  readonly spec = STUDIO_SPEC
  readonly hits = Array.from({ length: 8 }, () => new Float32Array(16))
  readonly counts = Array(8).fill(0) as number[]
  readonly last = Array(8).fill('Ready') as string[]
  readonly aimed = Array.from({ length: 8 }, () => new Set<number>())
  readonly strikes: { seat: number; surface: number; at: number }[] = []
  onHome: ((n: number) => void) | null = null
  play(unit: number, e: MusicEvent, surface?: number) {
    if (!this.hits[unit]) return
    if (e.op === 'hit' || e.op === 'on' || e.op === 'air') {
      const n = surface ?? (e.op === 'hit' ? e.n : e.n % 16)
      this.hits[unit][n] = Math.max(0.25, e.v)
      if (e.op !== 'air') this.counts[unit]++
      this.last[unit] = e.op === 'hit' ? DRUMS[e.n] : e.op === 'air' ? 'Air' : 'Playing'
      if (surface !== undefined) { this.strikes.push({ seat: unit, surface, at: e.at }); if (this.strikes.length > 128) this.strikes.shift() }
    }
  }
  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    for (const h of this.hits) for (let n = 0; n < h.length; n++) h[n] *= Math.exp(-dt * 8)
    this.aimed.forEach(a => a.clear())
    inputs.forEach((i, seat) => {
      if (!i?.space || i.quiet) return
      const target = musicTarget(i.space.aim, i.scope ?? 'object', seat)
      if (target.seat !== seat && inputs[target.seat]) return
      this.aimed[target.seat].add(target.surface)
    })
  }
  home(n: number) { this.hits[n]?.fill(0); this.onHome?.(n); this.last[n] = 'Ready' }
  readout(n: number) { return this.counts[n] ? `${this.counts[n]} · ${this.last[n]}` : 'Ready' }
  drain() { return [] }
}

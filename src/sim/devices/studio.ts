/** The studio's instrument seats and damped visual envelopes; sound is scheduled outside the frame loop. */
import { Controller } from '@obpal/core'
import { DRUMS, scaleNote, type MusicEvent } from '../../music'
import { axis, clamp } from './input'
import { rail } from '../vr/intent'
import type { DeviceInput, DeviceLogic, DeviceSpec } from './types'
import { musicTarget, STATION_NAMES } from '../../music-space'

export const STATIONS = STATION_NAMES
/** Notes are ordered across the visible keys; an octave boundary never wraps to the opposite side. */
export function studioKey(note: number) {
  let nearest = 0
  for (let n = 1; n < 16; n++) if (Math.abs(scaleNote(n, 0, 4, 'pentatonic') - note) < Math.abs(scaleNote(nearest, 0, 4, 'pentatonic') - note)) nearest = n
  return nearest
}
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
  readonly cursor = Array(8).fill(7) as number[]
  onControl: ((n: number, e: MusicEvent) => void) | null = null
  readonly aimed = Array.from({ length: 8 }, () => new Set<number>())
  readonly strikes: { seat: number; surface: number; at: number }[] = []
  onHome: ((n: number) => void) | null = null
  play(unit: number, e: MusicEvent, surface?: number) {
    if (!this.hits[unit]) return
    if (e.op === 'hit' || e.op === 'on' || e.op === 'air') {
      const n = surface ?? (e.op === 'hit' ? e.n : studioKey(e.n))
      if (e.op !== 'hit') this.cursor[unit] = n
      this.hits[unit][n] = Math.max(0.25, e.v)
      if (e.op !== 'air') this.counts[unit]++
      this.last[unit] = e.op === 'hit' ? DRUMS[e.n] : e.op === 'air' ? 'Air' : 'Playing'
      if (surface !== undefined) { this.strikes.push({ seat: unit, surface, at: e.at }); if (this.strikes.length > 128) this.strikes.shift() }
    }
  }
  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    inputs.forEach((i, unit) => {
      if (!i?.pad || i.quiet) return
      this.cursor[unit] = clamp(this.cursor[unit] + axis(i.pad.axes[0]) * rail(i.controlFrame) * dt * 8, 0, 15)
      if (i.padPressed & 1) {
        const drum = unit < 3 || unit === 7, index = Math.round(this.cursor[unit])
        const e: MusicEvent = { op: drum ? 'hit' : 'on', seq: 0, at: 0, uncertainty: 0, n: drum ? index % DRUMS.length : scaleNote(index, 0, 4, 'pentatonic'), v: 0.7, x: 0 }
        this.play(unit, e); this.onControl?.(unit, e)
      }
    })
    for (const h of this.hits) for (let n = 0; n < h.length; n++) h[n] *= Math.exp(-dt * 8)
    this.aimed.forEach(a => a.clear())
    inputs.forEach((i, seat) => {
      if (!i?.space || i.quiet) return
      const target = musicTarget(i.space.aim, i.scope ?? 'object', seat, rail(i.controlFrame))
      if (target.seat !== seat && inputs[target.seat]) return
      this.aimed[target.seat].add(target.surface)
    })
  }
  home(n: number) { this.hits[n]?.fill(0); this.onHome?.(n); this.last[n] = 'Ready' }
  readout(n: number) { return this.counts[n] ? `${this.counts[n]} · ${this.last[n]}` : 'Ready' }
  drain() { return [] }
}

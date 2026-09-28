/** The music value contract and input maths, shared by phone and studio. No audio or DOM. */
export const DRUMS = ['Kick', 'Snare', 'Closed hat', 'Open hat', 'Low tom', 'Mid tom', 'High tom', 'Crash', 'Ride', 'Conga', 'Bongo', 'Cajón', 'Djembe'] as const
export const SCALES = { pentatonic: [0, 2, 4, 7, 9], minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] } as const
export type Scale = keyof typeof SCALES
export const clamp = (n: number, lo = 0, hi = 1) => Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo

export interface MusicEvent {
  op: 'hit' | 'on' | 'off' | 'bend' | 'air' | 'stop' | 'alive'
  seq: number
  /** Capture time translated to the host monotonic epoch; zero until clock sync. */
  at: number
  /** Half the best clock-sync RTT, milliseconds. */
  uncertainty: number
  n: number
  v: number
  x: number
  /** Optional strike-time space snapshot; legacy pad and key events omit it. */
  aim?: [number, number]
  scope?: 'object' | 'scene'
}

/** Reject malformed music before it can allocate voices or schedule nonfinite AudioParams. */
export function readMusic(value: unknown): MusicEvent | null {
  if (typeof value !== 'string' || value.length > 256) return null
  try {
    const e = JSON.parse(value) as MusicEvent
    if (!e || !['hit', 'on', 'off', 'bend', 'air', 'stop', 'alive'].includes(e.op)) return null
    if (![e.seq, e.at, e.uncertainty, e.n, e.v, e.x].every(Number.isFinite)) return null
    if (!Number.isInteger(e.seq) || e.seq < 0 || !Number.isInteger(e.n) || e.n < 0 || e.n > 127 || e.at < 0 || e.uncertainty < 0) return null
    if (e.v < 0 || e.v > 1 || e.x < -1 || e.x > 1 || (e.op === 'hit' && e.n >= DRUMS.length)) return null
    if ((e.op === 'on' || e.op === 'air') && (e.n < 24 || e.n > 108)) return null
    if (e.aim !== undefined || e.scope !== undefined) {
      if (e.op !== 'hit' || !Array.isArray(e.aim) || e.aim.length !== 2 || !e.aim.every(n => Number.isFinite(n) && Math.abs(n) <= 1) || !['object', 'scene'].includes(e.scope ?? '')) return null
    }
    return e
  } catch { return null }
}

/** Default pressure 0.5 is not a velocity sensor. Centre and incoming speed provide a predictable fallback. */
export function padVelocity(pressure: number, width: number, height: number, distance: number, speed = 0) {
  if (pressure > 0 && pressure !== 0.5) return clamp(0.18 + pressure * 0.82, 0.18)
  if (width > 1 && height > 1) return clamp(0.25 + Math.sqrt(width * height) / 36, 0.18)
  return clamp(0.85 - clamp(distance) * 0.45 + clamp(speed / 2) * 0.15, 0.18)
}

/** A peak needs a rising threshold, a falling sample, then a quiet sample before another strike. */
export class StrikeDetector {
  private peak = 0
  private at = 0
  private last = -Infinity
  private armed = true
  reset() { this.peak = 0; this.last = -Infinity; this.armed = true }
  sample(acceleration: number, now: number): number | null {
    if (!Number.isFinite(acceleration) || !Number.isFinite(now)) return null
    if (acceleration < 3 && now - this.last >= 100) this.armed = true
    if (!this.armed || now - this.last < 100) return null
    if (!this.peak && acceleration >= 7) { this.peak = acceleration; this.at = now; return null }
    if (!this.peak) return null
    if (acceleration >= this.peak && now - this.at < 35) { this.peak = acceleration; return null }
    const v = clamp((this.peak - 5) / 28, 0.18)
    this.peak = 0; this.last = now; this.armed = false
    return v
  }
}

/** A downward peak carries its own aim and timestamp, never those of the later falling sample. */
export class SpatialStrike {
  private peak: { acceleration: number; aim: [number, number]; at: number } | null = null
  private began = 0
  private last = -Infinity
  private armed = true
  private sampled = -Infinity
  reset() { this.peak = null; this.last = this.sampled = -Infinity; this.armed = true }
  sample(down: number, aim: readonly [number, number], at: number): { aim: [number, number]; at: number; v: number } | null {
    if (![down, ...aim, at].every(Number.isFinite)) return null
    if (at < this.sampled) return null
    if (at - this.sampled > 80) this.peak = null
    this.sampled = at
    if (down < 3) this.armed = true
    if (!this.armed || at - this.last < 100) return null
    if (!this.peak) {
      if (down >= 7) { this.peak = { acceleration: down, aim: [...aim], at }; this.began = at }
      return null
    }
    if (down >= this.peak.acceleration && at - this.began < 35) { this.peak = { acceleration: down, aim: [...aim], at }; return null }
    const peak = this.peak
    this.peak = null; this.armed = false; this.last = at
    return { aim: peak.aim, at: peak.at, v: clamp((peak.acceleration - 5) / 28, 0.18) }
  }
}

/** Roll chooses left/centre/right, pitch chooses the lower or upper row. */
export function strikeDrum(up: readonly number[], hand = false): number {
  const col = up[0] < -0.3 ? 0 : up[0] > 0.3 ? 2 : 1
  return hand ? [9, 12, 10][col] : (up[2] < -0.35 ? [4, 5, 6] : [0, 1, 2])[col]
}

export function scaleNote(degree: number, root: number, octave: number, scale: Scale): number {
  const steps = SCALES[scale]
  const d = Math.round(degree)
  let note = 12 * (octave + 1 + Math.floor(d / steps.length)) + root + steps[((d % steps.length) + steps.length) % steps.length]
  // Fold by octaves at the voice limits; clamping to an arbitrary note would break the selected scale.
  while (note > 108) note -= 12
  while (note < 24) note += 12
  return note
}
export const frequency = (note: number) => 440 * 2 ** ((clamp(note, 24, 108) - 69) / 12)

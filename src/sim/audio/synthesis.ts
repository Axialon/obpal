/** Deterministic original buffers, generated once per context and reused by every voice. */
import { MATERIALS, materialPair } from './materials'
import type { Material, Texture } from './events'
import type { Space } from './profile'

export const SPACES: Record<Space, { seconds: number; wet: number; cutoff: number }> = {
  room: { seconds: 0.42, wet: 0.13, cutoff: 18000 }, hall: { seconds: 1.15, wet: 0.22, cutoff: 15000 },
  yard: { seconds: 0.16, wet: 0.04, cutoff: 18000 }, underwater: { seconds: 0.75, wet: 0.28, cutoff: 1400 },
  sky: { seconds: 0.06, wet: 0.015, cutoff: 16000 },
}

export class SoundBuffers {
  private cache = new Map<string, AudioBuffer>()
  constructor(private c: BaseAudioContext) {}
  private make(key: string, seconds: number, fn: (t: number, noise: number) => number, channels = 1) {
    const cached = this.cache.get(key)
    if (cached) return cached
    const buffer = this.c.createBuffer(channels, Math.ceil(seconds * this.c.sampleRate), this.c.sampleRate)
    let seed = 913
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0
        data[i] = fn(i / this.c.sampleRate, (seed >>> 0) / 2147483648 - 1)
      }
    }
    this.cache.set(key, buffer)
    return buffer
  }
  impulse(space: Space) {
    const seconds = SPACES[space].seconds
    return this.make(`room:${space}`, seconds, (t, n) => n * Math.exp(-7 * t / seconds) * Math.min(1, t * 2000), 2)
  }
  impact(a: Material, b: Material) {
    const m = materialPair(a, b), seconds = m.decay * 2
    return this.make([a, b].sort().join(':'), seconds, (t, n) => {
      const ring = Math.sin(t * m.hz * Math.PI * 2) + 0.35 * Math.sin(t * m.hz * 2.71 * Math.PI * 2)
      return (ring * (1 - m.noise) * Math.exp(-t * 6 / m.decay) + n * m.noise * Math.exp(-t * 11 / m.decay)) * Math.min(1, t * 1500) * 0.6
    })
  }
  texture(kind: Texture) {
    // Integer frequencies close the loop; noise fades at its seam. Filtering happens on the pooled strip.
    const hz = { motor: 90, engine: 48, rotor: 80, servo: 240, hydraulic: 65, roll: 31, scrape: 120, water: 23, air: 17 }[kind]
    return this.make(`loop:${kind}`, 2, (t, n) => {
      const seam = Math.min(1, t * 80, (2 - t) * 80)
      const turn = t * hz * Math.PI * 2
      if (kind === 'air' || kind === 'water') return n * seam * 0.32 + Math.sin(turn) * 0.04
      if (kind === 'roll' || kind === 'scrape') return n * seam * (0.24 + 0.12 * Math.sin(turn))
      const pulse = kind === 'rotor' ? 0.55 + 0.45 * Math.sin(t * 16 * Math.PI * 2) : 1
      return (Math.sin(turn) * 0.36 + Math.sin(turn * 2) * 0.17 + Math.sin(turn * 4) * 0.07 + n * seam * (kind === 'hydraulic' ? 0.25 : kind === 'motor' ? 0.12 : 0.045)) * pulse
    })
  }
  action(action: string) {
    if (action === 'horn') return this.make('action:horn', 0.3, t => (Math.sin(t * 330 * Math.PI * 2) + Math.sin(t * 440 * Math.PI * 2)) * 0.22 * Math.min(1, t * 100, (0.3 - t) * 100))
    if (action === 'fire' || action === 'launch') return this.impact('wood', 'metal')
    if (action === 'splash') return this.impact('water', 'water')
    const sonar = action === 'sonar', seconds = sonar ? 0.9 : action === 'score' ? 0.3 : 0.07
    return this.make(`action:${action}`, seconds, t => Math.sin(t * (sonar ? 880 : action === 'score' ? 660 : 440) * Math.PI * 2) * Math.exp(-6 * t / seconds) * Math.min(1, t * 600) * 0.45)
  }
  warm(space: Space, texture: Texture) {
    this.impulse(space); this.texture(texture); this.texture('roll'); this.texture('scrape'); this.texture('air'); this.texture('water')
    for (const a of Object.keys(MATERIALS) as Material[]) for (const b of Object.keys(MATERIALS) as Material[]) this.impact(a, b)
    for (const a of ['tick', 'score', 'grab', 'fire', 'launch', 'dock', 'sonar', 'splash', 'horn']) this.action(a)
  }
}

/** Deterministic acoustic excitations, cached per context. Physics modulates the layers in the engine. */
import { materialPair } from './materials'
import type { Material, Texture } from './events'
import type { Space } from './profile'
import type { Machine, Tuning } from './tuning'
import { normaliseBuffer } from './loudness'
import { seamlessLoop } from './samples'

export const SPACES: Record<Space, { seconds: number; wet: number; cutoff: number }> = {
  room: { seconds: 0.32, wet: 0.065, cutoff: 15000 }, hall: { seconds: 0.72, wet: 0.1, cutoff: 13000 },
  yard: { seconds: 0.12, wet: 0.018, cutoff: 16000 }, underwater: { seconds: 0.55, wet: 0.15, cutoff: 1400 },
  sky: { seconds: 0.045, wet: 0.006, cutoff: 16000 },
}
const tau = Math.PI * 2

export class SoundBuffers {
  private cache = new Map<string, AudioBuffer>()
  constructor(private c: BaseAudioContext) {}
  private make(key: string, seconds: number, fn: (t: number, noise: number) => number, channels = 1, target?: number, loop = false) {
    const cached = this.cache.get(key)
    if (cached) return cached
    let buffer = this.c.createBuffer(channels, Math.ceil(seconds * this.c.sampleRate), this.c.sampleRate)
    let seed = 913
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0
        data[i] = fn(i / this.c.sampleRate, (seed >>> 0) / 2147483648 - 1)
      }
    }
    if (loop) buffer = seamlessLoop(this.c, buffer, 0.15)
    if (target !== undefined) normaliseBuffer(buffer, target)
    this.cache.set(key, buffer)
    return buffer
  }
  impulse(space: Space) {
    const seconds = SPACES[space].seconds
    let low = 0
    return this.make(`room:${space}`, seconds, (t, n) => {
      low += 0.24 * (n - low)
      const taps = [0.011, 0.023, 0.037].reduce((sum, at, i) => sum + Math.exp(-(((t - at) * 4500) ** 2)) * (0.7 - i * 0.16), 0)
      return taps + low * Math.exp(-9 * t / seconds) * Math.min(1, t * 500) * 0.18
    }, 2)
  }
  impact(a: Material, b: Material) {
    const m = materialPair(a, b), seconds = m.decay * 2
    let low = 0
    return this.make([a, b].sort().join(':'), seconds, (t, n) => {
      low += 0.28 * (n - low)
      const ring = Math.sin(t * m.hz * tau) + 0.26 * Math.sin(t * m.hz * 2.71 * tau) + 0.12 * Math.sin(t * m.hz * 4.13 * tau)
      return (ring * (1 - m.noise) * Math.exp(-t * 7 / m.decay) + low * m.noise * Math.exp(-t * 12 / m.decay)) * Math.min(1, t * 1500) * 0.6
    }, 1, -20)
  }
  /** Sphere modes are high and short; the track has a lower, separately damped glass ring. */
  glassClack() {
    return this.make('glass:clack', 0.13, (t, n) => {
      const modes = Math.sin(tau * 3150 * t) * Math.exp(-t / 0.013)
        + 0.48 * Math.sin(tau * 4977 * t) * Math.exp(-t / 0.009)
        + 0.22 * Math.sin(tau * 7314 * t) * Math.exp(-t / 0.006)
      return (modes + n * 0.09 * Math.exp(-t / 0.0015)) * Math.min(1, t * 5000)
    }, 1, -23)
  }
  glassTrack() {
    return this.make('glass:track', 0.22, (t, n) => (Math.sin(tau * 2240 * t) * Math.exp(-t / 0.024)
      + 0.38 * Math.sin(tau * 3671 * t) * Math.exp(-t / 0.015)
      + 0.17 * Math.sin(tau * 6048 * t) * Math.exp(-t / 0.011)
      + n * 0.05 * Math.exp(-t / 0.002)) * Math.min(1, t * 3500), 1, -25)
  }
  glassDrag() {
    // A quiet bowed mode, with breath and irregular beating instead of alarm-like harmonics.
    let breath = 0
    return this.make('glass:drag', 4.15, (t, n) => {
      breath += 0.04 * (n - breath)
      const phase = tau * 2700 * t + 0.015 * Math.sin(tau * 3.7 * t)
      return (Math.sin(phase) * 0.7 + Math.sin(phase * 1.013) * 0.14 + Math.sin(phase * 1.587) * 0.07 + breath * 0.04) * (0.85 + 0.1 * Math.sin(tau * 1.7 * t))
    }, 1, -26, true)
  }
  glassRoll() {
    let low = 0
    return this.make('glass:roll', 4.15, (t, n) => {
      low += 0.09 * (n - low)
      return low * 0.38 + (n - low) * 0.025 + Math.sin(tau * 1860 * t) * (0.014 + 0.01 * Math.sin(tau * 31 * t))
    }, 1, -30, true)
  }
  machine(tuning: Tuning, machine: Machine, loaded = false) {
    const hz = machine === 'roll' ? 37 : machine === 'tracks' ? 24 : machine === 'water' ? 23 : machine === 'air' ? 17 : tuning.hz
    let low = 0, smooth = 0
    return this.make(`machine:${machine}:${hz}:${tuning.mesh}:${loaded}`, 4.15, (t, n) => {
      low += 0.075 * (n - low); smooth += 0.013 * (n - smooth)
      const drift = 0.015 * Math.sin(tau * t * 0.75) + 0.007 * Math.sin(tau * t * 1.25)
      const p = tau * hz * t + drift, mesh = p * tuning.mesh
      if (machine === 'servo') {
        // Commutation, reduction-stage mesh, sidebands and load-dependent gear chatter.
        return loaded
          ? 0.23 * Math.sin(mesh) * (0.65 + 0.35 * Math.cos(p * 0.25)) + low * 0.8 + 0.12 * Math.sin(tau * 100 * t) * (0.7 + 0.3 * Math.sin(tau * 27 * t))
          : 0.2 * Math.sin(p) + 0.13 * Math.sin(2 * p) + 0.075 * Math.sin(mesh + 0.12 * Math.sin(p)) + 0.035 * Math.sin(mesh * 2) + low * 0.08
      }
      if (machine === 'drone' || machine === 'propeller' || machine === 'helicopter') {
        const blades = Math.sin(p) + 0.5 * Math.sin(2 * p) + 0.24 * Math.sin(3 * p) + 0.13 * Math.sin(5 * p)
        const beating = machine === 'drone' ? Math.sin(p * 1.021) * 0.13 + Math.sin(p * 0.987) * 0.1 : 0
        const slap = Math.max(0, Math.cos(p)) ** (machine === 'helicopter' ? 14 : 6)
        return loaded ? (n - low) * 0.16 + low * (0.45 + slap * 1.8) + (slap - 0.15) * 0.3
          : blades * 0.17 + beating + 0.025 * Math.sin(mesh) + low * 0.16
      }
      if (machine === 'drive') return loaded ? low * 0.8 + 0.1 * Math.sin(mesh) * Math.sin(p * 0.5) : Math.sin(p) * 0.18 + Math.sin(mesh) * 0.08 + Math.sin(p * 2) * 0.06 + low * 0.1
      if (machine === 'hydraulic') return loaded ? low * 1.1 + (n - low) * 0.08 + Math.sin(mesh) * 0.04 : Math.sin(p) * 0.16 + Math.sin(p * 3) * 0.055 + smooth * 0.8
      if (machine === 'engine') {
        const combustion = Math.sin(p + 0.35 * Math.sin(p / 2)) + 0.45 * Math.sin(2 * p) + 0.2 * Math.sin(3 * p)
        return loaded ? low * (0.8 + 0.4 * Math.sin(p)) + Math.sin(p * 4) * 0.12 : combustion * 0.23 + smooth * 0.3
      }
      if (machine === 'vacuum' || machine === 'fan') return loaded ? low * 1.6 + (n - low) * 0.18 : 0.12 * Math.sin(p) + 0.04 * Math.sin(p * 2) + low * 0.8
      if (machine === 'tracks') return (low + Math.sin(tau * 630 * t) * 0.11) * (0.25 + Math.max(0, Math.sin(p)) ** 12) + smooth * 0.5
      if (machine === 'roll') return low * (0.5 + 0.3 * Math.sin(p) * Math.sin(p * 0.13)) + smooth * 0.6
      if (machine === 'scrape') return (low * 0.8 + (n - low) * 0.05) * (0.7 + 0.25 * Math.sin(p * 0.4))
      if (machine === 'water') return smooth * 2.5 + low * (0.3 + 0.15 * Math.sin(p * 0.07))
      return smooth * 1.4 + low * 0.2
    }, 1, -16, true)
  }
  contact(a: Material, b: Material, foley: AudioBuffer | null) {
    const ring = this.impact(a, b)
    if (!foley) return ring
    const key = `contact:${[a, b].sort().join(':')}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const buffer = this.c.createBuffer(1, Math.max(ring.length, foley.length), this.c.sampleRate)
    const data = buffer.getChannelData(0), resonant = ring.getChannelData(0), body = foley.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (resonant[i] ?? 0) * 0.65 + (body[i] ?? 0) * 0.55
    normaliseBuffer(buffer, -20); this.cache.set(key, buffer)
    return buffer
  }
  texture(kind: Texture) {
    return this.machine({ machine: 'air', category: 'passive', hz: 40, mesh: 3, level: 1, samples: 'none' }, kind === 'water' ? 'water' : 'air')
  }
  action(action: string) {
    if (action === 'glass-launch') return this.make('glass:launch', 0.09, t => Math.sin(tau * 1450 * t) * Math.exp(-t / 0.012) * Math.min(1, t * 2000), 1, -28)
    if (action === 'horn') return this.make('action:horn', 0.3, t => (Math.sin(t * 330 * tau) + Math.sin(t * 440 * tau)) * 0.2 * Math.min(1, t * 100, (0.3 - t) * 100), 1, -20)
    if (action === 'fire') {
      let low = 0
      return this.make('action:fire', 0.65, (t, n) => {
        low += 0.08 * (n - low)
        return (low * Math.exp(-t * 20) + Math.sin(t * 65 * tau) * Math.exp(-t * 9) * 0.5) * Math.min(1, t * 1000)
      }, 1, -20)
    }
    if (action === 'launch') return this.impact('wood', 'metal')
    if (action === 'splash') return this.impact('water', 'water')
    if (action === 'grab' || action === 'dock' || action === 'tick') return this.impact('plastic', 'rubber')
    const sonar = action === 'sonar', seconds = sonar ? 0.9 : 0.3
    return this.make(`action:${action}`, seconds, t => Math.sin(t * (sonar ? 880 : 660) * tau) * Math.exp(-6 * t / seconds) * Math.min(1, t * 600) * 0.45, 1, -22)
  }
  warm(space: Space, tuning: Tuning) {
    this.impulse(space)
    if (tuning.machine !== 'passive') { this.machine(tuning, tuning.machine); this.machine(tuning, tuning.machine, true) }
  }
}

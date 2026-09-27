/** Original procedural voices. Each source has a stop time, an envelope and a bounded seat budget. */
import { clamp, frequency } from '../../music'

export const AUDIO_LIMITS = { seats: 8, voices: 8, gain: 0.16, master: 0.65, ceiling: 0.88, maxSeconds: 12 } as const
export interface ToneSpec { hz: number; decay: number; noise: number; highpass: number; modes: readonly number[] }
export function drumSpec(n: number): ToneSpec {
  if (n === 0) return { hz: 52, decay: 0.42, noise: 0.08, highpass: 2200, modes: [1] }
  if (n === 1) return { hz: 185, decay: 0.19, noise: 0.8, highpass: 1100, modes: [1, 1.47] }
  if ([2, 3, 7, 8].includes(n)) return { hz: n === 8 ? 440 : 610, decay: n === 2 ? 0.075 : n === 3 ? 0.48 : 1.5, noise: 0.48, highpass: n === 8 ? 4200 : 6500, modes: [1, 1.483, 2.17] }
  return { hz: [0, 0, 0, 0, 90, 125, 165, 0, 0, 185, 320, 95, 145][n] ?? 180, decay: n >= 9 ? 0.27 : 0.4, noise: n >= 9 ? 0.12 : 0.03, highpass: 1400, modes: [1, 1.59, 2.14] }
}

export function limiterCurve() {
  const c = new Float32Array(4097)
  for (let i = 0; i < c.length; i++) c[i] = AUDIO_LIMITS.ceiling * Math.tanh((i / (c.length - 1) * 2 - 1) / AUDIO_LIMITS.ceiling)
  return c
}

interface Voice {
  seat: number
  key: number
  gain: GainNode
  sources: AudioScheduledSourceNode[]
  oscillators: OscillatorNode[]
  filter?: BiquadFilterNode
  release(): void
}

export class StudioSound {
  context: AudioContext | null = null
  analyser: AnalyserNode | null = null
  capture: MediaStreamAudioDestinationNode | null = null
  scheduled = 0
  stolen = 0
  private output: GainNode | null = null
  private buses: GainNode[] = []
  private noise: AudioBuffer | null = null
  private voices: Voice[] = []
  private volume = AUDIO_LIMITS.master as number
  private levels = new Float32Array(256)
  get active() { return this.voices.length }
  get running() { return this.context?.state === 'running' }
  async start() {
    if (!this.context) this.build()
    await this.context!.resume()
  }
  private build() {
    const c = this.context = new AudioContext({ latencyHint: 'interactive' })
    const sum = c.createGain(); sum.gain.value = AUDIO_LIMITS.gain
    const compressor = c.createDynamicsCompressor()
    compressor.threshold.value = -18; compressor.knee.value = 12; compressor.ratio.value = 4; compressor.attack.value = 0.003; compressor.release.value = 0.15
    const mix = c.createGain(); const wet = c.createGain(); wet.gain.value = 0.14
    const reverb = c.createConvolver(); reverb.buffer = this.impulse(c, 0.65)
    const limiter = c.createWaveShaper(); limiter.curve = limiterCurve(); limiter.oversample = 'none'
    this.output = c.createGain(); this.output.gain.value = this.volume
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 512
    this.capture = c.createMediaStreamDestination()
    sum.connect(compressor); compressor.connect(mix); compressor.connect(reverb); reverb.connect(wet); wet.connect(mix)
    mix.connect(limiter); limiter.connect(this.output); this.output.connect(this.analyser); this.analyser.connect(c.destination); this.analyser.connect(this.capture)
    this.buses = Array.from({ length: 8 }, (_, n) => {
      const bus = c.createGain(); const pan = c.createStereoPanner(); pan.pan.value = (n % 4 - 1.5) * 0.16
      bus.connect(pan); pan.connect(sum); return bus
    })
    this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate)
    const noise = this.noise.getChannelData(0)
    let seed = 17
    for (let i = 0; i < noise.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; noise[i] = (seed >>> 0) / 2147483648 - 1 }
  }
  private impulse(c: AudioContext, seconds: number) {
    const b = c.createBuffer(2, Math.ceil(c.sampleRate * seconds), c.sampleRate)
    let seed = 92
    for (let ch = 0; ch < 2; ch++) {
      const a = b.getChannelData(ch)
      for (let i = 0; i < a.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; a[i] = ((seed >>> 0) / 2147483648 - 1) * (1 - i / a.length) ** 3 }
    }
    return b
  }
  setVolume(v: number) { this.volume = clamp(v, 0, 0.8); this.output?.gain.setTargetAtTime(this.volume, this.context!.currentTime, 0.02) }
  meter() {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.levels)
    return this.levels.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0)
  }
  private voice(seat: number, key: number, velocity: number, decay: number, held: boolean): Voice {
    const c = this.context!, at = c.currentTime
    const own = this.voices.filter(v => v.seat === seat)
    if (own.length >= AUDIO_LIMITS.voices) { own[0].release(); this.stolen++ }
    const gain = c.createGain(); gain.connect(this.buses[seat])
    const peak = clamp(velocity) * 0.65
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(peak, at + 0.003)
    gain.gain.exponentialRampToValueAtTime(held ? Math.max(0.001, peak * 0.48) : 0.0001, at + decay)
    const sources: AudioScheduledSourceNode[] = [], oscillators: OscillatorNode[] = []
    let released = false
    const v: Voice = { seat, key, gain, sources, oscillators, release: () => {
      if (released) return
      released = true
      const now = c.currentTime
      gain.gain.cancelAndHoldAtTime(now); gain.gain.linearRampToValueAtTime(0, now + 0.025)
      for (const s of sources) s.stop(now + 0.035)
      this.voices = this.voices.filter(x => x !== v)
    } }
    this.voices.push(v)
    this.scheduled++
    return v
  }
  private finish(v: Voice, seconds: number, extra: AudioNode[] = []) {
    const at = this.context!.currentTime
    let remaining = v.sources.length
    for (const s of v.sources) {
      s.start(at); s.stop(at + seconds)
      s.onended = () => {
        s.disconnect()
        if (--remaining === 0) { v.gain.disconnect(); extra.forEach(n => n.disconnect()); this.voices = this.voices.filter(x => x !== v) }
      }
    }
    return at
  }
  hit(seat: number, n: number, velocity: number): number | null {
    if (!this.running) return null
    const c = this.context!, at = c.currentTime, p = drumSpec(n)
    if (n === 2) this.voices.filter(v => v.seat === seat && v.key === -4).forEach(v => v.release())
    const v = this.voice(seat, -n - 1, velocity, p.decay, false)
    const extras: AudioNode[] = []
    for (let i = 0; i < p.modes.length; i++) {
      const o = c.createOscillator(), g = c.createGain()
      o.frequency.value = p.hz * p.modes[i]; g.gain.value = 1 / (p.modes.length * (i + 1))
      if (n === 0) { o.frequency.setValueAtTime(155, at); o.frequency.exponentialRampToValueAtTime(p.hz, at + 0.055) }
      if ([2, 3, 7, 8].includes(n)) {
        const mod = c.createOscillator(), depth = c.createGain()
        mod.frequency.value = p.hz * 1.414 * (i + 1); depth.gain.value = p.hz * 1.6
        mod.connect(depth); depth.connect(o.frequency); v.sources.push(mod); extras.push(depth)
      }
      o.connect(g); g.connect(v.gain); v.sources.push(o); extras.push(g)
    }
    const noise = c.createBufferSource(), filter = c.createBiquadFilter(), ng = c.createGain()
    noise.buffer = this.noise; filter.type = 'highpass'; filter.frequency.value = p.highpass; ng.gain.value = p.noise
    if (n === 0) ng.gain.setTargetAtTime(0.0001, at + 0.005, 0.003)
    noise.connect(filter); filter.connect(ng); ng.connect(v.gain); v.sources.push(noise); extras.push(filter, ng)
    return this.finish(v, p.decay + 0.05, extras)
  }
  note(seat: number, note: number, velocity: number, air = false, oneShot = false): number | null {
    if (!this.running) return null
    const c = this.context!, key = air ? 127 : note
    this.off(seat, key)
    const modal = seat === 4 || seat === 5
    const v = this.voice(seat, key, velocity, modal ? (seat === 5 ? 1.5 : 3) : oneShot ? 0.6 : 0.22, !modal && !oneShot)
    const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = air ? 1800 : 2600; filter.Q.value = 0.5
    filter.connect(v.gain); v.filter = filter
    const modes = modal ? (seat === 5 ? [1, 4, 10] : [1, 2.002, 3.01]) : [1, 1]
    const extras: AudioNode[] = [filter]
    modes.forEach((ratio, i) => {
      const o = c.createOscillator(), g = c.createGain()
      o.type = modal || air ? 'sine' : 'sawtooth'; o.frequency.value = frequency(note) * ratio
      o.detune.value = modal ? 0 : (i ? 5 : -5); g.gain.value = (modal ? 1 / (i + 1) ** 2 : 0.32)
      o.connect(g); g.connect(filter); v.sources.push(o); v.oscillators.push(o); extras.push(g)
    })
    return this.finish(v, modal ? (seat === 5 ? 1.6 : 3.1) : oneShot ? 0.7 : AUDIO_LIMITS.maxSeconds, extras)
  }
  air(seat: number, note: number, brightness: number) {
    let v = this.voices.find(v => v.seat === seat && v.key === 127)
    const at = v ? this.context!.currentTime : this.note(seat, note, 0.55, true)
    v = this.voices.find(v => v.seat === seat && v.key === 127)
    if (v) { for (const o of v.oscillators) o.frequency.setTargetAtTime(frequency(note), this.context!.currentTime, 0.025); v.filter!.frequency.setTargetAtTime(400 + brightness * 6000, this.context!.currentTime, 0.03) }
    return at
  }
  bend(seat: number, x: number) { for (const v of this.voices) if (v.seat === seat && v.key >= 0) for (const o of v.oscillators) o.detune.setTargetAtTime(clamp(x, -1, 1) * 200, this.context!.currentTime, 0.02) }
  off(seat: number, key: number) { this.voices.filter(v => v.seat === seat && v.key === key).forEach(v => v.release()) }
  stop(seat?: number) { this.voices.filter(v => seat === undefined || v.seat === seat).forEach(v => v.release()) }
  async close() { this.stop(); await this.context?.close() }
}

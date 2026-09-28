import { VoiceBudget } from './budget'
import { audioContext } from './context'
import { SoundBus, unit, type Position, type SoundEvent, type Texture } from './events'
import { HapticGate, hapticOf } from './haptics'
import { impactGain } from './materials'
import type { SoundProfile } from './profile'
import { SoundBuffers, SPACES } from './synthesis'

interface Strip { pan: PannerNode; gain: GainNode; filter: BiquadFilterNode; source: AudioBufferSourceNode | null; until: number; loop: boolean }
export type Rumble = (strong: number, weak: number, ms: number, who: string) => void

/** A bounded effects graph. No node construction occurs on the per-frame listener path. */
export class SimSound {
  readonly bus = new SoundBus()
  readonly budget = new VoiceBudget()
  readonly gate = new HapticGate()
  context: AudioContext | null = null
  capture: MediaStreamAudioDestinationNode | null = null
  analyser: AnalyserNode | null = null
  muted = false
  reduced = false
  scheduled = 0
  haptics = 0
  events = 0
  contacts = 0
  updateMs = 0
  private strips: Strip[] = []
  private buffers: SoundBuffers | null = null
  private master: GainNode | null = null
  private sum: GainNode | null = null
  private nodes: AudioNode[] = []
  private last = 0
  private contactsAt = new Map<string, number>()
  private ambientAt: Position = [0, 1, -4]
  constructor(readonly profile: SoundProfile, private rumble: Rumble) {
    this.bus.on(e => { const start = performance.now(); this.event(e); this.updateMs += performance.now() - start })
  }
  get running() { return this.context?.state === 'running' }
  async start() {
    if (!this.context) this.build()
    await this.context!.resume()
  }
  private build() {
    const c = this.context = audioContext(), space = SPACES[this.profile.space]
    this.buffers = new SoundBuffers(c); this.buffers.warm(this.profile.space, this.profile.texture)
    const sum = this.sum = c.createGain(), filter = c.createBiquadFilter(), mix = c.createGain()
    filter.type = 'lowpass'; filter.frequency.value = space.cutoff
    const reverb = c.createConvolver(), wet = c.createGain()
    reverb.buffer = this.buffers.impulse(this.profile.space); wet.gain.value = space.wet
    const compressor = c.createDynamicsCompressor()
    compressor.threshold.value = -15; compressor.knee.value = 8; compressor.ratio.value = 10; compressor.attack.value = 0.003; compressor.release.value = 0.15
    const limiter = c.createWaveShaper(), curve = new Float32Array(2049)
    for (let i = 0; i < curve.length; i++) curve[i] = 0.88 * Math.tanh((i / 1024 - 1) / 0.88)
    limiter.curve = curve
    this.master = c.createGain(); this.analyser = c.createAnalyser(); this.analyser.fftSize = 512
    this.capture = c.createMediaStreamDestination()
    sum.connect(filter); filter.connect(mix); filter.connect(reverb); reverb.connect(wet); wet.connect(mix)
    mix.connect(compressor); compressor.connect(limiter); limiter.connect(this.master); this.master.connect(this.analyser)
    this.analyser.connect(c.destination); this.analyser.connect(this.capture)
    this.nodes = [sum, filter, mix, reverb, wet, compressor, limiter, this.master, this.analyser, this.capture]
    this.strips = this.budget.slots.map(() => {
      const pan = c.createPanner(), gain = c.createGain(), filter = c.createBiquadFilter()
      pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = this.profile.distance; pan.rolloffFactor = 0.8; pan.maxDistance = 150
      gain.gain.value = 0; filter.type = 'lowpass'; filter.frequency.value = 5000
      filter.connect(gain); gain.connect(pan); pan.connect(sum)
      this.nodes.push(pan, gain, filter)
      return { pan, gain, filter, source: null, until: 0, loop: false }
    })
    this.level()
  }
  setMuted(value: boolean) { this.muted = value; this.level(); if (value) this.stop() }
  setReduced(value: boolean) { this.reduced = value; this.level(); this.stop() }
  private level() { this.master?.gain.setTargetAtTime(this.muted ? 0 : this.reduced ? 0.28 : 0.68, this.context!.currentTime, 0.025) }
  private position(s: Strip, p: Position) {
    const t = this.context!.currentTime
    s.pan.positionX.setTargetAtTime(p[0], t, 0.025); s.pan.positionY.setTargetAtTime(p[1], t, 0.025); s.pan.positionZ.setTargetAtTime(p[2], t, 0.025)
  }
  private play(key: string, at: Position, buffer: AudioBuffer, gain: number, priority: number, loop = false, rate = 1, cutoff = 6000) {
    const c = this.context!, time = c.currentTime
    let index = loop ? this.budget.slots.findIndex((s, n) => s.active && s.key === key && this.strips[n].loop) : -1
    if (index >= 0) {
      const strip = this.strips[index]
      strip.until = time + 0.3; strip.gain.gain.setTargetAtTime(gain, time, 0.04)
      strip.source!.playbackRate.setTargetAtTime(rate, time, 0.05); strip.filter.frequency.setTargetAtTime(cutoff, time, 0.04)
      this.budget.slots[index].level = gain; this.position(strip, at)
      return
    }
    index = this.budget.take(key, priority, gain)
    if (index < 0) return
    const s = this.strips[index]
    if (s.source) { s.source.onended = null; s.source.stop(); s.source.disconnect() }
    const source = c.createBufferSource(); source.buffer = buffer; source.loop = loop; source.playbackRate.value = rate
    s.source = source; s.loop = loop; s.until = time + (loop ? 0.3 : buffer.duration / rate)
    s.filter.frequency.value = cutoff; s.gain.gain.cancelScheduledValues(time); s.gain.gain.setValueAtTime(0, time); s.gain.gain.linearRampToValueAtTime(gain, time + 0.004)
    this.position(s, at); source.connect(s.filter); source.start(time)
    if (!loop) source.stop(s.until)
    source.onended = () => { if (s.source === source) { source.disconnect(); s.source = null; this.budget.release(index) } }
    this.scheduled++
  }
  private event(e: SoundEvent) {
    this.events++; if (e.kind === 'contact') this.contacts++
    if (document.hidden) return
    const h = hapticOf(e), now = performance.now()
    if (h && e.who && e.who !== 'host' && this.gate.accept(e.who, e, now)) { this.rumble(h.strong, h.weak, h.ms, e.who); this.haptics++ }
    if (!this.running || this.muted) return
    if (e.kind === 'contact') {
      const last = this.contactsAt.get(e.source) ?? -Infinity
      if (now - last < 70) return
      this.contactsAt.set(e.source, now)
    }
    const strength = e.speed === undefined ? unit(e.strength) : impactGain(e.speed, e.impulse)
    if (strength < 0.015) return
    if (e.kind === 'motor' || e.kind === 'sustain') {
      if (this.reduced) return
      const texture = e.texture ?? this.profile.texture, rpm = unit(e.rpm ?? strength), load = unit(e.load ?? strength)
      this.play(`${e.source}:${e.kind}`, e.at, this.buffers!.texture(texture), strength * (e.kind === 'motor' ? 0.12 : 0.075), 1, true, this.profile.pitch * (0.55 + rpm * 1.6), 800 + load * 3600)
    } else if (e.kind === 'contact' || e.kind === 'footstep') {
      const [a, b] = e.materials ?? this.profile.materials
      this.play(e.source, e.at, this.buffers!.impact(a, b), strength * 0.65, 3)
    } else this.play(e.source, e.at, this.buffers!.action(e.action === 'tick' ? this.profile.action : e.action ?? this.profile.action), strength * 0.4, 2)
  }
  /** Refresh at 20 Hz. Forgotten loops decay rather than surviving a removed object. */
  tick(now: number) {
    if (now - this.last < 50 || !this.running) return
    this.last = now
    if (document.hidden || this.muted) return
    const c = this.context!, start = performance.now()
    for (let i = 0; i < this.strips.length; i++) {
      const s = this.strips[i]
      if (s.source && s.loop && s.until < c.currentTime) {
        s.gain.gain.setTargetAtTime(0, c.currentTime, 0.015); s.source.stop(c.currentTime + 0.06); s.loop = false
      }
    }
    if (!this.reduced && this.profile.id !== 'studio') {
      const texture: Texture = this.profile.space === 'underwater' ? 'water' : 'air'
      this.play('ambience', this.ambientAt, this.buffers!.texture(texture), 0.045, 0, true, 0.8, this.profile.space === 'underwater' ? 400 : 700)
    }
    this.sum!.gain.setTargetAtTime(1 / Math.sqrt(Math.max(1, this.budget.active / 5)), c.currentTime, 0.08)
    this.updateMs += performance.now() - start
  }
  stop() {
    for (let i = 0; i < this.strips.length; i++) {
      const s = this.strips[i]
      if (s.source) { s.source.onended = null; s.source.stop(); s.source.disconnect(); s.source = null }
      this.budget.release(i)
    }
  }
  dispose() { this.stop(); this.gate.clear(); this.contactsAt.clear(); this.nodes.forEach(n => n.disconnect()); this.capture?.stream.getTracks().forEach(t => t.stop()) }
}

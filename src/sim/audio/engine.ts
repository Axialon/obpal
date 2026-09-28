import { VoiceBudget } from './budget'
import { audioContext, listenerPosition, listenerVelocity } from './context'
import { SoundBus, unit, type Position, type SoundEvent, type Texture } from './events'
import { HapticGate, hapticOf } from './haptics'
import { impactGain } from './materials'
import type { SoundProfile } from './profile'
import { SoundBuffers, SPACES } from './synthesis'
import { airCutoff, dopplerRate, machineParameters } from './models'
import { SampleBank } from './samples'
import { profileTrim } from './tuning'

interface Feed { source: AudioBufferSourceNode; gain: GainNode; rate: number }
interface SpatialGroup { key: string; pan: PannerNode; strips: Set<Strip> }
interface Strip {
  pan: PannerNode; filter: BiquadFilterNode; source: AudioBufferSourceNode | null
  group: SpatialGroup | null
  feeds: Feed[]; until: number; loop: boolean; connected: boolean; at: [number, number, number]; velocity: [number, number, number]; cutoff: number; moved: number
}
export type Rumble = (strong: number, weak: number, ms: number, who: string) => void

/** Some supported browsers lack cancelAndHoldAtTime; retain their current value before rescheduling. */
function hold(parameter: AudioParam, time: number) {
  if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(time)
  else { const value = parameter.value; parameter.cancelScheduledValues(time); parameter.setValueAtTime(value, time) }
}

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
  samples: SampleBank | null = null
  samplesReady: Promise<unknown> = Promise.resolve()
  private strips: Strip[] = []
  private groups = new Map<string, SpatialGroup>()
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
    this.buffers = new SoundBuffers(c); this.buffers.warm(this.profile.space, this.profile.tuning)
    this.samples = new SampleBank(c); this.samplesReady = this.samples.preload(this.profile.tuning.samples)
    const sum = this.sum = c.createGain(), filter = c.createBiquadFilter(), mix = c.createGain(), highpass = c.createBiquadFilter()
    highpass.type = 'highpass'; highpass.frequency.value = this.profile.space === 'underwater' ? 35 : 65; highpass.Q.value = 0.5
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
    sum.connect(highpass); highpass.connect(filter); filter.connect(mix); filter.connect(reverb); reverb.connect(wet); wet.connect(mix)
    mix.connect(compressor); compressor.connect(this.master); this.master.connect(limiter); limiter.connect(this.analyser)
    this.analyser.connect(c.destination); this.analyser.connect(this.capture)
    this.nodes = [sum, highpass, filter, mix, reverb, wet, compressor, limiter, this.master, this.analyser, this.capture]
    this.strips = this.budget.slots.map(() => {
      const pan = this.panner(), filter = c.createBiquadFilter()
      filter.type = 'lowpass'; filter.frequency.value = 5000; filter.Q.value = 0.5
      this.nodes.push(pan, filter)
      return { pan, filter, source: null, group: null, feeds: [], until: 0, loop: false, connected: false, at: [0, 0, 0], velocity: [0, 0, 0], cutoff: 5000, moved: 0 }
    })
    this.level()
  }
  setMuted(value: boolean) { this.muted = value; this.level(); if (value) this.stop() }
  setReduced(value: boolean) { this.reduced = value; this.level(); this.stop() }
  private level() { this.master?.gain.setTargetAtTime((this.muted ? 0 : this.reduced ? 0.28 : 0.68) * profileTrim(this.profile.id), this.context!.currentTime, 0.025) }
  private panner() {
    const pan = this.context!.createPanner()
    pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = this.profile.distance; pan.rolloffFactor = 0.8; pan.maxDistance = 150
    return pan
  }
  private disconnect(s: Strip) {
    if (!s.connected) return
    s.filter.disconnect()
    if (s.group) {
      const group = s.group; group.strips.delete(s)
      if (!group.strips.size) {
        group.pan.disconnect(); this.groups.delete(group.key)
        this.nodes.splice(this.nodes.indexOf(group.pan), 1)
      }
      s.group = null
    } else s.pan.disconnect()
    s.connected = false
  }
  private connect(s: Strip, key?: string) {
    if (s.connected && s.group?.key === key) return
    this.disconnect(s)
    if (key) {
      let group = this.groups.get(key)
      if (!group) {
        group = { key, pan: this.panner(), strips: new Set() }
        group.pan.connect(this.sum!); this.nodes.push(group.pan); this.groups.set(key, group)
      }
      group.strips.add(s); s.group = group; s.filter.connect(group.pan)
    } else { s.filter.connect(s.pan); s.pan.connect(this.sum!) }
    s.connected = true
  }
  private position(s: Strip, p: Position, velocity?: Position) {
    const t = this.context!.currentTime
    const dt = t - s.moved
    for (let i = 0; i < 3; i++) {
      const v = velocity?.[i] ?? (dt > 0.01 && dt < 0.3 ? (p[i] - s.at[i]) / dt : 0)
      s.velocity[i] = Number.isFinite(v) && Math.abs(v) < 60 ? v : 0; s.at[i] = p[i]
    }
    s.moved = t
    if (!s.group) {
      s.pan.positionX.setTargetAtTime(p[0], t, 0.025); s.pan.positionY.setTargetAtTime(p[1], t, 0.025); s.pan.positionZ.setTargetAtTime(p[2], t, 0.025)
    }
  }
  private spatial(s: Strip) {
    const t = this.context!.currentTime, distance = Math.hypot(...s.at.map((v, i) => v - listenerPosition[i]))
    const doppler = s.loop ? dopplerRate(s.at, s.velocity, listenerPosition, listenerVelocity, this.profile.space === 'underwater') : 1
    s.filter.frequency.setTargetAtTime(airCutoff(distance, s.cutoff, this.profile.space === 'underwater'), t, 0.06)
    for (const feed of s.feeds) feed.source.playbackRate.setTargetAtTime(feed.rate * doppler, t, 0.05)
  }
  private release(s: Strip, immediate = false) {
    const t = this.context!.currentTime
    for (const feed of s.feeds) {
      feed.source.onended = () => {
        feed.source.disconnect(); feed.gain.disconnect()
        if (!s.source) this.disconnect(s)
      }
      hold(feed.gain.gain, t)
      feed.gain.gain.linearRampToValueAtTime(0, t + (immediate ? 0.003 : 0.018))
      feed.source.stop(t + (immediate ? 0.005 : 0.022))
    }
    s.feeds = []; s.source = null
  }
  private play(key: string, at: Position, buffer: AudioBuffer, gain: number, priority: number, loop = false, rate = 1, cutoff = 6000, layer?: { buffer: AudioBuffer; blend: number; rate: number }, velocity?: Position, group?: string, groupLimit = Infinity) {
    const c = this.context!, time = c.currentTime
    let index = loop ? this.budget.slots.findIndex((s, n) => s.active && s.key === key && this.strips[n].loop) : -1
    if (index >= 0 && this.strips[index].source?.buffer !== buffer) {
      // A recording arriving after unlock replaces its fallback through independent fade envelopes.
      this.release(this.strips[index]); this.budget.release(index); index = -1
    }
    if (index >= 0) {
      const strip = this.strips[index]
      strip.until = time + 0.3
      strip.cutoff = cutoff
      strip.feeds.forEach((feed, n) => {
        feed.rate = n ? layer?.rate ?? rate : rate
        feed.gain.gain.setTargetAtTime(gain * (layer ? Math.sqrt(n ? layer.blend : 1 - layer.blend) : 1), time, 0.05)
      })
      this.budget.slots[index].level = gain; this.budget.slots[index].priority = priority
      this.connect(strip, group); this.position(strip, at, velocity)
      return
    }
    if (group && Number.isFinite(groupLimit)) {
      const members = [...(this.groups.get(group)?.strips ?? [])].filter(s => s.source && s.loop)
      if (members.length >= groupLimit) {
        // Keep the dominant actuator tones; ownership wins, and hysteresis avoids swapping near-equals.
        const indices = members.map(s => this.strips.indexOf(s)).sort((a, b) => this.budget.slots[a].priority - this.budget.slots[b].priority || this.budget.slots[a].level - this.budget.slots[b].level)
        const quiet = indices[0], slot = this.budget.slots[quiet]
        if (priority < slot.priority || priority === slot.priority && gain < slot.level * 1.2) return
        this.release(this.strips[quiet]); this.budget.release(quiet)
      }
    }
    index = this.budget.take(key, priority, gain)
    if (index < 0) return
    const s = this.strips[index]
    if (s.source) this.release(s)
    this.connect(s, group)
    s.loop = loop; s.until = time + (loop ? 0.3 : buffer.duration / rate); s.cutoff = cutoff; s.moved = -Infinity
    const add = (buffer: AudioBuffer, rate: number, amplitude: number, primary: boolean) => {
      amplitude *= gain
      const source = c.createBufferSource(), envelope = c.createGain()
      source.buffer = buffer; source.loop = loop; source.playbackRate.value = rate
      envelope.gain.value = 0; envelope.gain.linearRampToValueAtTime(amplitude, time + (loop ? 0.035 : 0.004))
      source.connect(envelope); envelope.connect(s.filter)
      s.feeds.push({ source, gain: envelope, rate })
      if (primary) s.source = source
      // Decorrelate multiple devices and keep the recorded bed from restarting at one recognisable point.
      source.start(time, loop ? ((this.scheduled * 0.61803398875) % 1) * buffer.duration : 0)
      if (!loop) {
        const end = time + buffer.duration / rate
        envelope.gain.setValueAtTime(amplitude, Math.max(time + 0.005, end - 0.018)); envelope.gain.linearRampToValueAtTime(0, end)
        source.stop(end)
      }
      source.onended = () => {
        source.disconnect(); envelope.disconnect()
        if (s.source === source) { s.source = null; s.feeds = []; this.disconnect(s); this.budget.release(index) }
      }
    }
    add(buffer, rate, layer ? Math.sqrt(1 - layer.blend) : 1, true)
    if (layer) add(layer.buffer, layer.rate, Math.sqrt(layer.blend), false)
    this.position(s, at, velocity); this.spatial(s)
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
      // The small rover's loaded drive layer includes tyre grain, at the same position as its motor.
      if (e.kind === 'sustain' && this.profile.id === 'rover' && this.budget.slots.some(s => s.active && s.key === `${e.source}:motor`)) return
      const tuning = this.profile.tuning, model = machineParameters(tuning, e)
      if (model.machine === 'passive') return
      const recorded = model.machine === 'vacuum' ? this.samples!.get('suction') : null
      const buffer = recorded ?? this.buffers!.machine(tuning, model.machine)
      const rate = model.rate * (1 + Math.sin(this.context!.currentTime * 0.71) * 0.002)
      const layered = !['roll', 'tracks', 'scrape', 'water', 'air'].includes(model.machine)
      this.play(`${e.source}:${e.kind}`, e.at, buffer, model.gain * (e.kind === 'sustain' ? 0.45 * strength : 1), e.who ? e.kind === 'motor' ? 5 : 3 : 1, true, rate, model.cutoff,
        layered ? { buffer: this.buffers!.machine(tuning, model.machine, true), blend: recorded ? 0.12 + model.body * 0.13 : model.body, rate: model.bodyRate } : undefined, e.velocity, e.spatialGroup, model.machine === 'servo' ? 3 : Infinity)
    } else if (e.kind === 'contact' || e.kind === 'footstep') {
      const [a, b] = e.materials ?? this.profile.materials
      const foot = e.kind === 'footstep', bank = this.samples!
      const foley = foot ? bank.get(this.scheduled % 2 ? 'foot-a' : 'foot-b') : a === 'water' || b === 'water' ? null : bank.get('body') ?? bank.get('wood')
      this.play(e.source, e.at, foot && foley ? foley : this.buffers!.contact(a, b, foley), strength * (foot ? 0.55 : 0.65), e.who ? 4 : 2, false, foot ? 0.83 + (this.scheduled % 5) * 0.045 : 0.95 + strength * 0.1, foot ? 2600 : 5500)
    } else {
      const action = e.action === 'tick' ? this.profile.action : e.action ?? this.profile.action
      // Flight starts are already audible as spool-up. A takeoff must not sound like an impact.
      if (action === 'launch' && ['drone', 'helicopter', 'propeller'].includes(this.profile.tuning.machine)) return
      const foley = ['grab', 'dock', 'tick', 'launch'].includes(action) ? this.samples!.get('latch') ?? this.samples!.get('wood') : null
      const fallback = action === 'launch' ? this.buffers!.impact(...this.profile.materials) : this.buffers!.action(action)
      this.play(e.source, e.at, foley ?? fallback, strength * 0.5, e.who ? 4 : 2)
    }
  }
  /** Refresh at 20 Hz. Forgotten loops decay rather than surviving a removed object. */
  tick(now: number) {
    if (now - this.last < 50 || !this.running) return
    this.last = now
    if (document.hidden || this.muted) return
    const c = this.context!, start = performance.now()
    // Update each shared origin once, after all of its joint positions have arrived.
    for (const group of this.groups.values()) {
      let x = 0, y = 0, z = 0
      for (const s of group.strips) { x += s.at[0]; y += s.at[1]; z += s.at[2] }
      const count = group.strips.size
      group.pan.positionX.setTargetAtTime(x / count, c.currentTime, 0.025)
      group.pan.positionY.setTargetAtTime(y / count, c.currentTime, 0.025)
      group.pan.positionZ.setTargetAtTime(z / count, c.currentTime, 0.025)
    }
    for (let i = 0; i < this.strips.length; i++) {
      const s = this.strips[i]
      if (s.source && s.loop && s.until < c.currentTime) {
        for (const feed of s.feeds) { feed.gain.gain.setTargetAtTime(0, c.currentTime, 0.015); feed.source.stop(c.currentTime + 0.06) }
        s.loop = false
      }
      if (s.source) this.spatial(s)
    }
    if (!this.reduced && this.profile.tuning.machine !== 'passive' && (this.profile.space === 'sky' || this.profile.space === 'underwater')) {
      const texture: Texture = this.profile.space === 'underwater' ? 'water' : 'air'
      this.play('ambience', this.ambientAt, this.buffers!.texture(texture), 0.009, 0, true, 0.8, this.profile.space === 'underwater' ? 400 : 700)
    }
    this.sum!.gain.setTargetAtTime(1 / Math.sqrt(Math.max(1, this.budget.active / 5)), c.currentTime, 0.08)
    this.updateMs += performance.now() - start
  }
  stop() {
    for (let i = 0; i < this.strips.length; i++) {
      const s = this.strips[i]
      if (s.source) this.release(s, true)
      this.budget.release(i)
    }
  }
  dispose() { this.stop(); this.samples?.dispose(); this.gate.clear(); this.contactsAt.clear(); this.nodes.forEach(n => n.disconnect()); this.capture?.stream.getTracks().forEach(t => t.stop()) }
}

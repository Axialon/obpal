/**
 * Speakers for the physics harness: a stand-in AudioContext on the harness's clock, whose output is as far behind as a
 * device's (a computer's 50 ms, a Bluetooth link's 200), so the hero's sound (../../src/landing/glass.ts) can be driven
 * exactly as the hero drives it, and every sound it starts or stops read back: when it's heard, whether it's heard at
 * all (stopped at or before its start: never), and whether one was stopped once the output may already have been
 * playing it (cut off: a click). Its clock moves in render quanta; it renders `lag` ahead of what the speakers play.
 *
 * Which knock a sound belongs to: each knock is given its own place left to right (its pan, which nothing else
 * depends on), and every sound made after its panner is that knock's.
 */
export interface Sound { knock: number; start: number; stop: number | null }

export interface Speakers {
  /** Performance time now (ms): set by the harness (performance.now() reads it). */
  now: number
  sounds: Sound[]
  cuts: number
  /** The AudioContext to install. */
  Ctx: new () => unknown
  /** A knock's pan, naming it (0 … 1.6 million). */
  panOf(knock: number): number
  /** When the audio clock's `t` is heard (performance time, ms). */
  heardAt(t: number): number
}

export function speakers(lag: number, base = 0.01): Speakers {
  /** The context's clock is 0 at this performance time (ms); the speakers play its moment `lag` after it's rendered. */
  const T0 = 1000
  const QUANTUM = 128 / 48000
  const sp: Speakers = {
    now: T0, sounds: [], cuts: 0,
    Ctx: undefined as unknown as Speakers['Ctx'],
    panOf: (k) => -0.8 + k * 1e-6,
    heardAt: (t) => T0 + t * 1000,
  }
  const param = () => ({ value: 0, setValueAtTime() { return this }, linearRampToValueAtTime() { return this }, exponentialRampToValueAtTime() { return this } })
  const node = <T extends object>(extra?: T) => ({ connect: (to: unknown) => to, ...extra }) as { connect: (to: unknown) => unknown } & T
  let panner: { pan: { value: number } } | null = null
  class Ctx {
    state = 'running'
    sampleRate = 48000
    baseLatency = base
    outputLatency = lag - base
    destination = node()
    get currentTime() { return Math.floor(((sp.now - T0) / 1000 + lag) / QUANTUM) * QUANTUM }
    getOutputTimestamp() { return { contextTime: (sp.now - T0) / 1000, performanceTime: sp.now } }
    addEventListener() { /* its state never changes here */ }
    resume() { return Promise.resolve() }
    suspend() { this.state = 'suspended'; return Promise.resolve() }
    createWaveShaper() { return node({ curve: null as Float32Array | null, oversample: '' }) }
    createGain() { return node({ gain: param() }) }
    createAnalyser() { return node({ fftSize: 2048, getFloatTimeDomainData: (a: Float32Array) => a.fill(0) }) }
    createBiquadFilter() { return node({ type: '', frequency: param(), Q: param() }) }
    createStereoPanner() { panner = node({ pan: param() }); return panner }
    createOscillator() { return this.source({ type: '', frequency: param() }) }
    createBufferSource() { return this.source({ buffer: null }) }
    createBuffer(_: number, length: number) { return { getChannelData: () => new Float32Array(length) } }
    private source<T extends object>(extra: T) {
      const s: Sound = { knock: panner ? Math.round((panner.pan.value + 0.8) * 1e6) : -1, start: NaN, stop: null }
      sp.sounds.push(s)
      return node({
        ...extra,
        start: (t = 0) => { s.start = Math.max(t, this.currentTime) },
        stop: (t = 0) => {
          if (t <= this.currentTime && s.start <= this.currentTime + this.baseLatency) sp.cuts++
          s.stop = Math.max(t, this.currentTime)
        },
      })
    }
  }
  sp.Ctx = Ctx
  return sp
}

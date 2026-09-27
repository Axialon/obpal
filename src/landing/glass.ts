/**
 * The hero's sound: glass marbles, synthesized (nothing to download). A marble that comes down on a letter or the
 * floor, knocks into a letter's side, taps a button, or clinks against another marble makes the sound of it: louder
 * and brighter the harder it hit, a heavier knock on a letter than a tick on the floor, a ring of glass on glass, and
 * each one heard from where it happened, left to right.
 *
 * Sound is on unless the person switched it off (remembered on this device). Browsers let a page make sound only once
 * the person has clicked, tapped or pressed a key on it (some, like Safari, only from inside that event), so every such
 * gesture anywhere on the page is offered to gesture(), which starts the sound right there, synchronously. Until then
 * the sound is "blocked" and the hero's sound button says so. The state follows the audio context itself, so a system
 * interruption (a call on an iPhone) shows as blocked too, until the next tap.
 */
export type GlassHit = 'letter' | 'floor' | 'marble' | 'button'

/**
 * What the sound is doing: `on` (heard), `blocked` (wanted, but the browser is waiting for a click or a tap), `off`
 * (switched off by the person), `none` (no Web Audio here).
 */
export type SoundState = 'on' | 'blocked' | 'off' | 'none'

/** The sound's state from what the person wants and what the audio context is doing (null: not made yet). */
export function soundState(supported: boolean, wanted: boolean, context: string | null): SoundState {
  if (!supported) return 'none'
  if (!wanted) return 'off'
  return context === 'running' ? 'on' : 'blocked'
}

export interface GlassStats {
  state: SoundState
  /** The audio context's own state (null: not made yet). */
  context: string | null
  /** Hits heard, and hits that came while the sound was blocked or off (or over the rate limit). */
  played: number
  skipped: number
  /** The output's level now and its peak over the last second or so (dBFS; null without the meter, -Infinity silent). */
  levelDb: number | null
  peakDb: number | null
  /** The context's sample rate and its output latency (ms), where known. */
  rate: number | null
  latencyMs: number | null
}

export interface Glass {
  readonly state: SoundState
  /** Heard whenever the state changes. */
  onState: ((s: SoundState) => void) | null
  /** A click, tap or key press on the page: call from inside the event, where a browser lets sound start. */
  gesture(): void
  /** The person's switch (from a click on it, so the sound can start at once): blocked or off turns on, on turns off. */
  toggle(): void
  /** A hit: on what, how hard (0…1), and where (-1 left … 1 right). */
  hit(kind: GlassHit, strength: number, pan: number): void
  stats(): GlassStats
}

/** The partials of each kind of hit: frequency ratios to its pitch, their loudness, and how long each rings (s). */
const VOICES: Record<GlassHit, { pitch: [number, number]; modes: [number, number, number][]; body: number; knock: number; click: number }> = {
  letter: { pitch: [1350, 1650], modes: [[1, 1, 0.07], [2.41, 0.45, 0.045], [3.98, 0.25, 0.03], [5.93, 0.12, 0.02]], body: 0.55, knock: 210, click: 0.5 },
  floor: { pitch: [2100, 2500], modes: [[1, 1, 0.05], [2.76, 0.4, 0.035], [5.4, 0.2, 0.02]], body: 0.25, knock: 210, click: 0.6 },
  marble: { pitch: [2900, 3500], modes: [[1, 1, 0.22], [2.76, 0.55, 0.14], [5.4, 0.3, 0.08], [8.93, 0.14, 0.05]], body: 0, knock: 0, click: 0.35 },
  // A glass button: a short, bright tap over a small hollow knock.
  button: { pitch: [2500, 2800], modes: [[1, 1, 0.055], [2.24, 0.45, 0.035], [3.93, 0.2, 0.02]], body: 0.45, knock: 330, click: 0.75 },
}
const STORE = 'obpal.sound'
/** At most this many hits a second (a tumble of marbles stays a sound, not a roar). */
const MAX_RATE = 28

export function createGlass(opts: { meter?: boolean } = {}): Glass {
  const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  let ctx: AudioContext | null = null
  let out: GainNode | null = null
  let meter: AnalyserNode | null = null
  let wanted = read() !== 'off'
  let shown: SoundState = soundState(!!AC, wanted, null)
  let played = 0, skipped = 0
  let peak = 0, peakAt = 0
  const recent: number[] = []

  function read() { try { return localStorage.getItem(STORE) } catch { return null } }
  const write = (v: string) => { try { localStorage.setItem(STORE, v) } catch { /* private mode: not remembered */ } }

  const glass: Glass = {
    onState: null,
    get state() { return shown },
    gesture() {
      if (!wanted || !AC) return
      start()
    },
    toggle() {
      if (!AC) return
      if (shown === 'on') {
        wanted = false
        write('off')
        void ctx?.suspend().catch(() => undefined)
      } else {
        wanted = true
        write('on')
        start()
      }
      update()
    },
    hit(kind, strength, pan) {
      if (!wanted || !AC) { skipped++; return }
      // The first hit makes the context: where the browser already allows sound (a click on an earlier page of the
      // site, a site the person often plays sound on), it's heard at once; elsewhere it waits for a gesture.
      if (!ctx) make()
      if (!ctx || !out || ctx.state !== 'running') { skipped++; return }
      const now = ctx.currentTime
      while (recent.length && now - recent[0] > 1) recent.shift()
      if (recent.length >= MAX_RATE) { skipped++; return }
      recent.push(now)
      played++
      play(ctx, out, kind, strength, pan)
    },
    stats() {
      let levelDb: number | null = null, peakDb: number | null = null
      if (meter) {
        const level = measure()
        levelDb = db(level)
        peakDb = db(peak)
      }
      const latency = ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0
      return { state: shown, context: ctx?.state ?? null, played, skipped, levelDb, peakDb, rate: ctx?.sampleRate ?? null, latencyMs: ctx ? Math.round(latency * 1000) : null }
    },
  }

  function make() {
    if (ctx || !AC) return
    // Heard when switched on, even with an iPhone's silent switch on (it must be set before the context starts).
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session) try { session.type = 'playback' } catch { /* older Safari */ }
    try { ctx = new AC({ latencyHint: 'interactive' }) } catch { ctx = null; return }
    const c = ctx
    // Loud hits together are held under the ceiling rather than clipped.
    const limit = c.createDynamicsCompressor()
    limit.threshold.value = -14
    limit.ratio.value = 8
    limit.attack.value = 0.002
    limit.release.value = 0.12
    out = c.createGain()
    out.gain.value = 0.62
    out.connect(limit)
    if (opts.meter) {
      // What actually reaches the speakers, for ?debug=audio and the tests.
      meter = c.createAnalyser()
      meter.fftSize = 2048
      limit.connect(meter).connect(c.destination)
    } else limit.connect(c.destination)
    c.addEventListener('statechange', update)
    // Where the browser already allows it, this starts it; elsewhere it stays waiting (and gesture() starts it).
    void c.resume().catch(() => undefined)
    update()
  }

  /** Start the sound now (from inside a gesture): make the context there, resume it, and play one silent sample (iOS). */
  function start() {
    make()
    const c = ctx
    if (!c) return
    if (c.state !== 'running') {
      void c.resume().then(update, () => undefined)
      const s = c.createBufferSource()
      s.buffer = c.createBuffer(1, 1, c.sampleRate)
      s.connect(c.destination)
      s.start(0)
    }
    update()
  }

  function update() {
    const next = soundState(!!AC, wanted, ctx?.state ?? null)
    if (next === shown) return
    shown = next
    glass.onState?.(next)
  }

  const samples = new Float32Array(2048)
  function measure(): number {
    if (!meter) return 0
    meter.getFloatTimeDomainData(samples)
    let sum = 0, top = 0
    for (const v of samples) { sum += v * v; top = Math.max(top, Math.abs(v)) }
    const now = performance.now()
    if (top >= peak || now - peakAt > 1200) { peak = top; peakAt = now }
    return Math.sqrt(sum / samples.length)
  }
  // With the meter on, its peak is kept up to date even between readings (a hit lasts a tenth of a second).
  if (opts.meter) setInterval(() => { if (ctx?.state === 'running') measure() }, 25)

  if (!AC) shown = 'none'
  return glass
}

const db = (v: number) => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity)

function play(ctx: AudioContext, out: GainNode, kind: GlassHit, strength: number, pan: number) {
  const now = ctx.currentTime
  const s = Math.max(0, Math.min(1, strength))
  const v = VOICES[kind]
  const t = now + 0.005
  const hit = ctx.createGain()
  // Loud enough to hear at any strength: a gentle touch is quieter (about 12 dB under a hard landing), never silent.
  hit.gain.value = 0.14 + 0.56 * s * s
  // Harder hits are brighter: more of the high partials get through.
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 2600 + 12000 * s
  let last: AudioNode = hit
  if (typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-0.85, Math.min(0.85, pan))
    hit.connect(p)
    last = p
  }
  last.connect(tone).connect(out)
  const pitch = v.pitch[0] + Math.random() * (v.pitch[1] - v.pitch[0])
  for (const [ratio, amp, ring] of v.modes) {
    const o = ctx.createOscillator()
    o.frequency.value = pitch * ratio * (1 + (Math.random() - 0.5) * 0.012)
    const g = ctx.createGain()
    const len = ring * (0.7 + 0.6 * s)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(amp, t + 0.0015)
    g.gain.exponentialRampToValueAtTime(1e-4, t + len)
    o.connect(g).connect(hit)
    o.start(t)
    o.stop(t + len + 0.02)
  }
  // The weight of it: a short low knock under the ring (none for glass on glass).
  if (v.body > 0) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(v.knock + 60 * s, t)
    o.frequency.exponentialRampToValueAtTime(v.knock * 0.52, t + 0.05)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v.body * (0.4 + 0.6 * s), t + 0.002)
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.06)
    o.connect(g).connect(hit)
    o.start(t)
    o.stop(t + 0.08)
  }
  if (v.click > 0) {
    const n = ctx.createBufferSource()
    n.buffer = noiseFor(ctx)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 2400
    const g = ctx.createGain()
    g.gain.value = v.click * (0.3 + 0.7 * s)
    n.connect(hp).connect(g).connect(hit)
    n.start(t)
  }
}

const noises = new WeakMap<BaseAudioContext, AudioBuffer>()
/** A short burst of noise: the click of the contact itself (one per context). */
function noiseFor(ctx: AudioContext): AudioBuffer {
  let b = noises.get(ctx)
  if (b) return b
  b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.03), ctx.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.18))
  noises.set(ctx, b)
  return b
}

/**
 * The hero's sound: glass marbles, synthesized (nothing to download). Every knock is glass on glass: the marble rings
 * (a heavy glass ball's partials, which aren't harmonics: a clink, not a note), over a short bright click of the
 * contact and a soft low thump for its weight; what it struck adds its own voice: a glass letter's lower ring, a glass
 * button's or the screen's glass pane, another marble's ring; the floor just damps it. How loud follows the energy it
 * came in with (on a decibel scale, so a gentle touch is quiet but heard); harder is brighter and rings longer. Each
 * marble has a pitch of its own, and no two knocks are quite alike; each is heard from where it happened, left to
 * right. When many ring at once, each new one is a little quieter and there are never more than a few at a time.
 *
 * Sound is on unless the person switched it off (remembered on this device). Browsers let a page make sound only once
 * the person has clicked, tapped or pressed a key on it (some, like Safari, only from inside that event), so every such
 * gesture anywhere on the page is offered to gesture(), which starts the sound right there, synchronously. Until then
 * the sound is "blocked" and the hero's sound button says so. The state follows the audio context itself, so a system
 * interruption (a call on an iPhone) shows as blocked too, until the next tap.
 */
export type GlassHit = 'letter' | 'floor' | 'marble' | 'button' | 'wall'

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

/** What became of a knock: heard, or why not (sound blocked or off, too many at once, or none here). */
export type Verdict = 'heard' | 'blocked' | 'off' | 'none' | 'busy'

/** A knock as the ?debug=audio readout lists it: what, how hard (em/s), and what became of it (heard: how loud). */
export interface Knock { kind: GlassHit; speed: number; verdict: Verdict | string; db?: number }

export interface GlassStats {
  state: SoundState
  /** The audio context's own state (null: not made yet), and what an iPhone's audio session is set to. */
  context: string | null
  session: string | null
  /** Hits heard (and of each kind), and hits that came while the sound was blocked or off (or too many at once). */
  played: number
  kinds: Record<GlassHit, number>
  skipped: number
  /** The last few knocks, newest last (with those too soft to sound, noted by the field). */
  log: Knock[]
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
  /**
   * A knock: on what, how fast it came in (em/s), where (-1 left … 1 right), and which marbles (each has its own pitch;
   * two for glass on glass).
   */
  hit(kind: GlassHit, speed: number, pan: number, marbles?: [string, string?]): Verdict
  /** A knock too soft (or too soon) to sound, for the log: the field decided, and says why. */
  note(kind: GlassHit, speed: number, why: string): void
  stats(): GlassStats
}

/** A glass marble's ring: a solid ball's partials (ratios to its pitch), how loud each, how long each rings (s). */
const MARBLE: [number, number, number][] = [[1, 1, 0.55], [1.58, 0.55, 0.36], [2.13, 0.38, 0.25], [2.81, 0.24, 0.16], [3.55, 0.14, 0.1]]
/** A marble's pitch (Hz): a heavy glass ball. Each marble is a little higher or lower, and no knock quite the same. */
const PITCH = 1450
const IDENTITY = 0.08
const DETUNE = 0.015
/**
 * What each kind of knock is struck against: its own ring (ratios to the marble's pitch, loudness, ring), how much of
 * the marble's ring it lets out, the weight of the thump, the click of the contact, and how loud it is overall (so the
 * hardest knock of each kind peaks at its level, measured: a landing on the floor 3 dB under).
 */
const AGAINST: Record<GlassHit, { ring: [number, number, number][]; marble: number; thump: number; click: number; gain: number }> = {
  // A glass letter: a deeper ring of its own under the marble's clink, and a solid thump.
  letter: { ring: [[0.52, 0.8, 0.2], [0.91, 0.4, 0.12], [1.37, 0.22, 0.07]], marble: 0.8, thump: 0.9, click: 0.55, gain: 1.15 },
  // The floor: no ring of its own, the marble's damped short, a soft thump.
  floor: { ring: [], marble: 0.5, thump: 0.7, click: 0.45, gain: 1.38 },
  // Two marbles: both ring, long and clear (the second one's own pitch is added where it's known).
  marble: { ring: [], marble: 1, thump: 0.2, click: 0.7, gain: 0.78 },
  // A glass button: a small pane, bright and short.
  button: { ring: [[1.31, 0.7, 0.07], [2.97, 0.28, 0.04]], marble: 0.7, thump: 0.55, click: 0.75, gain: 1.11 },
  // The edge of the screen: a tap on its glass.
  wall: { ring: [[1.62, 0.65, 0.06], [3.8, 0.25, 0.035]], marble: 0.75, thump: 0.45, click: 0.8, gain: 1.08 },
}
/**
 * How loud (peak dBFS at the speakers, heard from the middle): the gentlest knock (from this speed, em/s: a phone
 * tipped 2°) and the hardest (from this one).
 */
const SOFT_DB = -30
const HARD_DB = -14
const SOFT_V = 0.2
const HARD_V = 6
/** Never more than this many rings at once; each new one is quieter the more are ringing. */
const MAX_VOICES = 8
/**
 * Knocks together are held under the ceiling rather than clipped: from this level (as a gain, -6 dBFS) the output bends
 * smoothly toward CEILING. A curve, not a compressor: a Web Audio compressor looks 6 ms ahead (every knock would come
 * that much later) and lifts everything under its threshold by its makeup gain; under the knee this is exactly level.
 */
const KNEE = 0.5
const CEILING = 0.9
const STORE = 'obpal.sound'

/** How hard a knock is, 0 (the gentlest heard) … 1 (the hardest): the energy it came in with, on a log scale. */
const hardness = (speed: number) => Math.max(0, Math.min(1, Math.log(Math.max(speed, 1e-3) / SOFT_V) / Math.log(HARD_V / SOFT_V)))

/** How loud a knock is (peak dBFS): from the energy it came in with, on a decibel scale. */
export function knockDb(speed: number): number {
  return SOFT_DB + (HARD_DB - SOFT_DB) * hardness(speed)
}

/** A marble's own pitch, from its name: the same every time, a few percent either way. */
export function pitchOf(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  return PITCH * (1 + IDENTITY * (((h >>> 0) % 2001) / 1000 - 1))
}

export function createGlass(opts: { meter?: boolean } = {}): Glass {
  const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  let ctx: AudioContext | null = null
  let out: GainNode | null = null
  let meter: AnalyserNode | null = null
  let wanted = read() !== 'off'
  let shown: SoundState = soundState(!!AC, wanted, null)
  let played = 0, skipped = 0
  const kinds: Record<GlassHit, number> = { letter: 0, floor: 0, marble: 0, button: 0, wall: 0 }
  const log: Knock[] = []
  let peak = 0, peakAt = 0
  /** When each ringing knock ends (the context's clock). */
  let ringing: number[] = []

  function read() { try { return localStorage.getItem(STORE) } catch { return null } }
  const write = (v: string) => { try { localStorage.setItem(STORE, v) } catch { /* private mode: not remembered */ } }
  const remember = (k: Knock) => { log.push(k); if (log.length > 8) log.shift() }
  const session = () => (navigator as Navigator & { audioSession?: { type: string } }).audioSession

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
    hit(kind, speed, pan, marbles) {
      const verdict = ((): Verdict => {
        if (!AC) return 'none'
        if (!wanted) return 'off'
        // The first hit makes the context: where the browser already allows sound (a click on an earlier page of the
        // site, a site the person often plays sound on), it's heard at once; elsewhere it waits for a gesture.
        if (!ctx) make()
        if (!ctx || !out || ctx.state !== 'running') return 'blocked'
        ringing = ringing.filter((t) => t > ctx!.currentTime)
        if (ringing.length >= MAX_VOICES) return 'busy'
        return 'heard'
      })()
      if (verdict !== 'heard') { skipped++; remember({ kind, speed, verdict }); return verdict }
      played++
      kinds[kind]++
      // Each new knock gives way a little to those still ringing.
      const db = knockDb(speed) - 10 * Math.log10(1 + 0.5 * ringing.length)
      ringing.push(playKnock(ctx!, out!, kind, speed, db, pan, marbles))
      remember({ kind, speed, verdict, db: Math.round(db) })
      return verdict
    },
    note(kind, speed, why) { remember({ kind, speed, verdict: why }) },
    stats() {
      let levelDb: number | null = null, peakDb: number | null = null
      if (meter) {
        const level = measure()
        levelDb = db(level)
        peakDb = db(peak)
      }
      const latency = ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0
      return {
        state: shown, context: ctx?.state ?? null, session: session()?.type ?? null, played, kinds: { ...kinds }, skipped, log: [...log],
        levelDb, peakDb, rate: ctx?.sampleRate ?? null, latencyMs: ctx ? Math.round(latency * 1000) : null,
      }
    },
  }

  function make() {
    if (ctx || !AC) return
    // Heard when switched on, even with an iPhone's silent switch on (it must be set before the context starts).
    const s = session()
    if (s) try { s.type = 'playback' } catch { /* older Safari */ }
    try { ctx = new AC({ latencyHint: 'interactive' }) } catch { ctx = null; return }
    const c = ctx
    // Loud knocks together are held under the ceiling rather than clipped, with no delay.
    const limit = c.createWaveShaper()
    limit.curve = ceiling()
    limit.oversample = 'none'
    out = c.createGain()
    out.gain.value = 1
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
      // The session again, in case something set it back (it only takes from a gesture on some iPhones).
      const s = session()
      if (s && s.type !== 'playback') try { s.type = 'playback' } catch { /* older Safari */ }
      void c.resume().then(update, () => undefined)
      const b = c.createBufferSource()
      b.buffer = c.createBuffer(1, 1, c.sampleRate)
      b.connect(c.destination)
      b.start(0)
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
  // With the meter on, its peak is kept up to date even between readings (a knock lasts a fraction of a second).
  if (opts.meter) setInterval(() => { if (ctx?.state === 'running') measure() }, 25)

  if (!AC) shown = 'none'
  return glass
}

const db = (v: number) => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity)

/**
 * The output's curve (a wave shaper's, over its input's -1 … 1; beyond, it holds the ends): level up to KNEE, then
 * bending smoothly (a tanh) toward CEILING.
 */
export function ceiling(n = 4097): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n)
  const room = CEILING - KNEE
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x)
    c[i] = a <= KNEE ? x : Math.sign(x) * (KNEE + room * Math.tanh((a - KNEE) / room))
  }
  return c
}

/**
 * One knock, played into `out` at `level` (dBFS for a knock alone): returns when it's done ringing (the context's clock).
 * Exported to measure it: rendered offline, its peak is how loud it is.
 */
export function playKnock(ctx: BaseAudioContext, out: AudioNode, kind: GlassHit, speed: number, level: number, pan: number, marbles?: [string, string?]): number {
  // Now: a knock is heard in the same frame it's seen (the output's own latency apart).
  const t = ctx.currentTime
  const s = hardness(speed)
  const a = AGAINST[kind]
  const hit = ctx.createGain()
  hit.gain.value = 10 ** (level / 20) * a.gain
  // Harder is brighter, never harsh.
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 3200 + 6500 * Math.sqrt(s)
  tone.Q.value = 0.5
  let last: AudioNode = hit
  if (typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-0.85, Math.min(0.85, pan))
    hit.connect(p)
    last = p
  }
  last.connect(tone).connect(out)
  let end = t
  const partials = (pitch: number, modes: [number, number, number][], gain: number, longer: number) => {
    for (const [ratio, amp, ring] of modes) {
      const o = ctx.createOscillator()
      o.frequency.value = pitch * ratio * (1 + (Math.random() - 0.5) * 2 * DETUNE)
      const g = ctx.createGain()
      const len = ring * longer * (0.55 + 0.75 * s)
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(amp * gain, t + 0.001)
      g.gain.exponentialRampToValueAtTime(1e-4, t + len)
      o.connect(g).connect(hit)
      o.start(t)
      o.stop(t + len + 0.02)
      end = Math.max(end, t + len + 0.02)
    }
  }
  // The marble's own ring (both marbles', glass on glass), and what it struck.
  const pitch = marbles?.[0] ? pitchOf(marbles[0]) : PITCH * (1 + (Math.random() - 0.5) * IDENTITY)
  const damp = kind === 'floor' ? 0.35 : 1
  partials(pitch, MARBLE, a.marble * 0.5, damp)
  if (kind === 'marble') partials(marbles?.[1] ? pitchOf(marbles[1]) : pitch * 1.07, MARBLE, 0.45, 1)
  partials(pitch, a.ring, 0.5, 1)
  // The weight of it: a soft low thump, falling in pitch.
  if (a.thump > 0) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(125 + 40 * s, t)
    o.frequency.exponentialRampToValueAtTime(62, t + 0.07)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(a.thump * (0.35 + 0.65 * s) * 0.55, t + 0.003)
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.09)
    o.connect(g).connect(hit)
    o.start(t)
    o.stop(t + 0.1)
  }
  // The contact itself: a short bright click.
  if (a.click > 0) {
    const n = ctx.createBufferSource()
    n.buffer = clickFor(ctx)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 3000 + 2000 * s
    const g = ctx.createGain()
    g.gain.value = a.click * (0.25 + 0.75 * s) * 0.6
    n.connect(hp).connect(g).connect(hit)
    n.start(t)
  }
  return end
}

const clicks = new WeakMap<BaseAudioContext, AudioBuffer>()
/** A few milliseconds of fading noise: the click of glass meeting glass (one per context). */
function clickFor(ctx: BaseAudioContext): AudioBuffer {
  let b = clicks.get(ctx)
  if (b) return b
  b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.012), ctx.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.12))
  clicks.set(ctx, b)
  return b
}

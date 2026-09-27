import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ceiling, createGlass, knockDb, pitchOf, soundState, type Foreseen, type SoundState } from '../src/landing/glass'

/**
 * A stand-in AudioContext that keeps a browser's autoplay rule: it may start only while `allowed` is true (inside a
 * click or a tap, or where the browser already allows sound). It counts the voices started, so a hit is heard or not,
 * and notes what an iPhone's audio session was set to when it was made.
 */
const env = {
  allowed: false, made: 0, voices: 0, last: null as FakeContext | null, session: null as string | null,
  /** When each voice was started (the context's clock), and the output's timestamp (null: the browser has none). */
  starts: [] as number[], stamp: null as { contextTime: number; performanceTime: number } | null,
  /**
   * Every source made (a voice, the click's noise): when it was started and stopped (the context's clock; a stop at or
   * before its start: never heard). `cuts`: sources stopped once the output may already be playing them (a click).
   */
  sources: [] as Src[], cuts: 0,
}
interface Src { start: number | null; stop: number | null }
/** The sources heard of those made from `from` on: started, and not stopped at or before their start. */
const heardFrom = (from: number) => env.sources.slice(from).filter((q) => q.start !== null && q.start > 0 && (q.stop === null || q.stop > q.start))
class FakeContext {
  state = 'suspended'
  sampleRate = 48000
  currentTime = 0
  baseLatency = 0.005
  outputLatency = 0.01
  destination = node()
  private listeners: (() => void)[] = []
  constructor() {
    env.made++
    env.last = this
    env.session = (globalThis.navigator as Navigator & { audioSession?: { type: string } } | undefined)?.audioSession?.type ?? null
    if (env.allowed) this.state = 'running'
  }
  addEventListener(_: string, fn: () => void) { this.listeners.push(fn) }
  set(s: string) { if (s !== this.state) { this.state = s; for (const fn of this.listeners) fn() } }
  resume() {
    // Not allowed: the promise waits (as Chrome's does) and the context stays suspended.
    if (!env.allowed) return new Promise<void>(() => undefined)
    this.set('running')
    return Promise.resolve()
  }
  suspend() { this.set('suspended'); return Promise.resolve() }
  createWaveShaper() { return node({ curve: null as Float32Array | null, oversample: '' }) }
  createGain() { return node({ gain: param() }) }
  createAnalyser() { return node({ fftSize: 2048, getFloatTimeDomainData: (a: Float32Array) => a.fill(0) }) }
  createBiquadFilter() { return node({ type: '', frequency: param(), Q: param() }) }
  createStereoPanner() { return node({ pan: param() }) }
  createOscillator() { return this.source({ type: '', frequency: param() }, true) }
  getOutputTimestamp() { return env.stamp ?? {} }
  createBufferSource() { return this.source({ buffer: null }, false) }
  private source<T extends object>(extra: T, voice: boolean) {
    const q: Src = { start: null, stop: null }
    env.sources.push(q)
    return node({
      ...extra,
      start: (t = 0) => { if (voice) { env.voices++; env.starts.push(t) } q.start = t },
      stop: (t = 0) => {
        // Stopped now while the output may already be playing it (it renders a callback ahead): cut off, a click.
        if (t <= this.currentTime && q.start !== null && q.start <= this.currentTime + this.baseLatency) env.cuts++
        q.stop = Math.max(t, this.currentTime)
      },
    })
  }
  createBuffer(_: number, length: number) { return { getChannelData: () => new Float32Array(length) } }
}
function param() { return { value: 0, setValueAtTime() { return this }, linearRampToValueAtTime() { return this }, exponentialRampToValueAtTime() { return this } } }
function node<T extends object>(extra?: T) {
  const n = { connect: (to: unknown) => to, ...extra }
  return n as typeof n & T
}

describe('the sound state', () => {
  it('is on only while the audio context runs, off when switched off, none without Web Audio', () => {
    expect(soundState(true, true, 'running')).toBe('on')
    expect(soundState(true, true, 'suspended')).toBe('blocked')
    expect(soundState(true, true, 'interrupted')).toBe('blocked')
    expect(soundState(true, true, null)).toBe('blocked')
    expect(soundState(true, false, 'running')).toBe('off')
    expect(soundState(false, true, 'running')).toBe('none')
  })
})

describe('a knock: how loud, and at what pitch', () => {
  it('is as loud as the energy it came in with, on a decibel scale: -30 dBFS the gentlest heard (2° of tilt), -14 the hardest', () => {
    expect(knockDb(0.2)).toBeCloseTo(-30)
    expect(knockDb(0.05)).toBeCloseTo(-30)
    expect(knockDb(6)).toBeCloseTo(-14)
    expect(knockDb(40)).toBeCloseTo(-14)
    // Twice as fast is the same step louder anywhere in between (a few dB: a gentle knock is quiet, but heard).
    const step = knockDb(1) - knockDb(0.5)
    expect(knockDb(4) - knockDb(2)).toBeCloseTo(step)
    expect(step).toBeGreaterThan(3)
    expect(step).toBeLessThan(3.5)
  })
  it('many at once are held under the ceiling, smoothly, and a knock alone (under -6 dBFS) passes exactly', () => {
    const c = ceiling(2001)
    const at = (x: number) => c[Math.round(((x + 1) / 2) * 2000)]
    for (const x of [0, 0.05, 0.2, 0.5]) { expect(at(x)).toBeCloseTo(x, 3); expect(at(-x)).toBeCloseTo(-x, 3) }
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1])
    expect(at(1)).toBeLessThan(0.9)
    expect(at(1)).toBeGreaterThan(0.8)
  })
  it('each marble rings at a pitch of its own (the same every time), within 8% of a heavy glass ball\'s 1450 Hz', () => {
    const names = ['me', 'a1b2c3', 'k9x7', 'phone-1', 'phone-2', 'zq']
    const pitches = names.map(pitchOf)
    for (const p of pitches) {
      expect(p).toBeGreaterThanOrEqual(1450 * 0.92)
      expect(p).toBeLessThanOrEqual(1450 * 1.08)
    }
    expect(names.map(pitchOf)).toEqual(pitches)
    expect(new Set(pitches.map((p) => Math.round(p))).size).toBe(names.length)
  })
})

describe('the glass sound', () => {
  const seen: SoundState[] = []
  beforeEach(() => {
    Object.assign(env, { allowed: false, made: 0, voices: 0, last: null, session: null, starts: [], stamp: null, sources: [], cuts: 0 })
    seen.length = 0
    ;(globalThis as { AudioContext?: unknown }).AudioContext = FakeContext
  })
  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    vi.unstubAllGlobals()
  })
  const make = () => { const g = createGlass(); g.onState = (s) => seen.push(s); return g }
  /** A click or a tap: the browser allows sound for the length of the event. */
  const gesture = (fn: () => void) => { env.allowed = true; fn(); env.allowed = false }

  it('is wanted from the start, and blocked until the first click or tap; hits before it are skipped, not queued', () => {
    const g = make()
    expect(g.state).toBe('blocked')
    expect(g.hit('letter', 0.8, 0)).toBe('blocked')
    expect(g.hit('floor', 0.3, 0)).toBe('blocked')
    expect(env.made).toBe(1)
    expect(env.voices).toBe(0)
    expect(g.stats()).toMatchObject({ state: 'blocked', context: 'suspended', played: 0, skipped: 2 })
    gesture(() => g.gesture())
    expect(g.state).toBe('on')
    expect(seen).toEqual(['on'])
    expect(g.hit('letter', 0.8, 0)).toBe('heard')
    expect(env.voices).toBeGreaterThan(0)
    expect(g.stats()).toMatchObject({ played: 1, skipped: 2, latencyMs: 15 })
  })
  it('starts at once where the browser already allows sound (no gesture needed)', () => {
    env.allowed = true
    const g = make()
    g.hit('marble', 0.5, 0.2, ['me', 'p1'])
    expect(g.state).toBe('on')
    expect(env.voices).toBeGreaterThan(0)
  })
  it('only a gesture offered inside the event starts it (one after an await is too late)', async () => {
    const g = make()
    g.gesture()
    await Promise.resolve()
    expect(g.state).toBe('blocked')
    gesture(() => g.gesture())
    expect(g.state).toBe('on')
  })
  it('asks an iPhone to play (heard with the silent switch on) before it makes the context, and again from a tap', () => {
    const session = { type: 'auto' }
    vi.stubGlobal('navigator', { audioSession: session })
    const g = make()
    g.hit('wall', 1, 0)
    expect(env.session).toBe('playback')
    expect(g.stats().session).toBe('playback')
    // Something set it back: the next tap sets it again, and starts the sound.
    session.type = 'ambient'
    gesture(() => g.gesture())
    expect(session.type).toBe('playback')
    expect(g.state).toBe('on')
  })
  it('without an audio session (every browser but Safari) it plays all the same', () => {
    vi.stubGlobal('navigator', {})
    const g = make()
    gesture(() => g.gesture())
    expect(g.hit('wall', 1, 0)).toBe('heard')
    expect(g.stats().session).toBe(null)
  })
  it('the button: blocked turns on, on turns off, off turns on', () => {
    const g = make()
    gesture(() => g.toggle())
    expect(g.state).toBe('on')
    gesture(() => g.toggle())
    expect(g.state).toBe('off')
    // Off: hits are skipped, and a click elsewhere on the page doesn't bring it back.
    gesture(() => g.gesture())
    expect(g.hit('letter', 1, 0)).toBe('off')
    expect(g.state).toBe('off')
    expect(g.stats().skipped).toBe(1)
    gesture(() => g.toggle())
    expect(g.state).toBe('on')
    expect(seen).toEqual(['on', 'off', 'on'])
  })
  it('a system interruption (a call, on an iPhone) shows as blocked, and the next tap brings it back', () => {
    const g = make()
    gesture(() => g.gesture())
    env.last!.set('interrupted')
    expect(g.state).toBe('blocked')
    g.hit('letter', 1, 0)
    expect(g.stats().skipped).toBe(1)
    gesture(() => g.gesture())
    expect(g.state).toBe('on')
    expect(seen).toEqual(['on', 'blocked', 'on'])
  })
  it('never rings more than 8 knocks at once, and each new one gives way to those still ringing', () => {
    env.allowed = true
    const g = make()
    const verdicts = Array.from({ length: 11 }, () => g.hit('floor', 3, 0))
    expect(verdicts.slice(0, 8)).toEqual(Array(8).fill('heard'))
    expect(verdicts.slice(8)).toEqual(['busy', 'busy', 'busy'])
    expect(g.stats()).toMatchObject({ played: 8, skipped: 3 })
    // Once they've rung out, a knock is heard at its own level again; with others ringing, each is quieter.
    env.last!.currentTime = 10
    g.hit('floor', 3, 0)
    g.hit('floor', 3, 0)
    g.hit('floor', 3, 0)
    const dbs = g.stats().log.slice(-3).map((k) => k.db!)
    expect(dbs[0]).toBe(Math.round(knockDb(3)))
    expect(dbs[1]).toBeLessThan(dbs[0])
    expect(dbs[2]).toBeLessThan(dbs[1])
  })
  it('lists the last knocks for ?debug=audio: heard (how loud) or why not, the field\'s own notes too', () => {
    const g = make()
    g.hit('wall', 0.5, 0)
    g.note('wall', 0.2, 'under 0.3 em/s')
    gesture(() => g.gesture())
    g.hit('wall', 0.5, -1, ['me'])
    const log = g.stats().log
    expect(log.map((k) => k.verdict)).toEqual(['blocked', 'under 0.3 em/s', 'heard'])
    expect(log.map((k) => k.kind)).toEqual(['wall', 'wall', 'wall'])
    expect(log[2].db).toBe(Math.round(knockDb(0.5)))
    for (let i = 0; i < 20; i++) g.note('floor', 0.1, 'under 0.6 em/s')
    expect(g.stats().log).toHaveLength(8)
  })
  it('every kind of hit makes a sound, a gentle one too, and is counted as its kind (a wall: the edge of the screen)', () => {
    env.allowed = true
    const g = make()
    for (const kind of ['letter', 'floor', 'marble', 'button', 'wall'] as const) {
      const before = env.voices
      g.hit(kind, 0, 0)
      expect(env.voices).toBeGreaterThan(before)
    }
    g.hit('wall', 1, -1)
    expect(g.stats().kinds).toEqual({ letter: 1, floor: 1, marble: 1, button: 1, wall: 2 })
  })
  it('a knock starts at the moment it happened, as near as the speakers allow: at once when that moment is past, never later', () => {
    env.allowed = true
    const g = make()
    const c = env.last ?? (g.hit('floor', 1, 0), env.last!)
    // The speakers play the context's 1.000 s at performance time 5000 ms; the context has rendered up to 1.050 s.
    c.currentTime = 1.05
    env.stamp = { contextTime: 1, performanceTime: 5000 }
    const now = vi.spyOn(performance, 'now').mockReturnValue(5010)
    // A knock that happened at 4990 ms (a frame ago): its sound is late already, so it starts at once.
    env.starts = []
    g.hit('wall', 2, 0, ['me'], 4990)
    expect(Math.min(...env.starts)).toBeCloseTo(1.05, 9)
    expect(g.stats().oursMs).toBe(0)
    // Heard 50 ms after that moment's frame reached the screen (the output's own latency, as the timestamp says).
    expect(g.stats().behindMs).toBeCloseTo(5000 + 50 - 4990, 1)
    now.mockRestore()
  })
  it('knocks of one frame keep the spacing they happened with', () => {
    env.allowed = true
    const g = make()
    g.hit('floor', 1, 0)
    const c = env.last!
    c.currentTime = 2
    env.stamp = { contextTime: 1.95, performanceTime: 8000 }
    const now = vi.spyOn(performance, 'now').mockReturnValue(8010)
    env.starts = []
    g.hit('floor', 2, 0, ['me'], 7990)
    const first = Math.min(...env.starts)
    env.starts = []
    // The same frame (the same moment's task), 6 ms later in its step.
    g.hit('letter', 2, 0, ['me'], 7996)
    expect(Math.min(...env.starts) - first).toBeCloseTo(0.006, 6)
    expect(first).toBeCloseTo(2, 9)
    now.mockRestore()
  })
  it('a knock whose moment the speakers have not reached yet starts exactly then (a knock foreseen)', () => {
    env.allowed = true
    const g = make()
    g.hit('floor', 1, 0)
    const c = env.last!
    c.currentTime = 3
    env.stamp = { contextTime: 2.99, performanceTime: 9000 }
    const now = vi.spyOn(performance, 'now').mockReturnValue(9001)
    env.starts = []
    // On screen at 9100 ms (+ the frame's own way to the screen): heard then, on the context's clock.
    g.hit('wall', 2, 0, ['me'], 9100)
    expect(Math.min(...env.starts)).toBeCloseTo(2.99 + (9100 + 20 - 9000) / 1000, 6)
    now.mockRestore()
  })
  describe('knocks foreseen (started ahead, to be heard the moment they are seen)', () => {
    /**
     * Sound on, the speakers 50 ms behind the audio clock: at performance time `t` (ms) the context has rendered up to
     * 1 + (t - 5000) / 1000 s and the speakers play 50 ms of that behind. A frame is 1/60 s.
     */
    const FRAME = 1 / 60
    let clock: { mockReturnValue(v: number): unknown; mockRestore(): void } | undefined
    const at = (t: number, lag = 0.05) => {
      const c = env.last!
      c.currentTime = 1 + (t - 5000) / 1000
      env.stamp = { contextTime: c.currentTime - lag, performanceTime: t }
      clock!.mockReturnValue(t)
    }
    const knock = (moment: number, key = 'me|letter|3'): Foreseen => ({ key, kind: 'letter', speed: 2, pan: 0, marbles: ['me'], at: moment })
    const on = () => {
      env.allowed = true
      const g = make()
      g.hit('floor', 1, 0)
      clock = vi.spyOn(performance, 'now')
      at(5000)
      return g
    }
    afterEach(() => clock?.mockRestore())

    it('one far enough ahead starts so it is heard with the frame that shows it; the knock itself, when it comes, is that one', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5065)], FRAME)
      const started = heardFrom(from)
      expect(started.length).toBeGreaterThan(0)
      // Heard at 5065 ms + the frame's 20 ms to the screen: on the context's clock, 0.95 + (5085 - 5000) / 1000.
      for (const q of started) expect(q.start).toBeCloseTo(1.035, 6)
      // Foreseen again, much the same: nothing new.
      at(5016)
      g.foresee([knock(5065.5)], FRAME)
      at(5033)
      g.foresee([knock(5065.3)], FRAME)
      expect(env.sources.length - from).toBe(started.length)
      // The knock itself: not started again.
      at(5070)
      expect(g.hit('letter', 2, 0, ['me'], 5065, 'me|letter|3')).toBe('heard')
      g.foresee([], FRAME)
      expect(env.sources.length - from).toBe(started.length)
      expect(heardFrom(from).length).toBe(started.length)
      const s = g.stats()
      expect(s.foreseen).toMatchObject({ met: 1, calledOff: 0, wrong: 0, leadMs: 0 })
      // Heard 20 ms after the moment it happened (with the frame showing it), started 35 ms before it came.
      expect(s.behindMs).toBeCloseTo(20, 1)
      expect(s.oursMs).toBeCloseTo(-35, 1)
      expect(s.kinds.letter).toBe(1)
      expect(env.cuts).toBe(0)
    })
    it('one no longer foreseen is called off before it starts: never heard, and nothing cut short', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5065)], FRAME)
      expect(heardFrom(from).length).toBeGreaterThan(0)
      at(5016)
      g.foresee([], FRAME)
      expect(heardFrom(from).length).toBe(0)
      expect(g.stats().foreseen).toMatchObject({ met: 0, calledOff: 1, wrong: 0 })
      // It came after all (it was only a glitch in the foresight): heard as it comes, once.
      at(5070)
      const again = env.sources.length
      expect(g.hit('letter', 2, 0, ['me'], 5065, 'me|letter|3')).toBe('heard')
      expect(heardFrom(again).length).toBeGreaterThan(0)
      expect(env.cuts).toBe(0)
    })
    it('one foreseen for another moment now is started again at that one (the first never heard)', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5065)], FRAME)
      const n = heardFrom(from).length
      at(5016)
      g.foresee([knock(5080)], FRAME)
      const heard = heardFrom(from)
      expect(heard.length).toBe(n)
      for (const q of heard) expect(q.start).toBeCloseTo(0.95 + (5080 + 20 - 5000) / 1000, 6)
      expect(g.stats().foreseen).toMatchObject({ calledOff: 0 })
      expect(env.cuts).toBe(0)
    })
    it('too near its start to call off, it stands; if the knock never comes, it is counted, and a later knock of the name is heard as it comes', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5065)], FRAME)
      const n = heardFrom(from).length
      // 5 ms before it starts (the output renders at least 10 ms ahead): it can't be stopped cleanly any more.
      at(5030)
      g.foresee([], FRAME)
      expect(heardFrom(from).length).toBe(n)
      expect(g.stats().foreseen).toMatchObject({ calledOff: 0, wrong: 0 })
      // Its moment long past, and no knock: heard for nothing.
      at(5120)
      g.foresee([], FRAME)
      expect(g.stats().foreseen).toMatchObject({ met: 0, calledOff: 0, wrong: 1 })
      expect(g.stats().log.at(-1)?.verdict).toBe('foreseen, never came')
      const later = env.sources.length
      expect(g.hit('letter', 2, 0, ['me'], 5125, 'me|letter|3')).toBe('heard')
      expect(heardFrom(later).length).toBe(n)
      expect(env.cuts).toBe(0)
    })
    it('the knock itself, come at another moment than foreseen, is heard as it comes, and the one foreseen never (heard once)', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5100)], FRAME)
      const n = heardFrom(from).length
      at(5045)
      expect(g.hit('letter', 2, 0, ['me'], 5040, 'me|letter|3')).toBe('heard')
      const heard = heardFrom(from)
      expect(heard.length).toBe(n)
      for (const q of heard) expect(q.start).toBeCloseTo(1.045, 6)
      expect(g.stats().foreseen).toMatchObject({ met: 0 })
      expect(env.cuts).toBe(0)
    })
    it('the same knock foreseen twice in a frame (two of a name) is started once, for the first', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5065), knock(5090)], FRAME)
      const first = env.sources.length - from
      for (const q of heardFrom(from)) expect(q.start).toBeCloseTo(1.035, 6)
      // Another knock of the same kind, of another name: as many voices as the first alone.
      g.foresee([knock(5065), knock(5090), knock(5070, 'me|letter|4')], FRAME)
      expect(env.sources.length - from - first).toBe(first)
      expect(heardFrom(from).length).toBe(2 * first)
    })
    it('one too near to be called off by the next frame, and no sooner than as it comes, is not started ahead', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5020)], FRAME)
      expect(env.sources.length).toBe(from)
      // Too near to be on time, but well sooner than as it comes: started as soon as the next frame could still stop it.
      g.foresee([knock(5020, 'me|letter|3'), knock(5045, 'me|wall|1')], FRAME)
      const heard = heardFrom(from)
      expect(heard.length).toBeGreaterThan(0)
      for (const q of heard) expect(q.start).toBeCloseTo(1 + 0.01 + 128 / 48000 + FRAME, 6)
    })
    it('switched off, every knock foreseen is stopped (none heard after it comes back on)', () => {
      const g = on()
      const from = env.sources.length
      g.foresee([knock(5065), knock(5070, 'me|wall|1')], FRAME)
      g.toggle()
      expect(heardFrom(from).length).toBe(0)
      expect(g.stats().foreseen).toMatchObject({ met: 0, wrong: 0 })
    })
    it('looks as far ahead as the speakers lag the screen (at most 60 ms), with room to call a knock off; not at all where they keep up', () => {
      const g = on()
      const room = 0.01 + 128 / 48000 + 2 * FRAME
      expect(g.lead(FRAME)).toBeCloseTo(0.05 - 0.02 + room, 6)
      expect(g.stats().foreseen.leadMs).toBe(30)
      at(5000, 0.3)
      expect(g.lead(FRAME)).toBeCloseTo(0.06 + room, 6)
      expect(g.stats().foreseen.leadMs).toBe(60)
      at(5000, 0.022)
      expect(g.lead(FRAME)).toBe(0)
      // Without a timestamp: the latency the context reports (5 + 10 ms here: the speakers keep up).
      env.stamp = null
      expect(g.lead(FRAME)).toBe(0)
      g.toggle()
      at(5000, 0.3)
      expect(g.lead(FRAME)).toBe(0)
    })
  })
  it('shows the output latency in its two parts (the context base, the device output), as the browser reports them', () => {
    env.allowed = true
    const g = make()
    g.hit('floor', 1, 0)
    expect(g.stats()).toMatchObject({ baseMs: 5, outputMs: 10, latencyMs: 15 })
  })
  it('without Web Audio there is no sound, and nothing breaks', () => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    const g = make()
    expect(g.state).toBe('none')
    g.gesture()
    g.toggle()
    expect(g.hit('letter', 1, 0)).toBe('none')
    expect(g.state).toBe('none')
  })
})

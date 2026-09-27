import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ceiling, createGlass, knockDb, pitchOf, soundState, type SoundState } from '../src/landing/glass'

/**
 * A stand-in AudioContext that keeps a browser's autoplay rule: it may start only while `allowed` is true (inside a
 * click or a tap, or where the browser already allows sound). It counts the voices started, so a hit is heard or not,
 * and notes what an iPhone's audio session was set to when it was made.
 */
const env = { allowed: false, made: 0, voices: 0, last: null as FakeContext | null, session: null as string | null }
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
  createOscillator() { return node({ type: '', frequency: param(), start: () => { env.voices++ }, stop: () => undefined }) }
  createBufferSource() { return node({ buffer: null, start: () => undefined }) }
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
    Object.assign(env, { allowed: false, made: 0, voices: 0, last: null, session: null })
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

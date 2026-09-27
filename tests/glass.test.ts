import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGlass, soundState, type SoundState } from '../src/landing/glass'

/**
 * A stand-in AudioContext that keeps a browser's autoplay rule: it may start only while `allowed` is true (inside a
 * click or a tap, or where the browser already allows sound). It counts the voices started, so a hit is heard or not.
 */
const env = { allowed: false, made: 0, voices: 0, last: null as FakeContext | null }
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
  createDynamicsCompressor() { return node({ threshold: param(), ratio: param(), attack: param(), release: param() }) }
  createGain() { return node({ gain: param() }) }
  createAnalyser() { return node({ fftSize: 2048, getFloatTimeDomainData: (a: Float32Array) => a.fill(0) }) }
  createBiquadFilter() { return node({ type: '', frequency: param() }) }
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

describe('the glass sound', () => {
  const seen: SoundState[] = []
  beforeEach(() => {
    Object.assign(env, { allowed: false, made: 0, voices: 0, last: null })
    seen.length = 0
    ;(globalThis as { AudioContext?: unknown }).AudioContext = FakeContext
  })
  afterEach(() => { delete (globalThis as { AudioContext?: unknown }).AudioContext })
  const make = () => { const g = createGlass(); g.onState = (s) => seen.push(s); return g }
  /** A click or a tap: the browser allows sound for the length of the event. */
  const gesture = (fn: () => void) => { env.allowed = true; fn(); env.allowed = false }

  it('is wanted from the start, and blocked until the first click or tap; hits before it are skipped, not queued', () => {
    const g = make()
    expect(g.state).toBe('blocked')
    g.hit('letter', 0.8, 0)
    g.hit('floor', 0.3, 0)
    expect(env.made).toBe(1)
    expect(env.voices).toBe(0)
    expect(g.stats()).toMatchObject({ state: 'blocked', context: 'suspended', played: 0, skipped: 2 })
    gesture(() => g.gesture())
    expect(g.state).toBe('on')
    expect(seen).toEqual(['on'])
    g.hit('letter', 0.8, 0)
    expect(env.voices).toBeGreaterThan(0)
    expect(g.stats()).toMatchObject({ played: 1, skipped: 2, latencyMs: 15 })
  })
  it('starts at once where the browser already allows sound (no gesture needed)', () => {
    env.allowed = true
    const g = make()
    g.hit('marble', 0.5, 0.2)
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
  it('the button: blocked turns on, on turns off, off turns on', () => {
    const g = make()
    gesture(() => g.toggle())
    expect(g.state).toBe('on')
    gesture(() => g.toggle())
    expect(g.state).toBe('off')
    // Off: hits are skipped, and a click elsewhere on the page doesn't bring it back.
    gesture(() => g.gesture())
    g.hit('letter', 1, 0)
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
  it('holds a tumble of hits to a sound, not a roar: at most 28 a second', () => {
    env.allowed = true
    const g = make()
    for (let i = 0; i < 60; i++) g.hit('floor', 0.5, 0)
    expect(g.stats()).toMatchObject({ played: 28, skipped: 32 })
  })
  it('every kind of hit makes a sound, a gentle one too', () => {
    env.allowed = true
    const g = make()
    for (const kind of ['letter', 'floor', 'marble', 'button'] as const) {
      const before = env.voices
      g.hit(kind, 0, 0)
      expect(env.voices).toBeGreaterThan(before)
    }
  })
  it('without Web Audio there is no sound, and nothing breaks', () => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    const g = make()
    expect(g.state).toBe('none')
    g.gesture()
    g.toggle()
    g.hit('letter', 1, 0)
    expect(g.state).toBe('none')
  })
})

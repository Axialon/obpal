import { describe, expect, it, vi } from 'vitest'
import { layoutControllers, Mode, withControllers } from '@obpal/core'
import { DRUMS, frequency, padVelocity, readMusic, scaleNote, SCALES, StrikeDetector, strikeDrum, type MusicEvent } from '../src/music'
import { AUDIO_LIMITS, drumSpec, limiterCurve } from '../src/sim/devices/studio.sound'
import { StudioPlayers } from '../src/sim/devices/studio.players'
import { StudioLogic } from '../src/sim/devices/studio'

const event = (seq = 0, op: MusicEvent['op'] = 'on'): MusicEvent => ({ op, seq, n: 60, v: 0.8, x: 0, at: 0, uncertainty: 0 })

describe('music inputs', () => {
  it('uses pressure, then contact area, then position/speed without treating default pressure as a sensor', () => {
    expect(padVelocity(0.9, 1, 1, 1)).toBeGreaterThan(padVelocity(0.2, 1, 1, 0))
    expect(padVelocity(0.5, 24, 24, 1)).toBeGreaterThan(padVelocity(0.5, 8, 8, 0))
    expect(padVelocity(0.5, 1, 1, 0)).toBeGreaterThan(padVelocity(0.5, 1, 1, 1))
    expect(padVelocity(0.5, 1, 1, 0.5, 2)).toBeGreaterThan(padVelocity(0.5, 1, 1, 0.5, 0))
    expect(padVelocity(Infinity, 1, 1, 0)).toBeLessThanOrEqual(1)
  })
  it('waits for the peak, rejects rebound and re-arms only after quiet', () => {
    const s = new StrikeDetector()
    expect(s.sample(2, 0)).toBeNull(); expect(s.sample(8, 10)).toBeNull(); expect(s.sample(24, 20)).toBeNull()
    expect(s.sample(15, 30)).toBeCloseTo(19 / 28)
    expect(s.sample(28, 50)).toBeNull(); expect(s.sample(0, 60)).toBeNull(); expect(s.sample(28, 160)).toBeNull()
    s.sample(0, 170); s.sample(10, 180)
    expect(s.sample(3, 190)).toBeCloseTo(5 / 28, 1)
  })
  it('bounds constant high acceleration and ignores invalid samples', () => {
    const s = new StrikeDetector()
    expect(s.sample(NaN, 0)).toBeNull(); s.sample(90, 10)
    expect(s.sample(90, 50)).toBe(1)
    expect(s.sample(90, 200)).toBeNull()
    s.reset(); s.sample(8, 300); expect(s.sample(0, 310)).toBe(0.18)
  })
  it('selects drums from orientation and keeps hand drums in their own layout', () => {
    expect(strikeDrum([-0.6, 0.8, 0])).toBe(0)
    expect(strikeDrum([0, 1, 0])).toBe(1)
    expect(strikeDrum([0.6, 0.8, 0])).toBe(2)
    expect(strikeDrum([0, 0.5, -0.8])).toBe(5)
    expect(strikeDrum([0, 1, 0], true)).toBe(12)
  })
  it.each(Object.keys(SCALES) as (keyof typeof SCALES)[])('locks every degree and octave to %s', scale => {
    for (let root = 0; root < 12; root++) for (let d = -7; d < 15; d++) {
      const note = scaleNote(d, root, 4, scale)
      expect(SCALES[scale]).toContain(((note - root) % 12 + 12) % 12)
      expect(scaleNote(d, root, 5, scale) - note).toBe(note + 12 > 108 ? 0 : 12)
    }
    expect(frequency(69)).toBe(440)
  })
})

describe('music contract', () => {
  it('round trips the optional value and rejects malformed/out-of-range input', () => {
    expect(readMusic(JSON.stringify(event()))).toEqual(event())
    for (const v of [null, 3, '{}', 'bad', 'x'.repeat(257), JSON.stringify({ ...event(), v: 9 }), JSON.stringify({ ...event(), x: null }), JSON.stringify({ ...event(), n: 4 }), JSON.stringify({ ...event(0, 'hit'), n: 13 })]) expect(readMusic(v)).toBeNull()
  })
  it('only offers music when explicitly named; old mode-only layouts keep their own faces', () => {
    expect(layoutControllers({ modes: [Mode.pad], tray: [] })).not.toContain('face.drums')
    expect(layoutControllers(withControllers({ v: 1, controllers: ['face.drums', 'face.keys'], tray: [] }))).toEqual(['face.drums', 'face.keys'])
  })
  it('lets simultaneous participants play and rejects duplicate messages', () => {
    const stop = vi.fn(), p = new StudioPlayers(stop)
    for (let n = 0; n < 8; n++) expect(p.accept(String(n), n, event(), 0)).toBe(true)
    expect(p.accept('0', 0, event(), 1)).toBe(false)
    expect(stop).not.toHaveBeenCalled()
  })
  it('releases old claims, disconnected phones and stale notes without touching active neighbours', () => {
    const stop = vi.fn(), p = new StudioPlayers(stop)
    p.accept('a', 0, event(), 0); p.accept('b', 1, event(), 500)
    p.check(1001, who => who === 'a' ? 0 : 1)
    expect(stop).toHaveBeenCalledExactlyOnceWith(0)
    p.accept('b', 2, event(1), 1100); expect(stop).toHaveBeenLastCalledWith(1)
    p.drop('b'); expect(stop).toHaveBeenLastCalledWith(2)
  })
  it('limits attacks but always takes releases and heartbeats', () => {
    const p = new StudioPlayers(vi.fn())
    for (let n = 0; n < 80; n++) expect(p.accept('a', 0, event(n), 0)).toBe(true)
    expect(p.accept('a', 0, event(80), 1)).toBe(false)
    expect(p.accept('a', 0, event(81, 'off'), 2)).toBe(true)
    expect(p.accept('a', 0, event(82, 'alive'), 3)).toBe(true)
    expect(p.accept('a', 0, event(83), 1001)).toBe(true)
    expect(p.accept('other', -1, event(), 0)).toBe(false)
  })
})

describe('synthesis and visual envelopes', () => {
  it.each(DRUMS.map((name, n) => [name, n] as const))('%s stays within finite frequency and decay budgets', (_name, n) => {
    const p = drumSpec(n)
    expect(p.hz).toBeGreaterThanOrEqual(40); expect(p.hz * Math.max(...p.modes)).toBeLessThan(20000)
    expect(p.decay).toBeGreaterThan(0.01); expect(p.decay).toBeLessThanOrEqual(2)
    expect(p.noise).toBeGreaterThanOrEqual(0); expect(p.noise).toBeLessThanOrEqual(1)
  })
  it('keeps the limiter monotonic, symmetric and below full scale at maximum volume', () => {
    const c = limiterCurve()
    for (let i = 1; i < c.length; i++) { expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]); expect(Math.abs(c[i]) * 0.8).toBeLessThan(1) }
    expect(c[0]).toBeCloseTo(-c[c.length - 1]); expect(c[(c.length - 1) / 2]).toBe(0)
    expect(AUDIO_LIMITS.voices * AUDIO_LIMITS.seats).toBe(64)
  })
  it('keeps simultaneous hit envelopes separate and decays them without a frame-size dependency', () => {
    const a = new StudioLogic(), b = new StudioLogic()
    a.play(0, { ...event(), op: 'hit', n: 1 }); a.play(1, { ...event(), op: 'hit', n: 9 })
    b.play(0, { ...event(), op: 'hit', n: 1 })
    a.step([], 0.1); for (let i = 0; i < 10; i++) b.step([], 0.01)
    expect(a.hits[0][1]).toBeCloseTo(b.hits[0][1]); expect(a.hits[1][9]).toBeGreaterThan(0)
    a.home(0); expect(a.hits[0][1]).toBe(0); expect(a.hits[1][9]).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { instrumentTargets, musicTarget, resolveStrike, STATION_NAMES, STUDIO_TARGETS } from '../src/music-space'
import { readMusic, SpatialStrike } from '../src/music'

describe('playable music space', () => {
  it.each(STATION_NAMES.map((name, seat) => [name, seat] as const))('%s exposes every own surface with an edge margin and comfortable spacing', (_name, seat) => {
    const targets = instrumentTargets(seat)
    for (const [i, t] of targets.entries()) {
      expect(Math.max(Math.abs(t.x), Math.abs(t.y))).toBeLessThanOrEqual(0.821)
      expect(musicTarget([t.x, t.y], 'object', seat)).toBe(t)
      for (const other of targets.slice(i + 1)) expect(Math.hypot((other.x - t.x) * 35, (other.y - t.y) * 25)).toBeGreaterThan(3.8)
    }
  })
  it('places the drums and cymbals around the player, and mallet pitches low to high', () => {
    const kit = instrumentTargets(0)
    expect(kit.find(t => t.label === 'Snare')!.x).toBeLessThan(0)
    expect(kit.find(t => t.label === 'Kick')!.y).toBeLessThan(-0.6)
    expect(kit.filter(t => ['Crash', 'Ride'].includes(t.label)).every(t => t.y > 0.7)).toBe(true)
    const bars = instrumentTargets(5)
    bars.slice(1).forEach((t, n) => { expect(t.x).toBeGreaterThan(bars[n].x); expect(t.n).toBeGreaterThan(bars[n].n) })
  })
  it('reaches all 75 studio surfaces, with a 10% edge margin and at least 4.2 degrees between targets', () => {
    expect(STUDIO_TARGETS).toHaveLength(75)
    for (const [i, t] of STUDIO_TARGETS.entries()) {
      expect(Math.max(Math.abs(t.x), Math.abs(t.y))).toBeLessThanOrEqual(0.901)
      for (let seat = 0; seat < 8; seat++) expect(musicTarget([t.x, t.y], 'scene', seat)).toBe(t)
      for (const next of STUDIO_TARGETS.slice(i + 1)) expect(Math.hypot((next.x - t.x) * 35, (next.y - t.y) * 25), `${t.label} / ${next.label}`).toBeGreaterThanOrEqual(4.199)
    }
  })
  it('resolves the strike snapshot even when the live aim has moved, while respecting scope and ownership', () => {
    const s = new SpatialStrike()
    s.sample(8, [-0.42, -0.38], 0)
    s.sample(24, [-0.42, -0.38], 16)
    const hit = s.sample(4, [0.7, 0.74], 32)!
    expect(hit.at).toBe(16)
    expect(resolveStrike(hit.aim, 'object', 'object', 0, () => true)?.label).toBe('Snare')
    expect(musicTarget([0.7, 0.74], 'object', 0).label).toBe('Ride')
    const far = STUDIO_TARGETS.find(t => t.seat === 7 && t.surface === 12)!
    expect(resolveStrike([far.x, far.y], 'scene', 'scene', 0, () => true)).toBe(far)
    expect(resolveStrike([far.x, far.y], 'scene', 'scene', 0, n => n !== 7)).toBeNull()
    expect(resolveStrike([far.x, far.y], 'scene', 'object', 0, () => true)).toBeNull()
    expect(resolveStrike([far.x, far.y], 'scene', 'scene', -1, () => true)).toBeNull()
  })
  it('copies peak aim, responds to strike strength and rejects recoil, stale samples and rearming without quiet', () => {
    const s = new SpatialStrike(), aim: [number, number] = [0.2, 0.3]
    expect(s.sample(-24, aim, 0)).toBeNull()
    s.sample(24, aim, 16); aim[0] = 1
    const hit = s.sample(8, aim, 32)!
    expect(hit.aim).toEqual([0.2, 0.3]); expect(hit.v).toBeCloseTo(19 / 28)
    expect(s.sample(30, aim, 64)).toBeNull()
    expect(s.sample(30, aim, 164)).toBeNull()
    s.sample(0, aim, 180); s.sample(8, aim, 196)
    expect(s.sample(1, aim, 212)!.v).toBe(0.18)
    s.reset(); s.sample(20, aim, 0)
    expect(s.sample(0, aim, 250)).toBeNull()
    expect(s.sample(NaN, aim, 260)).toBeNull()
  })
  it('validates optional spatial fields without changing legacy music', () => {
    const event = { op: 'hit', seq: 1, n: 0, v: 0.7, x: 0, at: 123, uncertainty: 0 }
    expect(readMusic(JSON.stringify(event))).toEqual(event)
    const spatial = { ...event, aim: [-0.42, -0.38], scope: 'object' }
    expect(readMusic(JSON.stringify(spatial))).toEqual(spatial)
    for (const bad of [{ ...spatial, aim: [0, 2] }, { ...event, scope: 'scene' }, { ...spatial, scope: 'other' }, { ...spatial, aim: [null, 0] }, { ...spatial, op: 'on', n: 60 }]) expect(readMusic(JSON.stringify(bad))).toBeNull()
  })
  it('remembers a quiet recovery during the refractory period so a quick next beat is not lost', () => {
    const s = new SpatialStrike()
    s.sample(24, [0, 0], 0)
    expect(s.sample(8, [0, 0], 16)).not.toBeNull()
    s.sample(0, [0, 0], 32)
    expect(s.sample(8, [0, 0], 105)).toBeNull()
    s.sample(24, [0, 0], 122)
    expect(s.sample(8, [0, 0], 138)).not.toBeNull()
  })
})

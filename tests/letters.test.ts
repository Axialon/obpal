import { describe, expect, it } from 'vitest'
import { inside, nearest, newOrb, step } from '../src/landing/bounce'
import { layoutLetters, TOP, tourStops } from '../src/landing/letters'

const HEADLINES = [['Your phone is', 'the controller.'], ['Your phone', 'is the controller.'], ['Your phone is the controller.']]

describe('the headline as 3D letters', () => {
  it('lays out every visible character, left-aligned, lines stacking down the screen', () => {
    const l = layoutLetters(['Your phone is', 'the controller.'])
    expect(l.map((x) => x.ch).join('')).toBe('Yourphoneisthecontroller.')
    expect(l[0].x).toBeLessThan(0)
    expect(l.find((x) => x.ch === 't')!.zBase).toBeGreaterThan(l[0].zBase)
    expect(new Set(l.map((x) => x.word)).size).toBe(5)
    // The full stop is the last letter and a word of its own at the end of "controller."
    expect(l.at(-1)!.ch).toBe('.')
  })
  it('gives every letter a landing spot deep inside it, never in a counter (the hole of an o)', () => {
    for (const x of layoutLetters(['Your phone is', 'the controller.'])) {
      expect(inside(x.fp, x.fp.spot[0], x.fp.spot[1]), x.ch).toBe(true)
      expect(nearest(x.fp, x.fp.spot[0], x.fp.spot[1]).d, x.ch).toBeGreaterThan(0.03)
    }
  })
})

describe('the opening', () => {
  for (const lines of HEADLINES) {
    it(`drops in, lands on every word and comes to rest on the full stop: ${lines.join(' / ')}`, () => {
      const letters = layoutLetters(lines)
      const fps = letters.map((l) => l.fp)
      const stops = tourStops(letters.map((l) => ({ ch: l.ch, spot: l.fp.spot, word: l.word })))
      expect(stops.length).toBe(new Set(letters.map((l) => l.word)).size + 1)
      const o = newOrb(stops[0].x, stops[0].z, 0.2)
      // As the hero does: dropped in over the first word, with the rest of the route to hop, then left to settle.
      Object.assign(o, { y: 2.4, route: stops.slice(1), resting: false })
      const landedOn: number[] = []
      let t = 0
      for (; t < 20 && !o.resting; t += 1 / 60) {
        const r = step(o, fps, 1 / 60, { hop: 0.8, bounds: [-30, -30, 30, 30] })
        if (r.landed !== null) landedOn.push(r.landed)
      }
      const dot = letters.at(-1)!
      expect(o.route).toEqual([])
      expect(o.resting).toBe(true)
      // A hop per word, then the settling bounces on the full stop: done in a few seconds.
      expect(t).toBeLessThan(7)
      expect(Math.hypot(o.x - dot.fp.spot[0], o.z - dot.fp.spot[1])).toBeLessThan(0.05)
      expect(o.y).toBeCloseTo(TOP + 0.2, 6)
      // Every hop came down on a letter, not the floor between them, and it lit a letter of every word.
      expect(landedOn.filter((id) => id < 0)).toEqual([])
      expect(new Set(landedOn.map((id) => letters[id].word)).size).toBe(new Set(letters.map((l) => l.word)).size)
    })
  }
})

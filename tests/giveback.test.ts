import { describe, expect, it } from 'vitest'
import data from '../src/support/open-source.json'
import { split } from '../src/support/share'

describe('giving back: the same again, split by how much ob.Pal relies on each project', () => {
  it('splits to the cent, and the parts add up to the amount', () => {
    const shares = data.upstream.map((u) => u.share)
    for (const amount of [1, 7.77, 25, 99.99, 10000]) {
      const parts = split(amount, shares)
      expect(Math.round(parts.reduce((s, x) => s + x, 0) * 100)).toBe(Math.round(amount * 100))
      expect(parts.every((x) => x >= 0)).toBe(true)
    }
    const p = split(100, shares)
    expect(p[0]).toBe(30)
  })

  it('credits every project with a page to give to, and the shares add up to 100', () => {
    expect(data.upstream.reduce((s, u) => s + u.share, 0)).toBe(100)
    for (const u of data.upstream) expect(u.give).toMatch(/^https:\/\/(github\.com\/sponsors|opencollective\.com)\//)
  })
})

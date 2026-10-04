import { describe, expect, it } from 'vitest'
import { ChipSettle } from '../packages/host/src/chip'
import { SEAL_SHOWN_MS } from '../src/sim/ui/chrome'

describe('a settling pairing chip (ChipSettle)', () => {
  it('opens for a new phone’s seal and folds a set time after it shows', () => {
    const s = new ChipSettle(4000)
    expect(s.seal('phone-a', 350)).toEqual({ open: true, foldInMs: 4350 })
  })

  it('never opens again for a phone it has seen, reconnecting', () => {
    const s = new ChipSettle(4000)
    s.seal('phone-a', 350)
    expect(s.join('phone-a').fresh).toBe(false)
    expect(s.seal('phone-a', 350).open).toBe(false)
    // Another phone is new, and opens it.
    expect(s.join('phone-b').fresh).toBe(true)
    expect(s.seal('phone-b', 350).open).toBe(true)
  })

  it('folds a card left open a while after a join, later than a seal would', () => {
    const s = new ChipSettle(4000)
    expect(s.join('phone-a').foldInMs).toBeGreaterThan(s.seal('phone-a', 350).foldInMs)
  })

  it('the sims show a new seal for about four seconds', () => {
    expect(SEAL_SHOWN_MS).toBeGreaterThanOrEqual(3000)
    expect(SEAL_SHOWN_MS).toBeLessThanOrEqual(5000)
  })
})

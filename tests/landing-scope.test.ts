import { describe, expect, it } from 'vitest'
import { PHONE_FIELD_SCOPE, fieldScope, heroInView, stageTop } from '../src/landing/scope'

describe('where the home marble field plays', () => {
  it('gives a phone only the hero for now, and everything else the whole page', () => {
    // The product decision (landing/scope.ts): flip PHONE_FIELD_SCOPE to 'page' to bring the whole-page field back.
    expect(PHONE_FIELD_SCOPE).toBe('hero')
    expect(fieldScope(true)).toBe('hero')
    expect(fieldScope(false)).toBe('page')
    expect(fieldScope(false, '?fieldscope=hero')).toBe('page')
  })

  it('lets the address ask a phone for the other scope, and ignores anything else', () => {
    expect(fieldScope(true, '?fieldscope=page')).toBe('page')
    expect(fieldScope(true, '?quality=low&fieldscope=page')).toBe('page')
    expect(fieldScope(true, '?fieldscope=hero')).toBe('hero')
    expect(fieldScope(true, '?fieldscope=everywhere')).toBe(PHONE_FIELD_SCOPE)
    expect(fieldScope(true, '')).toBe(PHONE_FIELD_SCOPE)
  })

  it('plays while any of the hero is below the page bar, and sleeps once it is gone', () => {
    // A 844 px canvas under a 65 px bar.
    expect(heroInView(0, 844, 65)).toBe(true)
    expect(heroInView(500, 844, 65)).toBe(true)
    expect(heroInView(778, 844, 65)).toBe(true)
    expect(heroInView(779, 844, 65)).toBe(false)
    expect(heroInView(5000, 844, 65)).toBe(false)
    // Coming back is the same line, crossed the other way.
    expect(heroInView(779 - 1, 844, 65)).toBe(true)
    // Pulled past the top (an overscroll) is still the hero.
    expect(heroInView(-40, 844, 65)).toBe(true)
  })

  it('rides a fixed control down the canvas with the scroll, then leaves it parked below the canvas', () => {
    const top = 720
    expect(stageTop(top, 0, 844)).toBe(720)
    expect(stageTop(top, 50, 844)).toBe(770)
    // Past the canvas's bottom (844) by the margin, it stops moving, however far the page goes.
    const parked = stageTop(top, 5000, 844)
    expect(parked).toBeGreaterThan(844)
    expect(stageTop(top, 900, 844)).toBe(parked)
    expect(stageTop(top, 5000, 844)).toBe(parked)
    // Scrolling back brings it up the same way; an overscroll never lifts it above where it is on the screen.
    expect(stageTop(top, 50, 844)).toBe(770)
    expect(stageTop(top, -30, 844)).toBe(720)
  })
})

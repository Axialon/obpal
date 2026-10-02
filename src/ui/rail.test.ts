import { describe, expect, it } from 'vitest'
import { railAxis, railPull } from './rail'

describe('gesture rails', () => {
  it('ignores press jitter and chooses the dominant axis in either direction', () => {
    expect(railAxis(7, -7)).toBeNull()
    expect(railAxis(-12, 9)).toBe('x')
    expect(railAxis(9, -12)).toBe('y')
  })
  it('follows the rail inside its ends and bounds overshoot to 48px', () => {
    expect(railPull(60, 100)).toBe(60)
    expect(railPull(-48, 100)).toBe(-24)
    expect(railPull(148, 100)).toBe(124)
    expect(railPull(-10000, 100)).toBeGreaterThan(-48)
    expect(railPull(10000, 100)).toBeLessThan(148)
  })
})

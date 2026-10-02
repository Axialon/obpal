import { expect, it } from 'vitest'
import { settledWindow } from '../scripts/lib/settled-window.mjs'

it.each([0.05, 0.1, 0.11, 0.12, 0.13, 0.2, 0.3])('recognises rest sampled every %s seconds', interval => {
  const samples = Array.from({ length: 30 }, (_, n) => ({ at: n * interval, x: 12, y: 24 }))
  expect(settledWindow(samples)).toBe(true)
})

it('requires the full stationary duration', () => {
  expect(settledWindow([])).toBe(false)
  expect(settledWindow([{ at: 0, x: 0, y: 0 }, { at: 0.3, x: 0, y: 0 }])).toBe(false)
})

it('keeps movement at the window boundary in the proof', () => {
  expect(settledWindow([
    { at: 0, x: 1, y: 0 }, { at: 0.06, x: 0, y: 0 }, { at: 0.12, x: 0, y: 0 },
    { at: 0.24, x: 0, y: 0 }, { at: 0.36, x: 0, y: 0 }, { at: 0.48, x: 0, y: 0 },
  ])).toBe(true)
  expect(settledWindow([
    { at: 0, x: 0, y: 0 }, { at: 0.12, x: 1, y: 0 }, { at: 0.24, x: 0, y: 0 },
    { at: 0.36, x: 0, y: 0 }, { at: 0.48, x: 0, y: 0 },
  ])).toBe(false)
})

it('preserves the strict position tolerance', () => {
  expect(settledWindow([{ at: 0, x: 0.29, y: 0 }, { at: 0.5, x: 0, y: 0 }])).toBe(true)
  expect(settledWindow([{ at: 0, x: 0.3, y: 0 }, { at: 0.5, x: 0, y: 0 }])).toBe(false)
})

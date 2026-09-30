import { describe, expect, it } from 'vitest'
import { warmupFailure, type WarmupResult } from '../scripts/lib/warmup.mjs'

function stable(): WarmupResult {
  const frames = [1000, 1020, 1040].map(t => ({ t, mean: 25, delta: 0, black: .6, alternation: 0 }))
  return { frames, screens: frames.map(f => ({ ...f })), events: [], reveal: 1000, end: 9000, error: null }
}

describe('the startup stability guard', () => {
  it('accepts a dark scene retained on screen while drawing stops', () => {
    expect(warmupFailure(stable())).toBeNull()
  })
  it('catches a near-black frame, even when it immediately recovers', () => {
    const result = stable()
    Object.assign(result.frames[1], { mean: 0, black: 1 })
    expect(warmupFailure(result)).toContain('cleared')
  })
  it('checks the first revealed frame for a clear too', () => {
    const result = stable()
    Object.assign(result.frames[0], { mean: 0, black: 1 })
    expect(warmupFailure(result)).toContain('cleared')
  })
  it('catches a near-black compositor frame when the canvas stream retains its image', () => {
    const result = stable()
    Object.assign(result.screens![1], { mean: 0, black: 1 })
    expect(warmupFailure(result)).toContain('cleared')
  })
  it('catches the headline disappearing in the compositor when the canvas stream skips the clear', () => {
    const result = stable()
    result.screens![2].alternation = .044
    expect(warmupFailure(result)).toContain('alternation')
    result.screens![2].alternation = .02
    expect(warmupFailure(result)).toBeNull()
  })
  it('catches an unpainted resize even when the compositor skips its frame', () => {
    const result = stable()
    result.events.push({ kind: 'unpainted-resize', t: 1200 })
    expect(warmupFailure(result)).toContain('without a replacement')
    result.events[0].t = 200
    expect(warmupFailure(result)).toBeNull()
  })
  it('catches a room arriving in one step after the floor was already revealed', () => {
    const result = stable()
    Object.assign(result.frames[1], { delta: 52, area: .6 })
    expect(warmupFailure(result)).toContain('setup-pop')
  })
  it('does not compare the first revealed frame with a hidden warm-up frame', () => {
    const result = stable()
    result.frames = [
      { t: 900, mean: 50, delta: 0, black: .6, alternation: 0 },
      { t: 1000, mean: 102, delta: 52, black: .6, alternation: 0, area: .6 },
      { t: 1020, mean: 102, delta: 0, black: .6, alternation: 0 },
    ]
    expect(warmupFailure(result)).toBeNull()
    result.reveal = 900
    expect(warmupFailure(result)).toContain('setup-pop')
  })
  it('counts a reversal only when its starting frame was already revealed', () => {
    const result = stable()
    result.screens = [900, 1000, 1020, 1040].map(t => ({ t, mean: 25, delta: 0, black: .6, alternation: 0, alternation2: 0, alternation3: 0 }))
    Object.assign(result.screens[2], { alternation: .1, alternation2: .1 })
    expect(warmupFailure(result)).toBeNull()
    Object.assign(result.screens[3], { alternation: .1, alternation2: .1 })
    expect(warmupFailure(result)).toContain('alternation')
  })
  it('cannot pass without a reveal, a complete interval, and valid frames from both captures', () => {
    expect(warmupFailure({ ...stable(), reveal: null })).toContain('never revealed')
    expect(warmupFailure({ ...stable(), end: 8999 })).toContain('eight seconds')
    expect(warmupFailure({ ...stable(), screens: [] })).toContain('compositor')
    const result = stable()
    result.frames[1].mean = NaN
    expect(warmupFailure(result)).toContain('invalid')
  })
})

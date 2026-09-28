import { describe, expect, it } from 'vitest'
import { temporalFailure, type TemporalFrame } from '../scripts/lib/temporal.mjs'

function stable(): { frames: TemporalFrame[] } {
  return { frames: ['rest', 'orbit', 'settle', 'rest-again'].flatMap(phase => Array.from({ length: 64 }, (_, n) => ({ phase, n, samples: 100, p95: 0, spikes: 0 }))) }
}

describe('surface stability thresholds', () => {
  it('allows refinement while settling, but requires stability afterwards', () => {
    const result = stable()
    for (const f of result.frames.filter(f => f.phase === 'settle')) { f.p95 = 20; f.spikes = .1 }
    expect(temporalFailure(result)).toBeNull()
    result.frames.at(-1)!.p95 = 2.1
    expect(temporalFailure(result)).toContain('rest-again')
  })

  it('allows small orbit shading changes and isolated occlusions, but catches widespread flashing', () => {
    const result = stable(), frame = result.frames[80]
    frame.p95 = 1.5; frame.spikes = .01
    expect(temporalFailure(result)).toBeNull()
    frame.p95 = 7.7
    expect(temporalFailure(result)).toContain('orbit')
    frame.p95 = 1; frame.spikes = .06
    expect(temporalFailure(result)).toContain('flashed')
  })

  it('rejects missing frames, empty surface masks and invalid measurements', () => {
    expect(temporalFailure({ frames: [] })).toContain('64 consecutive frames')
    const result = stable(), frame = result.frames[4]
    frame.samples = 0
    expect(temporalFailure(result)).toContain('static surface samples')
    frame.samples = 100; frame.p95 = NaN
    expect(temporalFailure(result)).toContain('invalid pixel measurement')
  })
})

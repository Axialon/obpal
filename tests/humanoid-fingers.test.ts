import { describe, expect, it } from 'vitest'
import type { Frame } from '@obpal/host'
import { FingerInput } from '../src/sim/humanoid/fingers'
import { humanoidBody } from './humanoid-fixture'

function hand(t = 100000, bent = true): NonNullable<Frame['hand']> {
  const landmarks: [number, number, number][] = Array.from({ length: 21 }, () => [0, 0, 0])
  for (const base of [5, 9, 13, 17]) {
    landmarks[base] = [0, 0.04, 0]
    landmarks[base + 1] = [0, 0.07, 0]
    landmarks[base + 2] = bent ? [0, 0.07, 0.025] : [0, 0.095, 0]
    landmarks[base + 3] = bent ? [0, 0.05, 0.025] : [0, 0.12, 0]
  }
  return { t, tracked: true, gen: 1, confidence: 0.9, handedness: 'left', gestures: 0, p: [0, 0, 0], landmarks }
}
const acquire = (input: FingerInput, mirror = false) => {
  input.step(humanoidBody(), hand(), mirror)
  return input.step(humanoidBody(undefined, 133), hand(133000), mirror)
}
describe('optional finger fusion', () => {
  it('requires fresh paired samples before driving one side, mirrored anatomically', () => {
    const input = new FingerInput()
    expect(input.step(humanoidBody(), hand(), false)).toEqual({ left: 0, right: 0 })
    expect(input.step(humanoidBody(), hand(), false)).toEqual({ left: 0, right: 0 })
    expect(acquire(new FingerInput())).toEqual({ left: 1, right: 0 })
    expect(acquire(new FingerInput(), true)).toEqual({ left: 0, right: 1 })
  })
  it('opens straight fingers without changing BODY data', () => {
    const input = new FingerInput(),
      body = humanoidBody(undefined, 133),
      before = JSON.stringify(body)
    acquire(input)
    expect(input.step(body, hand(133000, false), false)).toEqual({ left: 0, right: 0 })
    expect(JSON.stringify(body)).toBe(before)
  })
  it('rejects stale, uncertain, unidentified or malformed hands and missing BODY', () => {
    for (const edit of ['time', 'confidence', 'side', 'missing', 'finite', 'degenerate']) {
      const input = new FingerInput(),
        h = hand(133000)
      acquire(input)
      if (edit === 'time') h.t = 1000000
      if (edit === 'confidence') h.confidence = 0.1
      if (edit === 'side') h.handedness = 'unknown'
      if (edit === 'missing') h.landmarks.pop()
      if (edit === 'finite') h.landmarks[8][0] = NaN
      if (edit === 'degenerate') h.landmarks[6] = h.landmarks[5]
      expect(input.step(humanoidBody(undefined, 133), h, false)).toEqual({ left: 0, right: 0 })
      expect(input.step(null, hand(), false)).toEqual({ left: 0, right: 0 })
    }
  })
  it('resets fusion on source, hand generation and body generation changes', () => {
    for (const change of ['source', 'hand', 'body']) {
      const input = new FingerInput(),
        b = humanoidBody(undefined, 133),
        h = hand(133000)
      acquire(input)
      if (change === 'body') b.gen++
      if (change === 'hand') h.gen++
      expect(input.step(b, h, false, change === 'source' ? 'another-seat' : '')).toEqual({ left: 0, right: 0 })
    }
  })
  it('compares microsecond timestamps across the u32 wrap', () => {
    const input = new FingerInput(),
      b = humanoidBody(),
      h = hand(10000)
    b.t = 0xfffffff0
    input.step(b, h, false)
    b.t = 20000
    h.t = 30000
    expect(input.step(b, h, false).left).toBe(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeHand, HandFlag, HandGesture, type HandState, type Vec3 } from '@obpal/core'
import { Stream } from '../packages/host/src/stream'

beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); vi.advanceTimersByTime(100) })
afterEach(() => vi.useRealTimers())

const hand: HandState = {
  flags: HandFlag.tracked, seq: 10, t: 0, gen: 1, handedness: 'left', confidence: 0.8,
  gestures: HandGesture.pinch, p: [0.1, 0.2, -0.5], landmarks: Array.from({ length: 21 }, (): Vec3 => [0, 0, 0]),
}
const stream = (input = () => {}) => new Stream({ mode: () => {}, pad: () => {}, input })

describe('the hand stream', () => {
  it('exposes a nullable hand independently of STATE or POSE', () => {
    const input = vi.fn(), s = stream(input)
    expect(s.consume(performance.now(), false).hand).toBeNull()
    s.onHand(encodeHand(hand))
    expect(s.consume(performance.now(), true)).toMatchObject({
      pose: null,
      hand: { tracked: true, gen: 1, handedness: 'left', confidence: 0.8, gestures: HandGesture.pinch, p: hand.p, landmarks: hand.landmarks },
    })
    expect(input).toHaveBeenCalledTimes(1)
  })

  it('expires at 250 ms and never refreshes on old, duplicate or malformed packets', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const input = vi.fn(), s = stream(input)
    s.onHand(encodeHand(hand))
    vi.advanceTimersByTime(200)
    s.onHand(encodeHand(hand))
    s.onHand(encodeHand({ ...hand, seq: 9, gen: 0 }))
    s.onHand(new ArrayBuffer(144))
    vi.advanceTimersByTime(49)
    expect(s.consume(performance.now(), true).hand?.tracked).toBe(true)
    vi.advanceTimersByTime(1)
    expect(s.consume(performance.now(), true).hand).toBeNull()
    s.onHand(encodeHand(hand))
    s.onHand(encodeHand({ ...hand, seq: 9, gen: 0 }))
    expect(s.consume(performance.now(), true).hand).toBeNull()
    expect(input).toHaveBeenCalledTimes(1)
  })

  it('rejects a delayed prior generation before comparing identity or handedness', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const s = stream()
    s.onHand(encodeHand(hand))
    s.onHand(encodeHand({ ...hand, seq: 11, gen: 2, handedness: 'right', p: [1, 0, 0] }))
    const current = s.consume(performance.now(), true).hand
    vi.advanceTimersByTime(200)
    s.onHand(encodeHand(hand))
    expect(s.consume(performance.now(), true).hand).toEqual(current)
    vi.advanceTimersByTime(50)
    expect(s.consume(performance.now(), true).hand).toBeNull()
    s.onHand(encodeHand(hand))
    expect(s.consume(performance.now(), true).hand).toBeNull()
  })

  it('orders sequence and generation wrap and ignores a duplicate with a changed identity', () => {
    const s = stream()
    s.onHand(encodeHand({ ...hand, seq: 65535, t: 0xffffffff, gen: 255 }))
    const oldGen = s.consume(performance.now(), true).hand!.gen
    s.onHand(encodeHand({ ...hand, seq: 0, t: 0, gen: 0, p: [1, 0, 0] }))
    const current = s.consume(performance.now(), true).hand
    expect(current?.gen).toBeGreaterThan(oldGen)
    expect(current?.p).toEqual([1, 0, 0])
    s.onHand(encodeHand({ ...hand, seq: 65535, gen: 255 }))
    s.onHand(encodeHand({ ...hand, seq: 0, gen: 1, handedness: 'right' }))
    expect(s.consume(performance.now(), true).hand).toEqual(current)
  })

  it('keeps an identity while tracking and gives reacquisition and handedness changes new anchors', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const s = stream()
    s.onHand(encodeHand(hand))
    const first = s.consume(performance.now(), true).hand!.gen
    s.onHand(encodeHand({ ...hand, seq: 11, p: [1, 0, 0] }))
    expect(s.consume(performance.now(), true).hand!.gen).toBe(first)
    s.onHand(encodeHand({ ...hand, seq: 12, flags: 0, gestures: 0 }))
    expect(s.consume(performance.now(), true).hand).toMatchObject({ gen: first, tracked: false, gestures: 0 })
    s.onHand(encodeHand({ ...hand, seq: 13 }))
    const acquired = s.consume(performance.now(), true).hand!.gen
    expect(acquired).toBeGreaterThan(first)
    s.onHand(encodeHand({ ...hand, seq: 14, handedness: 'right' }))
    const switched = s.consume(performance.now(), true).hand!.gen
    expect(switched).toBeGreaterThan(acquired)
    // A consumer need not have read the expired frame for the next acquisition to get a new anchor.
    vi.advanceTimersByTime(250)
    s.onHand(encodeHand({ ...hand, seq: 15, handedness: 'right' }))
    expect(s.consume(performance.now(), true).hand!.gen).toBeGreaterThan(switched)
  })

  it('never reuses a host generation after wire wrap or reset', () => {
    const s = stream(), seen = new Set<number>()
    let previous = 0
    const remember = () => {
      const gen = s.consume(performance.now(), true).hand!.gen
      expect(gen).toBeGreaterThan(previous)
      expect(seen.has(gen)).toBe(false)
      seen.add(gen); previous = gen
    }
    for (let i = 0; i < 260; i++) {
      s.onHand(encodeHand({ ...hand, seq: i, gen: i & 0xff }))
      remember()
    }
    s.reset()
    expect(s.consume(performance.now(), true).hand).toBeNull()
    s.onHand(encodeHand(hand))
    remember()
  })
})

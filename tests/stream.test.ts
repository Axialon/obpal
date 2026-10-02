import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePose, encodeState, emptyState, Flag, PoseFlag, type PoseState } from '@obpal/core'
import { Stream } from '../packages/host/src/stream'

beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); vi.advanceTimersByTime(100) })
afterEach(() => vi.useRealTimers())

const pose: PoseState = { flags: PoseFlag.tracked | PoseFlag.touching, seq: 10, t: 0, p: [0, 0, 0], q: [0, 0, 0, 1], gen: 1, source: 'camera' }
const stream = () => new Stream({ mode: () => {}, pad: () => {}, input: () => {} })

it('activity ignores neutral heartbeats, expires, and never consumes motion deltas', () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const s = stream()
  s.onState(encodeState(emptyState()))
  expect(s.inputActive).toBe(false)
  s.consume(performance.now(), true)
  s.onState(encodeState({ ...emptyState(), seq: 1, flags: Flag.touching, aim: [12, 4] }))
  expect(s.inputActive).toBe(true)
  expect(s.inputActive).toBe(true)
  expect(s.consume(performance.now() + 30, true).aim).toEqual([12, 4])
  vi.advanceTimersByTime(301)
  expect(s.inputActive).toBe(false)
})

describe('the pose stream', () => {
  it.each(['camera', 'model', 'unknown'] as const)('exposes the %s source to hosts', (source) => {
    const s = stream()
    s.onPose(encodePose({ ...pose, source }))
    expect(s.consume(performance.now(), true).pose).toMatchObject({ source, tracked: true, touching: true })
  })

  it('ignores a late packet from an older generation, without refreshing its expiry', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const s = stream()
    s.onPose(encodePose(pose))
    s.onPose(encodePose({ ...pose, seq: 11, gen: 2, p: [1, 0, 0] }))
    const current = s.consume(performance.now(), true).pose
    vi.advanceTimersByTime(200)
    s.onPose(encodePose(pose))
    expect(s.consume(performance.now(), true).pose).toEqual(current)
    vi.advanceTimersByTime(50)
    expect(s.consume(performance.now(), true).pose).toBeNull()
    s.onPose(encodePose(pose))
    expect(s.consume(performance.now(), true).pose).toBeNull()
  })

  it('orders across both sequence and generation wrap, rejecting duplicates too', () => {
    const s = stream()
    s.onPose(encodePose({ ...pose, seq: 65535, gen: 255 }))
    s.onPose(encodePose({ ...pose, seq: 0, gen: 0, p: [1, 0, 0] }))
    const current = s.consume(performance.now(), true).pose
    s.onPose(encodePose({ ...pose, seq: 65535, gen: 255 }))
    s.onPose(encodePose({ ...pose, seq: 0, gen: 1 }))
    expect(s.consume(performance.now(), true).pose).toEqual(current)
    expect(current?.p).toEqual([1, 0, 0])
  })

  it('never reuses a host generation after wire wrap, a source switch, or a reset', () => {
    const s = stream(), seen = new Set<number>()
    const remember = () => {
      const gen = s.consume(performance.now(), true).pose!.gen
      expect(seen.has(gen)).toBe(false)
      seen.add(gen)
    }
    for (let i = 0; i < 260; i++) {
      s.onPose(encodePose({ ...pose, seq: i, gen: i }))
      remember()
    }
    s.onPose(encodePose({ ...pose, seq: 260, gen: 259, source: 'model' }))
    remember()
    s.reset()
    s.onPose(encodePose(pose))
    remember()
  })
})

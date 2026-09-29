import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeBody, encodeHand } from '@obpal/core'
import { BodyInput } from '../packages/host/src/body'
import { Stream } from '../packages/host/src/stream'
import { bodyState } from './body-fixture'
afterEach(() => vi.useRealTimers())
describe('body input lifetime', () => {
  it('expires at 250 ms, retaining sequence order across expiry and generation changes', () => {
    const input = new BodyInput(), packet = encodeBody(bodyState())
    expect(input.read(0)).toBeNull(); expect(input.receive(packet, 10)).toBe(true)
    expect(input.read(259)?.tracked).toBe(true)
    expect(input.receive(packet, 259)).toBe(false)
    expect(input.receive(encodeBody(bodyState({ seq: 1, gen: 10 })), 259)).toBe(false)
    expect(input.receive(new ArrayBuffer(276), 259)).toBe(false)
    expect(input.read(260)).toBeNull(); expect(input.receive(packet, 300)).toBe(false)
    expect(input.read(300)).toBeNull()
  })
  it('orders wrapped sequences before identity, and gives reacquisition a fresh host generation', () => {
    const input = new BodyInput()
    input.receive(encodeBody(bodyState({ seq: 65535, gen: 255, t: 0xffffffff })), 0)
    const first = input.read(0)!
    input.receive(encodeBody(bodyState({ seq: 0, gen: 0, t: 0 })), 1)
    expect(input.read(1)!.gen).toBeGreaterThan(first.gen)
    expect(input.read(1)!.t).toBe(0)
    const gen = input.read(1)!.gen
    input.receive(encodeBody(bodyState({ seq: 1, gen: 0, flags: 0 })), 2)
    expect(input.read(2)?.tracked).toBe(false)
    input.receive(encodeBody(bodyState({ seq: 2, gen: 0 })), 3)
    expect(input.read(3)!.gen).toBeGreaterThan(gen)
    const acquired = input.read(3)!.gen
    input.reset(); input.receive(encodeBody(bodyState({ seq: 0 })), 4)
    expect(input.read(4)!.gen).toBeGreaterThan(acquired)
  })
  it('composes independently with HAND and neutral STATE, resets with the stream', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const input = vi.fn(), s = new Stream({ mode: () => {}, pad: () => {}, input })
    expect(s.consume(performance.now(), false).body).toBeNull()
    s.onBody(encodeBody(bodyState()))
    s.onHand(encodeHand({ flags: 1, seq: 10, t: 45, gen: 1, handedness: 'left', confidence: 1, gestures: 0, p: [0, 0, 0], landmarks: Array.from({ length: 21 }, () => [0, 0, 0]) }))
    const f = s.consume(performance.now(), true)
    expect(f.body?.landmarks).toHaveLength(33); expect(f.hand?.t).toBe(45); expect(f.pose).toBeNull()
    expect(input).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(250); expect(s.consume(performance.now(), true).body).toBeNull()
    s.reset(); expect(s.consume(performance.now(), true).body).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPad, emptyState, encodePad, encodeState, Flag, Mode, PadButton } from '@obpal/core'
import { Remote } from '../packages/host/src/remote'
import { Stream } from '../packages/host/src/stream'

beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); vi.advanceTimersByTime(100) })
afterEach(() => vi.useRealTimers())

describe('a silent gamepad', () => {
  it('is neutral at 300 ms, disconnects at 1.5 s, and returns on the next packet', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const changed = vi.fn()
    const stream = new Stream({ mode: () => {}, pad: changed, input: () => {} })
    const held = { ...emptyPad(), seq: 7, buttons: 1 << PadButton.A, axes: [1, -1, 1, -1] as [number, number, number, number], triggers: [1, 1] as [number, number] }
    stream.onPad(encodePad(held))
    vi.advanceTimersByTime(299)
    expect(stream.pad).toEqual(held)
    vi.advanceTimersByTime(1)
    expect.soft(stream.pad).toMatchObject({ buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0] })
    expect(changed.mock.calls).toEqual([[true]])
    vi.advanceTimersByTime(1199)
    expect.soft(stream.pad).toMatchObject({ buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0] })
    vi.advanceTimersByTime(1)
    expect(stream.pad).toBeNull()
    expect(stream.pad).toBeNull()
    expect(changed.mock.calls).toEqual([[true], [false]])
    stream.onPad(encodePad({ ...held, seq: 8 }))
    expect(stream.pad).toEqual({ ...held, seq: 8 })
    expect(changed.mock.calls).toEqual([[true], [false], [true]])
  })

  it('resumes during the grace period, but duplicate and older packets do not prolong a hold', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const changed = vi.fn()
    const stream = new Stream({ mode: () => {}, pad: changed, input: () => {} })
    const held = { ...emptyPad(), seq: 7, buttons: 1 << PadButton.A }
    stream.onPad(encodePad(held))
    vi.advanceTimersByTime(250)
    stream.onPad(encodePad(held))
    stream.onPad(encodePad({ ...held, seq: 6 }))
    vi.advanceTimersByTime(50)
    expect.soft(stream.pad?.buttons).toBe(0)
    stream.onPad(encodePad({ ...held, seq: 8 }))
    expect(stream.pad?.buttons).toBe(held.buttons)
    vi.advanceTimersByTime(299)
    expect(stream.pad?.buttons).toBe(held.buttons)
    vi.advanceTimersByTime(1)
    expect.soft(stream.pad?.buttons).toBe(0)
    expect(changed.mock.calls).toEqual([[true]])
  })
})

describe('a screen’s paused phone', () => {
  it('accepts the first gamepad packet without a STATE, including after an attention reset', () => {
    const stream = new Stream({ mode: () => {}, pad: () => {}, input: () => {} }, 'direct')
    const pad = emptyPad()
    pad.buttons = 1 << PadButton.A
    pad.axes = [0, 0, 0.25, -0.8]
    for (let n = 0; n < 2; n++) {
      stream.onPad(encodePad(pad))
      expect(stream.consume(performance.now(), true)).toMatchObject({ connected: true, mode: Mode.gamepad })
      expect(stream.pad).toMatchObject({ buttons: 1 << PadButton.A })
      expect(stream.pad!.axes[3]).toBeCloseTo(-0.8, 3)
      stream.reset()
      expect(stream.pad).toBeNull()
    }
    // Returning to a touch or motion face still replaces a previously live pad.
    stream.onPad(encodePad(pad))
    const state = emptyState()
    state.mode = Mode.tilt
    state.flags = Flag.touching | Flag.clutch
    state.tilt = [0.25, -1]
    stream.onState(encodeState(state))
    const frame = stream.consume(performance.now(), true)
    expect(frame).toMatchObject({ mode: Mode.tilt, touching: true, clutch: true })
    expect(frame.tilt[1]).toBe(-1)
  })
  it('resets held input, ignores paused controls, still answers pings, and resumes without changing identity', async () => {
    const events: unknown[] = [], sent: string[] = []
    const stream = new Stream({ mode: () => {}, pad: () => {}, input: () => {} }, 'direct')
    const peer = { id: 'one', name: 'Phone', color: '#c6ff34', since: 1, caps: null, bound: true, pair: 'this-pc-only', fp: new Uint8Array(32), stream, ctl: { readyState: 'open', send: (m: string) => sent.push(m) } }
    const remote = Object.create(Remote.prototype) as Remote
    Object.assign(remote, { active: peer, peers: new Map([['one', peer]]), opts: { seats: 1 }, cards: [], status: 'connected', handlers: { attention: [(p: unknown) => events.push(p)], button: [vi.fn()], pad: [] } })
    const on = (m: object) => (remote as unknown as { onCtl(peer: unknown, data: string): Promise<void> }).onCtl(peer, JSON.stringify(m))
    const state = emptyState(); state.flags = Flag.touching; state.seq = 1
    stream.onState(encodeState(state))
    await on({ t: 'attention', active: false })
    expect(remote.participants[0]).toMatchObject({ pair: 'this-pc-only', paused: true })
    expect(remote.consume().touching).toBe(false)
    await on({ t: 'btn', id: 'key-Enter', ev: 'tap' })
    expect((remote as unknown as { handlers: { button: ReturnType<typeof vi.fn>[] } }).handlers.button[0]).not.toHaveBeenCalled()
    await on({ t: 'ping', t0: 1 })
    expect(sent.map((s) => JSON.parse(s))).toEqual([{ t: 'pong', t0: 1 }])
    await on({ t: 'attention', active: 'yes', otherScreen: 'private' })
    expect(remote.participants[0].paused).toBe(true)
    await on({ t: 'attention', active: true })
    expect(remote.participants[0].paused).toBeUndefined()
    expect(remote.participants[0].pair).toBe('this-pc-only')
    expect(events).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain('private')
  })
})

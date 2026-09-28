import { describe, expect, it, vi } from 'vitest'
import { emptyState, encodeState, Flag } from '@obpal/core'
import { Remote } from '../packages/host/src/remote'
import { Stream } from '../packages/host/src/stream'

describe('a screen’s paused phone', () => {
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

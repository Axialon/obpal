import { afterEach, describe, expect, it, vi } from 'vitest'
import * as core from '@obpal/core'
import {
  bindMac, DeviceLink, forgetConnection, getPair, importPairKey, isConnection, listConnections, migrateConnections,
  putConnection, putPair, saveInvite, type DeviceMsg, type HostMsg, type LinkStatus, type StoredConnection,
} from '@obpal/core'
import { Connections } from '../src/controller/connections'

const secret = (n: number) => new Uint8Array(16).fill(n)
const fp = new Uint8Array(32).fill(2)
const join = (n: number) => ({ v: 1 as const, pairing: { secret: secret(n), fp } })

afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const row of await listConnections()) await forgetConnection(row); vi.unstubAllGlobals() })

describe('the connection store', () => {
  it('migrates remembered PCs once and preserves renames and the original non-extractable key', async () => {
    const pair = { id: 'old-pc', key: await importPairKey(new Uint8Array(32)), peerFp: fp, peerName: 'Desk PC', at: 12 }
    await putPair(pair)
    const rows = await listConnections()
    expect(rows).toEqual([{ id: 'pair:old-pc', pairId: 'old-pc', name: 'Desk PC', kind: 'pc', at: 12 }])
    const renamed: StoredConnection = { ...rows[0], name: 'Studio', renamed: true }
    await putConnection(renamed)
    expect(migrateConnections([renamed], [pair])).toEqual([renamed])
    expect(migrateConnections([], [{ ...pair, at: NaN }])).toEqual([])
    expect((await getPair(pair.id))?.key).toBe(pair.key)
    expect(await listConnections()).toEqual([renamed])
    await forgetConnection(renamed)
    expect(await listConnections()).toEqual([])
    expect(await getPair(pair.id)).toBeNull()
  })
  it('keeps a verified invite as a non-extractable key with exactly the original binding', async () => {
    const p = join(3).pairing
    const invite = await saveInvite(p)
    expect(invite.key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', invite.key)).rejects.toThrow()
    expect(await bindMac(invite.key, fp, fp, invite.room)).toBe(await bindMac(p.secret, fp, fp, invite.room))
    const row: StoredConnection = { id: 'test', name: 'Viewer', kind: 'viewer', at: 10, invite }
    await putConnection(row)
    expect(await listConnections()).toEqual([row])
    expect(isConnection({ ...row, invite: { ...invite, key: secret(1) } })).toBe(false)
    expect(isConnection({ ...row, at: NaN })).toBe(false)
    expect(isConnection({ ...row, kind: 'admin' })).toBe(false)
  })
})

class Link {
  status: LinkStatus = 'connecting'
  sent: DeviceMsg[] = []
  frames: ArrayBuffer[] = []
  closes = 0
  handlers = new Map<string, ((v: never) => void)[]>()
  get ready() { return this.status === 'connected' }
  on(ev: string, fn: (v: never) => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]) }
  emit(ev: string, v: unknown) { for (const fn of this.handlers.get(ev) ?? []) fn(v as never) }
  async start() {}
  sendCtl(m: DeviceMsg) { this.sent.push(m) }
  sendState(b: ArrayBuffer) { this.frames.push(b); return true }
  close() { ++this.closes; this.status = 'closed'; this.emit('status', 'closed') }
  welcome(name: string, extra: Partial<Extract<HostMsg, { t: 'welcome' }>> = {}) {
    this.status = 'connected'
    this.emit('status', 'connected')
    this.emit('message', { t: 'welcome', proto: 1, name, kind: 'viewer', layout: { v: 1, tray: [] }, ...extra })
  }
}
function hub() {
  const links: Link[] = []
  const messages: HostMsg[] = []
  const order: string[] = []
  const attempts: (string | null)[] = []
  const current = new Connections({ service: 'https://obpal.example', cert: Promise.resolve(null), name: Promise.resolve('Phone'),
    caps: () => ({ tier: 0, sensorApi: 'none', haptics: 'none', platform: 'test' }),
    beforeSwitch: () => order.push(`release:${current.current}`), switched: (c) => order.push(`switch:${c?.row.name ?? 'none'}`),
    status: () => {}, stats: () => {}, message: (m) => messages.push(m), attempt: c => attempts.push(c?.stillConnecting ? 'still' : c ? 'pending' : null), create: () => { const link = new Link(); links.push(link); return link as unknown as DeviceLink },
  })
  return { current, links, messages, order, attempts }
}

describe('switching connections', () => {
  it('sends input as soon as welcome arrives while a key import and its storage commit are still pending', async () => {
    const invite = await saveInvite(join(30).pairing)
    let importDone!: (v: typeof invite) => void, commitDone!: () => void
    vi.spyOn(core, 'saveInvite').mockImplementation(() => new Promise((r) => { importDone = r }))
    const put = core.putConnection
    const committing = vi.spyOn(core, 'putConnection').mockImplementationOnce(async (row) => {
      await new Promise<void>((r) => { commitDone = r })
      await put(row)
    })
    const h = hub()
    await h.current.connect(join(30)); h.links[0].welcome('A')
    expect(h.current.ready).toBe(true)
    expect(h.current.saving).toBe(true)
    h.current.sendCtl({ t: 'btn', id: 'a', ev: 'tap' })
    h.current.sendState(new ArrayBuffer(1))
    expect(h.links[0].sent.at(-1)).toEqual({ t: 'btn', id: 'a', ev: 'tap' })
    expect(h.links[0].frames).toHaveLength(1)
    let confirmed = false
    const renamed = h.current.rename(h.current.current, 'Desk').then(() => { confirmed = true })
    await vi.waitFor(() => expect(importDone).toBeTypeOf('function'))
    expect(confirmed).toBe(false)
    importDone(invite)
    await vi.waitFor(() => expect(committing).toHaveBeenCalledOnce())
    expect(confirmed).toBe(false)
    expect(h.current.saving).toBe(true)
    commitDone()
    await renamed
    expect(confirmed).toBe(true)
    expect(h.current.saving).toBe(false)
    expect(await listConnections()).toEqual([expect.objectContaining({ name: 'Desk', renamed: true, invite })])
    h.current.destroy(); await h.current.settled()
  })
  it('releases before switching, routes input only to the active screen, and keeps background state private', async () => {
    const h = hub()
    await h.current.connect(join(10)); h.links[0].welcome('A', { attention: true })
    const a = h.current.current
    await h.current.connect(join(11)); h.links[1].welcome('B', { attention: true })
    expect(h.order.slice(-2)).toEqual([`release:${a}`, 'switch:B'])
    expect(h.links[0].sent.at(-1)).toEqual({ t: 'attention', active: false })
    const b = h.current.current
    h.links.forEach((l) => { l.sent = []; l.frames = [] })
    h.current.sendCtl({ t: 'text', s: 'only B' }); h.current.sendState(new ArrayBuffer(1))
    expect(h.links[0].sent).toEqual([]); expect(h.links[0].frames).toHaveLength(0)
    expect(h.links[1].sent).toEqual([{ t: 'text', s: 'only B' }]); expect(h.links[1].frames).toHaveLength(1)
    h.links[0].emit('message', { t: 'state', values: { notice: 'Waiting for approval on the PC', secret: 'A only' } })
    expect(h.messages).toEqual([])
    expect(h.current.active?.values).toEqual({})
    h.current.activate(a)
    expect(h.current.active?.values.notice).toBe('Waiting for approval on the PC')
    expect(h.links[1].sent.at(-1)).toEqual({ t: 'attention', active: false })
    h.current.activate(b)
    expect(h.current.active?.values.secret).toBeUndefined()
    h.current.destroy(); await h.current.settled()
  })
  it('does not activate an unverified or failed new screen; latest selection wins late welcomes', async () => {
    const h = hub()
    await h.current.connect(join(12)); h.links[0].welcome('A')
    const a = h.current.current
    await h.current.connect(join(13))
    expect(h.current.current).toBe(a)
    h.links[1].status = 'code-wrong'; h.links[1].emit('status', 'code-wrong')
    expect(h.current.current).toBe(a)
    expect(h.current.ready).toBe(true)
    await h.current.connect(join(14)); h.links[2].welcome('C')
    const c = h.current.current
    h.links[1].welcome('B')
    expect(h.current.current).toBe(c)
    expect(h.links[1].closes).toBe(1)
    expect(h.links[1].sent).toEqual([])
    h.current.destroy(); await h.current.settled()
  })
  it('evicts the least recently used idle link, persists its row, and forget cannot be undone by late events', async () => {
    const h = hub()
    h.current.setLimit(2)
    await h.current.connect(join(15)); h.links[0].welcome('A')
    const a = h.current.current
    await h.current.connect(join(16)); h.links[1].welcome('B')
    await h.current.connect(join(17)); h.links[2].welcome('C')
    expect(h.links[0].status).toBe('closed')
    expect(h.current.rows.has(a)).toBe(true)
    expect(h.current.live.size).toBe(2)
    const c = h.current.current
    await h.current.forget(c)
    h.links[2].welcome('C again')
    await h.current.settled()
    expect(h.current.rows.has(c)).toBe(false)
    expect((await listConnections()).some((r) => r.id === c)).toBe(false)
    h.current.destroy(); await h.current.settled()
  })
  it('a reconnect cannot replace a pending choice, and choosing the active screen cancels that choice', async () => {
    const h = hub()
    await h.current.connect(join(20)); h.links[0].welcome('A')
    await h.current.connect(join(21))
    h.links[0].welcome('A reconnected')
    h.links[1].welcome('B')
    expect(h.current.active?.row.name).toBe('B')
    const b = h.current.current
    await h.current.connect(join(22))
    h.current.activate(b)
    h.links[2].welcome('C')
    expect(h.current.current).toBe(b)
    expect(h.links[2].closes).toBe(1)
    expect(h.links[2].sent).toEqual([])
    h.current.destroy(); await h.current.settled()
  })
  it('a scanner suspends hardware and motion, then restores this screen’s latest state', async () => {
    const h = hub()
    await h.current.connect(join(18)); h.links[0].welcome('A')
    h.current.suspend(true)
    h.links[0].sent = []
    h.current.sendCtl({ t: 'btn', id: 'a', ev: 'tap' }); h.current.sendState(new ArrayBuffer(1))
    expect(h.links[0].sent).toEqual([]); expect(h.links[0].frames).toEqual([])
    h.links[0].emit('message', { t: 'state', values: { notice: 'Denied on this PC' } })
    expect(h.messages).toEqual([])
    h.current.suspend(false)
    expect(h.messages.at(-1)).toEqual({ t: 'state', values: { notice: 'Denied on this PC' } })
    expect(h.links[0].sent).toEqual([{ t: 'attention', active: true }])
    h.current.destroy(); await h.current.settled()
  })
  it('keeps a pending attempt recoverable beyond two minutes without retrying or sending input', async () => {
    vi.useFakeTimers()
    const h = hub()
    await h.current.connect({ v: 'code', code: { handle: '12345', secret: '67890', room: 'pending', ticket: 'test-ticket' } })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(h.current.attempt?.stillConnecting).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.current.attempt?.stillConnecting).toBe(true)
    expect(h.attempts.at(-1)).toBe('still')
    h.links[0].status = 'waiting-host'; h.links[0].emit('status', 'waiting-host')
    await vi.advanceTimersByTimeAsync(146_000)
    expect(h.current.attempt?.stillConnecting).toBe(true)
    expect(h.links).toHaveLength(1)
    h.current.sendCtl({ t: 'btn', id: 'a', ev: 'tap' }); h.current.sendState(new ArrayBuffer(1))
    expect(h.links[0].sent).toEqual([]); expect(h.links[0].frames).toEqual([])
    expect(h.current.cancel(h.current.attempt!.row.id)).toBe(true)
    expect(h.current.attempt).toBeNull()
    expect(h.attempts.at(-1)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    h.current.destroy(); await h.current.settled()
  })
  it('cancels only the pending saved screen, preserving its invite and a different active screen', async () => {
    const h = hub()
    await h.current.connect(join(40)); h.links[0].welcome('A')
    await h.current.connect(join(41)); h.links[1].welcome('B')
    const b = h.current.current
    await h.current.settled()
    const before = h.current.rows.get(b)!
    h.current.activate(h.current.rows.keys().next().value!)
    const a = h.current.current
    h.links[1].status = 'waiting-host'
    await h.current.use(b)
    const cancelled = h.links[2]
    expect(h.current.cancel(b)).toBe(true)
    expect(h.current.current).toBe(a)
    expect(h.current.ready).toBe(true)
    cancelled.welcome('Late B')
    cancelled.emit('invite', core.encodePairing(join(99).pairing))
    cancelled.emit('pair', { id: 'late-pair', peerName: 'Late B' })
    await h.current.settled()
    expect(h.current.rows.get(b)).toEqual(before)
    expect((await listConnections()).find(r => r.id === b)).toEqual(before)
    expect(h.current.current).toBe(a)
    h.current.sendCtl({ t: 'btn', id: 'a', ev: 'tap' })
    expect(cancelled.sent).toEqual([])
    expect(h.links[0].sent.at(-1)).toEqual({ t: 'btn', id: 'a', ev: 'tap' })
    expect(h.current.cancel(a)).toBe(false)
    h.current.destroy(); await h.current.settled()
  })
  it('retires superseded attempts immediately and repeated retry/cancel leaves no links or UI timers', async () => {
    vi.useFakeTimers()
    const h = hub()
    await h.current.connect(join(50))
    const first = h.links[0]
    const second = h.current.connect(join(51))
    first.welcome('Too late')
    await second
    expect(h.current.active).toBeNull()
    expect(first.closes).toBe(1)
    for (let i = 0; i < 12; i++) {
      const pending = h.current.attempt!
      h.current.cancel(pending.row.id)
      const link = h.links.at(-1)!
      link.welcome('Cancelled')
      expect(h.current.ready).toBe(false)
      expect(h.current.live.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      if (i < 11) await h.current.connect(join(52 + i))
    }
    expect(h.links.every(l => l.closes === 1)).toBe(true)
    h.current.destroy(); await h.current.settled()
  })
  it('restores a usable welcome once and preserves refusal phases without making them ready', async () => {
    const h = hub()
    await h.current.connect(join(70))
    for (const status of ['waiting-host', 'unreachable', 'code-wrong', 'invite-used', 'full'] as const) {
      h.links[0].status = status; h.links[0].emit('status', status)
      expect(h.current.attempt?.failure ?? h.current.attempt?.link.status).toBe(status)
      expect(h.current.ready).toBe(false)
    }
    h.links[0].status = 'connected'; h.links[0].emit('status', 'connected')
    expect(h.current.ready).toBe(false)
    h.links[0].welcome('Late refused host')
    expect(h.current.ready).toBe(false)
    await h.current.connect(join(71))
    h.links[1].welcome('Returned host')
    h.links[1].welcome('Returned host')
    expect(h.current.ready).toBe(true)
    expect(h.order.filter(s => s === 'switch:Returned host')).toHaveLength(1)
    expect(h.current.attempt).toBeNull()
    h.current.destroy(); await h.current.settled()
  })
  it('keeps terminal refusals visible through socket shutdown and needs an explicit fresh attempt', async () => {
    vi.useFakeTimers()
    const h = hub()
    await h.current.connect(join(72))
    h.links[0].status = 'invite-used'; h.links[0].emit('status', 'invite-used')
    h.links[0].status = 'signaling'; h.links[0].emit('status', 'signaling')
    await vi.advanceTimersByTimeAsync(150_000)
    expect(h.current.attempt?.failure).toBe('invite-used')
    expect(h.current.attempt?.stillConnecting).toBe(false)
    h.links[0].welcome('Late host')
    expect(h.current.active).toBeNull()
    expect(h.current.ready).toBe(false)
    expect(h.links).toHaveLength(1)
    h.current.destroy(); await h.current.settled()
  })
})

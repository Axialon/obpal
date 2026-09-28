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

afterEach(async () => { vi.restoreAllMocks(); for (const row of await listConnections()) await forgetConnection(row); vi.unstubAllGlobals() })

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
  handlers = new Map<string, ((v: never) => void)[]>()
  get ready() { return this.status === 'connected' }
  on(ev: string, fn: (v: never) => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]) }
  emit(ev: string, v: unknown) { for (const fn of this.handlers.get(ev) ?? []) fn(v as never) }
  async start() {}
  sendCtl(m: DeviceMsg) { this.sent.push(m) }
  sendState(b: ArrayBuffer) { this.frames.push(b); return true }
  close() { this.status = 'closed'; this.emit('status', 'closed') }
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
  const current = new Connections({ service: 'https://obpal.example', cert: Promise.resolve(null), name: Promise.resolve('Phone'),
    caps: () => ({ tier: 0, sensorApi: 'none', haptics: 'none', platform: 'test' }),
    beforeSwitch: () => order.push(`release:${current.current}`), switched: (c) => order.push(`switch:${c?.row.name ?? 'none'}`),
    status: () => {}, stats: () => {}, message: (m) => messages.push(m), create: () => { const link = new Link(); links.push(link); return link as unknown as DeviceLink },
  })
  return { current, links, messages, order }
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
    expect(h.links[1].sent.at(-1)).toEqual({ t: 'attention', active: false })
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
    expect(h.links[2].sent.at(-1)).toEqual({ t: 'attention', active: false })
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
})

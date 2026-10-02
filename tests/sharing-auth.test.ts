import { afterEach, describe, expect, it, vi } from 'vitest'
import { admissionFor, b64url, bindMac, emptyPad, encodePad, importPairKey, newSecret, parsePairing, encodePairing, sealShareTarget, openShareTarget } from '@obpal/core'
import { Remote } from '../packages/host/src/remote'
import { Stream } from '../packages/host/src/stream'
import { resolveShortLink } from '../src/controller/short-link'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function host() {
  const r = Object.create(Remote.prototype) as any
  Object.assign(r, { opts: { seats: 8 }, active: null, host: { color: '#38bdf8' }, held: {}, peers: new Map(), blockedInputs: [], emit: vi.fn(), firstInputAt: 0, idle: new Stream({ mode: () => {}, pad: () => {}, input: () => {} }) })
  return r
}
describe('watch capabilities', () => {
  it('replaces the pairing code without rotating Play or dropping connected peers', async () => {
    const r = host(), secret = newSecret()
    const sharing = { play: b64url(secret), watch: b64url(newSecret()), owner: 'owner', playOpen: true, watchOpen: true }
    const before = { ...sharing }
    Object.assign(r, { sharing, sig: { send: vi.fn() }, setCode: vi.fn(), askCode: vi.fn(), newShareLink: vi.fn(), dropPeer: vi.fn(), spentCodes: new Map([['spent', 1]]), recentCodes: new Map([['recent', 1]]), codeBinds: new Map([['pending', 1]]) })
    r.peers.set('player', { bound: true, capability: 'play' })
    r.peers.set('watcher', { bound: true, capability: 'watch' })
    await r.resetInvite()
    expect(r.sig.send).toHaveBeenCalledWith({ t: 'code', op: 'drop' })
    expect(r.setCode).toHaveBeenCalledWith(null); expect(r.askCode).toHaveBeenCalledOnce()
    expect(r.spentCodes.size + r.recentCodes.size + r.codeBinds.size).toBe(0)
    expect(r.sharing).toEqual(before)
    expect(r.newShareLink).not.toHaveBeenCalled(); expect(r.dropPeer).not.toHaveBeenCalled()
    expect(r.peers.size).toBe(2)
  })
  it('adding a phone refreshes only the short code and preserves the shared keys and connected peers', async () => {
    const r = host(), sharing = { play: 'play', watch: 'watch', playOpen: true }
    Object.assign(r, { sharing, sig: { send: vi.fn() }, setCode: vi.fn(), askCode: vi.fn(), newShareLink: vi.fn(), resetInvite: vi.fn() })
    const phone = { id: 'phone', bound: true, capability: 'play' }; r.peers.set(phone.id, phone)
    await r.inviteAnotherPhone()
    expect(r.sharing).toEqual(sharing); expect(r.peers.get(phone.id)).toBe(phone)
    expect(r.sig.send).toHaveBeenCalledWith({ t: 'code', op: 'drop' }); expect(r.setCode).toHaveBeenCalledWith(null); expect(r.askCode).toHaveBeenCalledOnce()
    expect(r.newShareLink).not.toHaveBeenCalled(); expect(r.resetInvite).not.toHaveBeenCalled()
    r.sharing = null; await r.inviteAnotherPhone(); expect(r.resetInvite).toHaveBeenCalledOnce()
  })
  it('seat grants accept only bounded sim input and never unlock binary, raw readers or hardware', async () => {
    const r = host(), channels = new Map()
    r.sceneChanged = vi.fn(); r.layout = { v: 1, tray: [{ id: 'home', label: 'Home' }] }
    const pc = { createDataChannel: (id: string) => { const channel = { readyState: 'open', send: vi.fn() }; channels.set(id, channel); return channel } }
    const p = r.addPeer('watcher', pc, null); p.bound = true; p.capability = 'watch'
    const packet = { t: 'sim', v: 1, kind: 'seat', seq: 1, data: { x: .5, y: -.5 } }
    await r.onCtl(p, JSON.stringify(packet)); expect(r.simPadOf(p.id)).toBeNull()
    expect(r.setSimSeat(p.id, 'rover1')).toBe(true)
    await r.onCtl(p, JSON.stringify(packet)); expect(r.simPadOf(p.id)?.axes).toEqual([.5, -.5, 0, 0])
    channels.get('st').onmessage({ data: encodePad({ ...emptyPad(), axes: [1, 1, 1, 1] }) })
    expect(r.padOf(p.id)).toBeNull(); expect(r.consumeOf(p.id).connected).toBe(false); expect(r.canDriveHardware(p.id)).toBe(false)
    await r.onCtl(p, JSON.stringify({ ...packet, seq: 2, data: { x: 0, y: 0, action: 'arm' } })); expect(r.simPadOf(p.id)?.axes[0]).toBe(.5)
    r.setSimSeat(p.id, null); expect(r.simPadOf(p.id)).toBeNull(); expect(r.participants[0].role).toBe('watch')
    await r.onCtl(p, JSON.stringify({ ...packet, seq: 3 })); expect(r.simPadOf(p.id)).toBeNull()
  })
  it('demoting a Play peer immediately removes its lead and raw input authority', async () => {
    const r = host(); r.sceneChanged = vi.fn(); r.layout = { v: 1, tray: [] }
    const pc = { createDataChannel: () => ({ readyState: 'open', send: vi.fn() }) }, p = r.addPeer('phone', pc, null)
    p.bound = true; p.capability = 'play'; r.active = p
    p.stream.onPad(encodePad({ ...emptyPad(), axes: [1, 0, 0, 0] })); expect(r.padOf(p.id)?.axes[0]).toBeCloseTo(1)
    expect(r.canDriveHardware(p.id)).toBe(true)
    r.setSimSeat(p.id, null); expect(r.padOf(p.id)).toBeNull(); expect(r.leadPhone()).toBeNull(); expect(r.canDriveHardware(p.id)).toBe(false)
    r.emit.mockClear(); await r.onCtl(p, JSON.stringify({ t: 'btn', id: 'home', ev: 'down' })); expect(r.emit.mock.calls.every(([event]: [string]) => event === 'blocked')).toBe(true)
  })
  it('ends the grant and exposes the released seat when the host removes its model', () => {
    const r = host(); r.sceneChanged = vi.fn(); r.nodesVersion = 0; r.held = {}
    const pc = { createDataChannel: () => ({ readyState: 'open', send: vi.fn() }) }, p = r.addPeer('watcher', pc, null)
    p.bound = true; p.capability = 'watch'
    r.setScene({ nodes: [{ id: 'arm1', name: 'Arm 1' }], held: { arm1: p.id } }); r.setSimSeat(p.id, 'arm1'); r.emit.mockClear()
    r.setScene({ nodes: [], held: {} })
    expect(r.participants[0].role).toBe('watch'); expect(r.simPadOf(p.id)).toBeNull()
    expect(r.emit).toHaveBeenCalledWith('role', expect.objectContaining({ releasedSeat: 'arm1', role: 'watch' }))
  })
  it('honours attention pause for scoped sim input without resuming an old held direction', async () => {
    const r = host(); r.sceneChanged = vi.fn(); r.renderCards = vi.fn(); r.layout = { v: 1, tray: [] }
    const pc = { createDataChannel: () => ({ readyState: 'open', send: vi.fn() }) }, p = r.addPeer('watcher', pc, null)
    p.bound = true; p.capability = 'watch'; r.setSimSeat(p.id, 'rover1')
    const packet = { t: 'sim', v: 1, kind: 'seat', seq: 1, data: { x: 1, y: 0 } }
    await r.onCtl(p, JSON.stringify(packet)); expect(r.simPadOf(p.id)?.axes[0]).toBe(1)
    await r.onCtl(p, JSON.stringify({ t: 'attention', active: false })); expect(r.simPadOf(p.id)).toBeNull()
    await r.onCtl(p, JSON.stringify({ ...packet, seq: 2 })); expect(r.simPadOf(p.id)).toBeNull()
    await r.onCtl(p, JSON.stringify({ t: 'attention', active: true })); expect(r.simPadOf(p.id)).toBeNull()
  })
  it('resolves a short Watch link locally and cannot decrypt Play metadata with a Watch key', async () => {
    const play = newSecret(), watch = newSecret(), room = b64url(newSecret()), target = { fp: b64url(new Uint8Array(32)), path: '/sim/kart/' }
    const sealed = await sealShareTarget(watch, target)
    await expect(openShareTarget(play, sealed)).rejects.toThrow()
    expect(await openShareTarget(await importPairKey(watch), sealed)).toEqual(target)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sealed }))))
    const url = new URL(await resolveShortLink(`#s.w.${room}.${b64url(watch)}`, 'https://example.org'))
    expect(url.pathname).toBe('/sim/kart/'); expect(url.searchParams.get('watch')).toBe('1')
    expect(parsePairing(url.hash)?.capability).toBe('watch')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sealed: await sealShareTarget(watch, { ...target, path: '//elsewhere.example/' }) }))))
    await expect(resolveShortLink(`#s.w.${room}.${b64url(watch)}`, 'https://example.org')).rejects.toThrow('fresh shared scene link')
  })
  it('uses independent keys, preserves their room and works with non-extractable saved keys', async () => {
    const play = newSecret(), watch = newSecret(), fp = new Uint8Array(32), room = 'a'.repeat(22)
    expect(await admissionFor(play)).not.toBe(await admissionFor(watch))
    expect(await admissionFor(await importPairKey(watch))).toBe(await admissionFor(watch))
    const decoded = parsePairing(encodePairing({ secret: watch, fp, room, capability: 'watch' }))!
    expect(decoded.capability).toBe('watch'); expect(decoded.room).toBe(room); expect(decoded.secret).toEqual(watch)
    expect(await bindMac(play, fp, fp, room)).not.toBe(await bindMac(watch, fp, fp, room))
  })
  it('blocks claims, presses, values, HAND/BODY/PAD/STATE and repeated captured inputs before dispatch', async () => {
    const r = host(), channels = new Map()
    const pc = { createDataChannel: (id: string) => { const channel = { readyState: 'open', send: vi.fn() }; channels.set(id, channel); return channel } }
    const p = r.addPeer('watcher', pc, null)
    p.bound = true; p.capability = 'watch'; p.caps = { platform: 'android' }
    for (let replay = 0; replay < 2; replay++) {
      for (const message of [{ t: 'claim', node: 'arm1' }, { t: 'btn', id: 'home', ev: 'tap' }, { t: 'value', id: 'arm', v: true }, { t: 'mode', m: 5 }]) await r.onCtl(p, JSON.stringify(message))
      for (const header of [0x11, 0x12, 0x15, 0x16, 0x17]) channels.get('st').onmessage({ data: Uint8Array.of(header).buffer })
      channels.get('st').onmessage({ data: encodePad({ ...emptyPad(), axes: [1, 1, 1, 1] }) })
    }
    expect(r.blockedInputs).toHaveLength(20)
    expect(r.emit.mock.calls.every(([event]: [string]) => event === 'blocked')).toBe(true)
    expect(r.padOf('watcher')).toBeNull(); expect(r.leadPhone()).toBeNull(); expect(r.inputActive('watcher')).toBe(false)
  })
  it('rejects a captured play binding even with the same certificate on watcher admission', async () => {
    vi.useFakeTimers()
    const r = host(), secret = newSecret(), watch = newSecret(), fp = new Uint8Array(32).fill(4), room = 'room'
    Object.assign(r, { secret, fp, roomId: room, sharing: { watchOpen: true, playOpen: true, watch: encodePairing({ secret: watch, fp }).split('.')[1] }, reject: vi.fn() })
    const peer = { bound: false, admission: 'watcher', fp }
    const captured = { t: 'hello', mac: await bindMac(secret, fp, fp, room), caps: { platform: 'android' }, name: 'Replay' }
    await r.onCtl(peer, JSON.stringify(captured))
    expect(r.reject).toHaveBeenCalledWith(peer); expect(peer.bound).toBe(false)
  })
  it('permits only validated presence, camera and drop requests; a presence pad cannot sneak in', async () => {
    const r = host(), p = { id: 'w', bound: true, capability: 'watch' }
    for (const kind of ['watch', 'drop', 'camera']) await r.onCtl(p, JSON.stringify({ t: 'sim', v: 1, kind, seq: 1, data: kind === 'camera' ? { pad: null, grab: false } : null }))
    expect(r.emit.mock.calls.filter(([ev]: [string]) => ev === 'sim')).toHaveLength(3)
    await r.onCtl(p, JSON.stringify({ t: 'sim', v: 1, kind: 'input', seq: 2, data: { pad: { axes: [1, 0, 0, 0] }, grab: true } }))
    expect(r.blockedInputs.at(-1).type).toBe('sim-drive')
  })
  it('cannot replay a play offer to renegotiate an existing player through watch admission', async () => {
    const r = host()
    Object.assign(r, { sig: { send: vi.fn() }, sameConnection: () => ({ capability: 'play' }), renegotiate: vi.fn() })
    await r.onPayload('watcher', { offer: { type: 'offer', sdp: 'captured' } }, undefined, 'watcher')
    expect(r.renegotiate).not.toHaveBeenCalled(); expect(r.blockedInputs.at(-1).type).toBe('offer-capability')
  })
  it('keeps an offline revoke pending across welcome and ignores stale rotation acknowledgements', async () => {
    const r = host(), secret = newSecret()
    vi.stubGlobal('sessionStorage', { setItem: vi.fn() })
    Object.assign(r, { opts: { session: 'test' }, sharing: { play: encodePairing({ secret, fp: new Uint8Array(32) }).split('.')[1], watch: encodePairing({ secret: newSecret(), fp: new Uint8Array(32) }).split('.')[1], owner: 'owner', playOpen: true, watchOpen: true }, sig: { send: vi.fn(), setUrl: vi.fn() }, roomId: 'room', service: 'https://example.org' })
    await r.stopSharing('watch')
    r.onSignal({ t: 'welcome', sharing: { play: true, watch: true } })
    expect(r.sharing.watchOpen).toBe(false); expect(r.sharing.pending).toBe(true)
    r.onSignal({ t: 'sharing', play: true, watch: true, revision: 0 })
    expect(r.sharing.watchOpen).toBe(false)
    r.onSignal({ t: 'sharing', play: true, watch: false, revision: 1 })
    expect(r.sharing.pending).toBe(false); expect(r.sharing.watchOpen).toBe(false)
  })
  it('never gives a watcher the Play scene URL, while player controls survive a layout change', () => {
    const r = host(), play = { id: 'p', bound: true, capability: 'play' }, watch = { id: 'w', bound: true, capability: 'watch' }
    r.peers.set('p', play); r.peers.set('w', watch); r.send = vi.fn(); r.layout = { v: 1, tray: [] }
    r.offerScene('https://example.org/sim/drone/?join=play#key', 'w'); expect(r.send).not.toHaveBeenCalled()
    r.offerScene('https://example.org/sim/drone/?join=play#key', 'p'); expect(r.send).toHaveBeenCalledWith(play, { t: 'state', values: { 'play.scene': 'https://example.org/sim/drone/?join=play#key' } })
    r.targets = () => [play]; r.extendTray([{ id: 'drops.undo', label: 'Undo drop' }])
    r.setLayout({ v: 1, tray: [{ id: 'fly', label: 'Fly' }] })
    expect(r.layout.tray.map((c: { id: string }) => c.id)).toEqual(['fly', 'drops.undo'])
  })
  it('closes remote Play admission while the owner keeps playing on the same phone', async () => {
    const r = host(), secret = newSecret()
    vi.stubGlobal('sessionStorage', { setItem: vi.fn() })
    Object.assign(r, { opts: { session: 'test' }, secret, fp: new Uint8Array(32), sharing: { play: b64url(secret), watch: b64url(newSecret()), owner: 'owner', playOpen: true, watchOpen: true }, sig: { send: vi.fn(), setUrl: vi.fn() }, roomId: 'room', service: 'https://example.org', send: vi.fn(), dropPeer: vi.fn(), setCode: vi.fn(), spentCodes: new Map(), recentCodes: new Map(), codeBinds: new Map() })
    r.peers.set('local', { id: 'local', local: true, capability: 'play' })
    r.peers.set('remote', { id: 'remote', capability: 'play' })
    await r.stopSharing('play')
    expect(r.sharingOpen('play')).toBe(false)
    expect(r.dropPeer.mock.calls).toEqual([['remote']])
    expect(r.send.mock.calls[0][0].id).toBe('remote')
  })
})

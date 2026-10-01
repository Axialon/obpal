/**
 * Keeping a link when the network under it changes: the phone's ICE restart (DeviceLink) and the screen's renegotiation
 * (Remote), against stand-ins for WebSocket and RTCPeerConnection. PROTOCOL §1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceLink, fingerprintHex, importPairKey, type LinkStatus, type StoredPair } from '@obpal/core'
import { Remote } from '../packages/host/src/remote'

const FP_DEVICE = new Uint8Array(32).fill(0x11)
const FP_HOST = new Uint8Array(32).fill(0x22)
const SECRET = new Uint8Array(16).fill(7)

/** A data-channel description in session `session`, with its own ICE credentials. */
function desc(o: { fp: Uint8Array; setup: string; ufrag: string; session?: string }) {
  return ['v=0', `o=- ${o.session ?? '4611731400430051336'} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', `a=ice-ufrag:${o.ufrag}`, 'a=ice-pwd:0123456789abcdefghijklmn',
    `a=fingerprint:sha-256 ${fingerprintHex(o.fp)}`, `a=setup:${o.setup}`, 'a=mid:0', 'a=sctp-port:5000', ''].join('\r\n')
}

class FakeChannel {
  readyState = 'connecting'
  binaryType = ''
  bufferedAmount = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 'closed' }
  /** The other side closed it. */
  shut() { this.readyState = 'closed'; this.onclose?.() }
  open() { this.readyState = 'open'; this.onopen?.() }
  receive(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
}

class FakePC {
  static all: FakePC[] = []
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  signalingState = 'stable'
  connectionState = 'new'
  channels: Record<string, FakeChannel> = {}
  config: RTCConfiguration
  restarts = 0
  added: RTCIceCandidateInit[] = []
  onicecandidate: ((e: { candidate: null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  private ufrag = 'u0'
  constructor(config: RTCConfiguration = {}) { this.config = config; FakePC.all.push(this) }
  createDataChannel(label: string) { return (this.channels[label] = new FakeChannel()) }
  getConfiguration() { return this.config }
  setConfiguration(c: RTCConfiguration) { this.config = c }
  restartIce() { this.restarts++; this.ufrag = `u${this.restarts}` }
  async createOffer() { return { type: 'offer' as const, sdp: desc({ fp: FP_DEVICE, setup: 'actpass', ufrag: this.ufrag }) } }
  async createAnswer() { return { type: 'answer' as const, sdp: desc({ fp: FP_HOST, setup: 'active', ufrag: `h${this.restarts}` }) } }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    if (d.type === 'rollback') { this.signalingState = 'stable'; return }
    this.localDescription = { ...d, toJSON: () => d }
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    if (d.type === 'answer' && this.signalingState !== 'have-local-offer') throw new Error('InvalidStateError')
    this.remoteDescription = d
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'
  }
  async addIceCandidate(c: RTCIceCandidateInit) { this.added.push(c) }
  async getStats() { return new Map() }
  close() { this.connectionState = 'closed' }
  state(s: string) { this.connectionState = s; this.onconnectionstatechange?.() }
}

class FakeWS {
  static all: FakeWS[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  constructor(readonly url: string) { FakeWS.all.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
  open() { this.readyState = 1; this.onopen?.() }
  receive(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const offers = (ws: FakeWS) => ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'sig' && m.d.offer)
const events = new EventTarget()

/** The phone's page: an event target whose visibility a test sets (show), and which says `visibilitychange` as a page does. */
let page: EventTarget & { visibilityState: string }
function show(state: 'hidden' | 'visible') {
  page.visibilityState = state
  page.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  FakePC.all = []
  FakeWS.all = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('document', page)
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
  vi.stubGlobal('fetch', async () => Response.json({ iceServers: [{ urls: 'stun:stun.example:3478' }] }))
})
afterEach(() => vi.unstubAllGlobals())

/** A phone that scanned the QR code, connected to a host that says whether it takes ICE restarts. */
async function connected(restart: boolean) {
  const link = new DeviceLink({ service: 'https://svc.test', pairing: { secret: SECRET, fp: FP_HOST }, caps: () => ({ tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' }), name: 'Test phone' })
  const statuses: LinkStatus[] = []
  link.on('status', (s) => statuses.push(s))
  await link.start()
  const ws = FakeWS.all.at(-1)!
  ws.open()
  ws.receive({ t: 'welcome', id: 'd1', role: 'device', host: true })
  await until('the offer', () => offers(ws).length === 1)
  const pc = FakePC.all.at(-1)!
  ws.receive({ t: 'sig', from: 'h1', d: { answer: { type: 'answer', sdp: desc({ fp: FP_HOST, setup: 'active', ufrag: 'h0' }) } } })
  await until('the answer applied', () => pc.remoteDescription)
  pc.state('connected')
  pc.channels.ctl.open()
  await until('the hello', () => pc.channels.ctl.sent.length > 0)
  pc.channels.ctl.receive({ t: 'welcome', proto: 1, name: 'Screen', layout: { v: 1, tray: [] }, ...(restart ? { restart: true } : {}) })
  await until('connected', () => statuses.includes('connected'))
  return { link, ws, pc, statuses }
}

describe('the phone keeps its link when the path under it goes', () => {
  it('sends gathering completion and passes the peer?s empty candidate to WebRTC', async () => {
    const { link, ws, pc } = await connected(true)
    pc.onicecandidate?.({ candidate: null })
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ t: 'sig', d: { cand: { candidate: '' } } })
    ws.receive({ t: 'sig', from: 'h1', d: { cand: { candidate: '' } } })
    await until('end of candidates applied', () => pc.added.some((c) => c.candidate === ''))
    link.close()
  })

  it('restarts ICE on the same connection when its path goes quiet, and carries on once the answer applies', async () => {
    const { link, ws, pc, statuses } = await connected(true)
    pc.state('disconnected')
    const restart = await until('a restart offer', () => offers(ws).find((m) => m.d.restart === true))
    expect(pc.restarts).toBe(1)
    expect(restart.d.offer.sdp).toContain('a=ice-ufrag:u1')
    expect(FakePC.all.filter((p) => p.connectionState !== 'closed' && p !== pc)).toHaveLength(0)
    ws.receive({ t: 'sig', from: 'h1', d: { answer: { type: 'answer', sdp: desc({ fp: FP_HOST, setup: 'active', ufrag: 'h1' }) } } })
    await until('the restart answer applied', () => pc.signalingState === 'stable' && pc.remoteDescription?.sdp?.includes('h1'))
    pc.state('connected')
    await until('connected again', () => link.status === 'connected')
    expect(statuses.filter((s) => s === 'reconnecting').length).toBeLessThanOrEqual(1)
    expect(link.sendState(new ArrayBuffer(76))).toBe(false) // the fake channel isn't open: nothing to send on, but no teardown
    expect(pc.connectionState).toBe('connected')
    link.close()
  })

  it('a restart answer with another fingerprint is refused: nobody slips in on a restart', async () => {
    const { link, ws, pc, statuses } = await connected(true)
    pc.state('failed')
    await until('a restart offer', () => offers(ws).find((m) => m.d.restart === true))
    ws.receive({ t: 'sig', from: 'h1', d: { answer: { type: 'answer', sdp: desc({ fp: new Uint8Array(32).fill(0x33), setup: 'active', ufrag: 'h1' }) } } })
    await until('host-mismatch', () => statuses.includes('host-mismatch'))
    link.close()
  })

  it('the network changing (online again) is enough to look for a new path', async () => {
    const { link, ws } = await connected(true)
    events.dispatchEvent(new Event('online'))
    await until('a restart offer', () => offers(ws).find((m) => m.d.restart === true))
    link.close()
  })

  it('a host with no such connection says gone: a new connection at once', async () => {
    const { link, ws, pc } = await connected(true)
    pc.state('failed')
    await until('a restart offer', () => offers(ws).find((m) => m.d.restart === true))
    ws.receive({ t: 'sig', from: 'h1', d: { gone: true } })
    await until('a new connection', () => FakePC.all.length > 1 && FakePC.all.at(-1) !== pc)
    expect(pc.connectionState).toBe('closed')
    link.close()
  })

  it('a host that doesn’t take restarts (ob.Pal Link 1.5) gets a new connection, as before', async () => {
    const { link, ws, pc } = await connected(false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      pc.state('disconnected')
      await vi.advanceTimersByTimeAsync(3000)
    } finally {
      vi.useRealTimers()
    }
    await until('a new connection', () => FakePC.all.at(-1) !== pc)
    expect(pc.restarts).toBe(0)
    expect(offers(ws).some((m) => m.d.restart)).toBe(false)
    link.close()
  })

  it('the host’s socket lost (not closed) leaves the link alone; the host leaving for good ends it', async () => {
    const { link, ws, pc } = await connected(true)
    ws.receive({ t: 'peer', ev: 'leave', id: 'h1', role: 'host', clean: false })
    ws.receive({ t: 'peer', ev: 'join', id: 'h2', role: 'host' })
    await tick()
    expect(link.status).toBe('connected')
    expect(pc.connectionState).toBe('connected')
    ws.receive({ t: 'peer', ev: 'leave', id: 'h2', role: 'host', clean: true })
    await until('waiting for the host', () => link.status === 'waiting-host')
    expect(pc.connectionState).toBe('closed')
    link.close()
  })

  it('an offer is sent only into an open socket: with it down, the next welcome sends it', async () => {
    const link = new DeviceLink({ service: 'https://svc.test', pairing: { secret: SECRET, fp: FP_HOST }, caps: () => ({ tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' }), name: 'Test phone' })
    await link.start()
    const ws = FakeWS.all.at(-1)!
    ws.open()
    ws.receive({ t: 'welcome', id: 'd1', role: 'device', host: true })
    ws.readyState = 2 // closing: the offer can't go
    await until('the offer built', () => FakePC.all.at(-1)?.localDescription)
    for (let i = 0; i < 5; i++) await tick()
    expect(offers(ws)).toHaveLength(0)
    ws.readyState = 1
    ws.receive({ t: 'welcome', id: 'd2', role: 'device', host: true })
    await until('the offer sent', () => offers(ws).length === 1)
    link.close()
  })

  /** The phone's signaling socket is lost, and the phone lets it retry: the socket it gets next, opened and welcomed. */
  async function socketBack(prev: FakeWS) {
    const next = await until('the socket retried', () => FakeWS.all.at(-1) !== prev && FakeWS.all.at(-1))
    next.open()
    next.receive({ t: 'welcome', id: 'd2', role: 'device', host: true })
    return next
  }

  it.each([
    ['disconnected', false],
    ['disconnected', true],
    ['failed', false],
    ['failed', true],
  ] as const)('a path %s (control channel closed: %s) while the socket is down: the restart it waits for goes when the socket is back, and a screen with no such connection has it build a new one', async (lost, closed) => {
    const { link, ws, pc, statuses } = await connected(true)
    ws.close() // the socket is lost (a phone that woke with no network yet)
    if (closed) pc.channels.ctl.shut()
    pc.state(lost)
    await until('reconnecting', () => statuses.includes('reconnecting'))
    for (let i = 0; i < 5; i++) await tick()
    expect(FakePC.all).toHaveLength(1) // nothing could be sent, and nothing is built again while it waits for the socket
    const next = await socketBack(ws)
    await until('a restart offer on the new socket', () => offers(next).find((m) => m.d.restart === true))
    next.receive({ t: 'sig', from: 'h1', d: { gone: true } })
    await until('a new connection', () => FakePC.all.length > 1 && FakePC.all.at(-1) !== pc)
    expect(pc.connectionState).toBe('closed')
    link.close()
  })

  it('the path coming back on its own while a restart waits for the socket: connected again, and nothing left to restart', async () => {
    const { link, ws, pc, statuses } = await connected(true)
    ws.close()
    pc.state('disconnected')
    await until('reconnecting', () => statuses.includes('reconnecting'))
    for (let i = 0; i < 5; i++) await tick()
    pc.state('connected')
    await until('connected again', () => link.status === 'connected')
    const next = await socketBack(ws)
    for (let i = 0; i < 10; i++) await tick()
    expect(offers(next)).toHaveLength(0)
    expect(FakePC.all).toHaveLength(1)
    expect(link.status).toBe('connected')
    link.close()
  })

  it('a network change while the socket is down (the link still up): the restart goes when the socket is back', async () => {
    const { link, ws, pc } = await connected(true)
    ws.close()
    events.dispatchEvent(new Event('online'))
    for (let i = 0; i < 20; i++) await tick()
    expect(pc.restarts).toBe(0)
    const next = await socketBack(ws)
    await until('a restart offer on the new socket', () => offers(next).find((m) => m.d.restart === true))
    expect(pc.restarts).toBe(1)
    link.close()
  })
})

/**
 * Coming back to a phone that was locked or switched away from (packages/core/src/device.ts onVisible). The page's
 * visibility goes hidden, then visible; only the timers are faked, so "at once" is measured against the grace a lost path
 * otherwise waits (3 s for a host that takes no restarts, 0.5 s for one that does).
 */
describe('the phone coming back to its page', () => {
  /** Fake the clock from here on, then let `by` ms pass. Restore it with vi.useRealTimers(). */
  const passing = async (by: number) => { await vi.advanceTimersByTimeAsync(by) }
  const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  afterEach(() => vi.useRealTimers())

  it.each([
    ['a host that takes no restarts', 'disconnected', false],
    ['a host that takes no restarts', 'failed', false],
    ['a host that takes restarts', 'disconnected', true],
    ['a host that takes restarts', 'failed', true],
  ] as const)('with %s and its path %s, hidden then visible builds the connection again at once', async (_who, lost, restart) => {
    const { link, pc, statuses } = await connected(restart)
    clock()
    pc.state(lost)
    // Hidden changes nothing: the path's own timer is still what is waiting.
    show('hidden')
    await passing(1)
    expect(FakePC.all).toHaveLength(1)
    expect(pc.connectionState).toBe(lost)
    // Visible again: no waiting for the grace, which is still ahead (a lost path waits 3 s, 0.5 s on a host with restarts).
    show('visible')
    await passing(1)
    vi.useRealTimers()
    await until('a new connection', () => FakePC.all.at(-1) !== pc)
    expect(pc.connectionState).toBe('closed')
    expect(statuses).toContain('reconnecting')
    link.close()
  })

  it.each(['connected', 'connecting'] as const)('with its connection %s, hidden then visible leaves it alone', async (state) => {
    const { link, pc, statuses } = await connected(true)
    pc.connectionState = state
    clock()
    show('hidden')
    show('visible')
    await passing(10_000)
    vi.useRealTimers()
    expect(FakePC.all).toHaveLength(1)
    expect(pc.connectionState).toBe(state)
    expect(link.status).toBe('connected')
    expect(statuses).not.toContain('reconnecting')
    link.close()
  })

  it('with no screen there, coming back has nothing to reconnect to', async () => {
    const link = new DeviceLink({ service: 'https://svc.test', pairing: { secret: SECRET, fp: FP_HOST }, caps: () => ({ tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' }), name: 'Test phone' })
    await link.start()
    const ws = FakeWS.all.at(-1)!
    ws.open()
    ws.receive({ t: 'welcome', id: 'd1', role: 'device', host: false })
    await until('waiting for the host', () => link.status === 'waiting-host')
    clock()
    show('hidden')
    show('visible')
    await passing(10_000)
    vi.useRealTimers()
    expect(FakePC.all.every((p) => p.connectionState !== 'closed')).toBe(true)
    expect(link.status).toBe('waiting-host')
    link.close()
  })

  it('a direct LAN link is never rebuilt on coming back: its code is single-use, so another attempt could not work', async () => {
    const key = await importPairKey(new Uint8Array(32).fill(5))
    const pair: StoredPair = { id: 'AQEBAQEBAQEBAQEBAQEBAQ', key, peerFp: FP_HOST, peerName: 'Desk', at: 1 }
    const lan = { id: new Uint8Array(16).fill(1), nonce: new Uint8Array(16).fill(2), ufrag: 'AAjr', pwd: 'RfMNkMijI//CP0AuqTCu0VY7', cands: [{ host: '192.168.1.101', port: 42610 }] }
    const link = new DeviceLink({ lan, pair, caps: () => ({ tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' }), name: 'Test phone', cert: {} as RTCCertificate })
    const statuses: LinkStatus[] = []
    link.on('status', (s) => statuses.push(s))
    await link.start()
    const pc = await until('the direct connection', () => FakePC.all.at(-1))
    await until('its answer', () => pc.localDescription)
    pc.state('connected')
    pc.channels.ctl.open()
    await until('the hello', () => pc.channels.ctl.sent.length > 0)
    pc.channels.ctl.receive({ t: 'welcome', proto: 1, name: 'Screen', layout: { v: 1, tray: [] } })
    await until('connected', () => link.status === 'connected')
    expect(link.direct).toBe(true)
    pc.state('disconnected')
    clock()
    show('hidden')
    show('visible')
    await passing(10_000)
    vi.useRealTimers()
    expect(FakePC.all).toHaveLength(1)
    expect(pc.connectionState).toBe('disconnected')
    expect(statuses).not.toContain('reconnecting')
    link.close()
  })
})

/** A screen with one bound phone on a connection in session `session`, and a room socket that records what it sends. */
function screen() {
  const sent: Record<string, unknown>[] = []
  const r = Object.create(Remote.prototype) as Remote & Record<string, unknown>
  const pc = new FakePC({ iceServers: [{ urls: 'stun:old' }] })
  pc.connectionState = 'connected'
  const peer = { id: 'p1', sig: 'p1', session: '4611731400430051336', renegotiating: false, pc, fp: FP_DEVICE, bound: true, lost: null, cands: [] as RTCIceCandidateInit[] }
  Object.assign(r, {
    handlers: new Proxy({}, { get: () => [] }), opts: {}, peers: new Map([['p1', peer]]), held: {}, active: peer, early: new Map(), iceLoaded: true,
    ice: [{ urls: 'turn:fresh', username: 'u', credential: 'c' }],
    sig: { open: true, send: (m: Record<string, unknown>) => sent.push(m) }, status: 'connected', cards: [],
  })
  const payload = (from: string, d: object) => (r as unknown as { onPayload(id: string, d: object): Promise<void> }).onPayload(from, d)
  const left = (sig: string, clean: boolean) => (r as unknown as { peerLeft(id: string, clean: boolean): void }).peerLeft(sig, clean)
  return { r, sent, pc, peer, payload, left }
}

describe('the screen renegotiates a phone’s connection', () => {
  it('a restart offer in the same session, from the phone’s new socket: answered there, with fresh ICE servers, same peer', async () => {
    const s = screen()
    const offer = { type: 'offer', sdp: desc({ fp: FP_DEVICE, setup: 'actpass', ufrag: 'u1' }) }
    const done = s.payload('p2', { offer, restart: true })
    // Candidates that come while the offer applies wait for it.
    void s.payload('p2', { cand: { candidate: 'candidate:1 1 udp 1 10.0.0.9 5000 typ host', usernameFragment: 'u1' } })
    void s.payload('p2', { cand: { candidate: '' } })
    await done
    expect(s.pc.remoteDescription).toEqual(offer)
    expect(s.pc.config.iceServers).toEqual([{ urls: 'turn:fresh', username: 'u', credential: 'c' }])
    expect(s.sent).toEqual([{ t: 'sig', to: 'p2', d: { answer: expect.objectContaining({ type: 'answer' }) } }])
    expect(s.peer.sig).toBe('p2')
    expect(s.pc.added).toHaveLength(2)
    expect(s.pc.added[1]).toEqual({ candidate: '' })
    expect([...(s.r as unknown as { peers: Map<string, unknown> }).peers.keys()]).toEqual(['p1'])
  })

  it('a restart for a connection it doesn’t have (another session, or another fingerprint) is told gone', async () => {
    const s = screen()
    await s.payload('p3', { offer: { type: 'offer', sdp: desc({ fp: FP_DEVICE, setup: 'actpass', ufrag: 'u1', session: '1' }) }, restart: true })
    await s.payload('p4', { offer: { type: 'offer', sdp: desc({ fp: new Uint8Array(32).fill(0x44), setup: 'actpass', ufrag: 'u1' }) }, restart: true })
    expect(s.sent).toEqual([{ t: 'sig', to: 'p3', d: { gone: true } }, { t: 'sig', to: 'p4', d: { gone: true } }])
    expect(s.pc.remoteDescription).toBeNull()
  })

  it('keeps a bound phone whose socket was lost, and lets one go that closed it', () => {
    const s = screen()
    const peers = (s.r as unknown as { peers: Map<string, unknown> }).peers
    s.left('p1', false)
    expect(peers.has('p1')).toBe(true)
    s.left('p1', true)
    expect(peers.has('p1')).toBe(false)
  })
})

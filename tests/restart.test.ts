/**
 * Keeping a link when the network under it changes: the phone's ICE restart (DeviceLink) and the screen's renegotiation
 * (Remote), against stand-ins for WebSocket and RTCPeerConnection. PROTOCOL §1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceLink, fingerprintHex, type LinkStatus } from '@obpal/core'
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
  onicecandidate: unknown = null
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
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeWS.all.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.() }
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

beforeEach(() => {
  FakePC.all = []
  FakeWS.all = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
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
    await done
    expect(s.pc.remoteDescription).toEqual(offer)
    expect(s.pc.config.iceServers).toEqual([{ urls: 'turn:fresh', username: 'u', credential: 'c' }])
    expect(s.sent).toEqual([{ t: 'sig', to: 'p2', d: { answer: expect.objectContaining({ type: 'answer' }) } }])
    expect(s.peer.sig).toBe('p2')
    expect(s.pc.added).toHaveLength(1)
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

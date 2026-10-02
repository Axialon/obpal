/**
 * The phone's first offer (DeviceLink), whatever order its pieces come in: the room socket's welcome, the ICE servers
 * (TURN credentials) and its certificate, each early or late. However they fall, one offer goes out, once, and it
 * carries the ICE servers whenever they came before it left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceLink, fingerprintHex } from '@obpal/core'

const FP_DEVICE = new Uint8Array(32).fill(0x11)
const desc = (servers: number) => ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  `a=ice-ufrag:s${servers}`, 'a=ice-pwd:0123456789abcdefghijklmn', `a=fingerprint:sha-256 ${fingerprintHex(FP_DEVICE)}`, 'a=setup:actpass', ''].join('\r\n')

class FakeChannel { readyState = 'connecting'; binaryType = ''; bufferedAmount = 0; onopen = null; onmessage = null; onclose = null; send() {}; close() {} }
class FakePC {
  static all: FakePC[] = []
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null
  signalingState = 'stable'
  connectionState = 'new'
  closed = false
  onicecandidate: ((e: { candidate: null }) => void) | null = null
  onconnectionstatechange = null
  constructor(readonly config: RTCConfiguration) { FakePC.all.push(this) }
  createDataChannel() { return new FakeChannel() }
  async createOffer() {
    await new Promise((r) => setTimeout(r, 1))
    if (this.closed) throw new Error('InvalidStateError: closed')
    return { type: 'offer' as const, sdp: desc(this.config.iceServers?.length ?? 0) }
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    await new Promise((r) => setTimeout(r, 1))
    if (this.closed) throw new Error('InvalidStateError: closed')
    this.localDescription = { ...d, toJSON: () => d }
    this.signalingState = 'have-local-offer'
    this.onicecandidate?.({ candidate: null })
  }
  async getStats() { return new Map() }
  close() { this.closed = true; this.connectionState = 'closed' }
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

/** A promise and the function that settles it. */
function later<T>() { let settle!: (v: T) => void; const p = new Promise<T>((r) => { settle = r }); return { p, settle } }
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  FakePC.all = []
  FakeWS.all = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

/**
 * One phone start: `order` says when the welcome, the ICE servers and the certificate come (ms after start, in
 * steps); returns the offers it sent.
 */
async function run(at: { welcome: number; ice: number; cert: number }) {
  const ice = later<Response>()
  vi.stubGlobal('fetch', () => ice.p)
  const cert = later<RTCCertificate | null>()
  const link = new DeviceLink({ service: 'https://svc.test', pairing: { secret: new Uint8Array(16).fill(1), fp: new Uint8Array(32).fill(2) }, cert: cert.p,
    caps: () => ({ tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' }), name: 'Test phone' })
  await link.start()
  const ws = FakeWS.all.at(-1)!
  const steps = [
    [at.welcome, () => { ws.open(); ws.receive({ t: 'welcome', id: 'd1', role: 'device', host: true }) }],
    [at.ice, () => ice.settle(Response.json({ iceServers: [{ urls: 'stun:s' }, { urls: 'turn:t', username: 'u', credential: 'c' }], turn: true, expires: Date.now() + 86_400_000 }))],
    [at.cert, () => cert.settle(null)],
  ] as const
  const start = Date.now()
  for (const [t, step] of [...steps].sort((a, b) => a[0] - b[0])) {
    await wait(Math.max(0, t - (Date.now() - start)))
    step()
  }
  await wait(900)
  const offers = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'sig' && m.d.offer).map((m) => m.d.offer.sdp as string)
  const messages = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'sig')
  expect(messages[0].d).toHaveProperty('offer')
  expect(messages.slice(1).map((m) => m.d)).toContainEqual({ cand: { candidate: '' } })
  link.close()
  return offers
}

describe('the first offer, whatever order its pieces come in', () => {
  const cases: [string, { welcome: number; ice: number; cert: number }][] = [
    ['everything at once', { welcome: 0, ice: 0, cert: 0 }],
    ['the ICE servers first, then the welcome, the certificate last', { welcome: 60, ice: 10, cert: 400 }],
    ['the welcome first, the certificate, the ICE servers late (after the wait)', { welcome: 5, ice: 700, cert: 20 }],
    ['the welcome first, the ICE servers within the send wait, the certificate after them', { welcome: 5, ice: 200, cert: 300 }],
    ['a slow certificate, the ICE servers while it loads', { welcome: 5, ice: 100, cert: 500 }],
    ['the ICE servers just as the certificate comes', { welcome: 5, ice: 300, cert: 300 }],
    ['the ICE servers just after the certificate', { welcome: 5, ice: 302, cert: 300 }],
    ['the ICE servers late, after the offer went', { welcome: 5, ice: 800, cert: 10 }],
  ]
  for (const [name, at] of cases) {
    it(name, async () => {
      const offers = await run(at)
      expect(offers).toHaveLength(1)
      // Built with the ICE servers (TURN in it) whenever they came before the offer went out.
      if (at.ice < Math.max(at.cert, at.welcome) + 400) expect(offers[0]).toContain('a=ice-ufrag:s2')
    })
  }
})

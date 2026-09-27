/**
 * The phone's side of a short-code join (DeviceLink), against a host played by the test: stand-ins for WebSocket and
 * RTCPeerConnection carry the signaling and the control channel. What a malicious room service could try, it tries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b64url, CodePake, DeviceLink, encodePairing, fingerprintHex, fromB64url, roomIdFor, type HostMsg, type LinkStatus } from '@obpal/core'

const FP_DEVICE = new Uint8Array(32).fill(0x11)
const FP_HOST = new Uint8Array(32).fill(0x22)
const FP_EVIL = new Uint8Array(32).fill(0x33)
const fpLine = (fp: Uint8Array) => `a=fingerprint:sha-256 ${fingerprintHex(fp)}`
/** A data-channel description: fingerprints where asked (the session name is free text); a new `ufrag` for an ICE restart. */
function desc(o: { media?: Uint8Array; session?: Uint8Array; name?: string; setup: string; ufrag?: string }) {
  return ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', `s=${o.name ?? '-'}`, 't=0 0', ...(o.session ? [fpLine(o.session)] : []), 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', `a=ice-ufrag:${o.ufrag ?? 'abcd'}`, 'a=ice-pwd:0123456789abcdefghijklmn',
    ...(o.media ? [fpLine(o.media)] : []), `a=setup:${o.setup}`, 'a=mid:0', 'a=sctp-port:5000', ''].join('\r\n')
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
  /** While set, applying a remote description waits for it, as a browser's operations queue can. */
  static hold: Promise<void> | null = null
  /** Applying a remote description fails. */
  static failRemote = false
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  signalingState = 'stable'
  connectionState = 'new'
  remoteSets = 0
  channels: Record<string, FakeChannel> = {}
  onicecandidate: unknown = null
  onconnectionstatechange: unknown = null
  constructor() { FakePC.all.push(this) }
  createDataChannel(label: string) { return (this.channels[label] = new FakeChannel()) }
  async createOffer() { return { type: 'offer' as const, sdp: desc({ media: FP_DEVICE, setup: 'actpass' }) } }
  async setLocalDescription(d: RTCSessionDescriptionInit) { this.localDescription = { ...d, toJSON: () => d }; this.signalingState = 'have-local-offer' }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteSets++
    if (FakePC.hold) await FakePC.hold
    if (FakePC.failRemote) throw new Error('OperationError: the description doesn’t apply')
    if (this.signalingState !== 'have-local-offer') throw new Error('InvalidStateError: no offer waiting')
    this.remoteDescription = d
    this.signalingState = 'stable'
  }
  async addIceCandidate() {}
  async getStats() { return new Map() }
  close() { this.connectionState = 'closed' }
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
async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const HANDLE = '48219'
const SECRET = '37056'
const TICKET = 'T'.repeat(22)
const S = crypto.getRandomValues(new Uint8Array(16))
let ROOM = ''

beforeEach(async () => {
  ROOM = await roomIdFor(S)
  FakePC.all = []
  FakePC.hold = null
  FakePC.failRemote = false
  FakeWS.all = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
  vi.stubGlobal('fetch', async () => Response.json({ iceServers: [{ urls: 'stun:stun.example:3478' }] }))
})
afterEach(() => vi.unstubAllGlobals())

/** A phone joining by short code, up to the moment its hello has gone out on the control channel. */
async function join(answer: { media?: Uint8Array; session?: Uint8Array; name?: string }, opts: { qr?: boolean } = {}) {
  const link = new DeviceLink(opts.qr
    ? { service: 'https://svc.test', pairing: { secret: S, fp: FP_HOST }, caps: () => ({ tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' }), name: 'Test phone' }
    : { service: 'https://svc.test', code: { handle: HANDLE, secret: SECRET, room: ROOM, ticket: TICKET }, caps: () => ({ tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' }), name: 'Test phone' })
  const statuses: LinkStatus[] = []
  const messages: HostMsg[] = []
  const invites: string[] = []
  link.on('status', (s) => statuses.push(s))
  link.on('message', (m) => messages.push(m))
  link.on('invite', (f) => invites.push(f))
  await link.start()
  const ws = FakeWS.all.at(-1)!
  ws.open()
  ws.receive({ t: 'welcome', id: 'd1', role: 'device', host: true })
  await until('the offer', () => ws.sent.some((s) => s.includes('"offer"')))
  const pc = FakePC.all.at(-1)!
  ws.receive({ t: 'sig', from: 'h1', d: { answer: { type: 'answer', sdp: desc({ ...answer, setup: 'active' }) } } })
  await tick()
  await tick()
  return { link, ws, pc, statuses, messages, invites }
}

/** The host's fingerprint as the phone has bound it. */
const boundFp = (link: DeviceLink) => (link as unknown as { hostFp: Uint8Array | null }).hostFp
/** An answer from the host's side of the room, for the offer that uses `ufrag`. */
function answer(ws: FakeWS, fp: Uint8Array, ufrag?: string) {
  ws.receive({ t: 'sig', from: 'h1', d: { answer: { type: 'answer', sdp: desc({ media: fp, setup: 'active', ufrag }) } } })
}
/** A new offer on the phone's connection, as an ICE restart makes it. */
function reoffer(pc: FakePC, ufrag: string) {
  return pc.setLocalDescription({ type: 'offer', sdp: desc({ media: FP_DEVICE, setup: 'actpass', ufrag }) })
}

/** The host's half of the exchange, as an honest host that holds the code and sees `fpHost` as its own fingerprint. */
async function hostAnswers(ctl: FakeChannel, fpHost = FP_HOST) {
  const hello = JSON.parse(ctl.sent[0]) as { code: string; ticket: string; pake: string }
  const pake = await CodePake.start('host', { secret: SECRET, handle: hello.code, room: ROOM })
  const macs = (await pake.confirm(fromB64url(hello.pake), FP_DEVICE, fpHost))!
  ctl.receive({ t: 'pake', y: b64url(pake.share), mac: macs.mine })
  return macs.theirs
}

describe('joining by short code, the phone’s side', () => {
  it('a host that proves the code gets the phone, and hands it the QR link’s code', async () => {
    const { link, pc, statuses, invites } = await join({ media: FP_HOST })
    const ctl = pc.channels.ctl
    ctl.open()
    await until('the hello', () => ctl.sent.length > 0)
    const expected = await hostAnswers(ctl)
    const confirm = await until('the phone’s confirmation', () => ctl.sent.slice(1).map((s) => JSON.parse(s)).find((m) => m.t === 'pake'))
    expect(confirm.mac).toBe(expected)
    const invite = encodePairing({ secret: S, fp: FP_HOST })
    ctl.receive({ t: 'welcome', proto: 1, name: 'Screen', layout: { v: 1, tray: [] }, invite })
    await until('connected', () => statuses.includes('connected'))
    await until('the invite taken', () => invites.length)
    expect(invites).toEqual([invite])
    link.close()
  })

  it('a host that skips the exchange is never heard: no welcome, layout, state or invite, and nothing is sent to it', async () => {
    const { link, pc, statuses, messages, invites } = await join({ media: FP_HOST })
    const ctl = pc.channels.ctl
    ctl.open()
    await until('the hello', () => ctl.sent.length > 0)
    ctl.receive({ t: 'welcome', proto: 1, name: 'Impostor', layout: { v: 1, tray: [] }, invite: encodePairing({ secret: S, fp: FP_HOST }), pair: { id: b64url(new Uint8Array(16)), key: b64url(new Uint8Array(32)) } })
    ctl.receive({ t: 'layout', layout: { v: 1, tray: [{ id: 'x', label: 'X' }] } })
    ctl.receive({ t: 'state', values: { textField: 'text' } })
    for (let i = 0; i < 5; i++) await tick()
    expect(statuses).not.toContain('connected')
    expect(messages).toEqual([])
    expect(invites).toEqual([])
    expect(link.sendState(new ArrayBuffer(76))).toBe(false)
    // A refusal is still heard.
    ctl.receive({ t: 'lock', reason: 'rejected' })
    await until('code-wrong', () => statuses.includes('code-wrong'))
    link.close()
  })

  it('takes one answer per offer: a second one, with another fingerprint, changes nothing', async () => {
    const { link, ws, pc, statuses } = await join({ media: FP_HOST })
    answer(ws, FP_EVIL)
    for (let i = 0; i < 5; i++) await tick()
    expect(pc.remoteSets).toBe(1)
    const ctl = pc.channels.ctl
    ctl.open()
    await until('the hello', () => ctl.sent.length > 0)
    // The exchange still binds the first answer's fingerprint: the honest host's confirmation checks.
    const expected = await hostAnswers(ctl, FP_HOST)
    const confirm = await until('the phone’s confirmation', () => ctl.sent.slice(1).map((s) => JSON.parse(s)).find((m) => m.t === 'pake'))
    expect(confirm.mac).toBe(expected)
    expect(statuses).not.toContain('code-wrong')
    link.close()
  })

  it('takes one answer per offer even while the first is still being applied, and binds its fingerprint only once it has', async () => {
    let release!: () => void
    FakePC.hold = new Promise((r) => (release = r))
    const { link, ws, pc } = await join({ media: FP_HOST })
    answer(ws, FP_EVIL)
    for (let i = 0; i < 5; i++) await tick()
    expect(pc.remoteSets).toBe(1)
    expect(boundFp(link)).toBeNull()
    release()
    await until('the fingerprint bound', () => boundFp(link))
    expect(boundFp(link)).toEqual(FP_HOST)
    link.close()
  })

  it('binds no fingerprint from an answer that doesn’t apply', async () => {
    FakePC.failRemote = true
    const { link, pc } = await join({ media: FP_HOST })
    expect(pc.remoteSets).toBe(1)
    expect(boundFp(link)).toBeNull()
    link.close()
  })

  it('refuses an answer with a second fingerprint beside the one DTLS checks', async () => {
    const { link, statuses } = await join({ session: FP_HOST, media: FP_EVIL })
    await until('host-mismatch', () => statuses.includes('host-mismatch'))
    link.close()
  })

  it('binds the fingerprint DTLS checks, not one written into the session name: relaying the exchange fails', async () => {
    // The service answers with its own DTLS endpoint and writes the real host's fingerprint as text beside it.
    const { link, pc, statuses } = await join({ name: fpLine(FP_HOST), media: FP_EVIL })
    const ctl = pc.channels.ctl
    ctl.open()
    await until('the hello', () => ctl.sent.length > 0)
    // It relays to the real host, which binds its own fingerprint: the two sides' transcripts differ.
    await hostAnswers(ctl, FP_HOST)
    await until('code-wrong', () => statuses.includes('code-wrong'))
    expect(ctl.sent.slice(1).some((s) => s.includes('"pake"'))).toBe(false)
    link.close()
  })

  it('by QR code too, a fingerprint written into the session name doesn’t pass the pin', async () => {
    const { link, statuses } = await join({ name: fpLine(FP_HOST), media: FP_EVIL }, { qr: true })
    await until('host-mismatch', () => statuses.includes('host-mismatch'))
    link.close()
  })
})

describe('a later answer on the same connection (an ICE restart)', () => {
  it('by short code, one that carries the fingerprint the first answer bound is taken, and the proven code still counts', async () => {
    const { link, ws, pc, statuses } = await join({ media: FP_HOST })
    const ctl = pc.channels.ctl
    ctl.open()
    await until('the hello', () => ctl.sent.length > 0)
    const expected = await hostAnswers(ctl)
    const confirm = await until('the phone’s confirmation', () => ctl.sent.slice(1).map((s) => JSON.parse(s)).find((m) => m.t === 'pake'))
    expect(confirm.mac).toBe(expected)
    await reoffer(pc, 'rst1')
    answer(ws, FP_HOST, 'rst1')
    await until('the restart’s answer applied', () => pc.signalingState === 'stable' && pc.remoteSets === 2)
    expect(boundFp(link)).toEqual(FP_HOST)
    // Same connection, same host: the code it proved still counts.
    ctl.receive({ t: 'welcome', proto: 1, name: 'Screen', layout: { v: 1, tray: [] }, invite: encodePairing({ secret: S, fp: FP_HOST }) })
    await until('connected', () => statuses.includes('connected'))
    expect(statuses).not.toContain('host-mismatch')
    link.close()
  })

  it('by short code, one with another fingerprint is dropped as host-mismatch', async () => {
    const { link, ws, pc, statuses } = await join({ media: FP_HOST })
    await reoffer(pc, 'rst1')
    answer(ws, FP_EVIL, 'rst1')
    await until('host-mismatch', () => statuses.includes('host-mismatch'))
    expect(pc.remoteSets).toBe(1)
    link.close()
  })

  it('by QR code, one must carry the pinned fingerprint', async () => {
    const { link, ws, pc, statuses } = await join({ media: FP_HOST }, { qr: true })
    await reoffer(pc, 'rst1')
    answer(ws, FP_HOST, 'rst1')
    await until('the restart’s answer applied', () => pc.signalingState === 'stable' && pc.remoteSets === 2)
    expect(statuses).not.toContain('host-mismatch')
    await reoffer(pc, 'rst2')
    answer(ws, FP_EVIL, 'rst2')
    await until('host-mismatch', () => statuses.includes('host-mismatch'))
    expect(pc.remoteSets).toBe(2)
    link.close()
  })
})

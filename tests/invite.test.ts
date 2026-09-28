/**
 * The invite moves on once a phone has paired (Remote's rotateInvite, spec/SECURITY.md §8 L2): the old code pairs
 * nobody new, while the phone that paired keeps its way back in through the room it paired in, by a reload or an ICE
 * restart. Against stand-ins for WebSocket and RTCPeerConnection; the test plays the phones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b64url, bindMac, DeviceLink, emptyPad, emptyState, encodePad, encodePose, encodeState, fingerprintHex, Flag, fromB64url, listPairs, Mode, parsePairing, PoseFlag, roomIdFor, type LinkStatus } from '@obpal/core'
import { Remote } from '../packages/host/src/remote'
import { Stream } from '../packages/host/src/stream'

const FP_HOST = new Uint8Array(32).fill(0x22)
const FP_A = new Uint8Array(32).fill(0x11)
const FP_B = new Uint8Array(32).fill(0x33)
const CAPS = { tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' } as const

/** A data-channel description with one fingerprint, in session `session`, with its own ICE credentials. */
function desc(o: { fp: Uint8Array; setup: string; ufrag: string; session: string }) {
  return ['v=0', `o=- ${o.session} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0',
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
  messages() { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>) }
}

/** Plays the host's peer connections (it answers with FP_HOST) and a phone's (it offers with FP_A). */
class FakePC {
  static all: FakePC[] = []
  static generateCertificate() {
    return Promise.resolve({ expires: Date.now() + 365 * 86_400_000, getFingerprints: () => [{ algorithm: 'sha-256', value: fingerprintHex(FP_HOST) }] })
  }
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  signalingState = 'stable'
  connectionState = 'new'
  iceGatheringState = 'complete'
  channels: Record<string, FakeChannel> = {}
  config: RTCConfiguration
  onicecandidate: ((e: { candidate: null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  constructor(config: RTCConfiguration = {}) { this.config = config; FakePC.all.push(this) }
  createDataChannel(label: string) { return (this.channels[label] = new FakeChannel()) }
  addEventListener() {}
  getConfiguration() { return this.config }
  setConfiguration(c: RTCConfiguration) { this.config = c }
  restartIce() {}
  async createOffer() { return { type: 'offer' as const, sdp: desc({ fp: FP_A, setup: 'actpass', ufrag: 'p0', session: '7' }) } }
  async createAnswer() { return { type: 'answer' as const, sdp: desc({ fp: FP_HOST, setup: 'active', ufrag: `h${FakePC.all.length}`, session: '9' }) } }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = { ...d, toJSON: () => d }
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'
  }
  added: RTCIceCandidateInit[] = []
  async addIceCandidate(c: RTCIceCandidateInit) { this.added.push(c) }
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
  messages() { return this.sent.map((s) => JSON.parse(s) as { t: string; to?: string; op?: string; d?: Record<string, unknown> }) }
}

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(() => {
  FakePC.all = []
  FakeWS.all = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('fetch', async () => Response.json({ iceServers: [{ urls: 'stun:stun.example:3478' }] }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** A screen that moves its invite on, its room socket open, and what its pairing link says. */
async function screen() {
  const r = await Remote.create({ appName: 'Test screen', service: 'https://svc.test', remember: true, rotateInvite: true })
  const ws = FakeWS.all.at(-1)!
  ws.open()
  return { r, ws }
}

/** The pairing the screen's link carries now: its secret, and the room that hashes to. */
async function invite(r: Remote) {
  const p = parsePairing(new URL(r.pairingUrl).hash)!
  return { secret: p.secret, room: await roomIdFor(p.secret) }
}

/**
 * A phone with fingerprint `fp` offers through room socket `ws` as `from`, in its connection's session `session`,
 * then proves `secret` for `room` once the channel opens. Returns the host's connection and what it sent back.
 */
async function offer(ws: FakeWS, o: { from: string; fp: Uint8Array; session: string }) {
  ws.receive({ t: 'sig', from: o.from, d: { offer: { type: 'offer', sdp: desc({ fp: o.fp, setup: 'actpass', ufrag: 'p0', session: o.session }) } } })
  await until(`the answer to ${o.from}`, () => ws.messages().find((m) => m.to === o.from && m.d?.answer))
  // The screen's connection for this offer (its direct code has one of its own, with a made-up answer).
  const pc = FakePC.all.find((p) => p.remoteDescription?.type === 'offer' && p.remoteDescription.sdp?.includes(`o=- ${o.session} `))!
  pc.connectionState = 'connected'
  pc.channels.ctl.open()
  pc.channels.st.open()
  return pc
}

async function pair(ws: FakeWS, o: { from: string; fp: Uint8Array; session: string; secret: Uint8Array; room: string; name?: string }) {
  const pc = await offer(ws, o)
  pc.channels.ctl.receive({ t: 'hello', proto: 1, caps: CAPS, name: o.name ?? 'Phone', mac: await bindMac(o.secret, o.fp, FP_HOST, o.room) })
  const welcome = await until('the welcome', () => pc.channels.ctl.messages().find((m) => m.t === 'welcome'))
  return { pc, welcome }
}

describe('input must bind to the invite first', () => {
  it('rejects a hello with a wrong MAC without welcoming or binding the phone', async () => {
    const { r, ws } = await screen()
    try {
      const p = await invite(r)
      const pc = await offer(ws, { from: 'bad', fp: FP_A, session: '11' })
      const mac = await bindMac(p.secret, FP_A, FP_HOST, p.room)
      pc.channels.ctl.receive({ t: 'hello', proto: 1, caps: CAPS, mac: (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1) })
      expect(await until('rejected', () => pc.channels.ctl.messages().find((m) => m.t === 'lock'))).toEqual({ t: 'lock', reason: 'rejected' })
      expect(pc.channels.ctl.messages().some((m) => m.t === 'welcome')).toBe(false)
      expect(r.participants).toEqual([])
      expect(r.consume().connected).toBe(false)
      expect(r.padOf('bad')).toBeNull()
    } finally { r.destroy() }
  })

  it.each(['STATE', 'PAD', 'POSE'] as const)('%s before binding never enters the stream or reaches consumers', async (kind) => {
    const { r, ws } = await screen()
    try {
      const p = await invite(r)
      const pc = await offer(ws, { from: 'early', fp: FP_A, session: '12' })
      const state = encodeState({ ...emptyState(), seq: 1, mode: Mode.tilt, flags: Flag.touching, tilt: [1, -1] })
      const pad = encodePad({ ...emptyPad(), seq: 1, buttons: 1 })
      const pose = encodePose({ seq: 1, t: 0, flags: PoseFlag.tracked | PoseFlag.touching, p: [1, 2, 3], q: [0, 0, 0, 1], gen: 1 })
      const packet = { STATE: state, PAD: pad, POSE: pose }[kind]
      const received = vi.spyOn(Stream.prototype, { STATE: 'onState', PAD: 'onPad', POSE: 'onPose' }[kind] as 'onState' | 'onPad' | 'onPose')
      const input = vi.fn()
      r.on('input', input)
      pc.channels.st.onmessage?.({ data: packet })
      expect(received).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      expect(r.consume()).toMatchObject({ connected: false, touching: false, tilt: [0, 0], pose: null })
      expect(r.consumeOf('early')).toMatchObject({ connected: false, touching: false, pose: null })
      expect(r.pad).toBeNull()
      expect(r.padOf('early')).toBeNull()
      pc.channels.ctl.receive({ t: 'hello', proto: 1, caps: CAPS, mac: await bindMac(p.secret, FP_A, FP_HOST, p.room) })
      await until('welcome', () => pc.channels.ctl.messages().find((m) => m.t === 'welcome'))
      expect(r.consume()).toMatchObject({ touching: false, tilt: [0, 0], pose: null })
      expect(r.padOf('early')).toBeNull()
      pc.channels.st.onmessage?.({ data: packet })
      expect(received).toHaveBeenCalledTimes(1)
      expect(input).toHaveBeenCalledTimes(1)
      if (kind === 'STATE') expect(r.consume()).toMatchObject({ touching: true, tilt: [1, -1] })
      if (kind === 'PAD') expect(r.padOf('early')?.buttons).toBe(1)
      if (kind === 'POSE') expect(r.consume().pose).toMatchObject({ p: [1, 2, 3], tracked: true, touching: true })
    } finally { r.destroy() }
  })
})

describe('the invite moves on once a phone pairs', () => {
  it('the host sends completion on its answering socket and receives an empty candidate', async () => {
    const { r, ws } = await screen()
    const p = await invite(r)
    const { pc } = await pair(ws, { from: 'a1', fp: FP_A, session: '1', ...p })
    pc.onicecandidate?.({ candidate: null })
    expect(ws.messages()).toContainEqual({ t: 'sig', to: 'a1', d: { cand: { candidate: '' } } })
    ws.receive({ t: 'sig', from: 'a1', d: { cand: { candidate: '' } } })
    await until('host applies completion', () => pc.added.some((c) => c.candidate === ''))
    r.destroy()
  })

  it('the old link pairs nobody new, and the phone that paired comes back through its room: a reload, an ICE restart', async () => {
    const { r, ws } = await screen()
    const first = r.pairingUrl
    const old = await invite(r)
    const moved = vi.fn()
    r.on('invite', moved)
    const a = await pair(ws, { from: 'a1', fp: FP_A, session: '1', ...old, name: 'Phone A' })
    await until('a new invite', () => r.pairingUrl !== first && FakeWS.all.length === 2)
    expect(moved).toHaveBeenCalledTimes(1)
    const next = FakeWS.all[1]
    next.open()
    expect(next.url).toContain(`/r/${(await invite(r)).room}?role=host`)
    // The phone knows which pairing the screen remembers it by, and so does the screen.
    expect(r.participants).toEqual([expect.objectContaining({ name: 'Phone A', pair: (a.welcome.pair as { id: string }).id, fp: b64url(FP_A) })])

    // Someone with a photo of the old code: told it has been used, and no connection is made for them.
    const pcs = FakePC.all.length
    ws.receive({ t: 'sig', from: 'x1', d: { offer: { type: 'offer', sdp: desc({ fp: FP_B, setup: 'actpass', ufrag: 'p0', session: '2' }) } } })
    await until('spent', () => ws.messages().find((m) => m.to === 'x1' && m.d?.spent === true))
    expect(FakePC.all.length).toBe(pcs)

    // Phone A's path goes: its ICE restart comes through the old room, and is answered there, on the same connection.
    ws.receive({ t: 'sig', from: 'a2', d: { offer: { type: 'offer', sdp: desc({ fp: FP_A, setup: 'actpass', ufrag: 'p1', session: '1' }), restart: true } } })
    await until('the restart answered in the old room', () => ws.messages().find((m) => m.to === 'a2' && m.d?.answer))
    expect(a.pc.remoteDescription?.sdp).toContain('a=ice-ufrag:p1')
    expect(FakePC.all.length).toBe(pcs)

    // Phone A reloads (a new connection, the same certificate): the old room takes it, and the invite stays put.
    const url = r.pairingUrl
    const again = await pair(ws, { from: 'a3', fp: FP_A, session: '3', ...old, name: 'Phone A' })
    expect(again.welcome.restart).toBe(true)
    expect(r.pairingUrl).toBe(url)
    expect(FakeWS.all.length).toBe(2)
    // The new link is the one that pairs now (and moves the invite on again).
    await pair(next, { from: 'b1', fp: FP_B, session: '4', ...(await invite(r)), name: 'Phone B' })
    await until('a third invite', () => FakeWS.all.length === 3)
    r.destroy()
  })

  it('a pairing key goes to the phone once, and is kept here only as a non-extractable key', async () => {
    const { r, ws } = await screen()
    const { welcome } = await pair(ws, { from: 'a1', fp: FP_A, session: '1', ...(await invite(r)) })
    const grant = welcome.pair as { id: string; key: string }
    expect(fromB64url(grant.key)).toHaveLength(32)
    const kept = await until('remembered', async () => (await listPairs()).find((p) => p.id === grant.id))
    const p = await kept
    expect(p?.key).toBeInstanceOf(CryptoKey)
    expect(p?.key.extractable).toBe(false)
    r.destroy()
  })

  it('forgetting the phone closes its room: it comes back only through the invite on the screen now', async () => {
    const { r, ws } = await screen()
    const { welcome } = await pair(ws, { from: 'a1', fp: FP_A, session: '1', ...(await invite(r)) })
    await until('a new invite', () => FakeWS.all.length === 2)
    r.disconnect()
    await until('nobody connected', () => r.participants.length === 0, 2000)
    expect(ws.readyState).toBe(1)
    await r.forget((welcome.pair as { id: string }).id)
    expect(ws.readyState).toBe(3)
    r.destroy()
  })

  it('a phone that pairs again through a newer invite lets its old room go', async () => {
    const { r, ws } = await screen()
    await pair(ws, { from: 'a1', fp: FP_A, session: '1', ...(await invite(r)) })
    await until('a second room', () => FakeWS.all.length === 2)
    const second = FakeWS.all[1]
    second.open()
    r.disconnect()
    await until('nobody connected', () => r.participants.length === 0, 2000)
    await pair(second, { from: 'a2', fp: FP_A, session: '2', ...(await invite(r)) })
    await until('a third room', () => FakeWS.all.length === 3)
    // Connected through the second room now: the first one is nobody's any more.
    expect(ws.readyState).toBe(3)
    expect(second.readyState).toBe(1)
    r.destroy()
  })

  it('a lookup that comes back without TURN (a room just joined) leaves the credentials that still hold', async () => {
    const turn = { iceServers: [{ urls: 'stun:stun.example:3478' }, { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }], turn: true, expires: Date.now() + 86_400_000 }
    let answer: object = turn
    vi.stubGlobal('fetch', async () => Response.json(answer))
    const { r } = await screen()
    const ice = () => (r as unknown as { ice: RTCIceServer[] }).ice
    await until('TURN', () => ice().some((s) => String(s.urls).startsWith('turn:')))
    answer = { iceServers: [{ urls: 'stun:stun.example:3478' }], turn: false }
    ;(r as unknown as { refreshIce(delay: number): void }).refreshIce(0)
    await new Promise((res) => setTimeout(res, 50))
    expect(ice().some((s) => String(s.urls).startsWith('turn:'))).toBe(true)
    r.destroy()
  })

  it('without rotateInvite, the invite stays until the screen makes a new one', async () => {
    const r = await Remote.create({ appName: 'Test screen', service: 'https://svc.test' })
    const ws = FakeWS.all.at(-1)!
    ws.open()
    const url = r.pairingUrl
    await pair(ws, { from: 'a1', fp: FP_A, session: '1', ...(await invite(r)) })
    await new Promise((res) => setTimeout(res, 50))
    expect(r.pairingUrl).toBe(url)
    expect(FakeWS.all.length).toBe(1)
    r.destroy()
  })
})

describe('the phone told its code was used', () => {
  it('stops trying, leaves the room and says so', async () => {
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
    const link = new DeviceLink({ service: 'https://svc.test', pairing: { secret: new Uint8Array(16).fill(7), fp: FP_HOST }, caps: () => ({ ...CAPS }), name: 'Phone' })
    const statuses: LinkStatus[] = []
    link.on('status', (s) => statuses.push(s))
    await link.start()
    const ws = FakeWS.all.at(-1)!
    ws.open()
    ws.receive({ t: 'welcome', id: 'd1', role: 'device', host: true })
    await until('the offer', () => ws.messages().some((m) => m.d?.offer))
    ws.receive({ t: 'sig', from: 'h1', d: { spent: true } })
    await until('invite-used', () => statuses.includes('invite-used'))
    expect(ws.readyState).toBe(3)
    link.close()
  })
})

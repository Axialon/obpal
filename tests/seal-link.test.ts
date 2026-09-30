/** The real phone and screen seal handshake, carried by fake signaling and data channels. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectionSeal, DeviceLink, fingerprintHex, forgetAllPairs, lanContext, parseLanPairing, parsePairing, roomIdFor, saveInvite,
  type ConnectionSeal, type HostMsg, type StoredPair,
} from '@obpal/core'
import { Remote } from '../packages/host/src/remote'

const FP_DEVICE = new Uint8Array(32).fill(0x11)
const FP_HOST = new Uint8Array(32).fill(0x22)
const CAPS = { tier: 3, sensorApi: 'events', haptics: 'none', platform: 'test' } as const
const HANDLE = '48219'
const TICKET = 'T'.repeat(22)
const certificate = (fp: Uint8Array) => ({ expires: Date.now() + 365 * 86_400_000, getFingerprints: () => [{ algorithm: 'sha-256', value: fingerprintHex(fp) }] }) as RTCCertificate
const HOST_CERT = certificate(FP_HOST)
const DEVICE_CERT = certificate(FP_DEVICE)

function description(fp: Uint8Array, setup: string, session: string, ufrag: string) {
  return ['v=0', `o=- ${session} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', `a=ice-ufrag:${ufrag}`, 'a=ice-pwd:0123456789abcdefghijklmn',
    `a=fingerprint:sha-256 ${fingerprintHex(fp)}`, `a=setup:${setup}`, 'a=mid:0', 'a=sctp-port:5000',
    'a=candidate:1 1 UDP 2122260223 192.0.2.1 53000 typ host', ''].join('\r\n')
}

class Channel {
  readyState = 'connecting'
  binaryType = ''
  bufferedAmount = 0
  sent: string[] = []
  peer: Channel | null = null
  transform: ((m: HostMsg) => HostMsg) | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(data: string) {
    this.sent.push(data)
    const message = this.transform ? JSON.stringify(this.transform(JSON.parse(data))) : data
    const peer = this.peer
    queueMicrotask(() => peer?.onmessage?.({ data: message }))
  }
  open() { this.readyState = 'open'; this.onopen?.() }
  close() { this.readyState = 'closed' }
  receive(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
  messages() { return this.sent.map(m => JSON.parse(m) as HostMsg) }
}

class PeerConnection {
  static all: PeerConnection[] = []
  static generateCertificate() { return Promise.resolve(HOST_CERT) }
  readonly fp: Uint8Array
  readonly session: string
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  signalingState = 'stable'
  connectionState = 'new'
  iceGatheringState = 'complete'
  channels: Record<string, Channel> = {}
  restarts = 0
  onicecandidate: ((e: { candidate: null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  constructor(private config: RTCConfiguration = {}) {
    this.fp = config.certificates?.[0] === HOST_CERT ? FP_HOST : FP_DEVICE
    this.session = String(100 + PeerConnection.all.length)
    PeerConnection.all.push(this)
  }
  createDataChannel(label: string) { return (this.channels[label] = new Channel()) }
  addEventListener(event: string, fn: () => void) { if (event === 'icegatheringstatechange') queueMicrotask(fn) }
  getConfiguration() { return this.config }
  setConfiguration(config: RTCConfiguration) { this.config = config }
  restartIce() { this.restarts++ }
  async createOffer() { return { type: 'offer' as const, sdp: description(this.fp, 'actpass', this.session, `u000${this.restarts}`) } }
  async createAnswer() { return { type: 'answer' as const, sdp: description(this.fp, 'active', this.session, `h000${this.restarts}`) } }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    if (d.type === 'rollback') { this.signalingState = 'stable'; return }
    this.localDescription = { ...d, toJSON: () => d }
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'
  }
  async addIceCandidate() {}
  async getStats() { return new Map() }
  state(s: string) { this.connectionState = s; this.onconnectionstatechange?.() }
  close() { this.connectionState = 'closed' }
}

class Socket {
  static all: Socket[] = []
  readyState = 0
  sent: string[] = []
  peer: Socket | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { Socket.all.push(this) }
  send(data: string) {
    this.sent.push(data)
    if (data === 'ping') return
    const m = JSON.parse(data)
    const peer = this.peer
    if (m.t === 'sig') queueMicrotask(() => peer?.receive({ t: 'sig', from: this.url.includes('role=host') ? 'screen' : 'phone', d: m.d }))
  }
  open() { this.readyState = 1; this.onopen?.() }
  close() { this.readyState = 3; this.onclose?.() }
  receive(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
  messages() { return this.sent.filter(m => m !== 'ping').map(m => JSON.parse(m) as { t: string; d?: { offer?: RTCSessionDescriptionInit; restart?: boolean } }) }
}

async function until<T>(what: string, fn: () => T | undefined | null | false): Promise<T> {
  const end = Date.now() + 4000
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const remotes: Remote[] = [], links: DeviceLink[] = []

beforeEach(async () => {
  await forgetAllPairs()
  PeerConnection.all = []
  Socket.all = []
  vi.stubGlobal('RTCPeerConnection', PeerConnection)
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
  vi.stubGlobal('fetch', async () => Response.json({ iceServers: [{ urls: 'stun:stun.example:3478' }] }))
})

afterEach(async () => {
  for (const link of links.splice(0)) link.close()
  for (const remote of remotes.splice(0)) remote.destroy()
  await forgetAllPairs()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function wire(screen: PeerConnection, phone: PeerConnection, transform?: (m: HostMsg) => HostMsg) {
  for (const label of ['ctl', 'st']) {
    screen.channels[label].peer = phone.channels[label]
    phone.channels[label].peer = screen.channels[label]
  }
  screen.channels.ctl.transform = transform ?? null
  screen.state('connected'); phone.state('connected')
  screen.channels.ctl.open(); screen.channels.st.open()
  phone.channels.st.open(); phone.channels.ctl.open()
}

async function phone(remote: Remote, hostSocket: Socket, opts: { code?: boolean; saved?: boolean; remember?: boolean; transform?: (m: HostMsg) => HostMsg } = {}) {
  const pairing = parsePairing(new URL(remote.pairingUrl).hash)!
  const room = await roomIdFor(pairing.secret)
  let code: { handle: string; secret: string; room: string; ticket: string } | undefined
  if (opts.code) {
    remote.wantCode()
    hostSocket.receive({ t: 'code', code: HANDLE, exp: Date.now() + 120_000 })
    code = { handle: HANDLE, secret: remote.code.slice(5), room, ticket: TICKET }
    hostSocket.receive({ t: 'code', ev: 'used', code: HANDLE, ticket: TICKET })
  }
  const link = new DeviceLink({ service: 'https://svc.test', ...(code ? { code } : opts.saved ? { saved: await saveInvite(pairing) } : { pairing }), remember: opts.remember, cert: DEVICE_CERT, caps: () => CAPS, name: 'Phone' })
  links.push(link)
  const seals: { seal: ConnectionSeal; delayMs: number }[] = []
  const pairs: StoredPair[] = []
  link.on('seal', s => seals.push(s))
  link.on('pair', p => pairs.push(p))
  await link.start()
  const socket = Socket.all.at(-1)!
  hostSocket.peer = socket; socket.peer = hostSocket
  socket.open()
  socket.receive({ t: 'welcome', id: 'phone', role: 'device', host: true })
  const pc = await until('phone offer', () => PeerConnection.all.find(p => p.fp === FP_DEVICE && p.localDescription?.type === 'offer' && p.connectionState !== 'closed'))
  const host = await until('screen answer', () => PeerConnection.all.find(p => p.fp === FP_HOST && p.remoteDescription?.sdp === pc.localDescription?.sdp))
  await until('answer applied', () => pc.remoteDescription)
  wire(host, pc, opts.transform)
  await until('phone welcome', () => link.ready)
  const welcome = await until('screen welcome', () => host.channels.ctl.messages().find((m): m is Extract<HostMsg, { t: 'welcome' }> => m.t === 'welcome'))
  return { link, pc, host, socket, seals, pairs, room, pairing, welcome }
}

async function screen(remember = false) {
  const remote = await Remote.create({ appName: 'Screen', service: 'https://svc.test', remember })
  remotes.push(remote)
  const socket = Socket.all.at(-1)!
  socket.open()
  const seals: { id: string; seal: ConnectionSeal; delayMs: number }[] = []
  remote.on('seal', s => seals.push(s))
  return { remote, socket, seals }
}

describe('connection seals through the verified link', () => {
  it.each(['qr', 'code', 'saved'] as const)('derives the same local seal on both ends after a %s join', async mode => {
    const host = await screen()
    const device = await phone(host.remote, host.socket, { code: mode === 'code', saved: mode === 'saved' })
    await until('phone seal pulse', () => device.seals.length)
    const verified = mode === 'saved' ? 'qr' : mode
    expect(device.link.verifiedBy).toBe(verified)
    expect(host.remote.seals).toEqual([{ id: 'phone', name: 'Phone', verified, seal: device.link.seal }])
    expect(host.seals).toHaveLength(1)
    expect(device.seals).toHaveLength(1)
    expect(host.seals[0].seal).toEqual(device.seals[0].seal)
    expect(host.seals[0].delayMs).toBe(350)
    expect(device.seals[0].delayMs).toBeGreaterThanOrEqual(0)
    expect(device.seals[0].delayMs).toBeLessThanOrEqual(350)
    expect(device.link.seal).toEqual(await connectionSeal(FP_DEVICE, FP_HOST, device.room, undefined, device.welcome.sealNonce))
    expect(device.welcome.sealProof).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(device.welcome.sealNonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(device.host.channels.ctl.messages().filter(m => m.t === 'seal-start')).toHaveLength(1)
  })

  it('derives equal LAN seals from the remembered key and fresh direct-code context', async () => {
    const host = await screen(true)
    const online = await phone(host.remote, host.socket, { remember: true })
    const pair = await until('remembered phone key', () => online.pairs[0])
    const url = await until('direct code', () => host.remote.lanUrl)
    const lan = parseLanPairing(new URL(url).hash)!
    expect(lan).not.toBeNull()
    const hostPeer = PeerConnection.all.find(p => p.fp === FP_HOST && p.localDescription?.type === 'offer')!
    online.link.close()
    await until('online peer gone', () => host.remote.participants.length === 0)
    const socketCount = Socket.all.length
    const link = new DeviceLink({ lan, pair, cert: DEVICE_CERT, caps: () => CAPS, name: 'LAN phone' })
    links.push(link)
    const pulses: { seal: ConnectionSeal; delayMs: number }[] = []
    link.on('seal', s => pulses.push(s))
    await link.start()
    const pc = PeerConnection.all.at(-1)!
    wire(hostPeer, pc)
    await until('LAN pulse', () => pulses.length)
    expect(Socket.all).toHaveLength(socketCount)
    expect(link.verifiedBy).toBe('lan')
    expect(host.remote.seals).toEqual([{ id: expect.stringMatching(/^lan:/), name: 'LAN phone', verified: 'lan', seal: link.seal }])
    const welcome = hostPeer.channels.ctl.messages().find((m): m is Extract<HostMsg, { t: 'welcome' }> => m.t === 'welcome')!
    expect(link.seal).toEqual(await connectionSeal(FP_DEVICE, FP_HOST, lanContext(lan.nonce), pair.key, welcome.sealNonce))
    expect(pulses).toHaveLength(1)
    const nextUrl = await until('fresh direct code', () => host.remote.lanUrl && host.remote.lanUrl !== url && host.remote.lanUrl)
    expect(parseLanPairing(new URL(nextUrl).hash)!.nonce).not.toEqual(lan.nonce)
  })

  it.each(['proof', 'nonce', 'malformed', 'older'] as const)('ignores a %s welcome seal while keeping verified input available', async kind => {
    const host = await screen()
    const device = await phone(host.remote, host.socket, { transform: m => {
      if (m.t !== 'welcome') return m
      if (kind === 'proof') return { ...m, sealProof: `${m.sealProof![0] === 'A' ? 'B' : 'A'}${m.sealProof!.slice(1)}` }
      if (kind === 'nonce') return { ...m, sealNonce: `${m.sealNonce![0] === 'A' ? 'B' : 'A'}${m.sealNonce!.slice(1)}` }
      if (kind === 'malformed') return { ...m, sealNonce: 'short' }
      return { ...m, sealNonce: undefined, sealProof: undefined }
    } })
    // Observe the async welcome work without changing the protocol implementation or using a timing delay.
    const takeSeal = vi.spyOn(device.link as unknown as { takeSeal(m: HostMsg): Promise<void> }, 'takeSeal')
    device.pc.channels.ctl.receive({ ...device.welcome, ...(kind === 'proof' ? { sealProof: 'A'.repeat(43) } : kind === 'nonce' ? { sealNonce: 'A'.repeat(22) } : kind === 'malformed' ? { sealNonce: 'short' } : { sealNonce: undefined, sealProof: undefined }) })
    await until('seal verification attempted', () => takeSeal.mock.results.length)
    await takeSeal.mock.results[0].value
    expect(device.link.seal).toBeNull()
    expect(device.seals).toEqual([])
    expect(host.seals).toEqual([])
    const button = vi.fn()
    host.remote.on('button', button)
    device.link.sendCtl({ t: 'btn', id: 'test', ev: 'tap' })
    await until('verified input', () => button.mock.calls.length)
    expect(button).toHaveBeenCalledWith({ id: 'test', ev: 'tap' }, expect.objectContaining({ id: 'phone' }))
    device.pc.channels.ctl.receive(device.welcome)
    await until('valid seal accepted', () => device.seals.length)
    expect(device.seals).toHaveLength(1)
    expect(host.seals).toHaveLength(1)
    expect(device.link.seal).toEqual(host.remote.seals[0].seal)
  })

  it('retains the seal and one pulse through an ICE restart on the same DTLS session', async () => {
    const host = await screen()
    const device = await phone(host.remote, host.socket)
    await until('initial pulse', () => device.seals.length)
    const seal = device.link.seal
    const hostSeal = host.remote.seals[0].seal
    const peers = PeerConnection.all.length
    device.pc.state('failed')
    await until('ICE restart offer', () => device.socket.messages().find(m => m.d?.restart))
    await until('ICE restart answer', () => device.pc.signalingState === 'stable')
    device.pc.state('connected')
    await until('path restored', () => device.link.ready)
    expect(PeerConnection.all).toHaveLength(peers)
    expect(device.pc.restarts).toBe(1)
    expect(device.link.seal).toBe(seal)
    expect(host.remote.seals[0].seal).toBe(hostSeal)
    expect(device.host.channels.ctl.messages().filter(m => m.t === 'welcome')).toHaveLength(1)
    expect(device.seals).toHaveLength(1)
    expect(host.seals).toHaveLength(1)
  })

  it('mints and authenticates a fresh nonce when the same certificates bind a new peer connection', async () => {
    const host = await screen()
    const first = await phone(host.remote, host.socket)
    await until('first pulse', () => first.seals.length)
    first.link.close()
    expect(first.link.seal).toBeNull()
    await until('first peer gone', () => host.remote.participants.length === 0)
    const next = await phone(host.remote, host.socket)
    await until('next pulse', () => next.seals.length)
    expect(next.welcome.sealNonce).not.toBe(first.welcome.sealNonce)
    expect(next.welcome.sealProof).not.toBe(first.welcome.sealProof)
    expect(next.pc.session).not.toBe(first.pc.session)
    expect(next.link.seal).toEqual(await connectionSeal(FP_DEVICE, FP_HOST, next.room, undefined, next.welcome.sealNonce))
    expect(host.remote.seals[0].seal).toEqual(next.link.seal)
    expect(host.seals).toHaveLength(2)
  })

  it('drops an authenticated seal still being derived when its peer connection closes', async () => {
    const host = await screen()
    const device = await phone(host.remote, host.socket)
    await until('first pulse', () => device.seals.length)
    const readyBefore = device.pc.channels.ctl.sent.filter(m => JSON.parse(m).t === 'seal-ready').length
    const derive = crypto.subtle.deriveBits.bind(crypto.subtle)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let waiting = false
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(async (...args) => {
      const bits = await derive(...args)
      waiting = true
      await gate
      return bits
    })
    const takeSeal = vi.spyOn(device.link as unknown as { takeSeal(m: HostMsg): Promise<void> }, 'takeSeal')
    // This welcome was produced by the real verified host; only the final crypto completion is held.
    device.pc.channels.ctl.receive(device.welcome)
    await until('seal derivation pending', () => waiting)
    device.link.close()
    release()
    await takeSeal.mock.results[0].value
    expect(device.link.seal).toBeNull()
    expect(device.link.status).toBe('closed')
    expect(device.pc.channels.ctl.sent.filter(m => JSON.parse(m).t === 'seal-ready')).toHaveLength(readyBefore)
    expect(device.seals).toHaveLength(1)
    expect(host.seals).toHaveLength(1)
  })
})

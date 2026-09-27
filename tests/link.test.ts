import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchIce, ICE_REFRESH_BEFORE_MS, ICE_RETRY_MS, iceRefreshIn, linkInfo } from '@obpal/core'

const NOW = 1_700_000_000_000

describe('ICE servers from the room service', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the servers, whether TURN is in them, and when its credentials lapse', async () => {
    const expires = Date.now() + 3600_000
    vi.stubGlobal('fetch', async () => Response.json({ iceServers: [{ urls: ['stun:s'] }, { urls: ['turn:t'], username: 'u', credential: 'c' }], turn: true, expires }))
    expect(await fetchIce('https://x', 'room')).toEqual({ servers: [{ urls: ['stun:s'] }, { urls: ['turn:t'], username: 'u', credential: 'c' }], turn: true, expires })
  })

  it('falls back to STUN when the service fails or says nothing usable', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    const a = await fetchIce('https://x', 'room')
    expect(a.turn).toBe(false)
    expect(a.servers[0].urls).toBe('stun:stun.cloudflare.com:3478')
    vi.stubGlobal('fetch', async () => Response.json({ iceServers: [] }))
    expect((await fetchIce('https://x', 'room')).turn).toBe(false)
  })

  it('asks again shortly before TURN credentials lapse, and now and then without TURN', () => {
    expect(iceRefreshIn({ turn: true, expires: NOW + 86_400_000 }, NOW)).toBe(86_400_000 - ICE_REFRESH_BEFORE_MS)
    expect(iceRefreshIn({ turn: true, expires: NOW + 5 * 60_000 }, NOW)).toBe(60_000)
    expect(iceRefreshIn({ turn: true }, NOW)).toBe(86_400_000 - ICE_REFRESH_BEFORE_MS)
    expect(iceRefreshIn({ turn: false }, NOW)).toBe(ICE_RETRY_MS)
  })
})

/** A peer connection that only answers getStats, with a selected pair of these candidate types. */
function fakePc(local: Record<string, unknown>, remote: Record<string, unknown>, transport: Record<string, unknown> = {}, state = 'connected') {
  const stats = new Map<string, Record<string, unknown>>([
    ['T', { type: 'transport', selectedCandidatePairId: 'P', dtlsState: 'connected', ...transport }],
    ['P', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', nominated: true, state: 'succeeded', currentRoundTripTime: 0.0123 }],
    ['L', { type: 'local-candidate', ...local }],
    ['R', { type: 'remote-candidate', ...remote }],
  ])
  return { connectionState: state, getStats: async () => stats } as unknown as RTCPeerConnection
}

describe('what a live connection says about itself', () => {
  it('names the path by the selected pair: the same network, through NAT, or a relay and how it is reached', async () => {
    expect((await linkInfo(fakePc({ candidateType: 'host' }, { candidateType: 'host' }))).path).toBe('lan')
    expect((await linkInfo(fakePc({ candidateType: 'srflx' }, { candidateType: 'prflx' }))).path).toBe('nat')
    expect((await linkInfo(fakePc({ candidateType: 'host' }, { candidateType: 'prflx' }))).path).toBe('direct')
    const relayed = await linkInfo(fakePc({ candidateType: 'relay', relayProtocol: 'tls' }, { candidateType: 'srflx' }))
    expect(relayed).toMatchObject({ path: 'relay', relayProtocol: 'tls', rttMs: 12 })
  })

  it('reports DTLS 1.2 and 1.3 and the cipher only as the browser gives them, and secure only while connected', async () => {
    expect(await linkInfo(fakePc({ candidateType: 'host' }, { candidateType: 'host' }, { tlsVersion: 'FEFC', dtlsCipher: 'TLS_AES_128_GCM_SHA256' })))
      .toMatchObject({ dtls: 'DTLS 1.3', cipher: 'TLS_AES_128_GCM_SHA256', secure: true })
    expect((await linkInfo(fakePc({ candidateType: 'host' }, { candidateType: 'host' }, { tlsVersion: 'fefd' }))).dtls).toBe('DTLS 1.2')
    const odd = await linkInfo(fakePc({ candidateType: 'host' }, { candidateType: 'host' }, { tlsVersion: '0303' }, 'disconnected'))
    expect(odd.dtls).toBeUndefined()
    expect(odd.secure).toBe(false)
  })

  it('says unknown before there is a pair, and survives a browser without stats', async () => {
    const none = { connectionState: 'connecting', getStats: async () => new Map() } as unknown as RTCPeerConnection
    expect(await linkInfo(none)).toEqual({ path: 'unknown', secure: false })
    const broken = { connectionState: 'connected', getStats: async () => { throw new Error('no') } } as unknown as RTCPeerConnection
    expect(await linkInfo(broken)).toEqual({ path: 'unknown', secure: true })
  })
})

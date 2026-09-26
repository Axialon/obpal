import { describe, expect, it } from 'vitest'
import {
  b64url, bindMac, candidatesOf, encodeLanPairing, encodePairing, fingerprintHex, fromB64url, lanAnswerSdp, lanContext, lanIceCredentials,
  lanOfferSdp, LAN_MAX_CANDIDATES, mungeIce, parseLanPairing, parsePairingCode, readLocalIce, sdpFingerprint,
} from '@obpal/core'
import { cacheName, route, staleCaches } from '../src/sw/routes'

const bytes = (n: number, v: number) => new Uint8Array(n).fill(v)
const ICE = /^[A-Za-z0-9+/]+$/
const lan = () => ({
  id: bytes(16, 1), nonce: bytes(16, 2), ufrag: 'AAjr', pwd: 'RfMNkMijI//CP0AuqTCu0VY7',
  cands: [{ host: '75b926e4-7d01-4e66-bd25-5fd596db7f1f.local', port: 47456 }, { host: '192.168.1.101', port: 42610 }],
})

describe('direct LAN code', () => {
  it('round-trips, with mDNS names shrunk to 22 characters', () => {
    const p = lan()
    const s = encodeLanPairing(p)
    expect(s.startsWith('2.')).toBe(true)
    const uuid = Uint8Array.from('75b926e47d014e66bd255fd596db7f1f'.match(/../g)!.map((h) => parseInt(h, 16)))
    expect(s).toContain(`.m${b64url(uuid)}~47456,a192.168.1.101~42610`)
    expect(b64url(uuid).length).toBe(22)
    expect(s.length).toBeLessThan(140)
    const back = parseLanPairing('#' + s)!
    expect(back).toEqual(p)
    expect(parsePairingCode(s)).toEqual({ v: 2, lan: p })
    expect(parsePairingCode(encodePairing({ secret: bytes(16, 7), fp: bytes(32, 9) }))?.v).toBe(1)
  })

  it('rejects malformed codes', () => {
    const p = lan()
    const ok = encodeLanPairing(p)
    expect(parseLanPairing(ok.replace(/^2\./, '3.'))).toBeNull()
    expect(parseLanPairing(encodeLanPairing({ ...p, ufrag: 'ab' }))).toBeNull() // too short
    expect(parseLanPairing(encodeLanPairing({ ...p, pwd: 'has.dots.in.it.and.is.long' }))).toBeNull()
    expect(parseLanPairing(encodeLanPairing({ ...p, id: bytes(15, 1) }))).toBeNull()
    expect(parseLanPairing(encodeLanPairing({ ...p, cands: [] }))).toBeNull()
    expect(parseLanPairing(encodeLanPairing({ ...p, cands: [{ host: '192.168.1.1', port: 70000 }] }))).toBeNull()
    expect(parseLanPairing(encodeLanPairing({ ...p, cands: [{ host: 'bad host!', port: 5 }] }))).toBeNull()
    expect(parseLanPairing(ok + '.extra')).toBeNull()
    expect(parseLanPairing('garbage')).toBeNull()
    // at most LAN_MAX_CANDIDATES travel
    const many = { ...p, cands: Array.from({ length: 9 }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 5000 + i })) }
    expect(parseLanPairing(encodeLanPairing(many))!.cands.length).toBe(LAN_MAX_CANDIDATES)
  })

  it('derives ICE credentials both sides agree on, in the ice-char alphabet', async () => {
    const key = bytes(32, 5)
    const a = await lanIceCredentials(key, bytes(16, 2))
    expect(a).toEqual(await lanIceCredentials(key, bytes(16, 2)))
    expect(a.ufrag).toMatch(ICE)
    expect(a.ufrag.length).toBe(8)
    expect(a.pwd).toMatch(ICE)
    expect(a.pwd.length).toBe(24)
    expect(await lanIceCredentials(key, bytes(16, 3))).not.toEqual(a)
    expect(await lanIceCredentials(bytes(32, 6), bytes(16, 2))).not.toEqual(a)
  })

  it('binds with the code nonce as context, distinct from the room', async () => {
    const key = bytes(32, 5)
    const ctx = lanContext(bytes(16, 2))
    expect(ctx).toBe(`lan:${b64url(bytes(16, 2))}`)
    const m = await bindMac(key, bytes(32, 1), bytes(32, 2), ctx)
    expect(m).toBe(await bindMac(key, bytes(32, 1), bytes(32, 2), ctx))
    expect(m).not.toBe(await bindMac(key, bytes(32, 1), bytes(32, 2), lanContext(bytes(16, 3))))
    expect(m).not.toBe(await bindMac(key, bytes(32, 1), bytes(32, 2), 'roomIdOf22Characters00'))
  })

  it('rebuilds both descriptions from the code and the remembered fingerprints', () => {
    const p = lan()
    const fp = bytes(32, 0xab)
    const offer = lanOfferSdp({ ufrag: p.ufrag, pwd: p.pwd, fp, cands: p.cands })
    expect(offer).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel')
    expect(offer).toContain(`a=ice-ufrag:${p.ufrag}\r\na=ice-pwd:${p.pwd}`)
    expect(offer).toContain('a=setup:actpass')
    expect(offer).toContain('a=candidate:1 1 udp 2113937151 75b926e4-7d01-4e66-bd25-5fd596db7f1f.local 47456 typ host')
    expect(offer).toContain('a=candidate:2 1 udp 2113937150 192.168.1.101 42610 typ host')
    expect(sdpFingerprint(offer)).toEqual(fp)
    expect(fingerprintHex(fp).startsWith('AB:AB:')).toBe(true)
    const answer = lanAnswerSdp({ ufrag: 'k7Qx9ZpL', pwd: 'Z1y2X3w4V5u6T7s8R9q0P1o2', fp })
    expect(answer).toContain('a=setup:active')
    expect(answer).not.toContain('a=candidate')
    expect(answer).toContain('a=sctp-port:5000')
  })

  it('replaces only the credential lines of a local answer', () => {
    const sdp = 'v=0\r\na=ice-ufrag:abcd\r\na=ice-pwd:0123456789012345678901\r\na=ice-options:trickle\r\na=fingerprint:sha-256 AA\r\n'
    const out = mungeIce(sdp, 'k7Qx9ZpL', 'Z1y2X3w4V5u6T7s8R9q0P1o2')
    expect(out).toBe('v=0\r\na=ice-ufrag:k7Qx9ZpL\r\na=ice-pwd:Z1y2X3w4V5u6T7s8R9q0P1o2\r\na=ice-options:trickle\r\na=fingerprint:sha-256 AA\r\n')
  })

  it('reads the credentials and UDP host candidates of a gathered description', () => {
    const sdp = [
      'a=ice-ufrag:AAjr', 'a=ice-pwd:RfMNkMijI//CP0AuqTCu0VY7',
      'a=candidate:1 1 udp 2113937151 192.168.1.101 42610 typ host generation 0 ufrag AAjr network-cost 999',
      'a=candidate:2 1 udp 2113937151 192.168.1.101 42610 typ host', // duplicate
      'a=candidate:3 1 tcp 1518280447 192.168.1.101 9 typ host tcptype active',
      'a=candidate:4 1 udp 1677729535 203.0.113.9 42610 typ srflx raddr 0.0.0.0 rport 0',
      'a=candidate:5 1 udp 2113937151 fe80::1%3 42611 typ host',
    ].join('\r\n')
    const ice = readLocalIce(sdp)!
    expect(ice.ufrag).toBe('AAjr')
    expect(ice.cands).toEqual([{ host: '192.168.1.101', port: 42610 }, { host: 'fe80::1%3', port: 42611 }])
    expect(candidatesOf('candidate:9 1 udp 1 a.local 5 typ host')).toEqual([{ host: 'a.local', port: 5 }])
    expect(readLocalIce('v=0')).toBeNull()
  })

  it('base64url helpers agree with the codes', () => {
    expect(fromB64url(b64url(bytes(16, 200)))).toEqual(bytes(16, 200))
  })
})

describe('controller service worker routing', () => {
  const origin = 'https://obpal.blackboxes.net'
  const pre = new Set(['/p/', '/assets/controller-abc.js', '/manifest.webmanifest'])
  const get = (url: string, mode = 'no-cors') => ({ url, method: 'GET', mode })

  it('serves the page shell for navigations inside /p/ and assets cache-first', () => {
    expect(route(get(`${origin}/p/`, 'navigate'), origin, pre)).toBe('shell')
    expect(route(get(`${origin}/p/?x=1`, 'navigate'), origin, pre)).toBe('shell')
    expect(route(get(`${origin}/p`, 'navigate'), origin, pre)).toBe('shell')
    expect(route(get(`${origin}/assets/controller-abc.js`), origin, pre)).toBe('precache')
    expect(route(get(`${origin}/manifest.webmanifest`), origin, pre)).toBe('precache')
  })

  it('never touches the room service, other pages, or unknown files', () => {
    expect(route(get(`${origin}/api/ice?room=x`), origin, pre)).toBe('network')
    expect(route(get(`${origin}/r/room`), origin, pre)).toBe('network')
    expect(route(get(`${origin}/view/`, 'navigate'), origin, pre)).toBe('network')
    expect(route(get(`${origin}/assets/viewer-zzz.js`), origin, pre)).toBe('network')
    expect(route({ url: `${origin}/api/x`, method: 'POST', mode: 'cors' }, origin, pre)).toBe('network')
    expect(route(get('https://example.com/x.js'), origin, pre)).toBe('network')
  })

  it('caches web fonts as they are seen and cleans old versions only', () => {
    expect(route(get('https://fonts.googleapis.com/css2?family=Inter'), origin, pre)).toBe('fonts')
    expect(route(get('https://fonts.gstatic.com/s/inter/v1/x.woff2'), origin, pre)).toBe('fonts')
    expect(staleCaches(['obpal-p-old', cacheName('new'), 'obpal-fonts-v1', 'other'], cacheName('new'))).toEqual(['obpal-p-old'])
  })
})

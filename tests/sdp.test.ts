import { describe, expect, it } from 'vitest'
import { fingerprintHex, sdpFingerprint } from '@obpal/core'

const REAL = new Uint8Array(32).fill(0xaa)
const PLANTED = new Uint8Array(32).fill(0x11)
const line = (fp: Uint8Array, alg = 'sha-256') => `a=fingerprint:${alg} ${fingerprintHex(fp)}`

/** A description with one data channel section; fingerprints where asked. */
function desc(o: { media?: string[]; session?: string[]; name?: string; sections?: number } = {}) {
  const section = (i: number) => [`m=application ${9 + i} UDP/DTLS/SCTP webrtc-datachannel`, 'c=IN IP4 0.0.0.0', 'a=setup:actpass', `a=mid:${i}`, ...(i === 0 ? o.media ?? [] : [])]
  return ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', `s=${o.name ?? '-'}`, 't=0 0', ...(o.session ?? []), 'a=group:BUNDLE 0',
    ...Array.from({ length: o.sections ?? 1 }, (_, i) => section(i)).flat(), ''].join('\r\n')
}
const read = (sdp: string) => { const f = sdpFingerprint(sdp); return f ? fingerprintHex(f) : null }

describe('the DTLS fingerprint an SDP commits to', () => {
  it('reads the one fingerprint line, in the media section (Chrome, Safari) or at session level (Firefox)', () => {
    expect(read(desc({ media: [line(REAL)] }))).toBe(fingerprintHex(REAL))
    expect(read(desc({ session: [line(REAL)] }))).toBe(fingerprintHex(REAL))
    expect(read(desc({ media: [line(REAL)] }).replace(/\r\n/g, '\n'))).toBe(fingerprintHex(REAL))
    expect(read(desc({ media: [line(REAL).toLowerCase()] }))).toBe(fingerprintHex(REAL))
  })

  it('ignores a fingerprint hidden in another line’s text (the session name)', () => {
    expect(read(desc({ name: line(PLANTED), media: [line(REAL)] }))).toBe(fingerprintHex(REAL))
    expect(read(desc({ name: line(PLANTED) }))).toBeNull()
  })

  it('refuses a description with more than one fingerprint line, wherever they are', () => {
    expect(read(desc({ session: [line(PLANTED)], media: [line(REAL)] }))).toBeNull()
    expect(read(desc({ media: [line(PLANTED), line(REAL)] }))).toBeNull()
    expect(read(desc({ media: [line(REAL), line(REAL)] }))).toBeNull()
    expect(read(desc({ media: [line(REAL, 'sha-1').slice(0, 30), line(REAL)] }))).toBeNull()
  })

  it('refuses more than one media section, another hash, and malformed values', () => {
    expect(read(desc({ media: [line(REAL)], sections: 2 }))).toBeNull()
    expect(read(desc({ media: [line(REAL, 'sha-512')] }))).toBeNull()
    expect(read(desc({ media: [`${line(REAL)}:AA`] }))).toBeNull()
    expect(read(desc({ media: [line(REAL).replace(/:([0-9A-F]{2})$/, ':G1')] }))).toBeNull()
    expect(read(desc({ media: [` ${line(REAL)}`] }))).toBeNull()
    expect(read('')).toBeNull()
    expect(sdpFingerprint(null)).toBeNull()
  })
})

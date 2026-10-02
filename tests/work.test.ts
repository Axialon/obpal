import { describe, expect, it, vi } from 'vitest'
import { hmacSha256, leadingZeroBits, sha256, solveWork, workDone } from '@obpal/core'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const enc = new TextEncoder()

describe('SHA-256 and HMAC-SHA-256 for the proof of work', () => {
  it('match the standard test vectors', () => {
    expect(hex(sha256(enc.encode('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hex(sha256(enc.encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hex(sha256(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    // RFC 4231, test case 2.
    expect(hex(hmacSha256(enc.encode('Jefe'), 'what do ya want for nothing?'))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })

  it('agree with the platform’s on random inputs of every length around the block edges, and long keys', async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = crypto.getRandomValues(new Uint8Array(n))
      expect(hex(sha256(data))).toBe(hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))))
    }
    for (const n of [1, 32, 64, 65, 200]) {
      const key = crypto.getRandomValues(new Uint8Array(n))
      const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const want = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('a challenge body')))
      expect(hex(hmacSha256(key, 'a challenge body'))).toBe(hex(want))
    }
  })
})

describe('the proof of work', () => {
  it('counts leading zero bits', () => {
    expect(leadingZeroBits(Uint8Array.of(0, 0, 0x10))).toBe(19)
    expect(leadingZeroBits(Uint8Array.of(0x80))).toBe(0)
    expect(leadingZeroBits(new Uint8Array(4))).toBe(32)
  })

  it('finds a solution that checks, and one that does not check fails', async () => {
    const x = await solveWork('k.16.nonce.tag', 12)
    expect(x).not.toBeNull()
    expect(workDone('k.16.nonce.tag', x!, 12)).toBe(true)
    expect(workDone('k.16.nonce.taG', x!, 12) && workDone('k.16.nonce.tah', x!, 12)).toBe(false)
  })

  it('yields every 4096 tries and stops at its fixed search budget', async () => {
    vi.useFakeTimers()
    try {
      const search = solveWork('fixed-no-solution', 256, 8192)
      expect(vi.getTimerCount()).toBe(1)
      await vi.runAllTimersAsync()
      expect(await search).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

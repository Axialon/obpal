import { describe, expect, it } from 'vitest'
import { b64url, encodeLanPairing, encodePairing, parsePairing } from '@obpal/core'
import { readScan } from '../src/controller/scan-code'

const origin = 'https://obpal.example'
const fragment = encodePairing({ secret: new Uint8Array(16).fill(7), fp: new Uint8Array(32).fill(8) })
const link = `${origin}/p/#${fragment}`

describe('QR input is pairing data, never a navigation', () => {
  it('accepts a canonical invite only at this deployment’s phone URL', () => {
    expect(readScan(link, origin)).toMatchObject({ kind: 'pairing', code: { v: 1 } })
    expect(readScan(link.replace(origin, 'http://localhost:5184'), 'http://localhost:5184')).not.toBeNull()
    expect(readScan(link.replace(origin, 'http://example.test'), 'http://example.test')).toBeNull()
  })
  it.each([
    'https://evil.example/p/#' + fragment,
    `${origin}.evil.example/p/#${fragment}`,
    `https://obpal.example@evil.example/p/#${fragment}`,
    `https://evil.example@obpal.example/p/#${fragment}`,
    `https://obpal.example:444/p/#${fragment}`,
    `//obpal.example/p/#${fragment}`,
    `/p/#${fragment}`, `#${fragment}`, `javascript:alert(1)`, `data:text/html,<script>alert(1)</script>`,
    `${origin}/p/?next=https://evil.example#${fragment}`, `${origin}/view/#${fragment}`,
    `${origin}/x/../p/#${fragment}`, `${origin}/%70/#${fragment}`, `${origin}/p#${fragment}`,
    `${link}.extra`, `${link}&x=1`, `${link}\n`, `${link}\u0000`, `${origin}\\p\\#${fragment}`,
    `${origin}/p/#3.a.b`, `${origin}/p/#${fragment.replace('1.', '1.%')}`, 'a'.repeat(10000),
    '0123456789', '123456789', '12345678901', '12345<script>67890', '12345.67890', '１２３４５６７８９０',
  ])('refuses hostile or malformed input: %s', (text) => expect(readScan(text, origin)).toBeNull())
  it('accepts complete digit codes with the visible separators', () => {
    expect(readScan('123 456 7890', origin)).toEqual({ kind: 'short', digits: '1234567890' })
    expect(readScan('12345-67890', origin)).toEqual({ kind: 'short', digits: '1234567890' })
  })
  it('accepts only a complete canonical direct code', () => {
    const direct = encodeLanPairing({ id: new Uint8Array(16), nonce: new Uint8Array(16).fill(1), ufrag: 'abcd', pwd: 'a'.repeat(24), cands: [{ host: '192.168.1.2', port: 45000 }] })
    expect(readScan(`${origin}/p/#${direct}`, origin)).toMatchObject({ code: { v: 2 } })
    expect(readScan(`${origin}/p/#${direct},aevil~70000`, origin)).toBeNull()
    expect(readScan(`${origin}/p/#${direct.replace('~45000', '~045000')}`, origin)).toBeNull()
  })
  it('the core fragment parser also refuses trailing fields and non-canonical secret bits', () => {
    expect(parsePairing(fragment + '.extra')).toBeNull()
    const secret = b64url(new Uint8Array(16))
    expect(parsePairing(`1.${secret.slice(0, -1)}B.${b64url(new Uint8Array(32))}`)).toBeNull()
  })
})

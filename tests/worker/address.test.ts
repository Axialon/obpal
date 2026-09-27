import { describe, expect, it } from 'vitest'
import { addressKey, addressNetworks } from '../../worker/address'
import { CodeBook, LIMITS, type CodeEntry } from '../../worker/codes'

const key = await addressKey('test relay secret')
const net = (ip: string) => addressNetworks(key, ip)

describe('keyed address limits', () => {
  it('derives a stable, separate HKDF key, and changes it with the existing secret', async () => {
    expect(await addressKey('test relay secret')).toEqual(key)
    expect(await addressKey('another test secret')).not.toEqual(key)
    const input = await crypto.subtle.importKey('raw', new TextEncoder().encode('test relay secret'), 'HKDF', false, ['deriveBits'])
    const other = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('another-purpose') }, input, 256))
    expect(other).not.toEqual(key)
    await expect(addressKey('')).rejects.toThrow('existing worker secret')
  })

  it('keeps IPv4 addresses separate but shares their /24, including mapped IPv6', () => {
    expect(net('::ffff:203.0.113.9')).toEqual(net('203.0.113.9'))
    expect(net('203.0.113.9').addr).not.toBe(net('203.0.113.10').addr)
    expect(net('203.0.113.9').wide).toBe(net('203.0.113.10').wide)
    expect(net('203.0.114.9').wide).not.toBe(net('203.0.113.9').wide)
    expect(net('203.0.113.9').mid).toBeNull()
  })

  it('shares IPv6 /64, /56 and /48 keys only at their respective boundaries', () => {
    const a = net('2001:db8:1:2ff::1')
    expect(a).toEqual(net('2001:0DB8:0001:02FF:1234:5678:abcd:ffff'))
    const b = net('2001:db8:1:200::1')
    expect(a.addr).not.toBe(b.addr)
    expect(a.mid).toBe(b.mid)
    const c = net('2001:db8:1:300::1')
    expect(a.mid).not.toBe(c.mid)
    expect(a.wide).toBe(c.wide)
    expect(a.wide).not.toBe(net('2001:db8:2:2ff::1').wide)
    for (const hash of Object.values(a)) expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('persists only hashes, then restores live limits and replacement codes without an address', () => {
    const saved = new Map<string, CodeEntry>()
    let next = 0
    const book = new CodeBook(() => 1000, () => next++, () => 'ticket', { put: (h, e) => { saved.set(h, e) }, del: (h) => { saved.delete(h) } })
    const network = net('2001:db8:1234:5678::abcd')
    for (let i = 0; i < LIMITS.live.addr; i++) expect(book.claim(`room${i}`, network)).toHaveProperty('code')
    const snapshot = [...saved]
    expect(JSON.stringify(snapshot)).not.toContain('2001:')
    expect(JSON.stringify(snapshot)).not.toContain('"ip"')
    const restored = new CodeBook(() => 1000, () => next++)
    restored.load(snapshot)
    expect(restored.claim('extra', network)).toMatchObject({ error: 'busy' })
    const used = restored.take(snapshot[0][0], net('192.0.2.8'))
    expect(used).toHaveProperty('next.code')
    expect(restored.claim('extra', network)).toMatchObject({ error: 'busy' })
    restored.drop('room1')
    expect(restored.claim('extra', network)).toHaveProperty('code')
  })
})

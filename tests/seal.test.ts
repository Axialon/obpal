import { describe, expect, it } from 'vitest'
import { bindMac, importPairKey, newSecret, roomIdFor } from '@obpal/core'
import { connectionSeal, sealSessionContext } from '../packages/core/src/seal'
import { isOfficialOrigin } from '../packages/host/src/origin'

const device = Uint8Array.from({ length: 32 }, (_, i) => i)
const host = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
const nonce = 'AQEBAQEBAQEBAQEBAQEBAQ'

describe('connection seal binding', () => {
  it('QR and typed-code peers independently derive the same three public six-bit indices', async () => {
    const room = await roomIdFor(newSecret())
    const phone = await connectionSeal(device, host, room, undefined, nonce)
    const screen = await connectionSeal(device.slice(), host.slice(), room, undefined, nonce)
    expect(phone).toEqual(screen)
    expect(phone).toHaveLength(3)
    expect(phone.every(i => Number.isInteger(i) && i >= 0 && i < 64)).toBe(true)
  })

  it('LAN peers derive equally from raw and non-extractable pairing keys', async () => {
    const bytes = new Uint8Array(32).fill(9)
    const key = await importPairKey(bytes)
    expect(await connectionSeal(device, host, 'lan:fresh', bytes, nonce)).toEqual(await connectionSeal(device, host, 'lan:fresh', key, nonce))
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('changes across sessions even when the room and both certificates persist', async () => {
    const sessions = await Promise.all(Array.from({ length: 32 }, (_, i) => connectionSeal(device, host, 'same-room', undefined, `${'A'.repeat(20)}${String(i).padStart(2, '0')}`)))
    expect(new Set(sessions.map(s => s.join('-'))).size).toBe(32)
    expect(await connectionSeal(host, device, 'same-room', undefined, nonce)).not.toEqual(await connectionSeal(device, host, 'same-room', undefined, nonce))
    expect(await connectionSeal(device, host, 'other-room', undefined, nonce)).not.toEqual(await connectionSeal(device, host, 'same-room', undefined, nonce))
  })

  it('authenticates session freshness separately and never turns the 18-bit display into a binding credential', async () => {
    const key = new Uint8Array(32).fill(17)
    const context = sealSessionContext('room', nonce)
    const proof = await bindMac(key, device, host, context)
    expect(proof).not.toBe(await bindMac(key, device, host, 'room'))
    expect(proof).not.toBe(await bindMac(key, device, host, sealSessionContext('other-room', nonce)))
    const seal = await connectionSeal(device, host, 'room', undefined, nonce)
    // Online display depends on verified public binding material, not QR secret bytes or short-code secrets.
    expect(seal).toEqual(await connectionSeal(device, host, 'room', undefined, nonce))
    const displayBytes = Uint8Array.from(seal)
    expect(await bindMac(displayBytes, device, host, 'room')).not.toBe(proof)
  })

  it('rejects malformed binding material', async () => {
    await expect(connectionSeal(new Uint8Array(31), host, 'room')).rejects.toThrow()
    await expect(connectionSeal(device, host, '')).rejects.toThrow()
    expect(() => sealSessionContext('room', 'too-short')).toThrow()
  })
})

describe('official origin disclosure', () => {
  it('allows the exact official origin and loopback development only', () => {
    for (const origin of ['https://obpal.blackboxes.net', 'https://obpal.blackboxes.net:443', 'chrome-extension://jnnpcnoilofjaffabnhecfokjjknlemg', 'http://localhost:5184', 'http://127.0.0.1:5197', 'http://[::1]:5184']) expect(isOfficialOrigin(origin), origin).toBe(true)
    for (const origin of ['http://obpal.blackboxes.net', 'https://obpal.blackboxes.net:8443', 'https://obpal.blackboxes.net.example.org', 'https://example.org', 'https://localhost.example.org', 'null', 'file:///']) expect(isOfficialOrigin(origin), origin).toBe(false)
  })
})

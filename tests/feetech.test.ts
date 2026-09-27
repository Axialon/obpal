import { describe, expect, it } from 'vitest'
import { checksum, packet, positionOf, readPosition, syncGoals, syncTorque, takeStatus } from '../src/sim/arm/feetech'

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

describe('Feetech STS bus servo packets (SO-100 / SO-101 arms)', () => {
  it('builds a read of the present position with the inverted-sum checksum', () => {
    // FF FF 01 04 02 38 02 BE: the documented read of register 0x38, two bytes, from servo 1.
    expect(hex(readPosition(1))).toBe('ff ff 01 04 02 38 02 be')
    expect(checksum([1, 4, 2, 0x38, 2])).toBe(0xbe)
    expect(hex(packet(1, 0x01))).toBe('ff ff 01 02 01 fb')
  })

  it('writes every goal position in one broadcast packet, little-endian and clamped to a turn', () => {
    const p = syncGoals([{ id: 1, pos: 2048 }, { id: 2, pos: 5000 }, { id: 3, pos: -4 }])
    expect(hex(p)).toBe(`ff ff fe 0d 83 2a 02 01 00 08 02 ff 0f 03 00 00 ${checksum([...p.slice(2, -1)]).toString(16).padStart(2, '0')}`)
    expect(hex(syncTorque([1, 2], true)).startsWith('ff ff fe 08 83 28 01 01 01 02 01')).toBe(true)
  })

  it('reads a status packet out of a noisy stream, and skips bad checksums', () => {
    const good = [0xff, 0xff, 0x02, 0x04, 0x00, 0x00, 0x08]
    good.push(checksum(good.slice(2)))
    const buf = [0x13, 0x37, ...good]
    const r = takeStatus(buf)!
    expect(r.status).toEqual({ id: 2, error: 0, params: [0x00, 0x08] })
    expect(r.used).toBe(buf.length)
    expect(positionOf(r.status!)).toBe(2048)
    const bad = [...good]
    bad[bad.length - 1] ^= 0xff
    expect(takeStatus(bad)!.status).toBeNull()
    // Not all there yet.
    expect(takeStatus(good.slice(0, 5))).toBeNull()
  })
})

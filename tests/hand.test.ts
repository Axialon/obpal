import { describe, expect, it } from 'vitest'
import { qAxisAngle } from '../packages/core/src/quat'
import { decodePose, encodePose, PoseFlag } from '../packages/core/src/pose'
import { handMove, handTurn, headingOf } from '../packages/host/src/hand'

const D2R = Math.PI / 180

describe('3D following: a tracked phone in the hand’s own terms', () => {
  it('takes where the phone points as forward, whichever way the person faces', () => {
    expect(headingOf([0, 0, 0, 1])).toBeCloseTo(0)
    // Turned a quarter left (about +y): it points along −x.
    const left = qAxisAngle(0, 1, 0, 90 * D2R)
    const h = headingOf(left)
    expect(h).toBeCloseTo(Math.PI / 2)
    const m = handMove([-0.1, 0.05, 0], h)
    expect(m.forward).toBeCloseTo(0.1)
    expect(m.right).toBeCloseTo(0)
    expect(m.up).toBeCloseTo(0.05)
    // Held flat like a remote, the top edge points.
    expect(headingOf(qAxisAngle(1, 0, 0, -90 * D2R))).toBeCloseTo(0)
  })

  it('reads tipping the front up and twisting', () => {
    const q0 = qAxisAngle(0, 1, 0, 30 * D2R)
    const h = headingOf(q0)
    // Tip up 20° about the hand's right axis.
    const right: [number, number, number] = [Math.cos(h), 0, -Math.sin(h)]
    const tipped = qAxisAngle(...right, 20 * D2R)
    const t = handTurn(q0, mul(tipped, q0), h)
    expect(t.tip).toBeCloseTo(20, 1)
    expect(Math.abs(t.twist)).toBeLessThan(0.5)
  })

  it('packs a pose into 32 bytes and back', () => {
    const q = qAxisAngle(0, 1, 0, 0.7)
    const back = decodePose(encodePose({ flags: PoseFlag.tracked, seq: 7, t: 123456, p: [0.25, 1.5, -0.75], q, gen: 3 }))!
    expect(back.p[0]).toBeCloseTo(0.25, 5)
    expect(back.p[2]).toBeCloseTo(-0.75, 5)
    expect(back.q[1]).toBeCloseTo(q[1], 4)
    expect(back.gen).toBe(3)
    expect(back.flags & PoseFlag.tracked).toBe(1)
  })

  it.each([['unknown', 0], ['camera', 1], ['model', 2]] as const)('round-trips the %s source in byte 29 only', (source, byte) => {
    const pose = { flags: PoseFlag.tracked, seq: 7, t: 123456, p: [0.25, 1.5, -0.75] as [number, number, number], q: qAxisAngle(0, 1, 0, 0.7), gen: 3 }
    const legacy = new Uint8Array(encodePose(pose))
    const packet = encodePose({ ...pose, source })
    expect(packet.byteLength).toBe(32)
    expect(new Uint8Array(packet)[29]).toBe(byte)
    expect(decodePose(packet)?.source).toBe(source)
    legacy[29] = byte
    expect(new Uint8Array(packet)).toEqual(legacy)
  })

  it.each([0, 255])('reads source byte %i as unknown, including legacy phones', (byte) => {
    const packet = encodePose({ flags: PoseFlag.tracked, seq: 1, t: 0, p: [0, 0, 0], q: [0, 0, 0, 1], gen: 1 })
    new DataView(packet).setUint8(29, byte)
    expect(decodePose(packet)?.source).toBe('unknown')
  })
})

function mul(a: number[], b: number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

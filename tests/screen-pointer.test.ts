import { describe, expect, it } from 'vitest'
import { POINT_HALF_FOV, ScreenPointer } from '../src/viewer/pointer'

const W = 1280
const H = 800
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180)

describe('Wii-style screen pointer', () => {
  it('starts at the centre and lands where the ray meets the screen', () => {
    const p = new ScreenPointer()
    const K = ScreenPointer.scale(W)
    expect(p.step([0, 0], [0, 0], W, H)).toMatchObject({ x: W / 2, y: H / 2, dx: 0, dy: 0, off: false })
    const s = p.step([10, 5], [0, 0], W, H) // 10 deg left, 5 deg up
    expect(s.x).toBeCloseTo(W / 2 - tan(10) * K, 6)
    expect(s.y).toBeCloseTo(H / 2 - tan(5) * K, 6)
    expect(s.dx).toBeCloseTo(s.x - W / 2, 6)
  })

  it('reaches the edge at the half field of view, and goes off-screen past it', () => {
    const p = new ScreenPointer()
    expect(p.step([-POINT_HALF_FOV, 0], [0, 0], W, H).x).toBeCloseTo(W, 6)
    const off = p.step([-10, 0], [0, 0], W, H)
    expect(off.off).toBe(true)
    // Aiming back returns exactly to where the phone points; nothing drifted while it was off-screen.
    expect(p.step([10 + POINT_HALF_FOV, 0], [0, 0], W, H)).toMatchObject({ x: W / 2, off: false })
  })

  it('stays finite however far the phone turns', () => {
    const p = new ScreenPointer()
    const s = p.step([-170, 0], [0, 0], W, H)
    expect(Number.isFinite(s.x)).toBe(true)
    expect(s.off).toBe(true)
  })

  it('trackpad pixels move the cursor one to one near the centre', () => {
    const p = new ScreenPointer()
    p.step([0, 0], [0, 0], W, H)
    const s = p.step([0, 0], [12, -8], W, H)
    expect(s.x).toBeCloseTo(W / 2 + 12, 1)
    expect(s.y).toBeCloseTo(H / 2 - 8, 1)
  })

  it('recentre puts the cursor back in the middle without a jump in motion', () => {
    const p = new ScreenPointer()
    p.step([7, -3], [0, 0], W, H)
    p.recenter()
    expect(p.step([0, 0], [0, 0], W, H)).toMatchObject({ x: W / 2, y: H / 2, dx: 0, dy: 0 })
  })
})

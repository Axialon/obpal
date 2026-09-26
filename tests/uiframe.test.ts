import { beforeEach, describe, expect, it } from 'vitest'
import { setUiRotation, toUi, uiRect, uiSize } from '../src/controller/uiframe'

describe('the controller UI frame while rotation is locked by counter-rotating (./lock.ts)', () => {
  beforeEach(() => {
    // A phone turned to landscape: the viewport is 915 × 412.
    Object.assign(globalThis, { innerWidth: 915, innerHeight: 412 })
    setUiRotation(0)
  })

  it('is the viewport when the UI isn’t turned', () => {
    expect(toUi(100, 200)).toEqual({ x: 100, y: 200 })
    expect(uiSize()).toEqual({ w: 915, h: 412 })
  })

  it('reads touches in the locked portrait frame when the page is turned back a quarter turn', () => {
    setUiRotation(-90)
    expect(uiSize()).toEqual({ w: 412, h: 915 })
    const c = toUi(915 / 2, 412 / 2)
    expect(c.x).toBeCloseTo(206)
    expect(c.y).toBeCloseTo(457.5)
    // A swipe up the (landscape) screen runs along the portrait UI's x axis: a drag to the right in the UI.
    const a = toUi(500, 300)
    const b = toUi(500, 200)
    expect(b.x - a.x).toBeCloseTo(100)
    expect(b.y - a.y).toBeCloseTo(0)
  })

  it('measures a turned element in the UI frame', () => {
    setUiRotation(270)
    const el = { getBoundingClientRect: () => ({ left: 300, top: 100, right: 400, bottom: 160, width: 100, height: 60 }) } as unknown as Element
    const r = uiRect(el)
    // 100 × 60 on the screen is 60 × 100 in the turned UI.
    expect(r.width).toBeCloseTo(60)
    expect(r.height).toBeCloseTo(100)
  })
})

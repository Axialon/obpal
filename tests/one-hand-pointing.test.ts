import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindPress, PressOwners } from '../src/controller/press'
import { Trackpad } from '../src/controller/trackpad'
import { thumbEdge, thumbGain, thumbRegion } from '../src/controller/thumb'
import { ScrollWheel } from '../src/controller/wheel'

class Pad extends EventTarget {
  classList = { add() {}, remove() {} }
  style = { setProperty() {} }
  querySelector() { return null }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 300 } }
  pointer(type: string, id = 1, x = 150, y = 150) {
    const e = new Event(type, { cancelable: true })
    Object.defineProperties(e, { pointerId: { value: id }, clientX: { value: x }, clientY: { value: y }, timeStamp: { value: performance.now() } })
    this.dispatchEvent(e)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout }))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }))
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('held clicks', () => {
  it('pairs each tap, including quick consecutive taps, without debounce', () => {
    const wire: boolean[] = [], owners = new PressOwners(d => wire.push(d)), el = new Pad()
    bindPress(el as unknown as HTMLElement, owners)
    for (let n = 0; n < 3; n++) { el.pointer('pointerdown'); el.pointer('pointerup'); el.pointer('lostpointercapture') }
    expect(wire).toEqual([true, false, true, false, true, false])
  })
  it('keeps the hold until the last finger or hardware source lets go', () => {
    const wire: boolean[] = [], owners = new PressOwners(d => wire.push(d))
    owners.set(1, true); owners.set(2, true); owners.set('hardware', true)
    owners.set(1, false); owners.set(2, false)
    expect(wire).toEqual([true])
    owners.set('hardware', false)
    expect(wire).toEqual([true, false])
  })
  it('cancel and capture loss release only their pointer, once', () => {
    const wire: boolean[] = [], owners = new PressOwners(d => wire.push(d)), el = new Pad()
    bindPress(el as unknown as HTMLElement, owners)
    el.pointer('pointerdown'); el.pointer('pointercancel'); el.pointer('lostpointercapture'); el.pointer('pointerup')
    expect(wire).toEqual([true, false])
  })
  it('reset releases once, ignores late ups, and permits a new press', () => {
    const wire: boolean[] = [], owners = new PressOwners(d => wire.push(d))
    owners.set(1, true); owners.reset(); owners.reset(); owners.set(1, false); owners.set(2, true); owners.set(2, false)
    expect(wire).toEqual([true, false, true, false])
  })
})

describe('thumb travel', () => {
  it('keeps slow precision at 1×, rises smoothly and caps fast travel at 6×', () => {
    expect(thumbGain(0)).toBe(1); expect(thumbGain(.08)).toBe(1)
    expect(thumbGain(.44)).toBeCloseTo(3.5)
    expect(thumbGain(.8)).toBe(6); expect(thumbGain(20)).toBe(6)
    for (let v = 0; v < 1; v += .01) expect(thumbGain(v + .01)).toBeGreaterThanOrEqual(thumbGain(v))
    expect(120 * thumbGain(.8)).toBe(720)
  })
  it('continues outward at edges, stays still centrally, and bounds corner speed', () => {
    expect(thumbEdge(150, 150, 300, 300)).toEqual([0, 0])
    expect(thumbEdge(0, 300, 300, 300)).toEqual([-.9, .9])
    expect(thumbEdge(12, 150, 300, 300)).toEqual([-.45, 0])
    expect(thumbEdge(-200, 500, 300, 300)).toEqual([-.9, .9])
  })
  it.each([360, 390, 430])('mirrors the %ipx thumb grid and leaves room for the tray and dock', width => {
    const l = thumbRegion(width, 844, true), r = thumbRegion(width, 844, false)
    expect(l.width).toBe(r.width); expect(r.width).toBeLessThanOrEqual(width - 32)
    expect(l.align).toBe('flex-start'); expect(r.align).toBe('flex-end')
    expect(l.primary).toBe('1 / 3'); expect(r.primary).toBe('2 / 4')
    expect(l.auxiliary).toBe('3'); expect(r.auxiliary).toBe('1')
    expect(r.height + 128).toBeLessThanOrEqual(844 * .6)
    expect(r.width).toBeGreaterThanOrEqual(48)
  })
})

describe('trackpad gestures', () => {
  function pad(thumb = true) {
    const el = new Pad(), p = new Trackpad(el as unknown as HTMLElement), taps: string[] = []
    p.setThumb(thumb); p.onTap = kind => taps.push(kind)
    return { el, p, taps }
  }
  it('lift and reposition never change accumulated travel', () => {
    const { el, p } = pad()
    el.pointer('pointerdown', 1, 80, 150); el.pointer('pointermove', 1, 100, 150); el.pointer('pointerup', 1)
    const before = [...p.pad1]
    el.pointer('pointerdown', 2, 200, 200)
    expect(p.pad1).toEqual(before)
    el.pointer('pointerup', 2)
  })
  it('cancel and lost capture never click, including the second finger', () => {
    const { el, taps } = pad()
    el.pointer('pointerdown'); el.pointer('pointercancel'); el.pointer('lostpointercapture')
    el.pointer('pointerdown'); el.pointer('pointerdown', 2); el.pointer('pointercancel', 2); el.pointer('pointerup')
    expect(taps).toEqual([])
  })
  it('recognises a two-finger right tap and a long press without an extra left click', () => {
    const { el, taps } = pad()
    el.pointer('pointerdown'); el.pointer('pointerdown', 2); el.pointer('pointerup', 2); el.pointer('pointerup')
    expect(taps).toEqual(['long'])
    el.pointer('pointerdown'); vi.advanceTimersByTime(530); el.pointer('pointerup')
    expect(taps).toEqual(['long', 'long'])
  })
  it('edge continuation requires movement and stops at lift, reset, blur or hiding', () => {
    const { el, p } = pad()
    el.pointer('pointerdown', 1, 299, 150); vi.advanceTimersByTime(100)
    expect(p.pad1).toEqual([0, 0])
    el.pointer('pointermove', 1, 285, 150)
    const atEdge = p.pad1[0]
    vi.advanceTimersByTime(100)
    expect(p.pad1[0]).toBeGreaterThan(atEdge)
    el.pointer('pointerup')
    const lifted = [...p.pad1]; vi.advanceTimersByTime(100)
    expect(p.pad1).toEqual(lifted)
    for (const end of [() => p.reset(), () => window.dispatchEvent(new Event('blur')), () => {
      Object.defineProperty(document, 'hidden', { value: true }); document.dispatchEvent(new Event('visibilitychange'))
    }]) {
      el.pointer('pointerdown', 1, 270, 150); el.pointer('pointermove', 1, 299, 150); end()
      const stopped = [...p.pad1]; vi.advanceTimersByTime(100); expect(p.pad1).toEqual(stopped); expect(p.touches).toBe(0)
    }
  })
  it('keeps ordinary two-handed motion at 1× and retains pan and pinch', () => {
    const { el, p } = pad(false)
    el.pointer('pointerdown', 1, 100, 100); el.pointer('pointermove', 1, 110, 105)
    expect(p.pad1).toEqual([10, 5])
    el.pointer('pointerdown', 2, 200, 100); el.pointer('pointermove', 2, 220, 100)
    expect(p.pad2[0]).toBe(10); expect(p.zoom).toBeGreaterThan(0)
    p.reset()
  })
  it('background reset notifies a released pad once and leaves idle or detached pads alone', () => {
    const { el, p } = pad(), touch = vi.fn()
    p.onTouchChange = touch
    p.reset(); window.dispatchEvent(new Event('blur'))
    expect(touch).not.toHaveBeenCalled()
    el.pointer('pointerdown'); window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('blur'))
    expect(touch.mock.calls).toEqual([[true], [false]])
  })
})

describe('wheel cancellation', () => {
  it.each(['pointercancel', 'lostpointercapture'])('%s cannot produce a middle click', type => {
    const el = new Pad(), tap = vi.fn(), hold = vi.fn(), wheel = new ScrollWheel(el as unknown as HTMLElement, { turn() {}, notch() {}, tap, hold })
    el.pointer('pointerdown'); el.pointer(type); vi.advanceTimersByTime(400)
    expect(tap).not.toHaveBeenCalled(); expect(hold).not.toHaveBeenCalled()
    wheel.destroy()
  })
  it('pairs a wheel hold through capture loss and late release', () => {
    const el = new Pad(), hold = vi.fn(), wheel = new ScrollWheel(el as unknown as HTMLElement, { turn() {}, notch() {}, hold })
    el.pointer('pointerdown'); vi.advanceTimersByTime(270); el.pointer('lostpointercapture'); el.pointer('pointerup')
    expect(hold.mock.calls).toEqual([[true], [false]])
    wheel.destroy()
  })
  it('blur releases a wheel hold exactly once', () => {
    const el = new Pad(), hold = vi.fn(), wheel = new ScrollWheel(el as unknown as HTMLElement, { turn() {}, notch() {}, hold })
    el.pointer('pointerdown'); vi.advanceTimersByTime(270); window.dispatchEvent(new Event('blur')); el.pointer('pointerup')
    expect(hold.mock.calls).toEqual([[true], [false]])
    wheel.destroy()
  })
})

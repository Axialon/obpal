import { describe, expect, it, vi } from 'vitest'
import { Group, PerspectiveCamera } from 'three'
import type { Vec3 } from '@obpal/core'
import { HandGestures, OneEuro, palmPosition } from '../src/controller/hand-signal'
import { ViewerHandInput } from '../src/viewer/hand-input'
import type { CameraHand } from '../src/ui/hand-control'
import { orderedQuickActions, quickKey, type QuickAction, type QuickId } from '../src/ui/quick-actions'
import { coverPoint } from '../src/ui/camera-space'
import { constrainedDownload } from '../src/controller/hand-assets'
import { HandCursor, handCursorPoint } from '../src/ui/hand-cursor'

function palm(ratio = 2.5): Vec3[] {
  const p: Vec3[] = Array.from({ length: 21 }, () => [0, 0, 0])
  for (const [i, x] of [[5, -.04], [9, 0], [13, .02], [17, .04]]) {
    p[i] = [x, .06, 0]; p[i + 3] = [x * ratio, .06 * ratio, 0]
  }
  p[4] = [-.12, .03, 0]
  return p
}
const hand = (x = 0, gestures = 2): CameraHand => ({ tracked: true, confidence: 1, gen: 1, p: [x, 0, -.4], handedness: 'right', landmarks: palm(), gestures })
const context = () => ({ controls: { rotate: vi.fn(), dolly: vi.fn(), distance: 5 }, camera: new PerspectiveCamera(), target: new Group(), orbit: true })

describe('round two gesture acceptance', () => {
  it('a fist with thumb touching index engages on two frames and is grip only', () => {
    const p = palm(1.2), g = new HandGestures(); p[4] = [...p[8]]
    expect(g.sample(p)).toBe(0)
    expect(g.sample(p)).toBe(2)
    expect(g.sample(p)).toBe(2)
  })
  it('requires two frames for a pinch too', () => {
    const p = palm(), g = new HandGestures(); p[4] = [...p[8]]
    expect(g.sample(p)).toBe(0); expect(g.sample(p)).toBe(1)
  })
  it('releases grip at its midpoint after three rising frames, before 1.65', () => {
    const g = new HandGestures(); g.sample(palm(1.2)); expect(g.sample(palm(1.2))).toBe(2)
    expect(g.sample(palm(1.4))).toBe(2)
    expect(g.sample(palm(1.49))).toBe(2)
    expect(g.sample(palm(1.52))).toBe(0)
  })
  it('releases pinch at its midpoint after three rising frames, before .42', () => {
    const g = new HandGestures(), p = palm()
    const sample = (ratio: number) => { p[4] = [p[8][0] + .08 * ratio, p[8][1], 0]; return g.sample(p) }
    sample(.2); expect(sample(.2)).toBe(1)
    expect(sample(.3)).toBe(1); expect(sample(.34)).toBe(1); expect(sample(.36)).toBe(0)
  })
})

describe('round two signal acceptance', () => {
  it('rotating the palm 60 degrees edge-on changes depth by no more than ten percent', () => {
    const estimate = (angle: number) => {
      const world = palm().map(([x, y, z]) => [x * Math.cos(angle), y, z - x * Math.sin(angle)] as Vec3)
      const image = world.map(([x, y, z]) => [.5 + x * .8660254 / (.4 - z), .5 - y * 1.1547005 / (.4 - z), 0] as Vec3)
      return -palmPosition(world, image, 640, 480)[2]
    }
    const flat = estimate(0), edge = estimate(Math.PI / 3)
    expect(Math.abs(edge / flat - 1)).toBeLessThanOrEqual(.1)
  })
  it.each([60, 120])('filters ±2 mm noise below .5 mm RMS at %s fps', fps => {
    const filter = new OneEuro(); filter.sample(0, 0)
    let seed = 13
    const out = Array.from({ length: fps * 10 }, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return filter.sample((seed / 0xffffffff * 2 - 1) * .002, (i + 1) / fps)
    })
    expect(Math.sqrt(out.reduce((sum, x) => sum + x * x, 0) / out.length)).toBeLessThanOrEqual(.0005)
  })
  it.each([60, 120])('holds lag below 20 ms on a .5 m/s ramp at %s fps', fps => {
    const filter = new OneEuro(); filter.sample(0, 0)
    const lag = Array.from({ length: fps * 2 }, (_, i) => {
      const t = (i + 1) / fps
      return (t * .5 - filter.sample(t * .5, t)) / .5
    })
    expect(Math.max(...lag)).toBeLessThanOrEqual(.02)
  })
})

describe('round two Viewer acceptance', () => {
  it('an open palm makes no rotate or dolly calls', () => {
    const input = new ViewerHandInput(), ctx = context()
    input.step(hand(0, 0), ctx, 0); input.step(hand(.1, 0), ctx, 100)
    expect(ctx.controls.rotate).not.toHaveBeenCalled(); expect(ctx.controls.dolly).not.toHaveBeenCalled()
  })
  it.each([1, -1])('a 10 cm fist drag has mouse gain and mirrored sign (%s)', sign => {
    const input = new ViewerHandInput(), ctx = context()
    input.step(hand(), ctx, 0)
    for (let i = 1; i <= 60; i++) input.step(hand(sign * Math.min(.1, i / 60 * .2)), ctx, i * 1000 / 60)
    const angle = ctx.controls.rotate.mock.calls.reduce((sum, c) => sum + c[0], 0)
    expect(angle).toBeCloseTo(-sign * .7, 2)
    expect(ctx.controls.rotate.mock.calls.every(c => c[2] === false)).toBe(true)
  })
  it('depth inside the 1.5 cm clutch band makes no dolly call and regrabbing ratchets', () => {
    const input = new ViewerHandInput(), ctx = context()
    input.step(hand(), ctx, 0)
    input.step({ ...hand(), p: [0, 0, -.386] }, ctx, 100)
    expect(ctx.controls.dolly).not.toHaveBeenCalled()
    input.step(null, ctx, 200); input.step({ ...hand(), p: [0, 0, -.2] }, ctx, 300)
    expect(ctx.controls.dolly).not.toHaveBeenCalled()
  })
})

describe('round two dock acceptance', () => {
  const action = (id: QuickId, group: QuickAction['group'], key?: string): QuickAction => ({ id, group, key, label: id, icon: id, run() {} })
  const list = [action('theme', 'system', 'T'), action('stop', 'page', 'Space'), action('camera', 'page', 'C'), action('pair', 'primary', 'P'), action('sound', 'system', 'M'), action('reset', 'page', 'R'), action('switch', 'page', 'K'), action('fullscreen', 'system', 'F'), action('next1', 'page', '1')]
  const offered = orderedQuickActions(new Map(list.map(a => [a.id, a])))
  const event = (key: string, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, target: null, ...extra })
  it('orders primary, four page shortcuts, then the three system shortcuts', () => {
    expect(offered.map(a => a.id)).toEqual(['pair', 'switch', 'reset', 'camera', 'stop', 'fullscreen', 'sound', 'theme'])
  })
  it('ignores inputs, editable fields and modifier keys', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) expect(quickKey(event('p', { [modifier]: true }), offered)).toBeNull()
    const closest = vi.fn(() => ({}))
    expect(quickKey(event('p', { target: { closest } }), offered)).toBeNull()
    expect(closest).toHaveBeenCalledWith(expect.stringContaining('contenteditable'))
    expect(quickKey(event('p'), offered)).toBe('pair')
    expect(quickKey(event('?'), offered)).toBe('shortcuts')
  })
  it('Space is live only when the arm offers Stop', () => {
    expect(quickKey(event(' '), offered)).toBe('stop')
    expect(quickKey(event(' '), offered.filter(a => a.id !== 'stop'))).toBeNull()
  })
})

describe('camera mapping and download gates', () => {
  it('cover coordinates crop, centre and mirror without stretching', () => {
    expect(coverPoint(320, 240, 640, 480, 390, 844)).toEqual({ x: 195, y: 422 })
    const a = coverPoint(400, 200, 640, 480, 390, 844), b = coverPoint(400, 200, 640, 480, 390, 844, true)
    expect(a.x + b.x).toBeCloseTo(390); expect(a.y).toBe(b.y)
  })
  it('asks on cellular, Save-Data or unknown networks, including Safari without the network API', () => {
    expect(constrainedDownload({ type: 'cellular' })).toBe(true)
    expect(constrainedDownload({ type: 'wifi', saveData: true })).toBe(true)
    expect(constrainedDownload({ type: 'wifi' })).toBe(false)
    expect(constrainedDownload({ type: 'ethernet' })).toBe(false)
    expect(constrainedDownload({ type: 'unknown' })).toBe(true)
    expect(constrainedDownload()).toBe(true)
  })
  it('maps the palm to the cursor and shows all four states with a 1.5 second loss hold', () => {
    vi.stubGlobal('innerWidth', 1280); vi.stubGlobal('innerHeight', 800)
    const el = { dataset: {} as Record<string, string>, style: { transform: '' }, hidden: true }
    const cursor = new HandCursor(el as unknown as HTMLElement)
    expect(handCursorPoint(hand())).toEqual({ x: .5, y: .5 })
    for (const [bits, state] of [[0, 'hover'], [2, 'grip'], [1, 'pinch']] as const) {
      cursor.step(hand(0, bits), 100); expect(el.dataset.cameraCursor).toBe(state)
    }
    cursor.step(null, 1599); expect(el.dataset.cameraCursor).toBe('lost'); expect(el.hidden).toBe(false)
    cursor.step(null, 1600); expect(el.hidden).toBe(true)
    vi.unstubAllGlobals()
  })
})

import { describe, expect, it } from 'vitest'
import { clampRect, clearLayout, defaultPlacement, fitHeight, layoutKey, readLayout, resizeRect, screenClass, snapMove, writeLayout, type Anchor, type Edge, type LayoutStorage, type Rect } from '../src/sim/ui/layout'

const area = { x: 52, y: 84, w: 1216, h: 704 }
const start = { x: 400, y: 300, w: 300, h: 200 }
const memory = (): LayoutStorage => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}
const inside = (r: Rect, a: Rect) => {
  expect(r.x).toBeGreaterThanOrEqual(a.x); expect(r.y).toBeGreaterThanOrEqual(a.y)
  expect(r.x + r.w).toBeLessThanOrEqual(a.x + a.w); expect(r.y + r.h).toBeLessThanOrEqual(a.y + a.h)
}

describe('window layout', () => {
  it.each([[1280, 800, 'desktop'], [1920, 1080, 'wide'], [844, 390, 'compact'], [390, 844, 'portrait']] as const)('separates %ix%i layouts', (w, h, kind) => {
    expect(screenClass(w, h)).toBe(kind)
    const bounds = { x: 52, y: 84, w: w - 64, h: h - 96 }
    for (const anchor of ['controls', 'camera', 'scores', 'arm', 'station', 'record', 'view'] as Anchor[]) {
      for (let i = 0; i < 8; i++) {
        const p = defaultPlacement(anchor, i, bounds, kind); inside(p.rect, bounds)
        if (kind === 'portrait' || kind === 'compact') expect(p.state).toBe('minimised')
      }
    }
  })
  it('keeps the initial desktop controls and camera apart', () => {
    const a = defaultPlacement('controls', 0, area, 'desktop'), b = defaultPlacement('camera', 0, area, 'desktop')
    expect(a.rect.x + a.rect.w).toBeLessThan(b.rect.x)
    expect(a.state).toBe('open'); expect(b.state).toBe('open')
  })
  it('keeps the phone viewpoint controls above the working area', () => {
    const bounds = { x: 52, y: 84, w: 326, h: 748 }
    expect(defaultPlacement('view', 0, bounds, 'portrait').rect.y).toBe(bounds.y)
    expect(defaultPlacement('controls', 0, bounds, 'portrait').rect.y).toBeGreaterThan(bounds.y)
  })
  it('clamps oversized and offscreen windows', () => {
    expect(clampRect({ x: -20, y: -60, w: 9000, h: 6000 }, area)).toEqual(area)
    expect(clampRect({ x: 9999, y: 9999, w: 10, h: 5 }, area)).toEqual({ x: 1028, y: 648, w: 240, h: 140 })
  })
  it('obeys per-window maximum sizes', () => {
    expect(clampRect(area, area, { minW: 100, minH: 80, maxW: 600, maxH: 400 })).toEqual({ x: 52, y: 84, w: 600, h: 400 })
  })
  it('lets minimum sizes yield to tiny viewports', () => {
    const tiny = { x: 52, y: 84, w: 80, h: 30 }
    expect(clampRect(start, tiny)).toEqual(tiny)
  })
  it('snaps to all four viewport edges', () => {
    expect(snapMove({ ...start, x: 57, y: 87 }, area, [])).toMatchObject({ x: 52, y: 84 })
    expect(snapMove({ ...start, x: 965, y: 583 }, area, [])).toMatchObject({ x: 968, y: 588 })
  })
  it('snaps beside a neighbour with a gutter and aligns its top', () => {
    expect(snapMove({ ...start, x: 756, y: 303 }, area, [{ x: 440, y: 300, w: 300, h: 200 }])).toMatchObject({ x: 752, y: 300 })
  })
  it('does not snap to distant panels or pull a window outside the threshold', () => {
    expect(snapMove(start, area, [{ x: 100, y: 650, w: 285, h: 130 }])).toEqual(start)
    expect(snapMove({ ...start, x: 63, y: 95 }, area, [])).toMatchObject({ x: 63, y: 95 })
  })
  it.each(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Edge[])('resizes %s without losing the opposite edge', edge => {
    const r = resizeRect(start, edge, 25, 20, area)
    if (edge.includes('w')) expect(r.x + r.w).toBe(start.x + start.w)
    else expect(r.x).toBe(start.x)
    if (edge.includes('n')) expect(r.y + r.h).toBe(start.y + start.h)
    else expect(r.y).toBe(start.y)
    inside(r, area)
  })
  it('retains the fixed corner when shrinking past the minimum', () => {
    expect(resizeRect(start, 'nw', 900, 900, area)).toEqual({ x: 460, y: 360, w: 240, h: 140 })
  })
  it('keeps all edge drags inside the screen at extreme deltas', () => {
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Edge[]) {
      for (const delta of [-10000, -20, 20, 10000]) inside(resizeRect(start, edge, delta, delta, area), area)
    }
  })
  it('snaps a resized edge to a neighbour', () => {
    expect(resizeRect(start, 'e', 85, 0, area, undefined, [{ x: 800, y: 300, w: 240, h: 200 }]).w).toBe(388)
  })
})

describe('windows that fit their content', () => {
  it('take the height their content needs and keep their top', () => {
    expect(fitHeight(start, 420, area)).toEqual({ ...start, h: 420 })
    expect(fitHeight({ ...start, h: 600 }, 260, area)).toEqual({ ...start, h: 260 })
  })
  it('stop at the bottom of the screen, and at their own limits', () => {
    expect(fitHeight(start, 2000, area).h).toBe(area.y + area.h - start.y)
    expect(fitHeight(start, 60, area).h).toBe(140)
    expect(fitHeight(start, 700, area, { minW: 240, minH: 140, maxH: 360 }).h).toBe(360)
  })
  it('grow upward from the bottom edge they stand on, as far as the top of the area', () => {
    const standing = { ...start, y: 588, h: 200 }
    expect(fitHeight(standing, 320, area, undefined, true)).toEqual({ ...standing, y: 468, h: 320 })
    expect(fitHeight(standing, 5000, area, undefined, true)).toEqual({ ...standing, y: area.y, h: 788 - area.y })
  })
  it('start fitted, except camera pictures, which keep their shape', () => {
    for (const anchor of ['controls', 'scores', 'arm', 'station', 'record', 'view'] as Anchor[]) expect(defaultPlacement(anchor, 0, area, 'desktop').fit).toBe(true)
    expect(defaultPlacement('camera', 0, area, 'desktop').fit).toBe(false)
  })
  it('remember whether a person sized them', () => {
    const storage = memory(), key = layoutKey('device:drone', 'desktop')
    const panels = { controls: { rect: start, state: 'open' as const, fit: false }, scores: { rect: area, state: 'open' as const, fit: true } }
    writeLayout(storage, key, panels); expect(readLayout(storage, key)).toEqual(panels)
  })
})

describe('local layout memory', () => {
  it('round trips moved, minimised and closed windows', () => {
    const storage = memory(), key = layoutKey('device:ptz', 'desktop')
    const panels = { controls: { rect: start, state: 'minimised' as const }, 'camera-1': { rect: area, state: 'closed' as const } }
    writeLayout(storage, key, panels); expect(readLayout(storage, key)).toEqual(panels)
    clearLayout(storage, key); expect(readLayout(storage, key)).toEqual({})
  })
  it('isolates sims and screen-size classes', () => {
    const storage = memory()
    writeLayout(storage, layoutKey('arm:six', 'wide'), { controls: { rect: start, state: 'open' } })
    expect(readLayout(storage, layoutKey('arm:six', 'portrait'))).toEqual({})
    expect(readLayout(storage, layoutKey('device:ptz', 'wide'))).toEqual({})
  })
  it.each(['{', 'null', '[]', '{"version":0,"panels":{}}', '{"version":1,"panels":[]}'])('ignores corrupt or stale data: %s', text => {
    const storage = memory(); storage.setItem('key', text); expect(readLayout(storage, 'key')).toEqual({})
  })
  it('keeps valid entries while rejecting invalid geometry, states and ids', () => {
    const storage = memory()
    storage.setItem('key', JSON.stringify({ version: 1, panels: {
      controls: { rect: start, state: 'open' }, negative: { rect: { ...start, w: -1 }, state: 'open' },
      nan: { rect: { ...start, x: null }, state: 'open' }, state: { rect: start, state: 'whatever' },
      huge: { rect: { ...start, y: 1e9 }, state: 'open' }, 'bad id': { rect: start, state: 'open' },
    } }))
    expect(readLayout(storage, 'key')).toEqual({ controls: { rect: start, state: 'open' } })
  })
  it('works without storage and when every storage operation throws', () => {
    const fail = () => { throw new Error('denied') }
    for (const storage of [null, { getItem: fail, setItem: fail, removeItem: fail }]) {
      expect(readLayout(storage, 'key')).toEqual({})
      expect(() => writeLayout(storage, 'key', {})).not.toThrow(); expect(() => clearLayout(storage, 'key')).not.toThrow()
    }
  })
})

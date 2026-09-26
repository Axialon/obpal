import { describe, expect, it } from 'vitest'
import { emptyPointer, PointerFlag } from '@obpal/core'
import { parseFromPage, parseInputFrame, type PointerTuple } from '../extension/src/shared/messages'
import { edgeTurn, POINT_HALF_FOV, pointerAim, PointerMapper, projectPointer } from '../extension/src/shared/pointer'
import { buildFrame, electFrame, isActive, pointerTuple, withoutClickButtons, withRelativeAim, type FrameInfo } from '../extension/src/shared/route'
import { SITE_PROFILES, suggestForFrames, suggestProfile } from '../extension/src/shared/sites'

const W = 1280
const H = 800
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180)
const pt = (yaw: number, pitch: number, ab = 0, flags: number = PointerFlag.valid, gen = 0): PointerTuple => [yaw, pitch, gen, flags, ab]
const frame = (p: PointerTuple | null, locked = false) => ({ pt: p, w: W, h: H, locked })
const types = (acts: { type: string }[]) => acts.map((a) => a.type)

describe('Wii pointer geometry (CATALOGUE §4)', () => {
  it('projects x = cx + tan(yaw)·K, reaching the edge at the half field of view', () => {
    const K = W / 2 / tan(POINT_HALF_FOV)
    expect(projectPointer(0, 0, W, H)).toMatchObject({ x: W / 2, y: H / 2, off: false })
    const p = projectPointer(-8, 4, W, H) // 8° left, 4° up
    expect(p.x).toBeCloseTo(W / 2 - tan(8) * K, 6)
    expect(p.y).toBeCloseTo(H / 2 - tan(4) * K, 6)
    expect(projectPointer(POINT_HALF_FOV, 0, W, H).x).toBeCloseTo(W, 6)
    expect(projectPointer(-20, 0, W, H).off).toBe(true)
    expect(Number.isFinite(projectPointer(-170, 0, W, H).x)).toBe(true)
  })

  it('the edge turn deflects toward the edge in proportion to how far into the last 12% the cursor is', () => {
    expect(edgeTurn(W / 2, H / 2, W, H)).toEqual([0, 0])
    expect(edgeTurn(W * 0.88, H / 2, W, H)).toEqual([0, 0])
    expect(edgeTurn(W * 0.94, H / 2, W, H)[0]).toBeCloseTo(0.5, 6)
    expect(edgeTurn(W - 1, H / 2, W, H)[0]).toBeCloseTo(1, 1)
    expect(edgeTurn(0, H / 2, W, H)[0]).toBe(-1)
    expect(edgeTurn(W / 2, H * 0.06, W, H)[1]).toBeCloseTo(-0.5, 6)
    expect(edgeTurn(W / 2, H - 1, W, H)[1]).toBeCloseTo(1, 1)
  })

  it('pointer changes read as aim deltas (+ left, + up), zero across a recentre, wrap-safe', () => {
    expect(pointerAim(pt(3, 2), pt(1, 1))).toEqual([-2, 1])
    expect(pointerAim(pt(3, 2), null)).toEqual([0, 0])
    expect(pointerAim(pt(3, 2, 0, 1, 1), pt(1, 1))).toEqual([0, 0])
    expect(pointerAim(pt(-327, 0), pt(327, 0))[0]).toBeCloseTo(-1.36, 6)
  })
})

describe('pointer mapper: cursor, A clicks, B drags', () => {
  it('draws the cursor where the phone points and hovers as it moves', () => {
    const m = new PointerMapper()
    const first = m.update(frame(pt(0, 0)))
    expect(first.acts).toEqual([{ type: 'cursor', x: W / 2, y: H / 2, grab: false, off: false }])
    const K = W / 2 / tan(POINT_HALF_FOV)
    const moved = m.update(frame(pt(-8, 0)))
    const x = Math.round(W / 2 - tan(8) * K)
    expect(types(moved.acts)).toEqual(['hover', 'cursor'])
    expect(moved.acts[0]).toMatchObject({ type: 'hover', x, y: H / 2, dx: x - W / 2, dy: 0 })
    expect(moved.stick).toEqual([0, 0])
    // off-screen: the cursor is kept at the edge and dimmed
    const off = m.update(frame(pt(-30, 0)))
    expect(off.acts.at(-1)).toMatchObject({ type: 'cursor', x: 0, off: true })
  })

  it('A presses, releases and clicks at the cursor; the button leaves the pad meanwhile', () => {
    const m = new PointerMapper()
    m.update(frame(pt(0, 0)))
    const down = m.update(frame(pt(0, 0, 1)))
    expect(types(down.acts)).toEqual(['down', 'cursor'])
    expect(down.acts[0]).toMatchObject({ x: W / 2, y: H / 2 })
    expect(m.dragging).toBe(true)
    const held = m.update(frame(pt(0, 0, 1)))
    expect(types(held.acts)).toEqual(['cursor'])
    const up = m.update(frame(pt(0, 0, 0)))
    expect(up.acts[0]).toEqual({ type: 'up', x: W / 2, y: H / 2, click: true })
    expect(m.dragging).toBe(false)
  })

  it('holding B drags: moves carry the left button and the release does not click', () => {
    const m = new PointerMapper()
    m.update(frame(pt(0, 0)))
    m.update(frame(pt(0, 0, 2)))
    const drag = m.update(frame(pt(-4, 0, 2)))
    expect(types(drag.acts)).toEqual(['drag', 'cursor'])
    expect(drag.acts[1]).toMatchObject({ type: 'cursor', grab: true })
    const up = m.update(frame(pt(-4, 0, 0)))
    expect(up.acts[0]).toMatchObject({ type: 'up', click: false })
    // A while B holds does nothing extra; releasing everything lifts once
    m.update(frame(pt(0, 0, 2)))
    expect(types(m.update(frame(pt(0, 0, 3))).acts)).toEqual(['cursor'])
    expect(types(m.update(frame(pt(0, 0, 0))).acts)).toEqual(['up', 'cursor'])
  })

  it('release lifts a held button and hides the cursor; a missing pointer does the same', () => {
    const m = new PointerMapper()
    m.update(frame(pt(0, 0, 1)))
    expect(types(m.release())).toEqual(['up', 'hide'])
    expect(m.release()).toEqual([])
    m.update(frame(pt(0, 0)))
    expect(types(m.update(frame(null)).acts)).toEqual(['hide'])
  })

  it('asks for the edge turn only when the packet flags it', () => {
    const m = new PointerMapper()
    expect(m.update(frame(pt(15, 0, 0, PointerFlag.valid | PointerFlag.edgeTurn))).stick[0]).toBeGreaterThan(0.5)
    expect(m.update(frame(pt(15, 0))).stick).toEqual([0, 0])
  })
})

describe('pointer mapper: gyro mouse under pointer lock', () => {
  it('turns the change of aim into movementX/Y, hides the cursor, and clicks with A on the locked element', () => {
    const m = new PointerMapper()
    m.update(frame(pt(0, 0)))
    const locked = m.update(frame(pt(0, 0), true))
    expect(types(locked.acts)).toEqual(['hide'])
    const move = m.update(frame(pt(2, -1), true))
    expect(move.acts).toEqual([{ type: 'lock', dx: 28, dy: 14, buttons: 0 }]) // 14 px per degree; up is −y
    const press = m.update(frame(pt(2, -1, 1), true))
    expect(types(press.acts)).toEqual(['down'])
    const drag = m.update(frame(pt(3, -1, 1), true))
    expect(drag.acts).toEqual([{ type: 'lock', dx: 14, dy: 0, buttons: 1 }])
    expect(m.update(frame(pt(3, -1, 0), true)).acts[0]).toMatchObject({ type: 'up', click: true })
  })

  it('skips the jump across a recentre and keeps sub-pixel remainders', () => {
    const m = new PointerMapper()
    m.update(frame(pt(40, 0), true))
    expect(m.update(frame(pt(0, 0, 0, PointerFlag.valid, 1), true)).acts).toEqual([])
    const slow = [1, 2, 3].map(() => m.update(frame(pt(0.03 * 0, 0), true)))
    expect(slow.every((s) => s.acts.length === 0)).toBe(true)
  })

  it('a relative pointer without lock is ignored here (the link mixed it into the stick already)', () => {
    const m = new PointerMapper()
    const rel = m.update(frame(pt(5, 5, 1, PointerFlag.valid | PointerFlag.relative)))
    expect(rel.acts).toEqual([])
    expect(rel.stick).toEqual([0, 0])
    // under lock a relative pointer moves the mouse but leaves A and B to the pad
    m.update(frame(pt(5, 5, 0, PointerFlag.valid | PointerFlag.relative), true))
    const move = m.update(frame(pt(6, 5, 1, PointerFlag.valid | PointerFlag.relative), true))
    expect(move.acts).toEqual([{ type: 'lock', dx: 14, dy: 0, buttons: 0 }])
  })
})

describe('site profiles and pointer routing in the link', () => {
  it('suggests a profile per site, subdomains included, from a data table', () => {
    expect(suggestProfile('tesana.com')).toBe('flight')
    expect(suggestProfile('www.tesana.com')).toBe('flight')
    expect(suggestProfile('play.tesana.ai')).toBe('flight')
    expect(suggestProfile('krunker.io')).toBe('shooter')
    expect(suggestProfile('example.org')).toBeNull()
    expect(suggestProfile('nottesana.com')).toBeNull()
    expect(suggestProfile('')).toBeNull()
    expect(suggestForFrames([{ frameId: 3, host: 'play.tesana.ai' }, { frameId: 0, host: 'example.org' }])).toBe('flight')
    expect(suggestForFrames([{ frameId: 0, host: 'example.org' }])).toBeNull()
    expect(suggestProfile('x.test', [{ host: 'x.test', profile: 'driving' }])).toBe('driving')
    expect(SITE_PROFILES.every((s) => /^[a-z0-9.-]+$/.test(s.host))).toBe(true)
  })

  it('elects the pointer frame: a pointer-locked frame first, else the largest canvas, else the top frame', () => {
    const f = (frameId: number, over: Partial<FrameInfo> = {}): FrameInfo => ({ frameId, focus: false, focusAt: 0, area: 0, ...over })
    expect(electFrame([f(0), f(2, { area: 500_000 }), f(3, { lock: true })], 'pointer')?.frameId).toBe(3)
    expect(electFrame([f(0), f(2, { area: 500_000 })], 'pointer')?.frameId).toBe(2)
    expect(electFrame([f(0), f(2)], 'pointer')?.frameId).toBe(0)
  })

  it('encodes the pointer with the A / B bits, strips them from the pad, and finishes relative aim on the right stick', () => {
    const p = emptyPointer()
    p.yaw = -8.123
    p.pitch = 2.5
    p.gen = 7
    p.flags = PointerFlag.valid | PointerFlag.edgeTurn
    expect(pointerTuple(p, 0b1011)).toEqual([-8.12, 2.5, 7, 5, 3])
    expect(pointerTuple(null, 1)).toBeNull()
    expect(withoutClickButtons([0b1011, 0, 0, 0, 0, 0, 0])).toEqual([0b1000, 0, 0, 0, 0, 0, 0])
    expect(withoutClickButtons(null)).toBeNull()
    const mixed = withRelativeAim([0, 0, 0, 0, 0, 0, 0], [36, 0])! // turning right at 36°/s
    expect(mixed[3]).toBeCloseTo(0.2 + 0.8 * 0.2, 4)
    expect(mixed[4]).toBe(0)
    expect(withRelativeAim([0, 0, 0, 0, 0, 0, 0], [0, 0])![3]).toBe(0)
  })

  it('carries the pointer in frames and validates it', () => {
    const t = pointerTuple(emptyPointer(), 1)!
    const f = buildFrame('gamepad', 16, null, null, null, t)
    expect(f.pt).toEqual(t)
    expect(parseInputFrame(JSON.parse(JSON.stringify(f)))).toEqual(f)
    expect(buildFrame('gamepad', 16, null, null, null, null).pt).toBeUndefined()
    expect(parseInputFrame({ t: 'in', m: 0, dt: 16, p: null, d: null, tl: null, pt: [0, 0, 0, 0, 4] })).toBeNull()
    expect(parseInputFrame({ t: 'in', m: 0, dt: 16, p: null, d: null, tl: null, pt: [999, 0, 0, 0, 0] })).toBeNull()
    expect(parseInputFrame({ t: 'in', m: 0, dt: 16, p: null, d: null, tl: null, pt: [0, 0, 1.5, 0, 0] })).toBeNull()
    expect(isActive(null, null, null, t)).toBe(true)
    expect(isActive(null, null, null, null)).toBe(false)
    expect(parseFromPage({ t: 'rep', focus: true, area: 1, lock: true })).toEqual({ t: 'rep', focus: true, area: 1, lock: true })
    expect(parseFromPage({ t: 'rep', focus: true, area: 1 })).toEqual({ t: 'rep', focus: true, area: 1, lock: false })
  })
})

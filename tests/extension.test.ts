import { describe, expect, it } from 'vitest'
import { MIN_VIEW_AREA } from '../extension/src/shared/constants'
import { DEFAULT_KEYS, DESKTOP_KEYS, KEYS, KeyMapper, keyInit, pcKeys, pressCharCode, type KeysInput } from '../extension/src/shared/keys'
import { hysteresis, stickCurve, type PadInput } from '../extension/src/shared/math'
import {
  allowedFrom, envelope, linkConfig, parseBgRequest, parseBridgeRequest, parseConfig, parseFacts, parseFromPage, parseInputFrame, parseLink,
  parseOffscreenRequest, parseToPage, readDown, readUp, sanitizeRumble, senderKind,
} from '../extension/src/shared/messages'
import { buildFrame, deltaTuple, electFrame, isActive, padTuple, recipients, tiltTuple, type FrameInfo } from '../extension/src/shared/route'
import { DEFAULT_VIEWER, DragSynth, viewerMotion, type Rect, type ViewerMotion } from '../extension/src/shared/viewer'

const pad = (over: Partial<{ buttons: number; axes: [number, number, number, number]; triggers: [number, number] }> = {}): PadInput => ({
  buttons: over.buttons ?? 0, axes: over.axes ?? [0, 0, 0, 0], triggers: over.triggers ?? [0, 0],
})
const input = (over: Partial<KeysInput> = {}): KeysInput => ({ pad: null, tilt: null, aim: [0, 0], pad1: [0, 0], dtMs: 16, ...over })
const bit = (...i: number[]) => i.reduce((m, b) => m | (1 << b), 0)
const edges = (out: { keys: { key: string; down: boolean }[] }) => out.keys.map((k) => `${k.key}${k.down ? '+' : '-'}`)

describe('keys: left stick to WASD with hysteresis', () => {
  it('hysteresis presses at the press threshold and releases below the release threshold', () => {
    expect(hysteresis(false, 0.39, 0.4, 0.3)).toBe(false)
    expect(hysteresis(false, 0.4, 0.4, 0.3)).toBe(true)
    expect(hysteresis(true, 0.31, 0.4, 0.3)).toBe(true)
    expect(hysteresis(true, 0.29, 0.4, 0.3)).toBe(false)
  })

  it('W goes down at 0.4, holds through the band, lets go below 0.3, and does not chatter back', () => {
    const m = new KeyMapper()
    expect(edges(m.update(input({ pad: pad({ axes: [0, -0.39, 0, 0] }) })))).toEqual([])
    expect(edges(m.update(input({ pad: pad({ axes: [0, -0.4, 0, 0] }) })))).toEqual(['KeyW+'])
    expect(edges(m.update(input({ pad: pad({ axes: [0, -0.33, 0, 0] }) })))).toEqual([])
    expect(edges(m.update(input({ pad: pad({ axes: [0, -0.25, 0, 0] }) })))).toEqual(['KeyW-'])
    expect(edges(m.update(input({ pad: pad({ axes: [0, -0.35, 0, 0] }) })))).toEqual([])
  })

  it('diagonals hold two keys, and a flick releases before it presses', () => {
    const m = new KeyMapper()
    expect(edges(m.update(input({ pad: pad({ axes: [0.7, 0.7, 0, 0] }) })))).toEqual(['KeyS+', 'KeyD+'])
    expect(edges(m.update(input({ pad: pad({ axes: [-0.9, 0, 0, 0] }) })))).toEqual(['KeyS-', 'KeyD-', 'KeyA+'])
  })

  it('uses the phone tilt stick as the left stick only when there is no pad', () => {
    const m = new KeyMapper()
    expect(edges(m.update(input({ tilt: [0.6, 0] })))).toEqual(['KeyD+'])
    expect(edges(m.update(input({ pad: pad(), tilt: [0.6, 0] })))).toEqual(['KeyD-'])
  })
})

describe('keys: buttons, key identity and mouse', () => {
  it('maps the standard buttons and D-pad to the configured keys', () => {
    const m = new KeyMapper()
    const out = m.update(input({ pad: pad({ buttons: bit(0, 1, 2, 3, 9, 12, 13, 14, 15) }) }))
    expect(edges(out).sort()).toEqual(['ArrowDown+', 'ArrowLeft+', 'ArrowRight+', 'ArrowUp+', 'Enter+', 'Escape+', 'KeyE+', 'KeyQ+', 'Space+'])
    expect(edges(m.update(input({ pad: pad() }))).length).toBe(9)
  })

  it('carries correct key, code and legacy keyCode values', () => {
    const expected: Record<string, [string, number]> = {
      KeyW: ['w', 87], KeyA: ['a', 65], KeyS: ['s', 83], KeyD: ['d', 68], KeyE: ['e', 69], KeyQ: ['q', 81],
      Space: [' ', 32], Escape: ['Escape', 27], Enter: ['Enter', 13], ShiftLeft: ['Shift', 16], ControlLeft: ['Control', 17],
      ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    }
    for (const [code, [key, keyCode]] of Object.entries(expected)) {
      const def = KEYS[code as keyof typeof KEYS]
      expect(def).toMatchObject({ code, key, keyCode })
      expect(keyInit(code as keyof typeof KEYS, { shift: false, ctrl: false, alt: false })).toMatchObject({ key, code, keyCode, which: keyCode })
    }
    expect(KEYS.ShiftLeft.location).toBe(1)
    expect(DEFAULT_KEYS.buttons).toMatchObject({ A: 'Space', B: 'Escape', X: 'KeyE', Y: 'KeyQ', Menu: 'Enter', LB: 'ShiftLeft', RB: 'ControlLeft' })
  })

  it('presses modifiers first and reports them on later keys (LB + X = Shift+E)', () => {
    const m = new KeyMapper()
    const out = m.update(input({ pad: pad({ buttons: bit(4, 2) }) }))
    expect(edges(out)).toEqual(['ShiftLeft+', 'KeyE+'])
    expect(out.keys[0].mods.shift).toBe(true)
    const e = keyInit('KeyE', out.keys[1].mods)
    expect(e).toMatchObject({ key: 'E', code: 'KeyE', keyCode: 69, shiftKey: true, ctrlKey: false })
    // releases non-modifiers before modifiers; Shift's own keyup reports shift released
    const up = m.update(input({ pad: pad() }))
    expect(edges(up)).toEqual(['KeyE-', 'ShiftLeft-'])
    expect(up.keys[1].mods.shift).toBe(false)
    expect(keyInit('ControlLeft', { shift: false, ctrl: true, alt: false })).toMatchObject({ key: 'Control', keyCode: 17, ctrlKey: true })
  })

  it('gives keypress char codes only for character keys and Enter', () => {
    expect(pressCharCode(' ')).toBe(32)
    expect(pressCharCode('e')).toBe(101)
    expect(pressCharCode('Enter')).toBe(13)
    expect(pressCharCode('Escape')).toBe(0)
    expect(pressCharCode('ArrowUp')).toBe(0)
  })

  it('maps RT to the left and LT to the right mouse button, with hysteresis', () => {
    const m = new KeyMapper()
    expect(m.update(input({ pad: pad({ triggers: [0, 0.6] }) })).buttons).toEqual([{ button: 0, down: true }])
    expect(m.update(input({ pad: pad({ triggers: [0, 0.4] }) })).buttons).toEqual([])
    expect(m.update(input({ pad: pad({ triggers: [0.9, 0.3] }) })).buttons).toEqual([{ button: 0, down: false }, { button: 2, down: true }])
    expect(m.update(input({ pad: pad({ buttons: bit(7), triggers: [0.9, 0] }) })).buttons).toEqual([{ button: 0, down: true }])
  })

  it('moves the mouse with the right stick (rate), phone aim and trackpad (deltas), in whole pixels', () => {
    const m = new KeyMapper()
    expect(m.update(input({ pad: pad({ axes: [0, 0, 1, 0] }), dtMs: 50 })).move).toEqual([60, 0])
    expect(m.update(input({ pad: pad({ axes: [0, 0, 0.1, -0.1] }), dtMs: 50 })).move).toEqual([0, 0])
    expect(m.update(input({ aim: [1, 1] })).move).toEqual([-14, -14])
    const slow = [1, 2, 3].map(() => m.update(input({ pad1: [0.25, 0] })).move)
    expect(slow).toEqual([[0, 0], [0, 0], [1, 0]])
  })

  it('releaseAll lets go of every key and button', () => {
    const m = new KeyMapper()
    m.update(input({ pad: pad({ buttons: bit(0, 5), axes: [0, -1, 0, 0], triggers: [0, 1] }) }))
    const out = m.releaseAll()
    expect(edges(out).sort()).toEqual(['ControlLeft-', 'KeyW-', 'Space-'])
    expect(out.keys.at(-1)?.key).toBe('ControlLeft')
    expect(out.buttons).toEqual([{ button: 0, down: false }])
    expect(m.releaseAll().keys).toEqual([])
  })
})

describe('3D viewer: motion math', () => {
  const none = { aim: [0, 0] as const, pad1: [0, 0] as const, pad2: [0, 0] as const, zoom: 0 }

  it('maps trackpad and gyro aim to rotate-drag, two-finger to pan, pinch to wheel', () => {
    const m = viewerMotion({ pad: null, tilt: null, dtMs: 16, deltas: { ...none, pad1: [10, -5], pad2: [4, 3], zoom: 1 } })
    expect(m.drag).toEqual([16, -8])
    expect(m.pan[0]).toBeCloseTo(5.6)
    expect(m.pan[1]).toBeCloseTo(4.2)
    expect(m.wheel).toBe(-480) // pinch out = zoom in = wheel up
    // aim is + left / + up; the drag follows the phone (left and up are negative screen deltas)
    expect(viewerMotion({ pad: null, tilt: null, dtMs: 16, deltas: { ...none, aim: [2, 1] } }).drag).toEqual([-24, -12])
  })

  it('turns sticks, triggers and tilt into rates over dt', () => {
    const at = (p: PadInput) => viewerMotion({ pad: p, deltas: null, tilt: null, dtMs: 100 })
    expect(at(pad({ axes: [0, 0, 1, 0] })).drag).toEqual([90, 0])
    expect(at(pad({ axes: [0, 0, 0.1, 0] })).drag).toEqual([0, 0]) // deadzone
    expect(at(pad({ axes: [0, 1, 0, 0] })).pan).toEqual([0, 70])
    expect(at(pad({ triggers: [0, 1] })).wheel).toBeCloseTo(-140)
    expect(at(pad({ triggers: [1, 0] })).wheel).toBeCloseTo(140)
    expect(at(pad({ triggers: [1, 1] })).wheel).toBeCloseTo(0)
    const t = viewerMotion({ pad: null, deltas: null, tilt: [0.5, -0.25], dtMs: 100 })
    expect(t.drag[0]).toBeCloseTo(((0.5 - 0.04) / 0.96) * 70)
    expect(t.drag[1]).toBeCloseTo((-(0.25 - 0.04) / 0.96) * 70)
    expect(stickCurve(0.15, 0.15)).toBe(0)
    expect(stickCurve(-1, 0.15, 2)).toBe(-1)
  })
})

describe('3D viewer: drag and wheel synthesis', () => {
  const area: Rect = { left: 0, top: 0, width: 400, height: 300 }
  const mo = (over: Partial<ViewerMotion>): ViewerMotion => ({ drag: [0, 0], pan: [0, 0], wheel: 0, ...over })

  it('presses at the target centre, moves while input continues, releases after 120 ms idle', () => {
    const s = new DragSynth()
    expect(s.step(0, mo({ drag: [10, 5] }), area)).toEqual([
      { type: 'down', button: 0, buttons: 1, x: 200, y: 150, shift: false },
      { type: 'move', buttons: 1, x: 210, y: 155, dx: 10, dy: 5, shift: false },
    ])
    expect(s.step(16, mo({ drag: [3, 0] }), area)).toEqual([{ type: 'move', buttons: 1, x: 213, y: 155, dx: 3, dy: 0, shift: false }])
    expect(s.tick(16 + 119)).toEqual([])
    expect(s.tick(16 + DEFAULT_VIEWER.releaseMs)).toEqual([{ type: 'up', button: 0, x: 213, y: 155, shift: false }])
    expect(s.dragging).toBe(false)
  })

  it('pans with the right button and switches gestures cleanly', () => {
    const s = new DragSynth()
    const pan = s.step(0, mo({ pan: [5, 0] }), area)
    expect(pan[0]).toEqual({ type: 'down', button: 2, buttons: 2, x: 200, y: 150, shift: false })
    expect(pan[1]).toMatchObject({ type: 'move', buttons: 2, dx: 5 })
    expect(s.step(10, mo({ drag: [1, 0] }), area).map((e) => `${e.type}${'button' in e ? e.button : ''}`)).toEqual(['up2', 'down0', 'move'])
    const shifty = new DragSynth({ ...DEFAULT_VIEWER, pan: 'shift' })
    expect(shifty.step(0, mo({ pan: [5, 0] }), area)[0]).toEqual({ type: 'down', button: 0, buttons: 1, x: 200, y: 150, shift: true })
  })

  it('accumulates sub-pixel motion into whole-pixel moves', () => {
    const s = new DragSynth()
    const out = [0, 16, 32].map((t) => s.step(t, mo({ drag: [0.4, 0] }), area))
    expect(out[0].map((e) => e.type)).toEqual(['down'])
    expect(out[1]).toEqual([])
    expect(out[2]).toEqual([{ type: 'move', buttons: 1, x: 201, y: 150, dx: 1, dy: 0, shift: false }])
  })

  it('lifts and re-grabs at the centre when the cursor would leave the target', () => {
    const s = new DragSynth()
    const small: Rect = { left: 0, top: 0, width: 40, height: 40 }
    s.step(0, mo({ drag: [10, 0] }), small)
    expect(s.step(16, mo({ drag: [10, 0] }), small)).toEqual([
      { type: 'up', button: 0, x: 30, y: 20, shift: false },
      { type: 'down', button: 0, buttons: 1, x: 20, y: 20, shift: false },
      { type: 'move', buttons: 1, x: 30, y: 20, dx: 10, dy: 0, shift: false },
    ])
  })

  it('batches small wheel amounts and flushes the rest when zooming stops', () => {
    const s = new DragSynth()
    expect(s.step(0, mo({ wheel: 5 }), area)).toEqual([])
    expect(s.step(10, mo({ wheel: 5 }), area)).toEqual([{ type: 'wheel', x: 200, y: 150, deltaY: 10 }])
    expect(s.step(20, mo({ wheel: -3 }), area)).toEqual([])
    expect(s.tick(139)).toEqual([])
    expect(s.tick(140)).toEqual([{ type: 'wheel', x: 200, y: 150, deltaY: -3 }])
    expect(s.busy).toBe(false)
  })

  it('reset releases a held button and drops a pending wheel', () => {
    const s = new DragSynth()
    s.step(0, mo({ drag: [2, 0], wheel: 4 }), area)
    expect(s.reset()).toEqual([{ type: 'up', button: 0, x: 202, y: 150, shift: false }])
    expect(s.busy).toBe(false)
  })
})

describe('messages: validation', () => {
  const SID = 'a'.repeat(32)
  const frame = { t: 'in', m: 1, dt: 16.7, p: [1, 0.5, -0.5, 0, 0, 0, 1], d: [0, 0, 1, 2, 0, 0, 0.1], tl: null }

  it('accepts well-formed input frames and strips unknown fields', () => {
    expect(parseInputFrame({ ...frame, extra: 'x' })).toEqual(frame)
    expect(parseToPage({ t: 'rel', junk: 1 })).toEqual({ t: 'rel' })
    expect(parseToPage({ t: 'off' })).toEqual({ t: 'off' })
  })

  it('rejects malformed frames', () => {
    const bad = [
      { ...frame, m: 3 }, { ...frame, dt: -1 }, { ...frame, dt: Number.NaN },
      { ...frame, p: [1, 0, 0, 0, 0, 0] }, { ...frame, p: [1, 1.5, 0, 0, 0, 0, 0] }, { ...frame, p: [2 ** 17, 0, 0, 0, 0, 0, 0] },
      { ...frame, p: [0.5, 0, 0, 0, 0, 0, 0] }, { ...frame, p: [0, 0, 0, 0, 0, 0, -0.1] },
      { ...frame, d: [0, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 0] }, { ...frame, tl: [2, 0] },
      { t: 'in', m: 0, dt: 16 }, null, 'in', [frame], { ...frame, t: 'out' },
    ]
    for (const b of bad) expect(parseInputFrame(b)).toBeNull()
    expect(parseToPage({ t: 'boom' })).toBeNull()
  })

  it('clamps rumble requests and rejects non-numbers', () => {
    expect(sanitizeRumble(2, -1, 99999)).toEqual({ t: 'rumble', s: 1, w: 0, ms: 5000 })
    expect(sanitizeRumble(0.5, 0.25, 120.4)).toEqual({ t: 'rumble', s: 0.5, w: 0.25, ms: 120 })
    expect(sanitizeRumble('1', 0, 10)).toBeNull()
    expect(sanitizeRumble(Number.NaN, 0, 10)).toBeNull()
    expect(parseFromPage({ t: 'rumble', s: 0.5, w: 0.2, ms: 100 })).toEqual({ t: 'rumble', s: 0.5, w: 0.2, ms: 100 })
    expect(parseFromPage({ t: 'rep', focus: true, area: 1234.4 })).toEqual({ t: 'rep', focus: true, area: 1234, lock: false })
    expect(parseFromPage({ t: 'rep', focus: 'yes', area: 1 })).toBeNull()
    expect(parseFromPage({ t: 'rep', focus: true, area: -5 })).toBeNull()
  })

  it('checks the bridge <-> page envelope: channel, direction and session id', () => {
    expect(readDown(envelope(SID, 'down', { t: 'hello' }))).toEqual({ sid: SID, m: { t: 'hello' } })
    expect(readDown(envelope(SID, 'down', frame))?.m).toEqual(frame)
    expect(readDown({ ...envelope(SID, 'down', { t: 'hello' }), ch: 'other' })).toBeNull()
    expect(readDown(envelope(SID, 'up', { t: 'hello' }))).toBeNull()
    expect(readDown(envelope('abc', 'down', { t: 'hello' }))).toBeNull()
    expect(readDown(envelope(SID, 'down', { ...frame, m: 9 }))).toBeNull()
    expect(readUp(envelope('', 'up', { t: 'loaded', v: 1 }))).toEqual({ sid: '', m: { t: 'loaded', v: 1 } })
    expect(readUp(envelope(SID, 'up', { t: 'ready', v: 1.5 }))).toBeNull()
    expect(readUp(envelope(SID, 'up', { t: 'rumble', s: 3, w: 0, ms: 50 }))?.m).toEqual({ t: 'rumble', s: 1, w: 0, ms: 50 })
    expect(readUp(envelope('x'.repeat(65), 'up', { t: 'loaded', v: 1 }))).toBeNull()
    expect(readUp(envelope(SID, 'down', { t: 'loaded', v: 1 }))).toBeNull()
  })

  it('validates service worker requests and the link state', () => {
    expect(parseBgRequest({ to: 'bg', type: 'enable', tabId: 5, on: true })).toEqual({ to: 'bg', type: 'enable', tabId: 5, on: true })
    expect(parseBgRequest({ to: 'bg', type: 'enable', tabId: -1, on: true })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'enable', tabId: '5', on: true })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'mode', mode: 'keys' })).toEqual({ to: 'bg', type: 'mode', mode: 'keys' })
    expect(parseBgRequest({ to: 'bg', type: 'mode', mode: 'mouse' })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'hello', extra: true })).toEqual({ to: 'bg', type: 'hello' })
    expect(parseBgRequest({ to: 'bg', type: 'nope' })).toBeNull()
    // The top frame's report of frames from other sites (the popup offers "All sites" for them).
    expect(parseBgRequest({ to: 'bg', type: 'frames', count: 1, host: 'html-classic.itch.zone', big: true }))
      .toEqual({ to: 'bg', type: 'frames', count: 1, host: 'html-classic.itch.zone', big: true })
    expect(parseBgRequest({ to: 'bg', type: 'frames', count: 0, host: '', big: false })).not.toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'frames', count: -1, host: '', big: false })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'frames', count: 1, host: '<img src=x>', big: true })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'frames', count: 1, host: 'a.b', big: 'yes' })).toBeNull()
    expect(parseBgRequest({ to: 'offscreen', type: 'hello' })).toBeNull()
    const link = { status: 'ready', url: 'https://obpal.blackboxes.net/p/#1.abc.def', device: null, lan: '', lanFor: null, pairs: [] }
    expect(parseBgRequest({ to: 'bg', type: 'link', link })).toEqual({ to: 'bg', type: 'link', link })
    expect(parseLink({ ...link, url: 'https://evil.example/p/#1.abc.def' })).toBeNull()
    expect(parseLink({ ...link, status: 'paired' })).toBeNull()
    expect(parseLink({ ...link, device: 'x'.repeat(61) })).toBeNull()
    expect(parseLink({ status: 'starting', url: '', device: 'Pixel' })).toEqual({ status: 'starting', url: '', device: 'Pixel', lan: '', lanFor: null, pairs: [] })
    // The direct LAN code and remembered phones travel with the link state.
    const id = 'A'.repeat(22)
    const lan = { ...link, status: 'offline', lan: `https://obpal.blackboxes.net/p/#2.${id}.${id}.abcd.${'x'.repeat(22)}.mAAAAAAAAAAAAAAAAAAAAAA~5000`, lanFor: id, pairs: [{ id, name: 'Pixel 7', at: 1 }] }
    expect(parseLink(lan)).toEqual(lan)
    expect(parseLink({ ...lan, lan: 'https://obpal.blackboxes.net/p/#1.abc.def' })).toBeNull()
    expect(parseLink({ ...lan, lanFor: 'short' })).toBeNull()
    expect(parseLink({ ...lan, pairs: [{ id: 'nope', name: 'x', at: 1 }] })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'forget', id })).toEqual({ to: 'bg', type: 'forget', id })
    expect(parseBgRequest({ to: 'bg', type: 'lan', id: 'x' })).toBeNull()
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'forget', id })).toEqual({ to: 'offscreen', type: 'forget', id })
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'diag' })).toEqual({ to: 'offscreen', type: 'diag' })
    expect(parseBgRequest({ to: 'bg', type: 'diag' })).toEqual({ to: 'bg', type: 'diag' })
    expect(allowedFrom('forget', 'page')).toBe(false)
    expect(allowedFrom('forget', 'extension')).toBe(true)
    expect(allowedFrom('diag', 'page')).toBe(false)
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'config', tabId: null, mode: 'viewer' })).toEqual({ to: 'offscreen', type: 'config', tabId: null, mode: 'viewer', desktop: false })
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'config', tabId: 1.5, mode: 'viewer' })).toBeNull()
    expect(parseBridgeRequest({ to: 'bridge', type: 'deactivate' })).toEqual({ to: 'bridge', type: 'deactivate' })
    expect(parseBridgeRequest({ to: 'bridge', type: 'exec' })).toBeNull()
  })

  it('the popup asks the link for its facts (its badge), and reads the answer strictly', () => {
    const facts = { verified: 'qr', path: 'relay', relay: 'tls', rttMs: 41, dtls: 'DTLS 1.3', cipher: 'TLS_AES_128_GCM_SHA256' }
    expect(parseBgRequest({ to: 'bg', type: 'facts' })).toEqual({ to: 'bg', type: 'facts' })
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'facts' })).toEqual({ to: 'offscreen', type: 'facts' })
    expect(parseFacts(facts)).toEqual(facts)
    expect(parseFacts({ verified: 'lan', path: 'lan' })).toEqual({ verified: 'lan', path: 'lan' })
    expect(parseFacts({ ...facts, verified: 'trust me' })).toBeNull()
    expect(parseFacts({ ...facts, path: 'wormhole' })).toBeNull()
    expect(parseFacts({ ...facts, cipher: '<img src=x>' })).toBeNull()
    expect(parseFacts({ ...facts, rttMs: -1 })).toBeNull()
    expect(parseFacts(null)).toBeNull()
    expect(allowedFrom('facts', 'extension')).toBe(true)
    expect(allowedFrom('facts', 'page')).toBe(false)
  })

  it('only lets each kind of sender make its own requests', () => {
    const self = { id: 'ext', origin: 'chrome-extension://ext' }
    expect(senderKind({ id: 'ext', url: 'chrome-extension://ext/popup.html' }, self)).toBe('extension')
    expect(senderKind({ id: 'ext', url: 'chrome-extension://ext/offscreen.html#x' }, self)).toBe('offscreen')
    expect(senderKind({ id: 'ext', url: 'https://game.example/', tabId: 3 }, self)).toBe('page')
    expect(senderKind({ id: 'other', url: 'chrome-extension://ext/popup.html' }, self)).toBe('unknown')
    expect(senderKind({ id: 'ext' }, self)).toBe('unknown')
    expect(allowedFrom('enable', 'page')).toBe(false)
    expect(allowedFrom('enable', 'extension')).toBe(true)
    expect(allowedFrom('hello', 'page')).toBe(true)
    expect(allowedFrom('link', 'extension')).toBe(false)
    expect(allowedFrom('mode', 'offscreen')).toBe(true)
    expect(allowedFrom('frames', 'page')).toBe(true)
    expect(allowedFrom('frames', 'extension')).toBe(false)
  })
})

describe('routing and wire encoding', () => {
  const f = (frameId: number, over: Partial<FrameInfo> = {}): FrameInfo => ({ frameId, focus: false, focusAt: 0, area: 0, ...over })

  it('sends keys to the newest focused frame, else the top frame', () => {
    const frames = [f(0), f(3, { focus: true, focusAt: 5 }), f(4, { focus: true, focusAt: 9 })]
    expect(electFrame(frames, 'keys')?.frameId).toBe(4)
    expect(electFrame([f(2), f(0)], 'keys')?.frameId).toBe(0)
    expect(electFrame([], 'keys')).toBeNull()
  })

  it('sends 3D drags to the frame with the largest canvas, else the top frame; the pad to every frame', () => {
    const frames = [f(0, { area: 1000 }), f(3, { area: 50_000 }), f(4, { area: 90_000 })]
    expect(electFrame(frames, 'viewer')?.frameId).toBe(4)
    expect(electFrame([f(0), f(3, { area: MIN_VIEW_AREA - 1 })], 'viewer')?.frameId).toBe(0)
    expect(recipients(frames, 'gamepad').map((x) => x.frameId)).toEqual([0, 3, 4])
    expect(recipients(frames, 'viewer').map((x) => x.frameId)).toEqual([4])
    expect(recipients(frames, 'keys').map((x) => x.frameId)).toEqual([0])
  })

  it('builds compact frames that pass validation', () => {
    const p = padTuple({ buttons: bit(0, 7), axes: [0.123456, -1.2, 0, 0], triggers: [0, 0.7777] })
    expect(p).toEqual([bit(0, 7), 0.1235, -1, 0, 0, 0, 0.778])
    const d = deltaTuple({ aim: [0, 0], pad1: [1.23456, 0], pad2: [0, 0], zoom: 0 })
    expect(d).toEqual([0, 0, 1.235, 0, 0, 0, 0])
    expect(deltaTuple({ aim: [0.0001, 0], pad1: [0, 0], pad2: [0, 0], zoom: 0 })).toBeNull()
    const tl = tiltTuple([0.5, 0])
    const frame = buildFrame('viewer', 16.667, p, d, tl)
    expect(frame).toMatchObject({ t: 'in', m: 1, dt: 16.7 })
    expect(parseInputFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame)
    expect(tiltTuple([0, 0])).toBeNull()
    expect(isActive(null, null, null)).toBe(false)
    expect(isActive([0, 0.01, 0, 0, 0, 0, 0], null, null)).toBe(false)
    expect(isActive([0, 0.5, 0, 0, 0, 0, 0], null, null)).toBe(true)
    expect(isActive(null, d, null)).toBe(true)
  })
})

describe('keys: the whole PC (a desktop controller that types no letters)', () => {
  it('the left stick and the tilt move the pointer and never press a key', () => {
    const m = new KeyMapper(DESKTOP_KEYS)
    const out = m.update(input({ pad: pad({ axes: [1, -1, 0, 0] }), dtMs: 50 }))
    expect(out.keys).toEqual([])
    expect(out.move[0]).toBeGreaterThan(40)
    expect(out.move[1]).toBeLessThan(-40)
    expect(m.update(input({ tilt: [1, 1] })).keys).toEqual([])
  })
  it('the right stick scrolls: pushed down, down; to the side, sideways', () => {
    const m = new KeyMapper(DESKTOP_KEYS)
    let w = [0, 0]
    for (let i = 0; i < 10; i++) { const o = m.update(input({ pad: pad({ axes: [0, 0, 0.6, 1] }), dtMs: 16 })); w = [w[0] + o.wheel[0], w[1] + o.wheel[1]]; expect(o.move).toEqual([0, 0]) }
    expect(w[1]).toBeGreaterThan(200)
    expect(w[0]).toBeGreaterThan(0)
  })
  it('A clicks (held, it drags), X right-clicks, the left stick press middle-clicks; B, Y and the D-pad are keys', () => {
    const m = new KeyMapper(DESKTOP_KEYS)
    expect(m.update(input({ pad: pad({ buttons: bit(0) }) })).buttons).toEqual([{ button: 0, down: true }])
    expect(m.update(input({ pad: pad() })).buttons).toEqual([{ button: 0, down: false }])
    expect(m.update(input({ pad: pad({ buttons: bit(2) }) })).buttons).toEqual([{ button: 2, down: true }])
    expect(m.update(input({ pad: pad({ buttons: bit(10) }) })).buttons).toEqual([{ button: 2, down: false }, { button: 1, down: true }])
    expect(edges(m.update(input({ pad: pad({ buttons: bit(1, 3, 12) }) })))).toEqual(['Escape+', 'Enter+', 'ArrowUp+'])
  })
  it('LB and RB are back and forward, Menu the Start menu: chords, the modifier pressed first and let go last', () => {
    const m = new KeyMapper(DESKTOP_KEYS)
    expect(edges(m.update(input({ pad: pad({ buttons: bit(4) }) })))).toEqual(['AltLeft+', 'ArrowLeft+'])
    expect(edges(m.update(input({ pad: pad() })))).toEqual(['ArrowLeft-', 'AltLeft-'])
    expect(edges(m.update(input({ pad: pad({ buttons: bit(9) }) })))).toEqual(['ControlLeft+', 'Escape+'])
  })

  /** The worker's answer to 'offscreen-ready', as the new link document receives it (a structured clone). */
  const answer = (tabId: number | null, mode: 'gamepad' | 'viewer' | 'keys' | 'pc', wholePc: boolean) =>
    parseConfig(JSON.parse(JSON.stringify(linkConfig(tabId, mode, wholePc))))

  it('a link document started again while the whole PC is controlled gets the desktop controller, not the game keys', () => {
    const cfg = answer(7, 'pc', true)
    expect(cfg).toEqual({ tabId: 7, mode: 'pc', desktop: true })
    expect(pcKeys(cfg!.desktop)).toBe(DESKTOP_KEYS)
    // The symptom it had: the left stick held up typed W into whatever had the focus. Now it moves the pointer.
    const out = new KeyMapper(pcKeys(cfg!.desktop)).update(input({ pad: pad({ axes: [0, -1, 0, 0] }), dtMs: 50 }))
    expect(out.keys).toEqual([])
    expect(out.move[1]).toBeLessThan(0)
  })

  it('one program at a time, or whole PC with another target: the game keys, as before', () => {
    expect(pcKeys(answer(7, 'pc', false)!.desktop)).toBe(DEFAULT_KEYS)
    expect(answer(7, 'keys', true)).toEqual({ tabId: 7, mode: 'keys', desktop: false })
    expect(pcKeys(answer(null, 'gamepad', true)!.desktop)).toBe(DEFAULT_KEYS)
    // An answer without it (a worker from before 1.5), or with something else in it, never turns the whole PC on.
    expect(parseConfig({ tabId: 7, mode: 'pc' })).toEqual({ tabId: 7, mode: 'pc', desktop: false })
    expect(parseConfig({ tabId: 7, mode: 'pc', desktop: 'yes' })?.desktop).toBe(false)
  })

  it('every config the worker pushes carries the whole PC the same way', () => {
    const push = { to: 'offscreen', type: 'config', ...linkConfig(3, 'pc', true) }
    expect(parseOffscreenRequest(JSON.parse(JSON.stringify(push)))).toEqual({ to: 'offscreen', type: 'config', tabId: 3, mode: 'pc', desktop: true })
    expect(parseOffscreenRequest({ ...push, ...linkConfig(3, 'pc', false) })).toMatchObject({ desktop: false })
  })
})

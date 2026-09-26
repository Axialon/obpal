import { describe, expect, it } from 'vitest'
import { KeyMapper, type KeysInput } from '../extension/src/shared/keys'
import type { PadInput } from '../extension/src/shared/math'
import { allowedFrom, parseBgRequest } from '../extension/src/shared/messages'
import {
  buildNativeFrame, EMPTY_PC, HeldState, isIdleFrame, parseHelperMessage, parseNativeFrame, parsePcRequest, parsePcState,
  pcView, scopeLabel, toHelperRequest, type PcProgram, type PcState,
} from '../extension/src/shared/native'
import { recipients, type FrameInfo } from '../extension/src/shared/route'

const pad = (over: Partial<PadInput> = {}): PadInput => ({ buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0], ...over })
const input = (over: Partial<KeysInput> = {}): KeysInput => ({ pad: null, tilt: null, aim: [0, 0], pad1: [0, 0], dtMs: 16, ...over })
const bit = (...i: number[]) => i.reduce((m, b) => m | (1 << b), 0)

describe('PC target: frames carry the whole desired state from the Keys mapping', () => {
  it('holds what the mapper pressed and drops what it released; idle frames are empty', () => {
    const m = new KeyMapper()
    const held = new HeldState()
    held.apply(m.update(input({ pad: pad({ buttons: bit(0, 4), axes: [0, -1, 0, 0], triggers: [0, 1] }) })))
    const f = buildNativeFrame(held, [3.6, -2.2], [0, 120])
    expect(f).toEqual({ t: 'f', k: ['ShiftLeft', 'KeyW', 'Space'], b: [0], m: [4, -2], w: [0, 120] })
    expect(isIdleFrame(f)).toBe(false)
    held.apply(m.update(input({ pad: pad({ buttons: bit(0) }) })))
    expect(buildNativeFrame(held, [0, 0])).toEqual({ t: 'f', k: ['Space'] })
    held.apply(m.releaseAll())
    expect(held.empty).toBe(true)
    expect(isIdleFrame(buildNativeFrame(held, [0.4, 0]))).toBe(true)
    // the same state again is the same frame: nothing depends on edges
    held.apply(m.update(input({ pad: pad({ buttons: bit(0) }) })))
    expect(buildNativeFrame(held, [0, 0])).toEqual({ t: 'f', k: ['Space'] })
  })

  it('clamps motion and round-trips through validation', () => {
    const held = new HeldState()
    const f = buildNativeFrame(held, [99999, -0.4], [5000, -5000])
    expect(f).toEqual({ t: 'f', m: [2000, 0], w: [2400, -2400] })
    expect(parseNativeFrame(JSON.parse(JSON.stringify(f)))).toEqual(f)
    expect(parseNativeFrame({ t: 'f' })).toEqual({ t: 'f' })
    expect(parseNativeFrame({ t: 'f', k: ['KeyW'], b: [2], m: [1, 1], w: [0, 0], extra: 1 })).toEqual({ t: 'f', k: ['KeyW'], b: [2], m: [1, 1], w: [0, 0] })
  })

  it('rejects frames that are not ours', () => {
    for (const bad of [
      { t: 'in' }, { t: 'f', k: 'KeyW' }, { t: 'f', k: ['Key W'] }, { t: 'f', k: [''] }, { t: 'f', k: Array(17).fill('KeyA') },
      { t: 'f', b: [5] }, { t: 'f', b: [0, 0, 0, 0, 0, 0] }, { t: 'f', m: [1] }, { t: 'f', m: [1.5, 0] }, { t: 'f', m: [2001, 0] },
      { t: 'f', w: [0, 2401] }, { t: 'f', m: 'up' }, null, 'f', [],
    ]) expect(parseNativeFrame(bad), JSON.stringify(bad)).toBeNull()
  })

  it('sends no page frames in PC mode', () => {
    const f = (frameId: number, over: Partial<FrameInfo> = {}): FrameInfo => ({ frameId, focus: false, focusAt: 0, area: 0, ...over })
    expect(recipients([f(0), f(1, { focus: true, focusAt: 1 })], 'pc')).toEqual([])
    expect(recipients([f(0)], 'keys').length).toBe(1)
  })
})

describe('PC target: helper messages are validated', () => {
  const program: PcProgram = { name: 'game.exe', path: 'C:\\Games\\game.exe', title: 'Game', pid: 42, elevated: false, browser: false, allowed: null }

  it('accepts hello, config, status, stats and error', () => {
    expect(parseHelperMessage({ t: 'hello', v: 1, version: '0.1.0', os: 'windows', hotkey: 'Ctrl+Alt+Backspace', caps: { keyboard: true, mouse: true, gamepad: false } }))
      .toEqual({ t: 'hello', v: 1, version: '0.1.0', os: 'windows', hotkey: 'Ctrl+Alt+Backspace', caps: { keyboard: true, mouse: true, gamepad: false } })
    expect(parseHelperMessage({ t: 'hello', v: 1, version: '0.1.0', os: 'windows', hotkey: null, caps: { keyboard: true, mouse: true, gamepad: false } })?.t).toBe('hello')
    expect(parseHelperMessage({ t: 'config', paused: false, programs: [{ path: 'C:\\g.exe', name: 'g.exe', keyboard: true, mouse: false, gamepad: false }] }))
      .toEqual({ t: 'config', paused: false, programs: [{ path: 'C:\\g.exe', name: 'g.exe', keyboard: true, mouse: false }] })
    const status = { t: 'status', enabled: true, panic: false, held: false, front: { ...program, allowed: { keyboard: true, mouse: true } }, program }
    expect(parseHelperMessage(status)).toEqual({ ...status, front: { ...program, allowed: { keyboard: true, mouse: true } } })
    expect(parseHelperMessage({ t: 'stats', frames: 10, injected: 4, refused: { notAllowed: 6, 'bad key!': 1 } })).toEqual({ t: 'stats', frames: 10, injected: 4, refused: { notAllowed: 6 } })
    expect(parseHelperMessage({ t: 'error', code: 'bad-frame', msg: 'x' })).toEqual({ t: 'error', code: 'bad-frame', msg: 'x' })
  })

  it('rejects malformed messages and unknown types', () => {
    for (const bad of [
      { t: 'exec' }, { t: 'hello', v: 1 }, { t: 'hello', v: 1, version: 'x'.repeat(33), os: 'windows', hotkey: null, caps: { keyboard: true, mouse: true, gamepad: false } },
      { t: 'config', paused: 'no', programs: [] }, { t: 'config', paused: false, programs: [{ path: 'p', name: 'n', keyboard: 1, mouse: true }] },
      { t: 'status', enabled: true, panic: false, held: false, front: { ...program, pid: -1 }, program: null },
      { t: 'status', enabled: true, panic: false, held: false, front: { ...program, allowed: { keyboard: 'y', mouse: true } }, program: null },
      { t: 'status', enabled: true, panic: false, front: null, program: null },
      { t: 'stats', frames: 'x', injected: 0, refused: {} }, { t: 'error', code: 'x'.repeat(41), msg: '' }, null, 'status',
    ]) expect(parseHelperMessage(bad), JSON.stringify(bad)).toBeNull()
  })

  it('re-validates the mirrored state', () => {
    expect(parsePcState(EMPTY_PC)).toEqual(EMPTY_PC)
    const s: PcState = { link: 'ready', version: '0.1.0', hotkey: null, error: null, config: { paused: false, programs: [] }, status: { enabled: true, panic: false, held: false, front: null, program }, stats: null }
    expect(parsePcState(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(parsePcState({ ...s, link: 'sideways' })).toBeNull()
    expect(parsePcState({ ...s, status: { enabled: true } })).toBeNull()
    expect(parsePcState({ ...s, stats: { frames: 1, injected: 1, refused: {} } })?.stats).toEqual({ frames: 1, injected: 1, refused: {} })
  })
})

describe('PC target: what the popup shows', () => {
  const program: PcProgram = { name: 'notepad.exe', path: 'C:\\Windows\\notepad.exe', title: 'Untitled', pid: 7, elevated: false, browser: false, allowed: null }
  const browser: PcProgram = { name: 'chrome.exe', path: 'C:\\chrome.exe', title: 'ob.Pal', pid: 1, elevated: false, browser: true, allowed: null }
  const ready = (over: Partial<PcState>): PcState => ({ ...EMPTY_PC, link: 'ready', hotkey: 'Ctrl+Alt+Backspace', config: { paused: false, programs: [] }, ...over })
  const status = (front: PcProgram | null, prog: PcProgram | null, over = {}) => ({ enabled: true, panic: false, held: false, front, program: prog, ...over })

  it('walks the states: permission, starting, missing, error, paused, panic', () => {
    expect(pcView({ ...EMPTY_PC, link: 'permission' })).toEqual({ kind: 'permission' })
    expect(pcView({ ...EMPTY_PC, link: 'off' })).toEqual({ kind: 'connecting' })
    expect(pcView({ ...EMPTY_PC, link: 'connecting' })).toEqual({ kind: 'connecting' })
    expect(pcView({ ...EMPTY_PC, link: 'missing' })).toEqual({ kind: 'missing' })
    expect(pcView({ ...EMPTY_PC, link: 'error', error: 'boom' })).toEqual({ kind: 'error', error: 'boom' })
    expect(pcView(ready({ config: { paused: true, programs: [] }, status: status(program, program) }))).toEqual({ kind: 'paused' })
    expect(pcView(ready({ status: status(program, program, { panic: true }) }))).toEqual({ kind: 'panic', hotkey: 'Ctrl+Alt+Backspace' })
  })

  it('offers to allow the program the person will switch back to, even while the browser is in front', () => {
    expect(pcView(ready({ status: status(browser, null) }))).toEqual({ kind: 'idle' })
    expect(pcView(ready({ status: status(browser, program) }))).toEqual({ kind: 'allow', program })
    expect(pcView(ready({ status: status(program, program) }))).toEqual({ kind: 'allow', program })
    const elevated = { ...program, elevated: true }
    expect(pcView(ready({ status: status(browser, elevated) }))).toEqual({ kind: 'elevated', program: elevated })
  })

  it('shows what is controlled and whether it is in front', () => {
    const allowed = { ...program, allowed: { keyboard: true, mouse: false } }
    expect(pcView(ready({ status: status(allowed, allowed) }))).toEqual({ kind: 'active', program: allowed, scope: { keyboard: true, mouse: false }, inFront: true })
    expect(pcView(ready({ status: status(browser, allowed) }))).toEqual({ kind: 'active', program: allowed, scope: { keyboard: true, mouse: false }, inFront: false })
    expect(scopeLabel({ keyboard: true, mouse: true })).toBe('keyboard + mouse')
    expect(scopeLabel({ keyboard: false, mouse: true })).toBe('mouse')
    expect(scopeLabel({ keyboard: false, mouse: false })).toBe('nothing')
  })
})

describe('PC target: requests from extension UI', () => {
  it('parses and forwards them, and only extension pages may send them', () => {
    const allow = { to: 'bg', type: 'pc-allow', path: 'C:\\g.exe', keyboard: true, mouse: false }
    expect(parsePcRequest(allow)).toEqual(allow)
    expect(parseBgRequest(allow)).toEqual(allow)
    expect(toHelperRequest(parsePcRequest(allow)!)).toEqual({ t: 'allow', path: 'C:\\g.exe', keyboard: true, mouse: false })
    expect(toHelperRequest({ to: 'bg', type: 'pc-scope', path: 'p', keyboard: false, mouse: true })).toEqual({ t: 'scope', path: 'p', keyboard: false, mouse: true })
    expect(toHelperRequest({ to: 'bg', type: 'pc-forget', path: 'p' })).toEqual({ t: 'forget', path: 'p' })
    expect(toHelperRequest({ to: 'bg', type: 'pc-pause', on: true })).toEqual({ t: 'pause', on: true })
    expect(toHelperRequest({ to: 'bg', type: 'pc-resume' })).toEqual({ t: 'resume' })
    expect(toHelperRequest({ to: 'bg', type: 'pc-stats' })).toEqual({ t: 'stats' })
    expect(toHelperRequest({ to: 'bg', type: 'pc-connect' })).toBeNull()
    for (const bad of [
      { to: 'bg', type: 'pc-allow', path: '', keyboard: true, mouse: true }, { to: 'bg', type: 'pc-allow', path: 'p', keyboard: 'yes', mouse: true },
      { to: 'bg', type: 'pc-forget' }, { to: 'bg', type: 'pc-pause', on: 1 }, { to: 'bg', type: 'pc-exec' }, { to: 'offscreen', type: 'pc-resume' },
    ]) expect(parseBgRequest(bad), JSON.stringify(bad)).toBeNull()
    for (const t of ['pc-connect', 'pc-allow', 'pc-scope', 'pc-forget', 'pc-pause', 'pc-resume', 'pc-stats'] as const) {
      expect(allowedFrom(t, 'extension')).toBe(true)
      expect(allowedFrom(t, 'page')).toBe(false)
      expect(allowedFrom(t, 'offscreen')).toBe(false)
    }
  })
})

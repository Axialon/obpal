import { describe, expect, it } from 'vitest'
import { KeyMapper, type KeysInput } from '../extension/src/shared/keys'
import type { PadInput } from '../extension/src/shared/math'
import { allowedFrom, parseBgRequest, parseOffscreenRequest, workerStale } from '../extension/src/shared/messages'
import {
  buildNativeFrame, EMPTY_PC, HeldState, heldSignature, isIdleFrame, parseHelperMessage, parseNativeFrame, parseNativeText, parsePcRequest, parsePcState,
  pcView, scopeLabel, toHelperRequest, TYPING_REFUSALS, typingField, typingToast, type PcProgram, type PcState, type PcStatus,
} from '../extension/src/shared/native'
import { recipients, type FrameInfo } from '../extension/src/shared/route'

const pad = (over: Partial<PadInput> = {}): PadInput => ({ buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0], ...over })
const input = (over: Partial<KeysInput> = {}): KeysInput => ({ pad: null, tilt: null, aim: [0, 0], pad1: [0, 0], dtMs: 16, ...over })
const bit = (...i: number[]) => i.reduce((m, b) => m | (1 << b), 0)

describe('Mac permission and shortcuts', () => {
  it('validates the Mac report and hides Type until Accessibility is granted', () => {
    const platform = { os: 'macos' as const, accessibility: false, ctrlToCmd: true }
    expect(parseHelperMessage({ t: 'platform', ...platform })).toEqual({ t: 'platform', ...platform })
    for (const patch of [{ accessibility: 'yes' }, { ctrlToCmd: 1 }, { os: 'linux' }]) {
      expect(parseHelperMessage({ t: 'platform', ...platform, ...patch })).toBeNull()
    }
    const state: PcState = { ...EMPTY_PC, link: 'ready', platform, config: { paused: false, desktop: { keyboard: true, mouse: true }, programs: [] }, status: { enabled: true, panic: false, held: false, front: { name: 'TextEdit', path: '/Applications/TextEdit.app/Contents/MacOS/TextEdit', pid: 1, title: '', browser: false, elevated: false, allowed: null }, program: null, text: 'secret' } }
    expect(parsePcState(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(pcView(state)).toEqual({ kind: 'accessibility' })
    expect(typingField(state)).toBeNull()
    state.platform = { ...platform, accessibility: true }
    expect(pcView(state).kind).toBe('desktop')
    expect(typingField(state)).toBe('secret')
  })

  it('allows only extension UI to change the Mac shortcut setting', () => {
    const request = { to: 'bg', type: 'pc-macshortcuts', ctrlToCmd: false }
    expect(parseBgRequest(request)).toEqual(request)
    expect(toHelperRequest(parsePcRequest(request)!)).toEqual({ t: 'macshortcuts', ctrlToCmd: false })
    expect(parsePcRequest({ ...request, ctrlToCmd: 'no' })).toBeNull()
    expect(allowedFrom('pc-macshortcuts', 'extension')).toBe(true)
    expect(allowedFrom('pc-macshortcuts', 'page')).toBe(false)
    expect(allowedFrom('pc-macshortcuts', 'offscreen')).toBe(false)
  })
})

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

  it('adds what the PC gestures hold, and tells a change of held state from a repeat', () => {
    const held = new HeldState()
    const m = new KeyMapper()
    held.apply(m.update(input({ pad: pad({ triggers: [1, 0] }) }))) // LT: right button
    const f = buildNativeFrame(held, [0, 0], [0, -120], { buttons: [0, 2], keys: ['ControlLeft'] })
    expect(f).toEqual({ t: 'f', k: ['ControlLeft'], b: [0, 2], w: [0, -120] })
    expect(heldSignature(f)).toBe('ControlLeft|0,2')
    expect(heldSignature(buildNativeFrame(new HeldState(), [5, 5]))).toBe('|')
    expect(heldSignature(buildNativeFrame(new HeldState(), [0, 0], [0, 0], { buttons: [0] }))).not.toBe('|')
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
    // 0.1 has no whole-PC mode (0.2 says so) and doesn't type (0.3 says so)
    expect(parseHelperMessage({ t: 'hello', v: 1, version: '0.1.0', os: 'windows', hotkey: 'Ctrl+Alt+Backspace', caps: { keyboard: true, mouse: true, gamepad: false } }))
      .toEqual({ t: 'hello', v: 1, version: '0.1.0', os: 'windows', hotkey: 'Ctrl+Alt+Backspace', caps: { keyboard: true, mouse: true, gamepad: false, desktop: false, text: false } })
    expect(parseHelperMessage({ t: 'hello', v: 1, version: '0.2.0', os: 'windows', hotkey: null, caps: { keyboard: true, mouse: true, gamepad: false, desktop: true } }))
      .toMatchObject({ caps: { desktop: true } })
    expect(parseHelperMessage({ t: 'hello', v: 1, version: '0.1.0', os: 'windows', hotkey: null, caps: { keyboard: true, mouse: true, gamepad: false } })?.t).toBe('hello')
    expect(parseHelperMessage({ t: 'config', paused: false, programs: [{ path: 'C:\\g.exe', name: 'g.exe', keyboard: true, mouse: false, gamepad: false }] }))
      .toEqual({ t: 'config', paused: false, desktop: null, programs: [{ path: 'C:\\g.exe', name: 'g.exe', keyboard: true, mouse: false }] })
    expect(parseHelperMessage({ t: 'config', paused: false, desktop: { keyboard: true, mouse: true, gamepad: false }, programs: [] }))
      .toEqual({ t: 'config', paused: false, desktop: { keyboard: true, mouse: true }, programs: [] })
    expect(parseHelperMessage({ t: 'config', paused: false, desktop: null, programs: [] })).toEqual({ t: 'config', paused: false, desktop: null, programs: [] })
    const status = { t: 'status', enabled: true, panic: false, held: false, front: { ...program, allowed: { keyboard: true, mouse: true } }, program }
    // a helper from before typing says nothing about text fields: none
    expect(parseHelperMessage(status)).toEqual({ ...status, front: { ...program, allowed: { keyboard: true, mouse: true } }, text: null })
    expect(parseHelperMessage({ t: 'stats', frames: 10, injected: 4, refused: { notAllowed: 6, 'bad key!': 1 } })).toEqual({ t: 'stats', frames: 10, injected: 4, refused: { notAllowed: 6 } })
    expect(parseHelperMessage({ t: 'error', code: 'bad-frame', msg: 'x' })).toEqual({ t: 'error', code: 'bad-frame', msg: 'x' })
  })

  it('rejects malformed messages and unknown types', () => {
    for (const bad of [
      { t: 'exec' }, { t: 'hello', v: 1 }, { t: 'hello', v: 1, version: 'x'.repeat(33), os: 'windows', hotkey: null, caps: { keyboard: true, mouse: true, gamepad: false } },
      { t: 'config', paused: 'no', programs: [] }, { t: 'config', paused: false, programs: [{ path: 'p', name: 'n', keyboard: 1, mouse: true }] },
      { t: 'config', paused: false, desktop: true, programs: [] }, { t: 'config', paused: false, desktop: { keyboard: 'y', mouse: true }, programs: [] },
      { t: 'hello', v: 1, version: '0.2.0', os: 'windows', hotkey: null, caps: { keyboard: true, mouse: true, gamepad: false, desktop: 'yes' } },
      { t: 'status', enabled: true, panic: false, held: false, front: { ...program, pid: -1 }, program: null },
      { t: 'status', enabled: true, panic: false, held: false, front: { ...program, allowed: { keyboard: 'y', mouse: true } }, program: null },
      { t: 'status', enabled: true, panic: false, front: null, program: null },
      { t: 'stats', frames: 'x', injected: 0, refused: {} }, { t: 'error', code: 'x'.repeat(41), msg: '' }, null, 'status',
    ]) expect(parseHelperMessage(bad), JSON.stringify(bad)).toBeNull()
  })

  it('re-validates the mirrored state', () => {
    expect(parsePcState(EMPTY_PC)).toEqual(EMPTY_PC)
    const s: PcState = { link: 'ready', version: '0.2.0', desktopCap: true, hotkey: null, error: null, config: { paused: false, desktop: { keyboard: true, mouse: false }, programs: [] }, status: { enabled: true, panic: false, held: false, front: null, program, text: null }, stats: null }
    expect(parsePcState(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(parsePcState({ ...s, link: 'sideways' })).toBeNull()
    expect(parsePcState({ ...s, status: { enabled: true } })).toBeNull()
    expect(parsePcState({ ...s, stats: { frames: 1, injected: 1, refused: {} } })?.stats).toEqual({ frames: 1, injected: 1, refused: {} })
    // a state stored by 1.2 (no whole-PC fields) still reads
    const { desktopCap: _, ...old } = s
    expect(parsePcState({ ...old, config: { paused: false, programs: [] } })).toEqual({ ...s, desktopCap: false, config: { paused: false, desktop: null, programs: [] } })
  })
})

describe('PC target: what the popup shows', () => {
  const program: PcProgram = { name: 'notepad.exe', path: 'C:\\Windows\\notepad.exe', title: 'Untitled', pid: 7, elevated: false, browser: false, allowed: null }
  const browser: PcProgram = { name: 'chrome.exe', path: 'C:\\chrome.exe', title: 'ob.Pal', pid: 1, elevated: false, browser: true, allowed: null }
  const ready = (over: Partial<PcState>): PcState => ({ ...EMPTY_PC, link: 'ready', hotkey: 'Ctrl+Alt+Backspace', config: { paused: false, desktop: null, programs: [] }, ...over })
  const status = (front: PcProgram | null, prog: PcProgram | null, over = {}) => ({ enabled: true, panic: false, held: false, front, program: prog, text: null, ...over })

  it('walks the states: permission, starting, missing, error, paused, panic', () => {
    expect(pcView({ ...EMPTY_PC, link: 'permission' })).toEqual({ kind: 'permission' })
    expect(pcView({ ...EMPTY_PC, link: 'off' })).toEqual({ kind: 'connecting' })
    expect(pcView({ ...EMPTY_PC, link: 'connecting' })).toEqual({ kind: 'connecting' })
    expect(pcView({ ...EMPTY_PC, link: 'missing' })).toEqual({ kind: 'missing' })
    expect(pcView({ ...EMPTY_PC, link: 'error', error: 'boom' })).toEqual({ kind: 'error', error: 'boom' })
    expect(pcView(ready({ config: { paused: true, desktop: null, programs: [] }, status: status(program, program) }))).toEqual({ kind: 'paused' })
    expect(pcView(ready({ config: { paused: true, desktop: { keyboard: true, mouse: true }, programs: [] } }))).toEqual({ kind: 'paused' })
    expect(pcView(ready({ status: status(program, program, { panic: true }) }))).toEqual({ kind: 'panic', hotkey: 'Ctrl+Alt+Backspace' })
  })

  it('offers to allow the program the person will switch back to, even while the browser is in front', () => {
    expect(pcView(ready({ status: status(browser, null) }))).toEqual({ kind: 'idle', desktop: false })
    expect(pcView(ready({ status: status(browser, program) }))).toEqual({ kind: 'allow', program, desktop: false })
    expect(pcView(ready({ status: status(program, program) }))).toEqual({ kind: 'allow', program, desktop: false })
    const elevated = { ...program, elevated: true }
    expect(pcView(ready({ status: status(browser, elevated) }))).toEqual({ kind: 'elevated', program: elevated, desktop: false })
    // a helper with whole-PC mode offers it beside the one-program views
    expect(pcView(ready({ desktopCap: true, status: status(browser, null) }))).toEqual({ kind: 'idle', desktop: true })
    expect(pcView(ready({ desktopCap: true, status: status(browser, program) }))).toEqual({ kind: 'allow', program, desktop: true })
  })

  it('shows what is controlled and whether it is in front', () => {
    const allowed = { ...program, allowed: { keyboard: true, mouse: false } }
    expect(pcView(ready({ status: status(allowed, allowed) }))).toEqual({ kind: 'active', program: allowed, scope: { keyboard: true, mouse: false }, inFront: true, desktop: false })
    expect(pcView(ready({ status: status(browser, allowed) }))).toEqual({ kind: 'active', program: allowed, scope: { keyboard: true, mouse: false }, inFront: false, desktop: false })
    expect(scopeLabel({ keyboard: true, mouse: true })).toBe('keyboard + mouse')
  })

  it('shows the whole PC while that mode is on, with the window in front', () => {
    const whole = { keyboard: true, mouse: true }
    const config = { paused: false, desktop: whole, programs: [] }
    expect(pcView(ready({ desktopCap: true, config, status: status(browser, program) }))).toEqual({ kind: 'desktop', scope: whole, front: browser })
    const admin = { ...program, name: 'taskmgr.exe', elevated: true }
    expect(pcView(ready({ desktopCap: true, config, status: status(admin, program) }))).toEqual({ kind: 'desktop', scope: whole, front: admin })
    // on with every kind off is not on
    expect(pcView(ready({ desktopCap: true, config: { ...config, desktop: { keyboard: false, mouse: false } }, status: status(browser, null) })).kind).toBe('idle')
    expect(pcView(ready({ config, status: status(program, program, { panic: true }) })).kind).toBe('panic')
    expect(scopeLabel({ keyboard: false, mouse: true })).toBe('mouse')
    expect(scopeLabel({ keyboard: false, mouse: false })).toBe('nothing')
  })
})

describe('PC target: typing from the phone', () => {
  const program: PcProgram = { name: 'notepad.exe', path: 'C:\\Windows\\notepad.exe', title: 'Untitled', pid: 7, elevated: false, browser: false, allowed: { keyboard: true, mouse: true } }
  const status = (over: Partial<PcStatus> = {}): PcStatus => ({ enabled: true, panic: false, held: false, front: program, program, text: 'text', ...over })
  const ready = (over: Partial<PcState> = {}): PcState => ({ ...EMPTY_PC, link: 'ready', config: { paused: false, desktop: null, programs: [] }, status: status(), ...over })

  it('takes text requests to type and delete, and nothing that isn’t typing', () => {
    expect(parseNativeText({ t: 'text', s: 'hi', del: 0 })).toEqual({ t: 'text', s: 'hi', del: 0 })
    expect(parseNativeText({ t: 'text', s: 'the ', del: 2 })).toEqual({ t: 'text', s: 'the ', del: 2 })
    // del may be left out; newline is Enter, tab is Tab; emoji and accents are typing
    expect(parseNativeText({ t: 'text', s: 'ok\n' })).toEqual({ t: 'text', s: 'ok\n', del: 0 })
    expect(parseNativeText({ t: 'text', s: 'a\tb 😀 é', del: 0, extra: 1 })).toEqual({ t: 'text', s: 'a\tb 😀 é', del: 0 })
    expect(parseNativeText({ t: 'text', s: '', del: 256 })).toEqual({ t: 'text', s: '', del: 256 })
    expect(parseNativeText({ t: 'text', s: 'x'.repeat(256) })?.s.length).toBe(256)
    for (const bad of [
      { t: 'text', s: '', del: 0 }, { t: 'text', s: '' }, { t: 'text', s: 'x'.repeat(257) }, { t: 'text', s: 'a', del: 257 }, { t: 'text', s: 'a', del: -1 },
      { t: 'text', s: 'a', del: 1.5 }, { t: 'text', s: 'a', del: '1' }, { t: 'text', s: 5 }, { t: 'text' },
      { t: 'text', s: 'bell\u0007' }, { t: 'text', s: 'cr\r' }, { t: 'text', s: 'nul\u0000' }, { t: 'text', s: 'c1\u0085' }, { t: 'text', s: 'del\u007f' },
      { t: 'text', s: 'half \ud83d' }, { t: 'text', s: '\ude00 half' }, { t: 'f', s: 'a' }, null, 'text',
    ]) expect(parseNativeText(bad), JSON.stringify(bad)).toBeNull()
  })

  it('reads the helper saying it types, and which field has the focus', () => {
    const hello = { t: 'hello', v: 1, version: '0.3.0', os: 'windows', hotkey: null, caps: { keyboard: true, mouse: true, gamepad: false, desktop: true, text: true } }
    expect(parseHelperMessage(hello)).toMatchObject({ caps: { desktop: true, text: true } })
    const { text: _, ...old } = hello.caps
    expect(parseHelperMessage({ ...hello, caps: old })).toMatchObject({ caps: { text: false } })
    expect(parseHelperMessage({ ...hello, caps: { ...hello.caps, text: 'yes' } })).toBeNull()
    const st = { t: 'status', enabled: true, panic: false, held: false, front: null, program: null }
    expect(parseHelperMessage({ ...st, text: 'text' })).toMatchObject({ text: 'text' })
    expect(parseHelperMessage({ ...st, text: 'secret' })).toMatchObject({ text: 'secret' })
    expect(parseHelperMessage({ ...st, text: null })).toMatchObject({ text: null })
    for (const text of ['password', true, 1, {}]) expect(parseHelperMessage({ ...st, text }), JSON.stringify(text)).toBeNull()
    // the mirrored state keeps it
    const s = ready()
    expect(parsePcState(JSON.parse(JSON.stringify(s)))?.status?.text).toBe('text')
  })

  it('offers the phone’s keyboard only where typing would go through', () => {
    expect(typingField(ready())).toBe('text')
    expect(typingField(ready({ status: status({ text: 'secret' }) }))).toBe('secret')
    expect(typingField(ready({ status: status({ text: null }) }))).toBeNull()
    // not armed, stopped, paused, or no helper
    expect(typingField(ready({ status: status({ enabled: false }) }))).toBeNull()
    expect(typingField(ready({ status: status({ panic: true }) }))).toBeNull()
    expect(typingField(ready({ config: { paused: true, desktop: null, programs: [] } }))).toBeNull()
    expect(typingField({ ...ready(), link: 'error' })).toBeNull()
    // one program at a time: the program in front must be allowed keys
    expect(typingField(ready({ status: status({ front: { ...program, allowed: { keyboard: false, mouse: true } } }) }))).toBeNull()
    expect(typingField(ready({ status: status({ front: { ...program, allowed: null } }) }))).toBeNull()
    expect(typingField(ready({ status: status({ front: null }) }))).toBeNull()
    // the whole PC: any window, if the whole PC takes keys; never an elevated one
    const browser: PcProgram = { ...program, name: 'chrome.exe', browser: true, allowed: null }
    const whole = (keyboard: boolean) => ({ paused: false, desktop: { keyboard, mouse: true }, programs: [] })
    expect(typingField(ready({ config: whole(true), status: status({ front: browser }) }))).toBe('text')
    expect(typingField(ready({ config: whole(false), status: status({ front: browser }) }))).toBeNull()
    expect(typingField(ready({ config: whole(true), status: status({ front: { ...browser, elevated: true } }) }))).toBeNull()
  })

  it('tells the offscreen link about the field and about typing that didn’t get through, strictly', () => {
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'text-field', field: 'secret' })).toEqual({ to: 'offscreen', type: 'text-field', field: 'secret' })
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'text-field', field: null })).toEqual({ to: 'offscreen', type: 'text-field', field: null })
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'typing', refused: 'not-typed' })).toEqual({ to: 'offscreen', type: 'typing', refused: 'not-typed' })
    for (const bad of [
      { to: 'offscreen', type: 'text-field' }, { to: 'offscreen', type: 'text-field', field: 'password' }, { to: 'offscreen', type: 'text-field', field: false },
      { to: 'offscreen', type: 'typing', refused: 'nope' }, { to: 'offscreen', type: 'typing' }, { to: 'bg', type: 'text-field', field: 'text' },
    ]) expect(parseOffscreenRequest(bad), JSON.stringify(bad)).toBeNull()
    // every refusal has a word for the phone
    for (const r of TYPING_REFUSALS) expect(typingToast(r).length).toBeGreaterThan(8)
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
    const whole = { to: 'bg', type: 'pc-desktop', on: true, keyboard: true, mouse: false }
    expect(parseBgRequest(whole)).toEqual(whole)
    expect(toHelperRequest(parsePcRequest(whole)!)).toEqual({ t: 'desktop', on: true, keyboard: true, mouse: false })
    expect(toHelperRequest({ to: 'bg', type: 'pc-pause', on: true })).toEqual({ t: 'pause', on: true })
    expect(toHelperRequest({ to: 'bg', type: 'pc-resume' })).toEqual({ t: 'resume' })
    expect(toHelperRequest({ to: 'bg', type: 'pc-stats' })).toEqual({ t: 'stats' })
    expect(toHelperRequest({ to: 'bg', type: 'pc-connect' })).toBeNull()
    for (const bad of [
      { to: 'bg', type: 'pc-allow', path: '', keyboard: true, mouse: true }, { to: 'bg', type: 'pc-allow', path: 'p', keyboard: 'yes', mouse: true },
      { to: 'bg', type: 'pc-forget' }, { to: 'bg', type: 'pc-pause', on: 1 }, { to: 'bg', type: 'pc-exec' }, { to: 'offscreen', type: 'pc-resume' },
      { to: 'bg', type: 'pc-desktop', on: true }, { to: 'bg', type: 'pc-desktop', on: 'yes', keyboard: true, mouse: true },
    ]) expect(parseBgRequest(bad), JSON.stringify(bad)).toBeNull()
    for (const t of ['pc-connect', 'pc-allow', 'pc-scope', 'pc-forget', 'pc-desktop', 'pc-pause', 'pc-resume', 'pc-stats'] as const) {
      expect(allowedFrom(t, 'extension')).toBe(true)
      expect(allowedFrom(t, 'page')).toBe(false)
      expect(allowedFrom(t, 'offscreen')).toBe(false)
    }
  })
})

describe('An unpacked copy updated without a reload', () => {
  it('is caught by asking the running worker for its version', () => {
    expect(parseBgRequest({ to: 'bg', type: 'version' })).toEqual({ to: 'bg', type: 'version' })
    expect(allowedFrom('version', 'extension')).toBe(true)
    expect(allowedFrom('version', 'page')).toBe(false)
    expect(workerStale({ version: '1.3.1' }, '1.3.1')).toBe(false)
    expect(workerStale({ version: '1.2.0' }, '1.3.1')).toBe(true)
    // a worker from before 1.3.1 doesn't answer at all
    expect(workerStale(undefined, '1.3.1')).toBe(true)
    expect(workerStale({ ok: false, error: 'The message port closed before a response was received.' }, '1.3.1')).toBe(true)
  })
})

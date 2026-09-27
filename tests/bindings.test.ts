import { describe, expect, it } from 'vitest'
import {
  ACTION_INPUTS, badgeOf, checkButtons, checkProfile, CONTROLLER_IDS, CONTROLLERS, CONTROLS, DEFAULT_BUTTONS, describeBindings, DEVICE_KINDS,
  hostButtons, INPUT_ID, INPUT_OPTIONS, inferKind, inputsFor, isTarget, KEY_TARGETS, MAX_BUTTONS, offerOf, optionOf, PROFILES,
  resolveButtons, SMART_BUTTONS, smartButtons, targetLabel,
} from '../packages/core/src'
import type { Layout } from '../packages/core/src'

const layout = (over: Partial<Layout> = {}): Layout => ({ v: 1, tray: [], ...over })

describe('Buttons: every controller has its controls, and its defaults press only those', () => {
  it('names the controls a physical input may press on each controller, in the contract', () => {
    for (const id of CONTROLLER_IDS) expect(CONTROLLERS[id].controls).toBe(CONTROLS[id])
    expect(CONTROLS['face.gamepad']).toHaveLength(17)
    expect(CONTROLS['face.wii']).toEqual(['a', 'b', 'minus', 'home', 'plus'])
  })

  it('binds only well-formed inputs to targets their controller has, and nothing to Back', () => {
    for (const [c, map] of Object.entries(DEFAULT_BUTTONS)) {
      for (const [input, t] of Object.entries(map)) {
        expect(INPUT_ID.test(input), `${c} ${input}`).toBe(true)
        expect(isTarget(c, t), `${c} ${input} -> ${t}`).toBe(true)
      }
      expect(map.back).toBeUndefined()
    }
  })

  it('keeps today’s behaviour: Enter, one headset press and a pad’s A are A; Esc is B; the arrows are next and previous', () => {
    const wii = DEFAULT_BUTTONS['face.wii']
    expect([wii['key:Enter'], wii['media:playpause'], wii['pad:b0'], wii['key:Escape'], wii['key:PageDown'], wii['media:previoustrack'], wii['pad:b15']])
      .toEqual(['a', 'a', 'a', 'b', 'plus', 'minus', 'plus'])
    expect(DEFAULT_BUTTONS['face.mouse']['key:AudioVolumeDown']).toBe('wheel')
    expect(DEFAULT_BUTTONS['face.trackpad']['key:Enter']).toBe('grab')
    // The wheel's volume keys are its pedals; the gamepad passes a pad's buttons straight through.
    expect([DEFAULT_BUTTONS['face.wheel']['key:AudioVolumeUp'], DEFAULT_BUTTONS['face.wheel']['key:Enter']]).toEqual(['rt', 'a'])
    expect(DEFAULT_BUTTONS['face.gamepad']['pad:b9']).toBe('menu')
    // A headset press can't hold, so it isn't the 3D hand's deadman.
    expect(DEFAULT_BUTTONS['face.hand']['key:Enter']).toBe('hold')
    expect(DEFAULT_BUTTONS['face.hand']['media:playpause']).toBeUndefined()
  })
})

describe('Buttons: recognising a device from what it sends', () => {
  it('tells a clicker, a selfie remote, a pad, a headset and a keyboard apart', () => {
    expect(inferKind(['key:PageDown'])).toBe('clicker')
    expect(inferKind(['key:ArrowRight', 'key:ArrowLeft', 'key:KeyB'])).toBe('clicker')
    expect(inferKind(['key:Enter'])).toBe('selfie')
    expect(inferKind(['key:AudioVolumeUp'])).toBe('selfie')
    expect(inferKind(['pad:b0', 'pad:a1-'])).toBe('pad')
    expect(inferKind(['media:nexttrack'])).toBe('headset')
    expect(inferKind(['key:KeyQ'])).toBe('keyboard')
    // More keys than a clicker has make it a keyboard; its start key alone doesn't make a clicker.
    expect(inferKind(['key:PageDown', 'key:KeyQ'])).toBe('keyboard')
    expect(inferKind(['key:Enter', 'key:PageDown'])).toBe('keyboard')
    expect(inferKind(['key:F5'])).toBe('keyboard')
  })

  it('leaves what it can’t use without setup: a pad the browser can’t map, Back, nothing', () => {
    expect(inferKind(['pad:raw:b0'])).toBeNull()
    expect(inferKind(['back'])).toBeNull()
    expect(inferKind([])).toBeNull()
  })

  it('has smart defaults only for known controllers, each target one that controller can press', () => {
    for (const kind of DEVICE_KINDS) {
      for (const [c, map] of Object.entries(SMART_BUTTONS[kind])) {
        expect(CONTROLLER_IDS as readonly string[]).toContain(c)
        for (const [input, t] of Object.entries(map ?? {})) expect(isTarget(c, t), `${kind} ${c} ${input} -> ${t}`).toBe(true)
      }
    }
    expect(smartButtons('selfie', 'face.wii')).toEqual({})
    expect(smartButtons('pad', 'face.gamepad')).toEqual({})
  })
})

describe('Buttons: the layers', () => {
  const typing = { tray: [], typing: true }
  const plain = { tray: [], typing: false }

  it('stacks the controller’s defaults, smart defaults, the host’s, the profile’s and the person’s own, the last winning', () => {
    const smart = smartButtons('clicker', 'face.wii')
    expect(resolveButtons('face.wii', [smart], typing)['key:PageDown']).toBe('key-ArrowRight')
    expect(resolveButtons('face.wii', [smart, { 'key:PageDown': 'a' }], typing)['key:PageDown']).toBe('a')
    expect(resolveButtons('face.wii', [smart, { 'key:PageDown': 'a' }, undefined, { 'key:PageDown': 'b' }], typing)['key:PageDown']).toBe('b')
    // The person's own always win over smart defaults, whatever comes between.
    expect(resolveButtons('face.mouse', [smartButtons('pad', 'face.mouse'), {}, {}, { 'pad:b4': 'home' }], plain)['pad:b4']).toBe('home')
  })

  it('keeps a clicker on the controller’s own next and previous where the screen doesn’t take typing', () => {
    const smart = smartButtons('clicker', 'face.wii')
    const r = resolveButtons('face.wii', [smart], plain)
    expect([r['key:PageDown'], r['key:PageUp'], r['key:F5'], r['key:KeyB']]).toEqual(['plus', 'minus', 'a', 'b'])
  })

  it('takes an input away with none, and skips targets the controller or the screen can’t use', () => {
    const r = resolveButtons('face.wii', [{ 'key:Enter': 'none', 'key:KeyQ': 'left', 'key:KeyW': 'tray:grip', 'key:KeyE': 'tray:gone', bad: 'a' }], { tray: ['grip'], typing: false })
    expect(r['key:Enter']).toBeUndefined()
    expect(r['key:KeyQ']).toBeUndefined() // Left is the mouse's, not the Wii remote's
    expect(r['key:KeyW']).toBe('tray:grip')
    expect(r['key:KeyE']).toBeUndefined()
    expect(r.bad).toBeUndefined()
  })

  it('reads a host’s keys as its buttons, on every controller but the gamepad’s, and only for tray buttons it has', () => {
    const arm = layout({ tray: [{ id: 'grip', label: 'Grip' }, { id: 'estop', label: 'Stop', tone: 'stop' }, { id: 'home', label: 'Home' }], keys: { primary: 'grip', secondary: 'estop', next: 'home' } })
    const host = hostButtons(arm, 'face.wii')
    for (const input of ACTION_INPUTS.primary) expect(host[input]).toBe('tray:grip')
    expect(host['key:Escape']).toBe('tray:estop')
    expect(host['media:nexttrack']).toBe('tray:home')
    expect(hostButtons(arm, 'face.gamepad')).toEqual({})
    const r = resolveButtons('face.wii', [host], offerOf(arm))
    expect([r['key:Enter'], r['key:AudioVolumeDown'], r['key:PageUp']]).toEqual(['tray:grip', 'tray:estop', 'minus'])
    expect(resolveButtons('face.wii', [hostButtons(layout({ keys: { primary: 'gone' } }), 'face.wii')], offerOf(layout()))['key:Enter']).toBe('a')
  })

  it('takes a host’s buttons for any input, over its keys', () => {
    const l = layout({ tray: [{ id: 'next', label: 'Next' }, { id: 'keyboard', label: 'Keyboard', type: 'keyboard' }], buttons: { 'media:nexttrack': 'tray:next', 'key:KeyB': 'key-Escape', junk: 'a' } })
    const r = resolveButtons('face.mouse', [hostButtons(l, 'face.mouse')], offerOf(l))
    expect(r['media:nexttrack']).toBe('tray:next')
    expect(r['key:KeyB']).toBe('key-Escape')
    expect(offerOf(l)).toEqual({ tray: ['next'], typing: true })
  })

  it('lists what presses a control, and says what inputs do now', () => {
    const r = resolveButtons('face.wii', [smartButtons('pad', 'face.wii')], { tray: [], typing: false })
    expect(inputsFor(r, 'plus')).toEqual(expect.arrayContaining(['key:PageDown', 'media:nexttrack', 'pad:b15', 'pad:b5']))
    expect(describeBindings('face.wii', ['media:playpause', 'media:nexttrack', 'media:previoustrack'], r)).toBe('1× = A · 2× = + · 3× = −')
    expect(describeBindings('face.wii', ['pad:b0', 'pad:b1', 'pad:b15', 'pad:b14'], r)).toBe('A = A · B = B · → = +')
    expect(targetLabel('face.mouse', 'left')).toBe('Left')
    expect(targetLabel('face.gamepad', 'left')).toBe('←')
    expect(targetLabel('face.wii', 'tray:grip', [{ id: 'grip', label: 'Grip' }])).toBe('Grip')
    expect(targetLabel('face.wii', 'key-ArrowRight')).toBe('→')
  })
})

describe('Buttons: the options the sheet lists, and profiles that carry buttons', () => {
  it('lists every input the phone can hear, each well formed and once', () => {
    const all = INPUT_OPTIONS.flatMap((g) => g.ids)
    for (const id of all) expect(INPUT_ID.test(id), id).toBe(true)
    expect(new Set(all).size).toBe(all.length)
    expect(all).toEqual(expect.arrayContaining(['media:playpause', 'media:nexttrack', 'media:previoustrack', 'key:PageDown', 'pad:b16', 'pad:a3+', 'back']))
    expect(['media:playpause', 'media:nexttrack', 'media:previoustrack'].map(optionOf)).toEqual(['1 press', '2 presses', '3 presses'])
    expect(['media:nexttrack', 'key:Enter'].map(badgeOf)).toEqual(['2×', 'Enter'])
  })

  it('checks a profile’s controller and buttons: known controller, input ids, targets it can press, at most 32', () => {
    const base = { id: 'presenter', name: 'Presenter', for: 'Slides from a clicker', on: [], aim: PROFILES.default.aim, steer: PROFILES.default.steer, point: PROFILES.default.point }
    const ok = checkProfile({ ...base, controller: 'face.mouse', buttons: { 'key:PageDown': 'key-ArrowRight', 'media:nexttrack': 'tray:next', 'pad:b3': 'right', back: 'none' } })
    expect(ok.errors).toEqual([])
    expect(ok.profile?.controller).toBe('face.mouse')
    expect(ok.profile?.buttons?.['pad:b3']).toBe('right')
    expect(checkProfile(base).profile).not.toHaveProperty('buttons')
    const bad = checkProfile({ ...base, controller: 'face.toaster', buttons: { 'key:Enter': 'a' } })
    expect(bad.errors.join('\n')).toMatch(/controller/)
    // Without a controller, a profile tunes the gamepad: `plus` isn't one of its controls.
    expect(checkProfile({ ...base, buttons: { 'key:Enter': 'plus' } }).errors.join('\n')).toMatch(/buttons\.key:Enter/)
    expect(checkProfile({ ...base, buttons: { 'Enter': 'a' } }).errors.join('\n')).toMatch(/isn’t an input id|isn't an input id/)
    const many = Object.fromEntries(Array.from({ length: MAX_BUTTONS + 1 }, (_, i) => [`key:Digit${i % 10}${'x'.repeat(Math.floor(i / 10))}`, 'a']))
    expect(checkButtons('face.gamepad', many).errors[0]).toMatch(/at most 32/)
    expect(KEY_TARGETS.every((t) => isTarget('face.wii', t))).toBe(true)
  })
})

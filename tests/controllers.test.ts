import { describe, expect, it } from 'vitest'
import {
  Controller, CONTROLLER_ID, CONTROLLER_IDS, controllerOf, CONTROLLERS, isControllerId, KEYBOARD_CONTROL, layoutControllers, Mode, readMode,
  Utility, withControllers, type Layout,
} from '../packages/core/src/index'
import { DEFAULT_LAYOUT } from '../packages/host/src/remote'

const UTILITIES = Object.values(Utility) as string[]
const MODES = Object.values(Mode) as number[]

describe('the controllers in the catalogue (CATALOGUE §9.1)', () => {
  it('each has a stable, well-formed id, known utilities and modes, in the picker’s category order', () => {
    expect(CONTROLLER_IDS).toEqual(['face.gamepad', 'face.wheel', 'face.wii', 'face.mouse', 'face.trackpad', 'face.hand', 'face.keyboard', 'face.drums', 'face.keys'])
    const order = ['Controller', 'Pointer', 'Touch', '3D', 'Keys', 'Music']
    let last = 0
    for (const id of CONTROLLER_IDS) {
      const c = CONTROLLERS[id]
      expect(c.id).toBe(id)
      expect(CONTROLLER_ID.test(id)).toBe(true)
      expect(isControllerId(id)).toBe(true)
      for (const u of c.utilities) expect(UTILITIES).toContain(u)
      for (const m of c.modes) expect(MODES).toContain(m)
      expect(order.indexOf(c.category)).toBeGreaterThanOrEqual(last)
      last = order.indexOf(c.category)
    }
    // The keyboard types beside any mode; every other controller sends in one.
    expect(CONTROLLER_IDS.filter((id) => !CONTROLLERS[id].modes.length)).toEqual([Controller.keyboard])
    expect(isControllerId('face.nope')).toBe(false)
    expect(isControllerId('toString')).toBe(false)
  })

  it('takes a wire id of any kind that is well formed, and nothing else', () => {
    for (const ok of ['face.wii', 'bridge.gamepad', 'face.drums', 'bridge.xr']) expect(CONTROLLER_ID.test(ok)).toBe(true)
    for (const bad of ['wii', 'Face.wii', 'face.', '.wii', 'face.wii.left', 'face.wii ', `face.${'x'.repeat(33)}`, 'face.<b>']) expect(CONTROLLER_ID.test(bad)).toBe(false)
  })
})

describe('withControllers: a layout that names controllers, for every phone (CATALOGUE §9.2)', () => {
  const base: Layout = { v: 1, tray: [] }

  it('leaves a layout that names none exactly as it is', () => {
    expect(withControllers(DEFAULT_LAYOUT)).toBe(DEFAULT_LAYOUT)
    const l: Layout = { v: 1, tray: [], modes: [Mode.point], controllers: [] }
    expect(withControllers(l)).toBe(l)
    // A controller this version doesn't know means nothing to it yet.
    const later: Layout = { v: 1, tray: [], controllers: ['bridge.gamepad'] }
    expect(withControllers(later)).toBe(later)
    // Nor does a list that isn't one.
    const odd = { v: 1, tray: [], controllers: 'face.wii' } as unknown as Layout
    expect(withControllers(odd)).toBe(odd)
    expect(layoutControllers({ ...odd, modes: [Mode.gamepad] })).toEqual([Controller.gamepad])
  })

  it('fills in the modes phones before controllers read, in the controllers’ order, once each', () => {
    const l = withControllers({ ...base, controllers: ['face.wii', 'face.trackpad', 'face.hand', 'face.mouse'] })
    expect(l.modes).toEqual([Mode.point, Mode.tilt, Mode.hold, Mode.track])
    expect(withControllers({ ...base, controllers: ['face.gamepad'] }).modes).toEqual([Mode.gamepad])
  })

  it('keeps the modes a layout lists itself, and never changes what it was given', () => {
    const given: Layout = { ...base, modes: [Mode.hold], controllers: ['face.trackpad', 'face.keyboard'] }
    const copy = JSON.parse(JSON.stringify(given))
    const l = withControllers(given)
    expect(l.modes).toEqual([Mode.hold])
    expect(given).toEqual(copy)
  })

  it('makes Point a mouse when the air mouse comes before the Wii remote, unless the layout says', () => {
    expect(withControllers({ ...base, controllers: ['face.mouse'] }).point).toBe('mouse')
    expect(withControllers({ ...base, controllers: ['face.mouse', 'face.wii'] }).point).toBe('mouse')
    expect(withControllers({ ...base, controllers: ['face.wii', 'face.mouse'] }).point).toBeUndefined()
    expect(withControllers({ ...base, controllers: ['face.mouse'], point: 'wii' }).point).toBe('wii')
  })

  it('adds the keyboard to the tray once, for the keyboard controller', () => {
    const l = withControllers({ ...base, tray: [{ id: 'reset', label: 'Reset' }], controllers: ['face.trackpad', 'face.keyboard'] })
    expect(l.tray).toEqual([{ id: 'reset', label: 'Reset' }, KEYBOARD_CONTROL])
    const own = { id: 'type', label: 'Type', type: 'keyboard' as const }
    expect(withControllers({ ...base, tray: [own], controllers: ['face.keyboard'] }).tray).toEqual([own])
    // The keyboard alone offers no mode of its own.
    expect(withControllers({ ...base, controllers: ['face.keyboard'] }).modes).toEqual([])
  })

  it('suggests the Driving profile for a wheel ahead of the gamepad, unless the layout suggests one', () => {
    expect(withControllers({ ...base, controllers: ['face.wheel'] }).profile).toBe('driving')
    expect(withControllers({ ...base, controllers: ['face.wheel', 'face.gamepad'] }).profile).toBe('driving')
    expect(withControllers({ ...base, controllers: ['face.gamepad', 'face.wheel'] }).profile).toBeUndefined()
    expect(withControllers({ ...base, controllers: ['face.wheel'], profile: 'flight' }).profile).toBe('flight')
  })

  it('survives the wire: a phone that predates controllers reads the same modes from the JSON', () => {
    const sent = JSON.parse(JSON.stringify({ t: 'welcome', proto: 1, name: 'A page', layout: withControllers({ ...base, controllers: ['face.hand', 'face.wii'] }) }))
    expect(sent.layout.modes).toEqual([Mode.track, Mode.point])
    expect(sent.layout.controllers).toEqual(['face.hand', 'face.wii'])
  })
})

describe('what a layout offers, and what a mode stands for', () => {
  it('names the faces of a host that lists only modes (every host before controllers)', () => {
    // The home page's try-out, the default layout, and ob.Pal Link on a PC (the mouse face and a keyboard).
    expect(layoutControllers({ modes: [Mode.tilt, Mode.point], tray: [] })).toEqual([Controller.trackpad, Controller.wii])
    expect(layoutControllers(DEFAULT_LAYOUT)).toEqual([Controller.trackpad, Controller.wii])
    expect(layoutControllers({ modes: [Mode.hold, Mode.point, Mode.gamepad], point: 'mouse', tray: [KEYBOARD_CONTROL] }))
      .toEqual([Controller.trackpad, Controller.mouse, Controller.gamepad, Controller.keyboard])
    // No modes at all: what phones show without them.
    expect(layoutControllers({ tray: [] })).toEqual([Controller.trackpad, Controller.wii])
  })

  it('takes the controllers a host names, known ones, once each, in its order', () => {
    expect(layoutControllers({ modes: [Mode.point], controllers: ['face.hand', 'bridge.gamepad', 'face.hand', 'face.wii'], tray: [] }))
      .toEqual([Controller.hand, Controller.wii])
  })

  it('maps each mode to its controller, the Point face by the layout', () => {
    expect(controllerOf(Mode.gamepad)).toBe(Controller.gamepad)
    expect(controllerOf(Mode.point)).toBe(Controller.wii)
    expect(controllerOf(Mode.point, { point: 'mouse' })).toBe(Controller.mouse)
    expect(controllerOf(Mode.track)).toBe(Controller.hand)
    for (const m of [Mode.hold, Mode.tilt, Mode.orbit, Mode.pad]) expect(controllerOf(m)).toBe(Controller.trackpad)
    expect(controllerOf(42 as never)).toBeNull()
  })
})

describe('mode{m, c, p}: what a device says it uses (CATALOGUE §9.4)', () => {
  it('reads the controller and the profile a device names', () => {
    expect(readMode({ m: Mode.gamepad, c: 'face.wheel', p: 'driving' })).toEqual({ controller: 'face.wheel', profile: 'driving' })
    // A newer device's controller, or a community profile, passes as long as it is well formed.
    expect(readMode({ m: Mode.gamepad, c: 'bridge.gamepad', p: 'my-crane' })).toEqual({ controller: 'bridge.gamepad', profile: 'my-crane' })
  })

  it('takes a device that says only mode{m} (every phone before controllers) to use what its mode stands for', () => {
    expect(readMode({ m: Mode.point })).toEqual({ controller: 'face.wii' })
    expect(readMode({ m: Mode.point }, { point: 'mouse' })).toEqual({ controller: 'face.mouse' })
    expect(readMode({ m: Mode.tilt })).toEqual({ controller: 'face.trackpad' })
  })

  it('drops what is malformed, and falls back to the mode for a bad controller', () => {
    expect(readMode({ m: Mode.track, c: 'Face.Hand', p: 'Not A Profile' })).toEqual({ controller: 'face.hand' })
    expect(readMode({ m: Mode.track, c: 42, p: { id: 'x' } })).toEqual({ controller: 'face.hand' })
    expect(readMode({ m: Mode.track, c: `face.${'x'.repeat(40)}` })).toEqual({ controller: 'face.hand' })
    expect(readMode({ m: 'point', c: 7 })).toEqual({})
    expect(readMode({})).toEqual({})
  })
})

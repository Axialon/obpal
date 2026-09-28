import { describe, expect, it } from 'vitest'
import { Controller, CONTROLLER_IDS, Mode, withControllers, type ControllerId, type Layout } from '../packages/core/src/index'
import { barSlots, byFit, choiceFor, controllerOn, fallback, FACE_OF, rateControllers, type Rating, type RatedLayout } from '../src/controller/ratings'

const fits = (r: Rating[]) => Object.fromEntries(r.map((x) => [x.id, x.fit]))
const phone = { motion: true }
const keyboard = { id: 'keyboard', label: 'Keyboard', type: 'keyboard' as const, icon: 'keyboard' }
/** A layout as a host sends it: the SDK fills in the fields older phones read (withControllers). */
const sent = (l: Partial<Layout>): Layout => withControllers({ v: 1, tray: [], ...l })

describe('the ratings: how well each controller fits the screen (CATALOGUE §9.2)', () => {
  it('rates a sim by the controllers it names, best first: the first is best, the others good, what it takes besides works', () => {
    // The rover: the steering wheel suits it best, then the gamepad, the trackpad and the Wii remote.
    const rover = sent({ controllers: [Controller.wheel, Controller.gamepad, Controller.trackpad, Controller.wii], profile: 'driving' })
    const r = rateControllers(rover, phone, 'Rover')
    expect(fits(r)).toEqual({
      'face.gamepad': 2, 'face.wheel': 3, 'face.wii': 2, 'face.mouse': 1, 'face.trackpad': 2, 'face.hand': 0, 'face.keyboard': 0, 'face.drums': 0, 'face.keys': 0,
    })
    expect(r.filter((x) => x.best).map((x) => x.id)).toEqual([Controller.wheel])
    expect(r.find((x) => x.id === Controller.hand)!.why).toBe('Rover doesn’t take 3D motion')
    expect(r.find((x) => x.id === Controller.drums)!.why).toBe('Drums play on a music screen')
    expect(r.find((x) => x.id === Controller.keyboard)!.why).toBe('Rover doesn’t take typing')
    // Everything it takes says nothing against it.
    for (const x of r) expect(x.why === '').toBe(x.fit > 0)
  })

  it('comes back in the catalogue’s order, one rating per controller', () => {
    expect(rateControllers({ tray: [] }, phone).map((x) => x.id)).toEqual(CONTROLLER_IDS)
  })

  it('takes a screen that names no controllers (every host before them) at its modes: their faces are good, the first mode’s best', () => {
    // The Viewer lists modes only: tilt first, so the trackpad is its best.
    const viewer: RatedLayout = { modes: [Mode.tilt, Mode.hold, Mode.point, Mode.track, Mode.gamepad], tray: [] }
    const r = rateControllers(viewer, phone)
    expect(fits(r)).toEqual({
      'face.gamepad': 2, 'face.wheel': 1, 'face.wii': 2, 'face.mouse': 1, 'face.trackpad': 3, 'face.hand': 2, 'face.keyboard': 0, 'face.drums': 0, 'face.keys': 0,
    })
    expect(r.filter((x) => x.best).map((x) => x.id)).toEqual([Controller.trackpad])
    // Listed the other way round, the gamepad is.
    expect(rateControllers({ ...viewer, modes: [Mode.gamepad, Mode.tilt] }, phone).find((x) => x.best)?.id).toBe(Controller.gamepad)
    // No modes at all is what phones showed without them: the trackpad and the Wii remote.
    expect(fits(rateControllers({ tray: [] }, phone))).toMatchObject({ 'face.trackpad': 3, 'face.wii': 2, 'face.gamepad': 0, 'face.hand': 0 })
  })

  it('reads ob.Pal Link on the PC: the air mouse is its pointing face, the keyboard is in its tray, a suggested profile is best', () => {
    const pc: RatedLayout = { modes: [Mode.gamepad, Mode.tilt, Mode.point], point: 'mouse', tray: [keyboard] }
    expect(fits(rateControllers(pc, phone))).toMatchObject({ 'face.mouse': 2, 'face.wii': 1, 'face.keyboard': 2, 'face.gamepad': 3, 'face.trackpad': 2, 'face.hand': 0 })
    // A racing site: Link suggests Driving, and the steering wheel is best; any other profile tunes the gamepad.
    const racing = rateControllers({ ...pc, profile: 'driving' }, phone)
    expect(racing.find((x) => x.best)?.id).toBe(Controller.wheel)
    expect(rateControllers({ ...pc, profile: 'flight' }, phone).find((x) => x.best)?.id).toBe(Controller.gamepad)
    // A profile it can't use gives way to its first mode.
    expect(rateControllers({ modes: [Mode.point], tray: [], profile: 'driving' }, phone).find((x) => x.best)?.id).toBe(Controller.wii)
  })

  it('lets music faces in only where a screen names them', () => {
    const studio = sent({ controllers: [Controller.drums, Controller.keys] })
    expect(fits(rateControllers(studio, phone))).toMatchObject({ 'face.drums': 3, 'face.keys': 2, 'face.trackpad': 0, 'face.gamepad': 0 })
    // The pad mode alone brings neither.
    expect(fits(rateControllers({ modes: [Mode.pad], tray: [] }, phone))).toMatchObject({ 'face.drums': 0, 'face.keys': 0 })
  })

  it('follows the utilities a screen takes: without tilt steering the wheel is out, and says so', () => {
    const r = rateControllers({ modes: [Mode.gamepad], utilities: ['pad', 'motion.aim'], tray: [] }, phone, 'Arcade')
    expect(fits(r)).toMatchObject({ 'face.gamepad': 3, 'face.wheel': 0 })
    expect(r.find((x) => x.id === Controller.wheel)!.why).toBe('Arcade doesn’t take tilt steering')
    // The trackpad needs any one of touch, 1:1 or tilt.
    expect(fits(rateControllers({ modes: [Mode.tilt], utilities: ['motion.tilt'], tray: [] }, phone))['face.trackpad']).toBe(3)
    expect(fits(rateControllers({ modes: [Mode.tilt], utilities: ['pad'], tray: [] }, phone))['face.trackpad']).toBe(0)
  })

  it('marks what needs motion on a phone without it, and nothing on a phone with it', () => {
    const viewer: RatedLayout = { modes: [Mode.tilt, Mode.point, Mode.track, Mode.gamepad], tray: [] }
    const still = rateControllers(viewer, { motion: false }).filter((x) => x.needsMotion).map((x) => x.id)
    expect(still).toEqual([Controller.wheel, Controller.wii, Controller.mouse])
    expect(rateControllers(viewer, phone).some((x) => x.needsMotion)).toBe(false)
  })

  it('shrugs off a malformed layout', () => {
    const odd = { modes: 'nope', controllers: 'face.wii', tray: null, utilities: 7 } as unknown as RatedLayout
    const r = rateControllers(odd, phone)
    expect(r).toHaveLength(CONTROLLER_IDS.length)
    expect(fits(r)).toMatchObject({ 'face.trackpad': 3, 'face.wii': 2 })
  })
})

describe('the controller bar and switching', () => {
  const rover = sent({ controllers: [Controller.wheel, Controller.gamepad, Controller.trackpad, Controller.wii] })
  const sorted = byFit(rateControllers(rover, phone), rover)

  it('sorts best first, then in the screen’s order, then the catalogue’s', () => {
    expect(sorted.map((x) => x.id)).toEqual([
      Controller.wheel, Controller.gamepad, Controller.trackpad, Controller.wii, Controller.mouse, Controller.hand, Controller.keyboard, Controller.drums, Controller.keys,
    ])
  })

  it('gives each face the screen takes one slot, its best controller in it, or the one in use', () => {
    expect(barSlots(sorted, Controller.trackpad)).toEqual([
      { face: 'gamepad', id: Controller.wheel }, { face: 'rotate', id: Controller.trackpad }, { face: 'point', id: Controller.wii },
    ])
    // Picking the gamepad (the wheel's face) or the air mouse (the Wii remote's) keeps the bar's order.
    expect(barSlots(sorted, Controller.gamepad).map((s) => s.id)).toEqual([Controller.gamepad, Controller.trackpad, Controller.wii])
    expect(barSlots(sorted, Controller.mouse).map((s) => s.id)).toEqual([Controller.wheel, Controller.trackpad, Controller.mouse])
    // A controller the screen doesn't take never stands in its face's slot.
    expect(barSlots(sorted, Controller.hand).map((s) => s.face)).toEqual(['gamepad', 'rotate', 'point'])
  })

  it('moves off a controller the screen stops taking, to the best it takes', () => {
    expect(fallback(sorted, Controller.trackpad)).toBe(Controller.trackpad)
    expect(fallback(sorted, Controller.hand)).toBe(Controller.wheel)
    // The keyboard has no face to show: it is never where the phone moves to.
    const typing = rateControllers({ modes: [], controllers: [Controller.keyboard], tray: [keyboard] }, phone)
    expect(fallback(byFit(typing, { tray: [] }), Controller.trackpad)).toBe(null)
  })

  it('picks a controller as a face and a variant, and reads it back the same', () => {
    for (const id of CONTROLLER_IDS) {
      const c = choiceFor(id)
      if (id === Controller.keyboard) { expect(c).toBe(null); continue }
      expect(c!.face).toBe(FACE_OF[id])
      const back = controllerOn(c!.face, { point: c!.point ?? 'wii', wheel: c!.wheel ?? false })
      expect(back).toBe(id as ControllerId)
    }
    expect(controllerOn('point', { point: 'mouse', wheel: false })).toBe(Controller.mouse)
    expect(controllerOn('gamepad', { point: 'wii', wheel: true })).toBe(Controller.wheel)
  })
})

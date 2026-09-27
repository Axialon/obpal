import { describe, expect, it } from 'vitest'
import { CONTROLLERS, hostButtons, isControllerId, isInputId, layoutControllers, Mode, qAxisAngle, withControllers } from '@obpal/core'
import { ARM_KINDS } from '../src/sim/arm/kinds'
import { faceParam, PROPOSED, SIMS, suiting } from '../src/sim/catalogue'
import { DEVICES, deviceById } from '../src/sim/devices/registry'
import { axis, DragStick, panTiltOf, readable, slopeOf, stick } from '../src/sim/devices/input'
import { joinText } from '../src/sim/devices/seats'
import { HOME, layoutOf, restInput } from '../src/sim/devices/types'

const D2R = Math.PI / 180

describe('the device registry', () => {
  it('has the first batch, each with a unique id, the controllers that suit it and how each drives it', () => {
    expect(DEVICES.map((d) => d.spec.id)).toEqual(['rover', 'drone', 'maze', 'ptz', 'lamp', 'claw'])
    for (const { spec } of DEVICES) {
      expect(spec.controllers.length).toBeGreaterThan(1)
      for (const c of spec.controllers) {
        expect(isControllerId(c)).toBe(true)
        expect(spec.how[c], `${spec.id}: how for ${c}`).toBeTruthy()
      }
      expect(spec.unitNames?.length ?? spec.units).toBe(spec.units)
      expect(deviceById(spec.id)?.spec).toBe(spec)
    }
  })

  it('offers each device’s controllers to every phone, old or new: the layout names them, and its modes follow', () => {
    for (const { spec } of DEVICES) {
      const layout = withControllers(layoutOf(spec))
      expect(layoutControllers(layout)).toEqual(spec.controllers)
      for (const c of spec.controllers) for (const m of CONTROLLERS[c].modes) expect(layout.modes, `${spec.id}: ${c}`).toContain(m)
      // A keyboard in the list puts one in the tray; the steering wheel first suggests the Driving profile.
      expect(layout.tray.some((t) => t.type === 'keyboard')).toBe(spec.controllers.includes('face.keyboard'))
      if (spec.controllers[0] === 'face.wheel') expect(layout.profile).toBe('driving')
      expect(layout.tray).toContainEqual(HOME)
      expect(new Set(layout.tray.map((t) => t.id)).size).toBe(layout.tray.length)
    }
  })

  it('offers one Point face (the Wii remote or the air mouse share the phone’s Point tab: the host picks one)', () => {
    for (const { spec } of DEVICES) expect(spec.controllers.includes('face.wii') && spec.controllers.includes('face.mouse'), spec.id).toBe(false)
  })

  it('suggests buttons a phone can press: real inputs, bound to something on each of its controllers', () => {
    for (const { spec } of DEVICES) {
      const layout = layoutOf(spec)
      for (const [input, target] of Object.entries(layout.buttons ?? {})) {
        expect(isInputId(input), `${spec.id}: ${input}`).toBe(true)
        // Tray buttons it has, or a control of at least one of its controllers.
        if (target.startsWith('tray:')) expect(layout.tray.some((t) => t.id === target.slice(5)), `${spec.id}: ${target}`).toBe(true)
        else expect(spec.controllers.some((c) => hostButtons(layout, c)[input] === target), `${spec.id}: ${input} -> ${target}`).toBe(true)
      }
    }
  })

  it('makes each device’s logic, which rests when nobody holds it', () => {
    for (const d of DEVICES) {
      const logic = d.logic()
      for (let i = 0; i < 60; i++) logic.step(Array.from({ length: d.spec.units }, () => null), 1 / 60)
      for (let n = 0; n < d.spec.units; n++) expect(logic.readout(n)).toBeTruthy()
      expect(logic.drain()).toEqual([])
    }
  })
})

describe('the sim catalogue', () => {
  it('lists every device, the arms, the arena and the Viewer, and proposes more', () => {
    const ids = SIMS.map((s) => s.id)
    for (const d of DEVICES) expect(ids).toContain(d.spec.id)
    expect(ids).toEqual(expect.arrayContaining(['arena', 'viewer']))
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of SIMS) expect(s.href).toBeTruthy()
    for (const s of PROPOSED) expect(s.href).toBeNull()
  })

  it('has a card for each kind of arm the arm sim has, trying it in that kind, with its own preview', () => {
    const arms = SIMS.filter((s) => s.kind === 'Arm')
    expect(arms.map((s) => s.id)).toEqual(ARM_KINDS.map((k) => `arm-${k.id}`))
    arms.forEach((s, i) => {
      const k = ARM_KINDS[i]
      expect([s.name, s.blurb, s.href, s.controllers]).toEqual([k.name, k.blurb, `/sim/arm/?kind=${k.id}`, k.controllers])
      for (const c of s.controllers) expect(s.how?.[c], `${s.id}: how for ${c}`).toBeTruthy()
      expect(typeof s.preview).toBe('function')
    })
  })

  it('filters by controller, and reads ?face= as a short name or an id', () => {
    const wii = suiting(SIMS, 'face.wii').map((s) => s.id)
    expect(wii).toEqual(expect.arrayContaining(['rover', 'ptz', 'claw', 'arm-scara', 'arm-delta', 'viewer']))
    expect(wii).not.toContain('maze')
    expect(suiting(SIMS, 'face.keyboard').map((s) => s.id)).toEqual(['lamp'])
    expect(suiting(SIMS, null).length).toBe(SIMS.length)
    // Every controller has somewhere to try it.
    for (const c of Object.keys(CONTROLLERS)) expect(suiting(SIMS, c).length, c).toBeGreaterThan(0)
    expect(faceParam('wii')).toBe('face.wii')
    expect(faceParam('face.hand')).toBe('face.hand')
    expect(faceParam('joystick')).toBeNull()
    expect(faceParam(null)).toBeNull()
  })
})

describe('reading a phone', () => {
  it('sticks past a deadzone keep their direction and still reach 1', () => {
    expect(stick(0.1, 0)).toEqual([0, 0])
    const [x, y] = stick(0.6, 0.8)
    expect(Math.hypot(x, y)).toBeCloseTo(1)
    expect(x / y).toBeCloseTo(0.75)
    expect(axis(-1)).toBe(-1)
    expect(axis(0.05)).toBe(0)
  })

  it('the trackpad’s floating stick centres where the thumb lands, follows it past the rim, and centres on lifting', () => {
    const s = new DragStick(100)
    expect(s.update(true, [50, 0])).toEqual([0.5, 0])
    expect(s.update(true, [100, 0])).toEqual([1, 0])
    // Past the rim the centre moved: pulling back 50 px is half way already.
    expect(s.update(true, [-50, 0])).toEqual([0.5, 0])
    expect(s.update(false, [0, 0])).toEqual([0, 0])
  })

  it('a 1:1 turn reads as a pan and tilt, or a tray’s slope', () => {
    const [pan] = panTiltOf(qAxisAngle(0, 1, 0, 30 * D2R))
    expect(pan / D2R).toBeCloseTo(30)
    const [sx, sz] = slopeOf(qAxisAngle(0, 0, 1, -10 * D2R))
    expect(sx).toBeCloseTo(Math.sin(10 * D2R))
    expect(sz).toBeCloseTo(0)
  })

  it('typing that arrives in pieces joins up, deletes included', () => {
    expect(joinText({ text: 'te', del: 0 }, 'al', 0)).toEqual({ text: 'teal', del: 0 })
    expect(joinText({ text: 'tea', del: 0 }, 'x', 1)).toEqual({ text: 'tex', del: 0 })
    expect(joinText({ text: 'a', del: 2 }, 'b', 3)).toEqual({ text: 'b', del: 4 })
  })

  it('readouts at a glance', () => {
    expect(readable(123.4)).toBe('123')
    expect(readable(7.25)).toBe('7.3')
    expect(readable(7)).toBe('7')
    expect(readable(0.456)).toBe('0.46')
    expect(readable(0.001)).toBe('0')
  })

  it('a phone at rest presses nothing', () => {
    const r = restInput('face.wii', Mode.point)
    expect([r.presses.length, r.held.size, r.wheel, r.text]).toEqual([0, 0, 0, ''])
  })
})

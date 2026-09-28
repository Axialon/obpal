import { describe, expect, it } from 'vitest'
import { Mode } from '@obpal/core'
import { routeParts, sceneParts, TILT_PX } from '../src/sim/devices/focus'
import { restInput, type DeviceInput, type DeviceSpec } from '../src/sim/devices/types'
import { DEVICES } from '../src/sim/devices/registry'
import { EXCAVATOR_SPEC, ExcavatorLogic } from '../src/sim/devices/excavator'
import { FORKLIFT_SPEC } from '../src/sim/devices/forklift'
import { GIMBAL_SPEC } from '../src/sim/devices/gimbal'

const pad = (over: Partial<DeviceInput> = {}): DeviceInput => ({ ...restInput('face.trackpad', Mode.tilt), touching: true, ...over })
const focus = (parts: string[], locks: string[] = []) => ({ parts, locks: new Set(locks) })

describe('the node strip on a device: the one finger drives the chosen parts (./focus.ts)', () => {
  it('leaves the whole unit to its own mapping, and every other controller alone', () => {
    const i = pad({ drag: [5, -3], pan: [2, 1] })
    expect(routeParts(EXCAVATOR_SPEC, i, focus([]), 1 / 60)).toBe(i)
    const gp = { ...i, face: 'face.gamepad' }
    expect(routeParts(EXCAVATOR_SPEC, gp, focus(['boom']), 1 / 60)).toBe(gp)
  })

  it('gives one part the drag either way (across or up is on), in its own gesture, and drops the rest', () => {
    // The stick reads two fingers up and down: a finger up (or right) moves it on, as two fingers up would.
    const out = routeParts(EXCAVATOR_SPEC, pad({ drag: [4, -6], pan: [3, 3], twist: 9, pinch: 0.2 }), focus(['stick']), 1 / 60)
    expect(out.drag).toEqual([0, 0])
    expect(out.pan).toEqual([0, -10])
    expect(out.twist).toBe(0)
    expect(out.pinch).toBe(0)
  })

  it('hands a set’s parts the finger across, then up and down, then two fingers', () => {
    // Reach: the stick across, the boom up and down.
    const out = routeParts(EXCAVATOR_SPEC, pad({ drag: [4, -6], pan: [0, 5] }), focus(['stick', 'boom']), 1 / 60)
    expect(out.pan).toEqual([0, -4])
    expect(out.drag).toEqual([0, -6])
  })

  it('adds tilt to the finger while it’s down, and not without it', () => {
    const tilted = routeParts(EXCAVATOR_SPEC, pad({ tilt: [0.5, 0] }), focus(['swing']), 0.1)
    expect(tilted.drag[0]).toBeCloseTo(0.5 * TILT_PX * 0.1)
    expect(tilted.tilt).toEqual([0, 0])
    expect(routeParts(EXCAVATOR_SPEC, pad({ tilt: [0.5, 0], touching: false }), focus(['swing']), 0.1).drag).toEqual([0, 0])
  })

  it('holds a locked part: its gestures are dropped for the whole unit, and it moves nothing in a set', () => {
    const whole = routeParts(EXCAVATOR_SPEC, pad({ drag: [4, -6], pan: [2, 3] }), focus([], ['boom', 'bucket']), 1 / 60)
    expect(whole.drag).toEqual([4, 0])
    expect(whole.pan).toEqual([0, 3])
    const set = routeParts(EXCAVATOR_SPEC, pad({ drag: [4, -6] }), focus(['stick', 'boom'], ['stick']), 1 / 60)
    expect(set.pan).toEqual([0, 0])
    expect(set.drag).toEqual([0, -6])
  })

  it('lets a drive left behind centre (its stick hears the finger lift), and gives it both axes when chosen', () => {
    const lift = routeParts(FORKLIFT_SPEC, pad({ drag: [0, -8] }), focus(['lift']), 1 / 60)
    expect(lift.touching).toBe(false)
    expect(lift.pan).toEqual([0, -8])
    const drive = routeParts(FORKLIFT_SPEC, pad({ drag: [3, -8] }), focus(['drive']), 1 / 60)
    expect(drive.touching).toBe(true)
    expect(drive.drag).toEqual([3, -8])
  })

  it('keeps the 1:1 turn only when every part it moves is chosen', () => {
    const q = [0, 0, 0.1, 1] as [number, number, number, number]
    expect(routeParts(GIMBAL_SPEC, pad({ hold: q }), focus(['roll']), 1 / 60).hold).toBeNull()
    expect(routeParts(GIMBAL_SPEC, pad({ hold: q }), focus(['pan', 'tilt', 'roll']), 1 / 60).hold).toBe(q)
  })

  it('moves only the chosen part of an excavator, and the next from where it is when the choice changes mid-drag', () => {
    const logic = new ExcavatorLogic()
    const u = logic.units[0]
    const at = { ...u }
    const drag = (parts: string[]) => logic.step([routeParts(EXCAVATOR_SPEC, pad({ mode: Mode.hold, drag: [0, -10] }), focus(parts), 1 / 60)], 1 / 60)
    for (let n = 0; n < 5; n++) drag(['boom'])
    expect(u.boom).toBeGreaterThan(at.boom + 0.1)
    for (const k of ['swing', 'stick', 'curl'] as const) expect(u[k], k).toBeCloseTo(at[k], 9)
    const boom = u.boom
    drag(['stick'])
    expect(u.boom).toBe(boom)
    expect(u.stick).toBeCloseTo(at.stick + 0.03)
  })
})

describe('every device’s parts and sets', () => {
  const channels = new Set(['drag.x', 'drag.y', 'pan.x', 'pan.y', 'twist', 'pinch'])
  const withParts = DEVICES.map((d) => d.spec).filter((s): s is DeviceSpec & { parts: NonNullable<DeviceSpec['parts']> } => !!s.parts?.length)

  it('are offered on the unit’s scene node', () => {
    expect(withParts.map((s) => s.id).sort()).toEqual(['excavator', 'forklift', 'gimbal', 'jib', 'painter', 'ptz', 'slider', 'tank', 'telescope'])
    expect(sceneParts(EXCAVATOR_SPEC)).toMatchObject({ parts: [{ id: 'swing' }, { id: 'boom' }, { id: 'stick' }, { id: 'bucket' }], sets: [{ id: 'reach', parts: ['stick', 'boom'], locks: true }, { id: 'dig' }] })
    expect(sceneParts(DEVICES.find((d) => d.spec.id === 'rover')!.spec)).toEqual({})
  })

  it('name real gestures, distinct ids, sets of their own parts, and a trackpad that reaches them', () => {
    for (const s of withParts) {
      const ids = s.parts.map((p) => p.id)
      expect(new Set([...ids, ...(s.sets ?? []).map((x) => x.id)]).size, s.id).toBe(ids.length + (s.sets?.length ?? 0))
      for (const p of s.parts) {
        expect(p.channels.length, `${s.id} ${p.id}`).toBeGreaterThan(0)
        for (const c of p.channels) expect(channels.has(c), `${s.id} ${p.id} ${c}`).toBe(true)
      }
      for (const set of s.sets ?? []) {
        expect(set.parts.length, `${s.id} ${set.id}`).toBeGreaterThan(1)
        for (const id of set.parts) expect(ids, `${s.id} ${set.id}`).toContain(id)
      }
      expect(s.controllers, s.id).toContain('face.trackpad')
      expect(s.how['face.trackpad'], s.id).toBeTruthy()
    }
  })
})

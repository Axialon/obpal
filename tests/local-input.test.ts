import { describe, expect, it } from 'vitest'
import { emptyPad, Mode, PadButton, withControllers, type Layout } from '../packages/core/src/index'
import { LocalInput, chooseInput, liveInput, standardPad, type PadLike } from '../src/sim/local-input'
import { ALL_SIM_FACES, mapFaceInput } from '../src/sim/face-input'
import { restInput, type DeviceInput, type DeviceLogic } from '../src/sim/devices/types'
import { DEVICES } from '../src/sim/devices/registry'
import { DroneLogic } from '../src/sim/devices/drone'
import { rateControllers } from '../src/controller/ratings'

const pad = (index = 0): PadLike & { buttons: { pressed: boolean; value: number }[] } => ({ index, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) })
it('touch preference leaves input to Seats and source or unit changes release local keys', () => {
  const input = new LocalInput(() => 2)
  input.armed = true; input.key('KeyW', true); input.selectUnit(1)
  expect(input.armed).toBe(false); expect(input.keys.size).toBe(0)
  input.source = 'touch'; input.armed = true; input.key('KeyW', true)
  expect(input.read([pad()], true).size).toBe(0)
  input.disarm(); expect(input.armed).toBe(false); expect(input.keys.size).toBe(0)
})
/** Compare the state rendered by views, excluding input filters, event queues and physics diagnostics. */
const state = (logic: DeviceLogic) => JSON.stringify(Object.fromEntries(['units', 'rovers', 'drones', 'claws', 'lamps', 'boards', 'cams', 'cursor', 'counts'].filter(k => k in logic).map(k => [k, (logic as unknown as Record<string, unknown>)[k]])))
const faceInput = (face: string): DeviceInput => {
  const i = restInput(face, Mode.tilt)
  i.touching = true
  if (['face.gamepad', 'face.wheel'].includes(face)) { i.mode = Mode.gamepad; i.pad = { ...emptyPad(), axes: [.7, -.6, .6, -.5], triggers: [0, .8], buttons: 1 }; i.padPressed = 1 }
  else if (['face.wii', 'face.mouse'].includes(face)) { i.mode = Mode.point; i.point = { x: 700, y: 320, yaw: 20, pitch: 15, off: false }; i.spot = [1, 1]; i.held = new Set(['wii-b', 'mouse-left']); i.presses = ['wii-a', 'mouse-left'] }
  else if (face === 'face.hand') { i.mode = Mode.track; i.pose = { p: [.2, .3, -.2], q: [.15, .2, .1, Math.sqrt(1 - .0725)], tracked: true, touching: true, gen: 1 } }
  else if (face === 'hand') i.hand = { tracked: true, gen: 1, handedness: 'right', confidence: 1, gestures: 0, p: [.2, .3, -.2], landmarks: [] }
  else if (face === 'body') {
    const landmarks: [number, number, number][] = Array.from({ length: 33 }, () => [0, 0, 0])
    landmarks[16] = [.3, .3, 0]
    i.body = { tracked: true, gen: 1, t: 0, receivedAt: 0, landmarks, visibility: Array(33).fill(1), presence: Array(33).fill(1) }
  }
  else if (face === 'face.keys' || face === 'face.drums') i.values = [{ id: 'music.event', v: JSON.stringify({ op: 'hit', n: 1, v: .8, seq: 1, at: 0, uncertainty: 0, x: 0 }) }]
  else if (face === 'face.keyboard') { i.text = 'wd'; i.presses = ['key-ArrowUp'] }
  else if (face === 'tilt') i.tilt = [.7, -.6]
  else { i.drag = [8, -7]; i.pan = [7, -6]; i.tilt = [.7, -.6]; i.presses = ['pad'] }
  return i
}

describe('local controllers share the phone input boundary', () => {
  it('matches equivalent phone PAD input without a second deadzone curve', () => {
    const local = new LocalInput(() => 2); local.source = 'gamepad'; local.armed = true
    const p = { ...pad(), axes: [.7, -.6, .6, -.5] }
    const frame = local.read([p]).get(0)!
    const phone = { ...restInput(), pad: { ...emptyPad(), axes: [.7, -.6, .6, -.5] as [number, number, number, number] } }
    for (const entry of DEVICES) expect(mapFaceInput(entry.spec.id, entry.spec.controllers, frame, 1 / 60)).toEqual(mapFaceInput(entry.spec.id, entry.spec.controllers, phone, 1 / 60))
  })
  it('bounds finite axes, ignores small jitter, rejects non-standard mappings and supports d-pad', () => {
    expect(standardPad({ ...pad(), axes: [.04, -.06, NaN, Infinity] })?.axes).toEqual([0, 0, 0, 0])
    expect(standardPad({ ...pad(), axes: [7, -9, 0, 0] })?.axes).toEqual([1, -1, 0, 0])
    expect(standardPad({ ...pad(), mapping: '' })).toBe(null)
    const p = pad(); p.buttons[PadButton.Right] = { pressed: true, value: 1 }
    expect(standardPad(p)?.axes[0]).toBe(1)
  })
  it('keeps several pads on distinct units and releases on unplug, background and disarm', () => {
    const local = new LocalInput(() => 3); local.source = 'gamepad'; local.armed = true
    const a = pad(2), b = pad(7); a.buttons[0].pressed = true
    expect([...local.read([null, a, b]).keys()]).toEqual([0, 1])
    expect(local.read([a]).get(0)?.padPressed).toBe(0)
    expect(local.read([]).size).toBe(0)
    expect(local.read([a]).get(0)?.padPressed).toBe(1)
    expect(local.read([a], false).size).toBe(0)
    local.disarm(); expect(local.read([a]).size).toBe(0)
  })
  it('keeps assigned units when a new pad is inserted at an earlier API index', () => {
    const local = new LocalInput(() => 3); local.source = 'gamepad'; local.armed = true
    const a = pad(2), b = pad(7), c = pad(0)
    local.read([a, b]); expect([...local.read([c, a, b]).keys()]).toEqual([2, 0, 1])
  })
  it('requires explicit enable, consumes deltas once and clears held keys', () => {
    const local = new LocalInput(() => 1); local.source = 'keyboard'; local.key('KeyW', true)
    expect(local.read([]).size).toBe(0)
    local.armed = true; local.key('KeyW', true); local.key('Enter', true); local.move(30, -20); local.scroll(120)
    const first = local.read([]).get(0)!
    expect(first.pad?.axes[1]).toBe(-1); expect(first.padPressed).toBe(1); expect(first.wheel).toBe(120)
    expect(first.pad?.triggers[0]).toBe(1)
    expect(local.read([]).get(0)?.wheel).toBe(0)
    local.clear(); expect(local.read([]).get(0)?.pad?.axes).toEqual([0, 0, 0, 0])
    local.key('KeyE', true); local.key('KeyL', true)
    expect(local.read([]).get(0)?.pad?.axes[2]).toBe(1)
  })
  it('gives a claimed phone priority even when quiet, without leaking local actions', () => {
    const phone = { ...restInput(), quiet: true }, local = { ...restInput(), presses: ['fly'] }
    expect(chooseInput(phone, true, local)).toBe(phone)
    expect(chooseInput(null, true, local)).toBe(null)
    expect(chooseInput(null, false, local)).toBe(local)
  })
  it('rates every face as guidance on sims and preserves their recommendation', () => {
    const layout: Layout = withControllers({ v: 1 as const, universal: true, tray: [], controllers: ['face.trackpad'] })
    const ratings = rateControllers(layout, { motion: true })
    expect(ratings.every(r => r.fit >= 1)).toBe(true)
    expect(ratings.find(r => r.best)?.id).toBe('face.trackpad')
    expect(layout.modes).toContain(Mode.track)
  })
  it('expands a legacy sim layout with no named recommendations, including the arena', () => {
    const layout: Layout = withControllers({ v: 1 as const, universal: true, modes: [Mode.tilt, Mode.gamepad], tray: [] })
    expect(layout.modes).toContain(Mode.track)
    expect(layout.modes).toContain(Mode.pad)
    expect(layout.tray.some(c => c.type === 'keyboard')).toBe(true)
    expect(rateControllers(layout, { motion: true }).every(r => r.fit >= 1)).toBe(true)
    expect(rateControllers(layout, { motion: true }).find(r => r.best)?.id).toBe('face.trackpad')
  })
  it('keeps tracking deadmen and quiet input neutral in the fallback', () => {
    const i = faceInput('face.hand'); i.pose!.touching = false
    expect(mapFaceInput('kart', [], i, .016).pad?.axes).toEqual([0, 0, 0, 0])
    expect(mapFaceInput('drone', [], { ...i, quiet: true }, .016).pad).toBe(null)
  })
  it('holds after tracking loss even if a previous calibrated motion sample is still active', () => {
    for (const face of ['face.hand', 'hand', 'body']) {
      const i = faceInput(face)
      if (i.pose) i.pose.tracked = false
      if (i.hand) i.hand.tracked = false
      if (i.body) i.body.tracked = false
      i.space = { aim: [.8, .8], tilt: [.8, .8], active: true, pointer: false }
      const mapped = mapFaceInput('kart', [], i, .016)
      expect(mapped.pad).toEqual(emptyPad()); expect(mapped.touching).toBe(false)
    }
  })
  it('lets native pose consumers forget their clutch anchor on release', () => {
    const i = faceInput('face.hand'); i.pose!.touching = false
    expect(mapFaceInput('drone', ['face.hand'], i, .016)).toBe(i)
    expect(mapFaceInput('gimbal', ['face.hand'], i, .016).pad).toBe(null)
  })
  it('neutralises all local driver commands without a held deadman', () => {
    const i = faceInput('face.gamepad'); i.presses = ['fly']; i.wheel = 120
    const held = liveInput(i, true, true), released = liveInput(i, true, false)
    expect(held).toBe(i); expect(liveInput(i, false, false)).toBe(i)
    expect(released.pad).toEqual(emptyPad()); expect(released.padPressed).toBe(0)
    expect(released.presses).toEqual([]); expect(released.wheel).toBe(0)
    expect(liveInput({ ...i, presses: ['estop', 'home'] }, true, false).presses).toEqual(['estop'])
  })
  it('keeps a drone landed for horizontal movement and preserves the explicit takeoff action', () => {
    const entry = DEVICES.find(d => d.spec.id === 'drone')!, logic = new DroneLogic()
    const i = faceInput('face.gamepad'); i.pad!.buttons = 0; i.padPressed = 0
    i.pad!.axes[1] = 0; i.pad!.triggers = [0, 0]
    for (let n = 0; n < 90; n++) logic.step([mapFaceInput('drone', entry.spec.controllers, i, 1 / 60)], 1 / 60)
    expect(logic.drones[0].phase).toBe('landed')
    logic.step([{ ...i, presses: ['fly'] }], 1 / 60)
    expect(logic.drones[0].phase).toBe('takeoff')
  })
  it('maps keyboard dock typing even when the phone keeps its previous native face', () => {
    const i = restInput('face.gamepad'); i.text = 'wd'; i.pad = emptyPad()
    expect(mapFaceInput('kart', ['face.gamepad'], i, .016).pad?.axes.slice(0, 2)).toEqual([1, -1])
    i.presses = ['key-Enter']
    expect(mapFaceInput('kart', ['face.gamepad'], i, .016).pad?.buttons).toBe(1)
  })
})

describe('every face reaches every registry sim', () => {
  for (const entry of DEVICES) for (const face of ALL_SIM_FACES) it(`${entry.spec.id} accepts ${face} with bounded input and changes state`, () => {
    const logic = entry.logic(), reference = entry.logic()
    const raw = faceInput(face)
    if (entry.spec.id === 'drone') raw.presses = [...raw.presses, 'fly']
    let nonzero = false, changed = false
    for (let frame = 0; frame < 60; frame++) {
      if (raw.pose) raw.pose.p = [.2 + frame * .003, .3 + frame * .002, -.2 - frame * .003]
      const input = mapFaceInput(entry.spec.id, entry.spec.controllers, { ...raw, padPressed: frame === 0 ? raw.padPressed : 0, presses: frame === 0 ? raw.presses : [], values: frame === 0 ? raw.values : [], text: frame === 0 ? raw.text : '' }, 1 / 60)
      const channels = [...(input.pad?.axes ?? []), ...input.tilt, ...input.drag, ...input.pan, ...(input.pose?.p ?? [])]
      expect(channels.every(Number.isFinite)).toBe(true)
      expect(input.pad?.axes.every(v => Math.abs(v) <= 1) ?? true).toBe(true)
      nonzero ||= channels.some(v => Math.abs(v) > 0) || !!input.padPressed || !!input.presses.length
      logic.step([input], 1 / 60); reference.step([null], 1 / 60)
      // A one-packet jog can return to rest. It must visibly actuate before it does, beyond autonomous physics.
      changed ||= state(logic) !== state(reference)
    }
    expect(nonzero).toBe(true)
    expect(changed).toBe(true)
  })
})

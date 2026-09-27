import { describe, expect, it } from 'vitest'
import { Mode, qAxisAngle } from '@obpal/core'
import { hsvOf, LampLogic, nameOf, parseLamp, rgbOf } from '../src/sim/devices/lamp'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

const D2R = Math.PI / 180
const pad = (over: Partial<DeviceInput>): DeviceInput => ({ ...restInput('face.trackpad', Mode.hold), ...over })
const one = () => { const logic = new LampLogic(1); return { logic, l: logic.lamps[0] } }

describe('smart lamps: words typed on the phone', () => {
  it('reads colours by name and #hex, brightness, on, off and party', () => {
    expect(parseLamp('teal')).toMatchObject({ h: 174, on: true })
    expect(parseLamp('warm 40%')).toMatchObject({ h: 34, v: 0.4 })
    expect(parseLamp('#ff8800')).toMatchObject({ h: 32, s: 1, v: 1 })
    expect(parseLamp('0ff')).toMatchObject({ h: 180 })
    expect(parseLamp('Off')).toEqual({ on: false })
    expect(parseLamp('party')).toMatchObject({ party: true, on: true })
    expect(parseLamp('warm white')!.s).toBeCloseTo(0.3)
    expect(parseLamp('make it dim please')).toEqual({ v: 0.25 })
    expect(parseLamp('bananas')).toBeNull()
    expect(parseLamp('   ')).toBeNull()
  })

  it('shows what’s being typed on the lamp, and keeps it on Enter', () => {
    const { logic, l } = one()
    logic.step([pad({ face: 'face.keyboard', text: 'tea' })], 1 / 60)
    expect(l.draft).toBeNull()
    logic.step([pad({ face: 'face.keyboard', text: 'l' })], 1 / 60)
    expect(l.draft).toMatchObject({ h: 174 })
    expect(logic.readout(0)).toBe('“teal”')
    logic.step([pad({ face: 'face.keyboard', text: '\n' })], 1 / 60)
    expect(l.h).toBe(174)
    expect(l.draft).toBeNull()
    expect(logic.drain().at(-1)!.text).toBe('Floor lamp: 80% teal')
  })

  it('deletes as the phone deletes, and Esc clears; a word it doesn’t know says so', () => {
    const { logic, l } = one()
    logic.step([pad({ text: 'rosy' })], 1 / 60)
    logic.step([pad({ del: 1 })], 1 / 60)
    expect(l.typing).toBe('ros')
    logic.step([pad({ presses: ['key-Escape'] })], 1 / 60)
    expect(l.typing).toBe('')
    logic.step([pad({ text: 'bananas\n' })], 1 / 60)
    expect(logic.drain().at(-1)).toMatchObject({ kind: 'bump' })
  })
})

describe('smart lamps: each controller sets them', () => {
  it('trackpad: dragging across turns the colour, up brightens, twisting turns it too, a tap switches it', () => {
    const { logic, l } = one()
    const h0 = l.h, v0 = l.v
    logic.step([pad({ drag: [40, -25] })], 1 / 60)
    expect(l.h).toBeCloseTo(h0 + 20)
    expect(l.v).toBeCloseTo(v0 + 0.1)
    logic.step([pad({ twist: 30 })], 1 / 60)
    expect(l.h).toBeCloseTo(h0 + 50)
    logic.step([pad({ presses: ['pad'] })], 1 / 60)
    expect(l.on).toBe(false)
  })

  it('trackpad 1:1: the phone is a dial for the colour', () => {
    const { logic, l } = one()
    const h0 = l.h
    logic.step([pad({ hold: [0, 0, 0, 1] })], 1 / 60)
    logic.step([pad({ hold: qAxisAngle(0, 0, 1, 90 * D2R) })], 1 / 60)
    expect(l.h).toBeCloseTo(h0 + 90, 0)
  })

  it('air mouse: the wheel dims (up brightens), Left switches it, Right goes to the next scene', () => {
    const { logic, l } = one()
    const point = { x: 0, y: 0, yaw: 0, pitch: 0, off: false }
    logic.step([pad({ face: 'face.mouse', mode: Mode.point, point, wheel: 240 })], 1 / 60)
    expect(l.v).toBeCloseTo(0.7)
    logic.step([pad({ face: 'face.mouse', mode: Mode.point, point, presses: ['mouse-left'] })], 1 / 60)
    expect(l.on).toBe(false)
    logic.step([pad({ face: 'face.mouse', mode: Mode.point, point, presses: ['mouse-right'] })], 1 / 60)
    expect(l.on).toBe(true)
  })

  it('Wii remote: holding B and sweeping paints it; − and + dim; A switches it', () => {
    const { logic, l } = one()
    const at = (yaw: number, pitch: number, held: string[] = [], presses: string[] = []) => pad({ face: 'face.wii', mode: Mode.point, point: { x: 0, y: 0, yaw, pitch, off: false }, held: new Set(held), presses })
    const h0 = l.h, v0 = l.v
    logic.step([at(0, 0, ['wii-b'])], 1 / 60)
    logic.step([at(10, 5, ['wii-b'])], 1 / 60)
    expect(l.h).toBeCloseTo(h0 + 60)
    expect(l.v).toBeCloseTo(v0 + 0.15)
    logic.step([at(20, 5)], 1 / 60)
    expect(l.h).toBeCloseTo(h0 + 60)
    logic.step([at(0, 0, [], ['wii-minus'])], 1 / 60)
    expect(l.v).toBeCloseTo(v0 + 0.05)
    logic.step([at(0, 0, [], ['wii-a'])], 1 / 60)
    expect(l.on).toBe(false)
  })

  it('the tray: On and off, and a scene', () => {
    const { logic, l } = one()
    logic.step([pad({ presses: ['power'] })], 1 / 60)
    expect(l.on).toBe(false)
    logic.step([pad({ values: [{ id: 'scene', v: 'relax' }] })], 1 / 60)
    expect([l.on, l.v]).toEqual([true, 0.35])
  })
})

describe('smart lamps: within their limits', () => {
  it('brightness stays between a glimmer and full, and the hue goes round', () => {
    const { logic, l } = one()
    for (let i = 0; i < 20; i++) logic.step([pad({ drag: [200, -300], pinch: 3 })], 1 / 60)
    expect(l.v).toBe(1)
    expect(l.h).toBeGreaterThanOrEqual(0)
    expect(l.h).toBeLessThan(360)
    for (let i = 0; i < 20; i++) logic.step([pad({ drag: [0, 300] })], 1 / 60)
    expect(l.v).toBeCloseTo(0.02)
  })

  it('off is dark; a colour is its RGB; Home is warm white again', () => {
    const { logic, l } = one()
    expect(hsvOf('ff0000')).toEqual({ h: 0, s: 1, v: 1 })
    Object.assign(l, { h: 120, s: 1, v: 1 })
    expect(rgbOf(l).map((c) => Math.round(c * 255))).toEqual([0, 255, 0])
    l.on = false
    expect(rgbOf(l)).toEqual([0, 0, 0])
    expect(nameOf(l)).toBe('Off')
    logic.home(0)
    expect(logic.readout(0)).toBe('80% warm')
  })
})

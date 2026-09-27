import { Controller, Mode, checkButtons, offerOf, resolveButtons } from '@obpal/core'
import { describe, expect, it } from 'vitest'
import { SMARTHOME_SPEC, SmarthomeLogic, roomChannel, roomSetpoint } from '../src/sim/devices/smarthome'
import { layoutOf, restInput } from '../src/sim/devices/types'

describe('smart home room', () => {
  it('offers four independently named appliances and valid physical bindings', () => {
    expect(SMARTHOME_SPEC.units).toBe(4)
    expect(SMARTHOME_SPEC.unitNames).toEqual(['Blinds', 'Ceiling fan', 'Television', 'Thermostat'])
    expect(SMARTHOME_SPEC.controllers[0]).toBe(Controller.trackpad)
    const layout = layoutOf(SMARTHOME_SPEC)
    for (const face of SMARTHOME_SPEC.controllers) {
      expect(checkButtons(face, layout.buttons).errors).toEqual([])
      expect(resolveButtons(face, [layout.buttons], offerOf(layout))['key:KeyM']).toBe('tray:movie')
    }
  })

  it('raises blinds from a drag and switches them with a tap', () => {
    const logic = new SmarthomeLogic(), input = restInput(Controller.trackpad, Mode.pad)
    input.drag = [0, -60]
    logic.step([input], 0.05)
    expect(logic.units[0].target).toBeCloseTo(0.95)
    expect(logic.units[0].level).toBeGreaterThan(0.7)
    input.drag = [0, 0]; input.presses = ['pad']
    logic.step([input], 0.05)
    expect(logic.units[0].on).toBe(false)
    expect(logic.units[0].actions).toBe(1)
    expect(logic.drain()[0].text).toBe('Blinds off')
  })

  it('uses a mouse wheel for the claimed appliance and bounds every setting', () => {
    const logic = new SmarthomeLogic(), input = restInput(Controller.mouse, Mode.point)
    input.wheel = -12000
    logic.step([null, input, null, input], 0.05)
    expect(logic.units[1].target).toBe(1)
    expect(roomSetpoint(logic.units[3])).toBe(30)
    expect(logic.units[0].target).toBe(0.7)
    input.wheel = 12000
    logic.step([null, input, input, input], 0.05)
    expect(logic.units[1].target).toBe(0)
    expect(roomSetpoint(logic.units[3])).toBe(16)
    expect(roomChannel(logic.units[2])).toBe(0)
  })

  it('makes Movie and Morning coordinate the entire room from any seat', () => {
    const logic = new SmarthomeLogic(), input = restInput()
    input.presses = ['movie']
    logic.step([null, null, input], 0.05)
    expect(logic.scene).toBe('Movie')
    expect(logic.units[0].target).toBe(0)
    expect(logic.units[2].on).toBe(true)
    expect(logic.units[2].actions).toBe(1)
    input.presses = ['morning']
    logic.step([null, input], 0.05)
    expect(logic.scene).toBe('Morning')
    expect(logic.units[0].target).toBe(1)
    expect(logic.units[2].on).toBe(false)
    expect(logic.drain().map((e) => e.text)).toEqual(['Movie: the whole room', 'Morning: the whole room'])
  })

  it('keeps a selected fan running after release and moves room temperature gradually', () => {
    const logic = new SmarthomeLogic(), input = restInput()
    input.presses = ['raise']
    logic.step([null, null, null, input], 0.05)
    for (let n = 0; n < 200; n++) logic.step([], 0.05)
    expect(logic.units[1].phase).toBeGreaterThan(0)
    expect(logic.units[1].phase).toBeLessThan(Math.PI * 2)
    expect(logic.temperature).toBeGreaterThan(22)
    expect(logic.temperature).toBeLessThanOrEqual(roomSetpoint(logic.units[3]))
  })

  it('ignores stale movement and taps while quiet, but accepts an explicit tray action', () => {
    const logic = new SmarthomeLogic(), input = restInput()
    input.quiet = true; input.drag = [0, -1000]; input.twist = 1000; input.wheel = -1200; input.presses = ['pad']
    logic.step([input], 0.05)
    expect(logic.units[0].target).toBe(0.7)
    expect(logic.units[0].on).toBe(true)
    input.presses = ['power']
    logic.step([input], 0.05)
    expect(logic.units[0].on).toBe(false)
  })

  it('homes only the requested appliance and keeps all state finite on a long frame', () => {
    const logic = new SmarthomeLogic()
    logic.units[0].target = 0; logic.units[1].target = 1; logic.units[1].phase = 2
    logic.home(0)
    expect(logic.units[0].target).toBe(0.7)
    expect(logic.units[1].target).toBe(1)
    expect(logic.units[1].phase).toBe(2)
    logic.step([], Infinity); logic.step([], -1); logic.step([], 60)
    expect(logic.units.every((u) => Number.isFinite(u.level) && Number.isFinite(u.phase))).toBe(true)
    expect(logic.units[1].level).toBeLessThan(0.5)
    expect(logic.readout(3)).toContain('°C')
  })
})

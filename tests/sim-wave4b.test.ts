import { expect, it } from 'vitest'
import { checkButtons } from '@obpal/core'
import { SIMS, filterSims } from '../src/sim/catalogue'
import { DEVICES } from '../src/sim/devices/registry'
import { HOME, layoutOf, restInput } from '../src/sim/devices/types'

const categories = { football: 'games', marblerun: 'games', planetary: 'space-science', telescope: 'space-science', pendulum: 'space-science', trebuchet: 'space-science', slider: 'camera-stage', jib: 'camera-stage' } as const
for (const [id, category] of Object.entries(categories)) {
  it(`${id} declares its category, supported bindings, seats and searchable controllers`, () => {
    const spec = DEVICES.find(d => d.spec.id === id)!.spec, card = SIMS.find(c => c.id === id)!
    expect(spec.category).toBe(category); expect(card.category).toBe(category); expect(card.fresh).toBe(true)
    expect(spec.units).toBeGreaterThanOrEqual(2); expect(layoutOf(spec).tray).toContainEqual(HOME)
    for (const controller of spec.controllers) {
      expect(checkButtons(controller, spec.buttons).errors).toEqual([])
      expect(filterSims(SIMS, { category, face: controller, q: spec.name }).map(c => c.id)).toContain(id)
    }
  })
  it(`${id} remains finite after repeated controls, quiet input and invalid frame times`, () => {
    const logic = DEVICES.find(d => d.spec.id === id)!.logic(), input = restInput()
    input.drag = [400, -400]; input.pan = [-400, 400]; input.touching = true
    for (let n = 0; n < 100; n++) logic.step([input], 2)
    input.quiet = true
    for (const dt of [NaN, Infinity, -1, 0, 0.05]) logic.step([input], dt)
    for (let n = 0; n < logic.spec.units; n++) { expect(logic.readout(n)).not.toMatch(/NaN|Infinity/); logic.home(n) }
  })
}

it('maps the alternate gamepad axes for the track, rover, telescope, lab, launcher and slider', () => {
  const cases = [
    ['marblerun', 'cursorX', 2], ['planetary', 'swing', 0], ['telescope', 'pan', 0],
    ['pendulum', 'length', 1.2], ['trebuchet', 'weight', 25], ['slider', 'x', 0],
  ] as const
  for (const [id, field, start] of cases) {
    const logic = DEVICES.find(d => d.spec.id === id)!.logic() as unknown as { step: (inputs: ReturnType<typeof restInput>[], dt: number) => void; units: Record<string, unknown>[] }
    const input = restInput(); input.pad = { axes: [1, -1, 1, -1], triggers: [0, 1], buttons: 0, flags: 0, seq: 0, t: 0 }
    logic.step([input], 0.05)
    expect(logic.units[0][field], id).not.toBe(start)
  }
})

import { describe, expect, it } from 'vitest'
import { Controller, Mode, type ControllerId } from '@obpal/core'
import { ControllerChoice } from '../src/controller/controller-choice'
import { byFit, rateControllers } from '../src/controller/ratings'

const rated = (controllers: ControllerId[] = [Controller.trackpad, Controller.wii]) => byFit(rateControllers({ controllers, tray: [] }, { motion: true }), { controllers, tray: [] })

describe('explicit controller arrival', () => {
  it('opens with no selected controller even when the host ranks one best', () => {
    const arrival = new ControllerChoice(); arrival.connect('viewer-a')
    const choices = rated()
    expect(choices[0].best).toBe(true)
    expect(arrival.current(choices)).toBeNull()
  })
  it('keeps the explicit choice across a reconnect and changed recommendation', () => {
    const arrival = new ControllerChoice(); arrival.connect('viewer-a')
    expect(arrival.pick(Controller.trackpad, rated())).toBe(true)
    arrival.connect('viewer-a')
    const changed = rated([Controller.wii, Controller.trackpad])
    expect(changed[0].id).toBe(Controller.wii)
    expect(arrival.current(changed)).toBe(Controller.trackpad)
  })
  it('requires a fresh choice for another authenticated screen', () => {
    const arrival = new ControllerChoice(); arrival.connect('viewer-a'); arrival.pick(Controller.trackpad, rated())
    arrival.connect('viewer-b')
    expect(arrival.current(rated())).toBeNull()
  })
  it('returns to Options when the host removes the chosen controller, without substituting its new best', () => {
    const arrival = new ControllerChoice(); arrival.connect('viewer-a'); arrival.pick(Controller.trackpad, rated())
    const choices = rateControllers({ controllers: [Controller.gamepad], modes: [Mode.gamepad], utilities: [], tray: [] }, { motion: true })
    expect(arrival.current(choices)).toBeNull()
  })
  it('refuses an unavailable choice and cannot select before a screen is active', () => {
    const arrival = new ControllerChoice()
    expect(arrival.pick(Controller.trackpad, rated())).toBe(false)
    arrival.connect('viewer-a')
    expect(arrival.pick(Controller.keyboard, rated())).toBe(false)
    expect(arrival.current(rated())).toBeNull()
  })
  it('leaves a usable selection alone while a different attempt is only pending', () => {
    const arrival = new ControllerChoice(); arrival.connect('viewer-a'); arrival.pick(Controller.trackpad, rated())
    // Pending and cancelled attempts never call connect: only the authenticated active switch does.
    expect(arrival.current(rated())).toBe(Controller.trackpad)
    arrival.connect('')
    expect(arrival.current(rated())).toBeNull()
  })
  it('accepts typing as an explicit first choice when the host offers it', () => {
    const arrival = new ControllerChoice(); arrival.connect('typing-screen')
    const choices = rateControllers({ controllers: [Controller.keyboard], tray: [{ id: 'type', label: 'Type', type: 'keyboard' }] }, { motion: false })
    expect(arrival.current(choices)).toBeNull()
    expect(arrival.pick(Controller.keyboard, choices)).toBe(true)
    expect(arrival.current(choices)).toBe(Controller.keyboard)
  })
  it('can require a new choice without losing the authenticated screen', () => {
    const arrival = new ControllerChoice(); arrival.connect('viewer-a'); arrival.pick(Controller.trackpad, rated())
    arrival.clear()
    expect(arrival.current(rated())).toBeNull()
    expect(arrival.pick(Controller.wii, rated())).toBe(true)
  })
})

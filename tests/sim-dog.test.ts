import { Mode, PadButton } from '@obpal/core'
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { DOG_SPEC, DOG_YARD, DogLogic, dogHome } from '../src/sim/devices/dog'
import { preview } from '../src/sim/devices/dog.view'
import { layoutOf, restInput } from '../src/sim/devices/types'

const pad = (x = 0, y = -1) => ({ axes: [x, y, 0, 0] as [number, number, number, number], triggers: [0, 0] as [number, number], buttons: 0, flags: 0, seq: 0, t: 0 })

it('offers two seats, distinct sit and stand buttons, and the shared Home', () => {
  expect(DOG_SPEC.units).toBe(2)
  expect(DOG_SPEC.controllers).toEqual(['face.gamepad', 'face.trackpad'])
  expect(layoutOf(DOG_SPEC).tray?.map((b) => b.id)).toEqual(['sit', 'stand', 'home'])
  expect(DOG_SPEC.buttons?.['key:Space']).toBe('tray:sit')
})

it('trots on the left stick with opposite diagonals and independent seats', () => {
  const logic = new DogLogic(), input = restInput()
  input.pad = pad(0.35)
  for (let k = 0; k < 45; k++) logic.step([input], 1 / 60)
  const u = logic.units[0]
  expect(u.z).toBeLessThan(dogHome(0).z - 0.5)
  expect(u.h).toBeLessThan(-0.1)
  expect(u.stride).toBeGreaterThan(0.5)
  expect(u.legs[0].stance).toBe(u.legs[3].stance)
  expect(u.legs[1].stance).toBe(u.legs[2].stance)
  expect(Math.abs(u.legs[0].previous - u.legs[1].previous)).toBeCloseTo(.5)
  expect(logic.units[1].z).toBe(dogHome(1).z)
})

it('maps both a floating thumb and tilt to movement, with release clearing the thumb', () => {
  const logic = new DogLogic(), input = restInput('face.trackpad', Mode.pad)
  input.touching = true
  input.drag = [30, -70]
  logic.step([input], 0.05)
  expect(logic.units[0].v).toBeGreaterThan(0)
  expect(logic.units[0].turn).toBeLessThan(0)
  input.touching = false
  input.drag = [0, 0]
  for (let k = 0; k < 20; k++) logic.step([input], 0.05)
  expect(logic.units[0].v).toBe(0)
  input.mode = Mode.tilt
  input.tilt = [-0.5, -0.8]
  logic.step([input], 0.05)
  expect(logic.units[0].v).toBeGreaterThan(0)
  expect(logic.units[0].turn).toBeGreaterThan(0)
})

it('sits without accidentally standing, then stands from its separate pad or tray command', () => {
  const logic = new DogLogic(), input = restInput()
  input.pad = pad()
  input.presses = ['sit']
  logic.step([input], 0.05)
  expect(logic.units[0].sitting).toBe(true)
  expect(logic.units[0].v).toBe(0)
  input.presses = []
  for (let k = 0; k < 20; k++) logic.step([input], 0.05)
  expect(logic.units[0].sit).toBe(1)
  expect(logic.units[0].legs[2].knee).toBeGreaterThan(1.7)
  input.padPressed = 1 << PadButton.B
  logic.step([input], 0.05)
  expect(logic.units[0].sitting).toBe(false)
  input.padPressed = 1 << PadButton.A
  logic.step([input], 0.05)
  expect(logic.units[0].sitting).toBe(true)
  input.padPressed = 0
  input.presses = ['stand']
  logic.step([input], 0.05)
  expect(logic.units[0].sitting).toBe(false)
})

it('stops stale stick and tilt input at the watchdog while still accepting explicit posture actions', () => {
  const logic = new DogLogic(), input = restInput('face.trackpad', Mode.tilt)
  input.tilt = [0.8, -1]
  logic.step([input], 0.05)
  const before = { x: logic.units[0].x, z: logic.units[0].z, h: logic.units[0].h }
  input.quiet = true
  input.presses = ['sit']
  logic.step([input], 0.05)
  expect(logic.units[0]).toMatchObject({ ...before, v: 0, turn: 0, sitting: true })
  logic.step([null], 0.05)
  expect(logic.units[0]).toMatchObject(before)
})

it('scores only the holder reaching its own ball, moves the target and preserves scores on Home', () => {
  const logic = new DogLogic(), input = restInput(), u = logic.units[0]
  Object.assign(u, u.ball)
  logic.step([null], 0.05)
  expect(u.score).toBe(0)
  logic.step([input], 0.05)
  expect(u.score).toBe(1)
  expect(Math.hypot(u.x - u.ball.x, u.z - u.ball.z)).toBeGreaterThan(1)
  expect(logic.drain().filter((e) => e.kind === 'score')).toHaveLength(1)
  logic.step([input], 0.05)
  expect(u.score).toBe(1)
  logic.units[1].score = 4
  logic.home(0)
  expect(u).toMatchObject({ ...dogHome(0), score: 1, v: 0, turn: 0, sitting: false, stride: 0 })
  expect(logic.units[1].score).toBe(4)
})

it('Home clears a held drag and the bounded timestep keeps the dog inside the yard', () => {
  const logic = new DogLogic(), input = restInput('face.trackpad', Mode.pad)
  input.touching = true
  input.drag = [0, -90]
  logic.step([input], 0.05)
  logic.home(0)
  input.drag = [0, 0]
  logic.step([input], 0.05)
  expect(logic.units[0]).toMatchObject({ ...dogHome(0), v: 0 })
  input.pad = pad()
  for (let k = 0; k < 500; k++) logic.step([input], 10)
  expect(logic.units[0].z).toBeGreaterThanOrEqual(-DOG_YARD.z)
  expect(Math.abs(logic.units[0].x)).toBeLessThanOrEqual(DOG_YARD.x)
  expect(Math.abs(logic.units[0].v)).toBeLessThanOrEqual(2)
  const z = logic.units[0].z
  logic.step([input], NaN)
  expect(logic.units[0].z).toBe(z)
})

it('builds named articulated parts within the scene geometry and draw budgets', () => {
  const view = preview()
  view.step(0, 0)
  let triangles = 0, draws = 0
  view.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3
    draws += Array.isArray(object.material) ? object.material.length : 1
  })
  expect(view.scene.getObjectByName('front-left-hip')?.getObjectByName('knee')).toBeTruthy()
  expect(view.scene.getObjectByName('torso')).toBeTruthy()
  expect(triangles).toBeLessThan(250000)
  expect(draws).toBeLessThanOrEqual(150)
})

it('Home parks held sticks and tilt until the phone returns to neutral', () => {
  for (const tilt of [false, true]) {
    const logic = new DogLogic(), input = restInput(tilt ? 'face.trackpad' : 'face.gamepad', tilt ? Mode.tilt : Mode.gamepad)
    if (tilt) input.tilt = [0, -1]
    else input.pad = pad()
    logic.step([input], 0.05)
    logic.home(0)
    for (let k = 0; k < 10; k++) logic.step([input], 0.05)
    expect(logic.units[0]).toMatchObject({ ...dogHome(0), v: 0 })
    logic.step([restInput()], 0.05)
    logic.step([input], 0.05)
    expect(logic.units[0].z).toBeLessThan(dogHome(0).z)
  }
})

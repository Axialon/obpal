import { Mode, PadButton } from '@obpal/core'
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { SORTING, SORTING_SPEC, SortingLogic } from '../src/sim/devices/sorting'
import { preview } from '../src/sim/devices/sorting.view'
import { layoutOf, restInput } from '../src/sim/devices/types'

it('offers two cells, pointing first, touch and gamepad fallbacks, and shared Home', () => {
  expect(SORTING_SPEC.units).toBe(2)
  expect(SORTING_SPEC.controllers).toEqual(['face.wii', 'face.trackpad', 'face.gamepad'])
  expect(layoutOf(SORTING_SPEC).tray?.map((b) => b.id)).toEqual(['sort', 'home'])
  expect(SORTING_SPEC.buttons?.['key:Space']).toBe('tray:sort')
})

it('points at each cell in its own frame and clamps the three lanes', () => {
  const logic = new SortingLogic(), input = restInput('face.wii', Mode.point)
  input.point = { x: 0, y: 0, yaw: 0, pitch: 0, off: false }
  for (let lane = 0; lane < 3; lane++) {
    input.spot = [SORTING.centres[1] + SORTING.lanes[lane], 0.8]
    logic.step([null, input], 0.05)
    expect(logic.units[1].lane).toBe(lane)
  }
  input.spot = [999, 0]
  logic.step([input], 0.05)
  expect(logic.units[0].lane).toBe(2)
  input.point.off = true
  input.spot = [-999, 0]
  logic.step([input], 0.05)
  expect(logic.units[0].lane).toBe(2)
})

it('accepts touch aiming without a floor hit, a relative drag, and a gamepad stick', () => {
  const logic = new SortingLogic(), input = restInput('face.wii', Mode.point)
  input.point = { x: 0, y: 0, yaw: -30, pitch: 0, off: false }
  logic.step([input], 0.05)
  expect(logic.units[0].lane).toBe(0)
  input.point = null
  input.touching = true
  input.drag = [150, 0]
  logic.step([input], 0.05)
  expect(logic.units[0].lane).toBe(2)
  input.pad = { axes: [-1, 0, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  for (let k = 0; k < 20; k++) logic.step([input], 0.05)
  expect(logic.units[0].lane).toBe(0)
})

it('sorts a matched colour once per cycle and keeps another cell untouched', () => {
  const logic = new SortingLogic(), input = restInput(), u = logic.units[0]
  input.padPressed = 1 << PadButton.A
  logic.step([input], 0.05)
  expect(u.held).toBe(1)
  input.padPressed = 0
  for (let k = 0; k < 60; k++) logic.step([input], 0.05)
  expect(u).toMatchObject({ score: 1, missed: 0, held: null, phase: 'ready', bins: [0, 1, 0] })
  expect(logic.units[1]).toMatchObject({ score: 0, belt: 0, phase: 'ready' })
  expect(logic.drain().filter((e) => e.kind === 'score')).toHaveLength(1)
})

it('latches the chosen bin through a pusher cycle and reports a wrong colour', () => {
  const logic = new SortingLogic(), input = restInput('face.trackpad', Mode.pad), u = logic.units[0]
  input.touching = true
  input.drag = [90, 0]
  input.presses = ['sort']
  logic.step([input], 0.05)
  expect(u.target).toBe(2)
  expect(u.x).toBeGreaterThan(0)
  input.drag = [-180, 0]
  input.presses = []
  logic.step([input], 0.05)
  input.drag = [0, 0]
  for (let k = 0; k < 50; k++) logic.step([input], 0.05)
  expect(u.lane).toBe(0)
  expect(u).toMatchObject({ target: 2, score: 0, missed: 1, bins: [0, 0, 1] })
  expect(logic.drain().some((e) => e.kind === 'bump')).toBe(true)
})

it('freezes a running conveyor and pusher at the watchdog, ignoring stale axes and pointing', () => {
  const logic = new SortingLogic(), input = restInput(), u = logic.units[0]
  input.presses = ['sort']
  logic.step([input], 0.05)
  input.presses = []
  logic.step([input], 0.05)
  expect(u.push).toBeGreaterThan(0)
  const before = structuredClone(u)
  input.quiet = true
  input.pad = { axes: [1, 0, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  for (let k = 0; k < 30; k++) logic.step([input], 0.05)
  expect(u).toEqual({ ...before, active: false })
  logic.step([null], 0.05)
  expect(u).toEqual({ ...before, active: false })
})

it('Home clears local motion and a held part while keeping both players scores', () => {
  const logic = new SortingLogic(), input = restInput(), u = logic.units[0]
  u.score = 4
  logic.units[1].score = 7
  input.presses = ['sort']
  logic.step([input], 0.05)
  logic.home(0)
  expect(u).toMatchObject({ x: 0, aim: 0, lane: 1, push: 0, phase: 'ready', held: null, belt: 0, score: 4, active: false })
  expect(logic.units[1].score).toBe(7)
  logic.step([null], 0.05)
  expect(u.push).toBe(0)
})

it('caps large timesteps, keeps the queue bounded and does not award idle scores', () => {
  const logic = new SortingLogic(), input = restInput(), u = logic.units[0]
  const before = u.parts[1].z
  logic.step([input], 100)
  expect(u.parts[1].z - before).toBeLessThanOrEqual(0.033)
  for (let k = 0; k < 1000; k++) logic.step([input], 0.05)
  expect(u.parts.length).toBeLessThanOrEqual(5)
  expect(u.parts[0].z).toBe(SORTING.ready)
  expect(u.parts.every((p) => p.z >= SORTING.start)).toBe(true)
  expect(u.score).toBe(0)
  const belt = u.belt
  logic.step([input], Infinity)
  expect(u.belt).toBe(belt)
})

it('builds named machinery within the scene geometry and draw budgets', () => {
  const view = preview()
  view.step(0, 0)
  let triangles = 0, draws = 0
  view.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const instances = object instanceof THREE.InstancedMesh ? object.count : 1
    triangles += ((object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3) * instances
    draws += Array.isArray(object.material) ? object.material.length : 1
  })
  expect(view.scene.getObjectByName('pusher-ram')).toBeTruthy()
  expect(view.scene.getObjectByName('blue-bin')).toBeTruthy()
  expect(triangles).toBeLessThan(250000)
  expect(draws).toBeLessThanOrEqual(150)
})

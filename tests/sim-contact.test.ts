import { expect, it } from 'vitest'
import * as THREE from 'three'
import { contactInstances, contactPart, contactProbe, contactSurface, lowestPoint } from '../src/sim/contact'
import { batch } from '../src/sim/kit'
import { tiledDeck } from '../src/sim/kit/precision'

it('reports signed millimetres from rendered geometry through nested rotation and scale', () => {
  const scene = new THREE.Scene(), parent = new THREE.Group()
  parent.position.set(1, .006, -2); parent.scale.set(2, 3, 4); parent.rotation.y = .7; scene.add(parent)
  const part = contactPart(new THREE.Mesh(new THREE.BoxGeometry(.2, .1, .3)), 'foot')
  part.position.y = .05; parent.add(part)
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(20, 20)))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  const probe = contactProbe(scene)
  expect(probe.sample()[0].gapMm).toBeCloseTo(6, 5)
  parent.position.y = -.009
  expect(probe.sample()[0].gapMm).toBeCloseTo(-9, 5)
  probe.dispose()
})

it('retains contact surfaces and parts when two batches flatten and merge them', () => {
  const scene = new THREE.Scene(), rigid = new THREE.Group(), material = new THREE.MeshStandardMaterial()
  rigid.userData.static = true; rigid.position.set(2, .4, 3); scene.add(rigid)
  const part = contactPart(new THREE.Mesh(new THREE.BoxGeometry(.2, .1, .2), material), 'base')
  part.position.y = .05; rigid.add(part, new THREE.Mesh(new THREE.BoxGeometry(.01, .01, .01), material))
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(20, 20), material))
  floor.rotation.x = -Math.PI / 2; floor.position.y = .4; scene.add(floor)
  const probe = contactProbe(scene), before = probe.sample()
  batch(scene); batch(scene)
  expect(probe.sample()).toEqual(before)
})

it('measures instances independently and follows a replaced skin without cached bounds', () => {
  const scene = new THREE.Scene(), mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshBasicMaterial(), 2)
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, .05, 0))
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1, .06, 0)); scene.add(mesh)
  contactInstances(mesh, 'prize')
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(20, 20)))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  const skin = contactPart(new THREE.Group(), 'skin'); skin.position.y = .5; scene.add(skin)
  skin.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
  const probe = contactProbe(scene)
  expect(probe.sample().map(r => Math.round(r.gapMm!))).toEqual([0, 10, 0])
  skin.clear(); skin.add(new THREE.Mesh(new THREE.BoxGeometry(1, .8, 1)))
  expect(probe.sample()[2].gapMm).toBeCloseTo(100, 4)
})

it('uses transformed vertices rather than the corners of a rotated bounding box', () => {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(2, 0, 0)])
  const matrix = new THREE.Matrix4().makeRotationZ(Math.PI / 4)
  expect(lowestPoint(geometry, matrix).y).toBeCloseTo(0)
})

it('chooses the support below a part instead of an overhead shelf with the same name', () => {
  const scene = new THREE.Scene(), part = contactPart(new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1)), 'foot')
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(4, 4))); floor.rotation.x = -Math.PI / 2
  const shelf = contactSurface(new THREE.Mesh(new THREE.BoxGeometry(3, .1, 3))); shelf.position.y = 2
  scene.add(part, floor, shelf); part.position.y = .05
  const probe = contactProbe(scene)
  expect(probe.sample()[0].gapMm).toBeCloseTo(0, 4)
  part.position.y = .041; expect(probe.sample()[0].gapMm).toBeCloseTo(-9, 4)
  part.position.y = -.2; expect(probe.sample()[0].gapMm).toBeCloseTo(-250, 4)
  part.position.y = 2.1; expect(probe.sample()[0].gapMm).toBeCloseTo(0, 4)
})

it('follows count changes up to the allocated instance capacity', () => {
  const scene = new THREE.Scene(), mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshBasicMaterial(), 2)
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, .05, 0)); mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1, .06, 0))
  mesh.count = 0; contactInstances(mesh, 'growing'); scene.add(mesh)
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(4, 4))); floor.rotation.x = -Math.PI / 2; scene.add(floor)
  const probe = contactProbe(scene)
  expect(probe.sample()).toHaveLength(0)
  mesh.count = 2; expect(probe.sample().map(r => Math.round(r.gapMm!))).toEqual([0, 10])
  mesh.count = 1; expect(probe.sample()).toHaveLength(1)
})

it('finds the tile under a foot that bridges a recessed grout seam', () => {
  const scene = new THREE.Scene(), foot = contactPart(new THREE.Mesh(new THREE.BoxGeometry(.14, .08, .2)), 'foot')
  foot.position.y = .04; scene.add(foot, tiledDeck(4, 4))
  const reading = contactProbe(scene).sample()[0]
  expect(reading.lowestGapMm).toBeCloseTo(6, 4)
  expect(reading.gapMm).toBeCloseTo(0, 4)
})

it('distinguishes repeated rigs without renaming their model frames', () => {
  const scene = new THREE.Scene()
  for (const id of ['a1', 'a2']) {
    const root = new THREE.Group(); root.name = 'root'; root.userData.contactName = id
    root.add(contactPart(new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1)), 'finger')); scene.add(root)
  }
  expect(contactProbe(scene).sample().map(r => r.part)).toEqual(['a1/finger', 'a2/finger'])
})

it('measures a foot bridging a shallow recess independently of the acceptance tolerance', () => {
  const scene = new THREE.Scene(), foot = contactPart(new THREE.Mesh(new THREE.BoxGeometry(.14, .08, .2)), 'foot')
  foot.position.y = .04
  const backing = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(4, 4)))
  backing.rotation.x = -Math.PI / 2; backing.position.y = -.001
  const tile = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(.1, 1)))
  tile.rotation.x = -Math.PI / 2; tile.position.x = .1; scene.add(foot, backing, tile)
  const reading = contactProbe(scene).sample()[0]
  expect(reading.lowestGapMm).toBeCloseTo(1, 4)
  expect(reading.gapMm).toBeCloseTo(0, 4)
})

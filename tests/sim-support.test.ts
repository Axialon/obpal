import { expect, it } from 'vitest'
import * as THREE from 'three'
import { seat, supportGap, supportVertices } from '../src/sim/kit/support'
import { boxPenetration, geometryBox } from '../src/sim/contact-box'
import { terrain } from '../src/sim/devices/planetary'
import { contactPart, contactProbe, contactSurface } from '../src/sim/contact'

it('seats a scaled, rolling wheel against the rendered terrain triangles', () => {
  const scene = new THREE.Scene(), parent = new THREE.Group(); scene.add(parent)
  parent.scale.setScalar(1.36); parent.rotation.set(.1, .7, 0); parent.position.set(-1, .3, 2)
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.066, .066, .05, 32)); wheel.rotation.z = Math.PI / 2; parent.add(wheel)
  contactPart(wheel, 'wheel', { slope: true })
  const points = supportVertices(wheel), g = new THREE.PlaneGeometry(18, 18, 70, 70).rotateX(-Math.PI / 2), p = g.attributes.position
  for (let i = 0; i < p.count; i++) p.setY(i, terrain(p.getX(i), p.getZ(i)))
  scene.add(contactSurface(new THREE.Mesh(g)))
  const probe = contactProbe(scene)
  for (let i = 0; i < 16; i++) {
    wheel.rotation.x = i * .7; parent.position.x += .06
    seat(wheel, points, terrain)
    expect(Math.abs(supportGap(points, wheel.matrixWorld, terrain))).toBeLessThan(1e-7)
    expect(Math.abs(probe.sample()[0].gapMm!)).toBeLessThan(.01)
  }
})

it('measures wall and finger penetration with all separating axes', () => {
  const shape = new THREE.BoxGeometry(.1, .2, .3)
  const a = geometryBox(shape, new THREE.Matrix4()), b = geometryBox(shape, new THREE.Matrix4().makeTranslation(.097, 0, 0))
  expect(boxPenetration(a, b)).toBeCloseTo(.003, 7)
  b.centre.x = .101; expect(boxPenetration(a, b)).toBe(0)
  const turn = new THREE.Matrix4().makeRotationY(Math.PI / 4); turn.setPosition(.3, 0, .3)
  expect(boxPenetration(a, geometryBox(shape, turn))).toBe(0)
})

it('raycasts onto the supporting part instead of the floor under a prize stack', () => {
  const scene = new THREE.Scene(), material = new THREE.MeshBasicMaterial()
  const bottom = contactPart(new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), material), 'bottom', { supports: 'bottom' })
  bottom.position.y = .05
  const top = contactPart(new THREE.Mesh(new THREE.SphereGeometry(.04), material), 'top', { surface: 'bottom' }); top.position.y = .14
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(10, 10))); floor.rotation.x = -Math.PI / 2
  scene.add(floor, bottom, top)
  expect(contactProbe(scene).sample().every(r => Math.abs(r.gapMm!) < .001)).toBe(true)
})

import { expect, it } from 'vitest'
import * as THREE from 'three'
import { instanceCopies } from '../src/sim/kit/instances'

it('shares model draws while independent joints and held objects retain their transforms', () => {
  const scene = new THREE.Scene(), material = new THREE.MeshStandardMaterial(), geometry = new THREE.BoxGeometry()
  const roots = [new THREE.Group(), new THREE.Group()]
  const parts = roots.map(root => { const m = new THREE.Mesh(geometry, material); root.add(m); scene.add(root); return m })
  roots[1].position.x = 2
  const instances = instanceCopies(scene)
  instances.set(roots)
  const batch = scene.children.find(o => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh
  expect(batch.count).toBe(2)
  const matrix = new THREE.Matrix4()
  batch.getMatrixAt(1, matrix)
  expect(matrix.elements[12]).toBe(2)
  parts[1].position.y = 0.5
  instances.update(); batch.getMatrixAt(1, matrix)
  expect(matrix.elements[13]).toBe(0.5)
  const version = batch.instanceMatrix.version
  instances.update()
  expect(batch.instanceMatrix.version).toBe(version)
  instances.clear()
  expect(parts.every(p => p.visible)).toBe(true)
  expect(scene.children).toEqual(roots)
  const held = new THREE.Mesh(geometry, material); held.userData.pickable = true; roots[0].add(held)
  instances.set(roots)
  expect(held.visible).toBe(true)
})

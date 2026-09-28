import { expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { skinSlot, upgradeSkins } from '../src/sim/kit/skins'
import { pov } from '../src/sim/kit/precision'
import type { Prototype } from '../src/sim/kit/prototype'
import { batch } from '../src/sim/kit'

const loader = vi.hoisted(() => vi.fn())
vi.mock('../src/sim/kit/prototype', async original => ({
  ...await original<typeof import('../src/sim/kit/prototype')>(), loadPrototype: loader,
}))
const names: Prototype[] = ['helicopter', 'plane', 'kart', 'boat', 'tank', 'forklift', 'excavator',
  'slotcars', 'planetary', 'submarine', 'vacuum', 'film-camera', 'gimbal', 'ptz', 'dog', 'studio']

it('joins authored and kit geometry while preserving a moving camera frame', () => {
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial()
  const a = new THREE.Mesh(new THREE.BoxGeometry(), material), b = a.clone()
  b.geometry = b.geometry.clone(); b.geometry.deleteAttribute('uv'); b.position.x = 2
  const joint = new THREE.Group(); root.add(a, b, joint)
  const anchor = pov(joint, [0, 1, 0]); batch(root, [joint])
  expect(root.children).toHaveLength(2)
  expect(anchor.parent).toBe(joint)
  const bounds = new THREE.Box3().setFromObject(root)
  expect(bounds.min.x).toBeCloseTo(-.5); expect(bounds.max.x).toBeCloseTo(2.5)
})

it('preserves instance transforms when a loaded skin triggers a second batch', () => {
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial(), geometry = new THREE.BoxGeometry()
  const keys = new THREE.InstancedMesh(geometry, material, 2)
  keys.setMatrixAt(1, new THREE.Matrix4().makeTranslation(2, 0, 0))
  root.add(keys, new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material))
  batch(root)
  expect(root.children).toHaveLength(2)
  expect(keys.parent).toBe(root); expect(keys.count).toBe(2)
  const pose = new THREE.Matrix4(); keys.getMatrixAt(1, pose)
  expect(new THREE.Vector3().setFromMatrixPosition(pose).x).toBe(2)
})

it.each(names)('%s decodes within its payload budget and changes only declared rigid skins', async name => {
  const data = readModel(name)
  expect(data.byteLength).toBeLessThanOrEqual(400_000)
  const header = new DataView(data)
  const json = JSON.parse(new TextDecoder().decode(data.slice(20, 20 + header.getUint32(12, true))))
  expect(json.extensionsRequired).toContain('EXT_meshopt_compression')
  expect(json.images ?? []).toHaveLength(0)
  expect(json.animations ?? []).toHaveLength(0)
  expect(json.buffers.every((buffer: { uri?: string }) => !buffer.uri)).toBe(true)
  await MeshoptDecoder.ready
  const source = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '')).scene
  const rig = new THREE.Group(), slots: Record<string, THREE.Object3D> = {}
  const anchors = source.children.map((node, n) => {
    const joint = new THREE.Group(); joint.position.set(n * .3, .5, -.2); joint.rotation.set(.2, -.4, .7); rig.add(joint)
    slots[node.name] = skinSlot(joint, node.name, new THREE.Mesh(new THREE.BoxGeometry()))
    return pov(joint, [0, .03, -.1])
  })
  rig.updateMatrixWorld(true)
  const before = anchors.map(anchor => anchor.matrixWorld.clone())
  loader.mockResolvedValueOnce(source)
  const invalidate = vi.fn(); upgradeSkins(name, slots, invalidate)
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalledOnce())
  rig.updateMatrixWorld(true)
  anchors.forEach((anchor, n) => expect(anchor.matrixWorld.equals(before[n])).toBe(true))
  for (const slot of Object.values(slots)) {
    expect(slot.children.length).toBeGreaterThan(0)
    slot.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return
      expect(Array.from(node.geometry.attributes.position.array).every(Number.isFinite)).toBe(true)
      expect(Array.from(node.geometry.attributes.normal.array).every(Number.isFinite)).toBe(true)
    })
  }
})

it.each([null, new THREE.Group()])('retains a working placeholder on download failure or a missing slot', async source => {
  const rig = new THREE.Group(), placeholder = new THREE.Mesh(new THREE.BoxGeometry())
  const slot = skinSlot(rig, 'cameraSkin', placeholder), anchor = pov(rig, [0, 0, -.2])
  loader.mockResolvedValueOnce(source)
  const invalidate = vi.fn(); upgradeSkins('gimbal', { cameraSkin: slot }, invalidate)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(slot.children).toEqual([placeholder]); expect(anchor.parent).toBe(rig)
  expect(invalidate).not.toHaveBeenCalled()
})

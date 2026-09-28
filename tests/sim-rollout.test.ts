import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { KINDS } from '../src/sim/arm/kind'
import { plateGeometry, pov } from '../src/sim/kit/precision'

vi.mock('../src/sim/kit/prototype', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sim/kit/prototype')>(),
  loadPrototype: async (name: string) => {
    await MeshoptDecoder.ready
    return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readModel(name), '')).scene
  },
}))

describe('confirmed appearance rollout', () => {
  it.each(Object.keys(KINDS))('%s keeps its tool camera and control frames through the optional mesh swap', async id => {
    const kind = KINDS[id as keyof typeof KINDS]
    const model = kind.build(1, { metal: new THREE.MeshStandardMaterial(), dark: new THREE.MeshStandardMaterial() })
    const anchor = model.root.getObjectByName('pov')!
    expect(anchor).toBeTruthy()
    expect(anchor.parent).toBe(model.grasp.parent)
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(anchor.quaternion).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-6)
    kind.kin.joints.forEach((joint, i) => model.apply[i](joint.home))
    model.root.updateMatrixWorld(true)
    const at = model.grasp.matrixWorld.clone(), camera = anchor.matrixWorld.clone()
    const fingers: THREE.Object3D[] = []; model.root.traverse(o => { if (o.name.startsWith('finger')) fingers.push(o) })
    const install = await model.upgrade!()
    expect(install).toBeTypeOf('function'); install!()
    model.root.updateMatrixWorld(true)
    expect(model.root.getObjectByName('pov')).toBe(anchor)
    expect(model.grasp.matrixWorld.equals(at)).toBe(true)
    expect(anchor.matrixWorld.equals(camera)).toBe(true)
    for (const finger of fingers) expect(finger.parent).not.toBeNull()
    kind.kin.joints.forEach((joint, i) => model.apply[i](joint.min))
    model.root.updateMatrixWorld(true)
    expect(anchor.matrixWorld.elements.every(Number.isFinite)).toBe(true)
    model.dispose()
  })

  it('keeps both chamfers inside the original box envelope', () => {
    for (const size of [[.01,.02,.003], [.2,.4,.1], [8,.1,8]]) {
      const g = plateGeometry(...size as [number, number, number]); g.computeBoundingBox()
      const bounds = g.boundingBox!.getSize(new THREE.Vector3())
      bounds.toArray().forEach((v, i) => expect(v).toBeCloseTo(size[i], 6))
      expect(Array.from(g.attributes.normal.array).every(Number.isFinite)).toBe(true)
    }
  })

  it('defines +Z as forward without rotating its parent', () => {
    const parent = new THREE.Group(), rotation = parent.quaternion.clone()
    const anchor = pov(parent, [0, .2, -.3])
    expect(parent.quaternion.equals(rotation)).toBe(true)
    expect(anchor.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(-1)
  })

  it('keeps pitched cameras upright in both forward directions', () => {
    for (const z of [-1, 1]) for (const y of [-.55, 0, .55]) {
      const direction = new THREE.Vector3(0, y, z).normalize()
      const anchor = pov(new THREE.Group(), [0, 0, 0], direction.toArray())
      expect(anchor.getWorldDirection(new THREE.Vector3()).distanceTo(direction)).toBeLessThan(1e-6)
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(anchor.quaternion).y).toBeGreaterThan(.8)
    }
  })

  it('uses the supplied up axis on a lens rotated around its optical cylinder', () => {
    const lens = new THREE.Group(); lens.rotation.x = Math.PI / 2
    const anchor = pov(lens, [0, -.064, 0], [0, -1, 0], [0, 0, -1])
    expect(anchor.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(-1)
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion())).y).toBeCloseTo(1)
  })
})

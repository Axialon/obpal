import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { KEEL, MORROW, neutral } from '../src/sim/humanoid/profile'
import { modelPivots, pivotName } from '../src/sim/humanoid/models'
import { forward, v } from '../src/sim/humanoid/ik'
import { finishPrototype } from '../src/sim/kit/prototype'
import { pageModels } from '../src/sim/kit/models'

const files = ['keel', 'keel-lod', 'morrow', 'morrow-lod', 'humanoid-arena']
const load = async (name: string) => {
  await MeshoptDecoder.ready
  return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readModel(name), '')).scene
}

describe('authored humanoids', () => {
  it('starts the three scene downloads through the shared early-load registry', () => {
    expect(pageModels('/sim/humanoid/', '')).toEqual(['keel', 'morrow', 'humanoid-arena'])
  })
  it.each(files)('%s is self-contained meshopt with no textures, within its byte and triangle budgets', (name) => {
    const data = readModel(name),
      header = new DataView(data)
    const doc = JSON.parse(new TextDecoder().decode(data.slice(20, 20 + header.getUint32(12, true))))
    expect(header.getUint32(8, true)).toBe(data.byteLength)
    expect(data.byteLength).toBeLessThan(name === 'humanoid-arena' ? 750_000 : 1_500_000)
    expect(doc.extensionsRequired).toContain('EXT_meshopt_compression')
    expect(doc.images ?? []).toHaveLength(0)
    expect(doc.textures ?? []).toHaveLength(0)
    expect(doc.animations ?? []).toHaveLength(0)
    expect(doc.buffers.every((b: { uri?: string }) => !b.uri)).toBe(true)
    const primitives = doc.meshes.flatMap((m: { primitives: { indices: number }[] }) => m.primitives)
    const triangles = primitives.reduce(
      (sum: number, p: { indices: number }) => sum + doc.accessors[p.indices].count / 3,
      0,
    )
    expect(triangles).toBeLessThan(name.endsWith('-lod') ? 10_000 : name === 'humanoid-arena' ? 15_000 : 25_000)
    expect(primitives.length).toBeLessThan(name === 'humanoid-arena' ? 10 : 50)
  })
  it.each(files)('%s decodes to finite, correctly oriented geometry and shared finishes', async (name) => {
    const scene = await load(name)
    finishPrototype(scene)
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3(),
      n = new THREE.Vector3()
    let inverted = 0
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      expect((mesh.material as THREE.Material).userData.simShared).toBe(true)
      const { position, normal } = mesh.geometry.attributes,
        index = mesh.geometry.index!
      for (let i = 0; i < position.count; i++) {
        expect(
          [position.getX(i), position.getY(i), position.getZ(i), normal.getX(i), normal.getY(i), normal.getZ(i)].every(
            Number.isFinite,
          ),
        ).toBe(true)
      }
      for (let i = 0; i < index.count; i += 3) {
        const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
        a.fromBufferAttribute(position, ids[0])
        b.fromBufferAttribute(position, ids[1])
        c.fromBufferAttribute(position, ids[2])
        const face = b.sub(a).cross(c.sub(a)).normalize(),
          sum = new THREE.Vector3()
        for (const id of ids) sum.add(n.fromBufferAttribute(normal, id))
        if (face.dot(sum) < -0.01) inverted++
      }
    })
    expect(inverted).toBe(0)
  })
  for (const [name, profile] of [
    ['keel', KEEL],
    ['morrow', MORROW],
  ] as const) {
    for (const suffix of ['', '-lod']) {
      it(`${name}${suffix} preserves every pivot through independent full-limit sweeps`, async () => {
        const scene = await load(name + suffix),
          nodes = modelPivots(scene, profile)
        for (const joint of profile.joints) {
          for (let i = 0; i <= 16; i++) {
            const q = neutral(profile)
            q[joint.id] = joint.limits[0] + ((joint.limits[1] - joint.limits[0]) * i) / 16
            for (const j of profile.joints) nodes.get(j.id)!.quaternion.setFromAxisAngle(v(j.axis), q[j.id])
            scene.updateMatrixWorld(true)
            const fk = forward(profile, q)
            for (const j of profile.joints) {
              expect(nodes.get(j.id)!.getWorldPosition(new THREE.Vector3()).distanceTo(fk.get(j.id)!.p)).toBeLessThan(
                0.00001,
              )
            }
            const bounds = new THREE.Box3().setFromObject(scene)
            expect([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)).toBe(true)
            expect(bounds.getSize(new THREE.Vector3()).length()).toBeLessThan(4)
          }
        }
        for (const side of ['left', 'right']) {
          const finger = scene.getObjectByName(`${side}_arm_fingers`)!
          expect(finger.parent).toBe(nodes.get(`${side}.arm.wrist.yaw`))
          expect(scene.getObjectByName(`${side}_arm_tips`)!.parent).toBe(finger)
        }
      })
    }
    it(`${name} retains its silhouette in the fallback LOD`, async () => {
      const high = new THREE.Box3().setFromObject(await load(name)),
        low = new THREE.Box3().setFromObject(await load(name + '-lod'))
      expect(high.min.distanceTo(low.min)).toBeLessThan(0.016)
      expect(high.max.distanceTo(low.max)).toBeLessThan(0.016)
      expect(high.min.y).toBeGreaterThanOrEqual(-0.001)
    })
  }
  it('rejects absent, duplicate, translated, scaled, rotated and reparented pivots before a swap', async () => {
    for (const corrupt of ['absent', 'duplicate', 'translated', 'scaled', 'rotated', 'parent', 'finger']) {
      const scene = await load('keel'),
        joint = scene.getObjectByName(pivotName('left.arm.elbow'))!
      if (corrupt === 'absent') joint.removeFromParent()
      if (corrupt === 'duplicate') scene.add(joint.clone())
      if (corrupt === 'translated') joint.position.y += 0.001
      if (corrupt === 'scaled') joint.scale.x = 0.98
      if (corrupt === 'rotated') joint.rotation.x = 0.01
      if (corrupt === 'parent') scene.add(joint)
      if (corrupt === 'finger') scene.getObjectByName('left_arm_tips')!.position.y += 0.002
      expect(() => modelPivots(scene, KEEL)).toThrow('Invalid humanoid pivot')
    }
  })
})

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { measure, shoe } from '../assets/blender/proportions.mjs'
import forms from '../assets/blender/humanoid-forms.json'
import { SOFT_PROFILES, SOFT_FACES, KEEL, MORROW, robotRoster, neutral } from '../src/sim/humanoid/profile'
import { softPreview } from '../src/sim/humanoid/preview'
import { modelPivots, modelName } from '../src/sim/humanoid/models'
import { forward, v } from '../src/sim/humanoid/ik'
import { faceState } from '../src/sim/humanoid/face'
import { softDesktop, softPhone } from '../src/sim/humanoid/soft-materials'
import { fingerAngles } from '../src/sim/humanoid/tendons'

const profiles = robotRoster(true).flatMap(robot => [...robot.forms]).filter(profile => profile.face)
const load = async (name: string) => {
  await MeshoptDecoder.ready
  return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readModel(name), '')).scene
}
describe('original soft humanoids', () => {
  it('excludes all three preview models from the default roster', () => {
    expect(robotRoster().map(robot => robot.id)).toEqual(['keel', 'morrow'])
    expect(robotRoster(true).map(robot => robot.id)).toEqual(['keel', 'morrow', 'cairn', 'rill', 'hush'])
  })
  it('requires the soft flag and remembers it only in the supplied session', () => {
    const values = new Map<string, string>()
    const session = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
    expect(softPreview('', session)).toBe(false)
    expect(softPreview('?preview=other', session)).toBe(false)
    expect(softPreview('?preview=soft', session)).toBe(true)
    expect(softPreview('', session)).toBe(true)
    values.clear()
    expect(softPreview('', session)).toBe(false)
  })
  it('keeps an explicit opt-in working when session storage is blocked', () => {
    const blocked = () => { throw new Error('Storage unavailable') }
    expect(softPreview('?preview=soft', blocked)).toBe(true)
    expect(softPreview('', blocked)).toBe(false)
  })
  it('keeps existing identities and gives the two forms distinct shoulder and hip spans', () => {
    expect(modelName(KEEL)).toBe('keel')
    expect(modelName(MORROW)).toBe('morrow')
    for (const [a, b] of Object.values(SOFT_PROFILES)) {
      expect(a.height).toBeCloseTo(1.73)
      expect(b.height).toBe(1.8)
      expect(b.joints.find(j => j.id === 'right.arm.roll')!.offset[0]).toBeGreaterThan(a.joints.find(j => j.id === 'right.arm.roll')!.offset[0])
      expect(b.joints.find(j => j.id === 'right.leg.roll')!.offset[0]).toBeLessThan(a.joints.find(j => j.id === 'right.leg.roll')!.offset[0])
      expect(fingerAngles(a, 1)).toEqual([.7, 1.02, .78])
    }
  })
  for (const profile of profiles) {
    for (const suffix of ['', '-lod']) {
      const name = modelName(profile) + suffix
      it(`${name} fits the budgets with no image dependency or clearcoat`, () => {
        const bytes = readModel(name)
        const doc = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + new DataView(bytes).getUint32(12, true))))
        expect(bytes.byteLength).toBeLessThan(1_500_000)
        expect(doc.extensionsRequired).toContain('EXT_meshopt_compression')
        expect(doc.images ?? []).toHaveLength(0)
        expect(doc.textures ?? []).toHaveLength(0)
        expect(doc.animations ?? []).toHaveLength(0)
        const primitives = doc.meshes.flatMap((mesh: { primitives: { indices: number }[] }) => mesh.primitives)
        expect(primitives.reduce((n: number, p: { indices: number }) => n + doc.accessors[p.indices].count / 3, 0)).toBeLessThan(suffix ? 10_000 : 25_000)
        expect(primitives.length).toBeLessThanOrEqual(51)
        for (const material of doc.materials) expect(material.extensions?.KHR_materials_clearcoat?.clearcoatFactor ?? 0).toBe(0)
      })
      it(`${name} validates and keeps every pivot through the limits`, async () => {
        const scene = await load(name)
        const nodes = modelPivots(scene, profile)
        for (const joint of profile.joints) for (const fraction of [0, .5, 1]) {
          const q = neutral(profile)
          q[joint.id] = joint.limits[0] + (joint.limits[1] - joint.limits[0]) * fraction
          for (const j of profile.joints) nodes.get(j.id)!.quaternion.setFromAxisAngle(v(j.axis), q[j.id])
          scene.updateMatrixWorld(true)
          const fk = forward(profile, q)
          for (const j of profile.joints) expect(nodes.get(j.id)!.getWorldPosition(new THREE.Vector3()).distanceTo(fk.get(j.id)!.p)).toBeLessThan(.00001)
        }
        let inverted = 0
        scene.traverse(object => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          const { position, normal } = mesh.geometry.attributes, index = mesh.geometry.index!
          for (let n = 0; n < position.count; n++) expect([position.getX(n), position.getY(n), position.getZ(n), normal.getX(n), normal.getY(n), normal.getZ(n)].every(Number.isFinite)).toBe(true)
          for (let n = 0; n < index.count; n += 3) {
            const ids = [index.getX(n), index.getX(n+1), index.getX(n+2)]
            const [a, b, c] = ids.map(i => new THREE.Vector3().fromBufferAttribute(position, i))
            const face = b.sub(a).cross(c.sub(a)).normalize()
            const sum = ids.reduce((s, i) => s.add(new THREE.Vector3().fromBufferAttribute(normal, i)), new THREE.Vector3())
            if (face.dot(sum) < -.01) inverted++
          }
        })
        expect(inverted).toBe(0)
        for (const side of ['left', 'right']) {
          expect(scene.getObjectByName(`${side}_arm_distal`)).toBeTruthy()
          expect(scene.getObjectByName(`${side}_arm_thumb_tip`)).toBeTruthy()
          for (const part of ['fingers', 'tips', 'distal']) {
            const frame = scene.getObjectByName(`${side}_arm_${part}`)!
            const mesh = frame.children.find(child => (child as THREE.Mesh).isMesh && ((child as THREE.Mesh).material as THREE.Material).name.endsWith('Cover')) as THREE.Mesh
            mesh.updateMatrix()
            const positions = mesh.geometry.attributes.position, bands = new Set<number>()
            for (let i = 0; i < positions.count; i++) {
              const x = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrix).x / (profile.height/1.8)
              bands.add(Math.floor((x+.042)/.021))
            }
            expect([...bands].sort(), `${side} ${part} has four separated digits beside the thumb`).toEqual([0, 1, 2, 3])
          }
        }
      })
      it(`${name} keeps closed limb cores in straight, halfway and folded poses`, async () => {
        const scene = await load(name), nodes = modelPivots(scene, profile)
        const surface = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
        scene.traverse(object => { if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).material = surface })
        const ray = new THREE.Raycaster(), direction = new THREE.Vector3(.815, .319, .48).normalize()
        for (const fraction of [0, .5, 1]) {
          const q = neutral(profile)
          for (const chain of profile.chains) {
            const joint = profile.joints.find(j => j.id === chain.joints[3])!
            q[joint.id] = joint.limits[1] * fraction
          }
          for (const joint of profile.joints) nodes.get(joint.id)!.quaternion.setFromAxisAngle(v(joint.axis), q[joint.id])
          scene.updateMatrixWorld(true)
          for (const chain of profile.chains) {
            const ids = [chain.joints[0], chain.joints[3], chain.end]
            for (let segment = 0; segment < 2; segment++) {
              const a = nodes.get(ids[segment])!.getWorldPosition(new THREE.Vector3())
              const b = nodes.get(ids[segment+1])!.getWorldPosition(new THREE.Vector3())
              for (let i = 0; i <= 24; i++) {
                ray.set(a.clone().lerp(b, i/24), direction)
                // Signed crossings retain intentionally overlapping closed covers.
                const winding = ray.intersectObject(nodes.get(chain.joints[0])!, true).reduce((sum, hit) => sum + Math.sign(hit.face!.normal.clone().transformDirection(hit.object.matrixWorld).dot(direction)), 0)
                expect(winding, `${chain.id}, segment ${segment}, sample ${i}, fold ${fraction}`).toBeGreaterThan(0)
              }
            }
          }
        }
        surface.dispose()
      })
    }
    it(`${profile.model} meets its form's proportion targets at rest`, async () => {
      const spec = forms.forms[profile.model!.endsWith('-ii') ? 'ii' : 'i']
      const m = measure(await load(profile.model!), profile)
      for (const key of ['headsTall', 'headBreadth', 'shoulderSpan', 'upperArmWidth', 'hipBreadth', 'waistToHip'] as const) {
        expect(m[key], key).toBeGreaterThanOrEqual(spec[key][0])
        expect(m[key], key).toBeLessThanOrEqual(spec[key][1])
      }
      expect(m.headDepthRatio).toBeGreaterThanOrEqual(spec.headDepthRatio)
    })
    for (const suffix of ['', '-lod']) {
      it(`${profile.model}${suffix} stands its shoe flat on the physics foot box`, async () => {
        const fit = shoe(await load(profile.model! + suffix), profile)
        // The sole is the box's bottom plane; the shoe stays inside the box and
        // spans most of its heel-to-toe length, so heel and toe rolls stay grounded.
        expect(Math.abs(fit.min[1] - fit.box.min[1])).toBeLessThanOrEqual(forms.shoe.soleTolerance)
        expect(fit.lengthCoverage).toBeGreaterThanOrEqual(forms.shoe.lengthCoverage)
        expect(fit.toeSpring).toBeLessThanOrEqual(forms.shoe.toeSpring)
        for (const axis of [0, 2]) {
          expect(fit.min[axis]).toBeGreaterThanOrEqual(fit.box.min[axis] - .001)
          expect(fit.max[axis]).toBeLessThanOrEqual(fit.box.max[axis] + .001)
        }
      })
    }
    it(`${profile.model} retains height and silhouette in its LOD`, async () => {
      const high = new THREE.Box3().setFromObject(await load(profile.model!))
      const low = new THREE.Box3().setFromObject(await load(profile.model! + '-lod'))
      expect(high.min.y).toBeGreaterThanOrEqual(-.001)
      expect(high.max.y).toBeCloseTo(profile.height, 2)
      expect(high.min.distanceTo(low.min)).toBeLessThan(.018)
      expect(high.max.distanceTo(low.max)).toBeLessThan(.018)
    })
  }
  it('authors every soft form around the live pivots and face glass', () => {
    for (const [name, face] of Object.entries(forms.faces)) {
      expect(SOFT_FACES[name as keyof typeof SOFT_FACES].surface).toEqual(face.surface)
      expect(SOFT_FACES[name as keyof typeof SOFT_FACES].eyes).toBe(face.eyes)
    }
    for (const pair of Object.values(SOFT_PROFILES)) for (const profile of pair) {
      const spec = forms.forms[profile.model!.endsWith('-ii') ? 'ii' : 'i'], scale = profile.height / 1.8
      expect(profile.height).toBeCloseTo(spec.height, 9)
      expect(profile.joints.find(j => j.id === 'right.arm.roll')!.offset[0]).toBeCloseTo(spec.pivots.arm * scale, 9)
      expect(profile.joints.find(j => j.id === 'right.leg.roll')!.offset[0]).toBeCloseTo(spec.pivots.leg * scale, 9)
    }
  })
  for (const suffix of ['', '-lod']) it(`Cairn I${suffix} keeps finite normalized skin influences on existing joints`, async () => {
    const scene = await load('cairn-i' + suffix)
    let suits = 0
    scene.traverse(object => {
      const mesh = object as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      suits++
      const weights = mesh.geometry.attributes.skinWeight, indices = mesh.geometry.attributes.skinIndex
      expect(weights.itemSize).toBe(4)
      expect(indices.itemSize).toBe(4)
      for (let vertex = 0; vertex < weights.count; vertex++) {
        let total = 0
        for (let slot = 0; slot < 4; slot++) {
          const weight = weights.getComponent(vertex, slot), joint = indices.getComponent(vertex, slot)
          expect(Number.isFinite(weight)).toBe(true)
          expect(weight).toBeGreaterThanOrEqual(0)
          expect(weight).toBeLessThanOrEqual(1)
          expect(Number.isInteger(joint)).toBe(true)
          expect(joint).toBeGreaterThanOrEqual(0)
          expect(joint).toBeLessThan(mesh.skeleton.bones.length)
          total += weight
        }
        expect(total).toBeCloseTo(1, 4)
      }
    })
    expect(suits).toBeGreaterThan(0)
  })
  it('retains low gloss on phones without sheen or clearcoat', () => {
    for (const tiers of [softDesktop, softPhone]) for (const material of Object.values(tiers)) {
      expect((material as THREE.MeshStandardMaterial).roughness).toBeGreaterThanOrEqual(.30)
      expect((material as THREE.MeshPhysicalMaterial).clearcoat ?? 0).toBe(0)
    }
    expect((softDesktop.rillCover as THREE.MeshPhysicalMaterial).sheen).toBeGreaterThan(0)
    expect(softPhone.rillCover).not.toBeInstanceOf(THREE.MeshPhysicalMaterial)
  })
  it('bounds deterministic face motion and holds a centred open face under reduced motion', () => {
    expect(faceState(5.7, false, false).blink).toBe(.08)
    expect(faceState(5.7, false, false, true).blink).toBeCloseTo(.35)
    expect(faceState(3, true, false)).toEqual(faceState(3, true, false))
    for (const t of [0, 5.7, 6.4, 1234, NaN, Infinity]) {
      const state = faceState(t, true, false)
      expect(Object.values(state).every(Number.isFinite)).toBe(true)
      expect(Math.abs(state.x)).toBeLessThanOrEqual(.005)
      expect(state.glow).toBeGreaterThanOrEqual(1)
      expect(faceState(t, true, true)).toEqual({ blink: 1, x: 0, y: 0, glow: 1.12 })
    }
  })
})

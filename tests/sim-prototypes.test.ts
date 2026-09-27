import { readModel } from '../assets/blender/read-model.mjs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { finishPrototype, prototypeNodes } from '../src/sim/kit/prototype'
import { telescoping } from '../src/sim/kit/mechanism'
import { SO101 } from '../src/sim/arm/kind/so101'
import { FINGER_IN, FINGER_TRAVEL, FINGER_W } from '../src/sim/arm/grasp'

const files = ['drone', 'so101', 'rover'].map(name => ({ name, data: readModel(name) }))
async function scene(name: string) {
  const data = files.find(f => f.name === name)!.data
  await MeshoptDecoder.ready
  return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '')).scene
}
const position = (o: THREE.Object3D, wanted: number[]) => o.position.toArray().forEach((v, i) => expect(v).toBeCloseTo(wanted[i], 6))

describe('Blender prototype contract', () => {
  it('ships only self-contained, required meshopt assets within the combined 1.5 MB budget', () => {
    expect(files.reduce((n, f) => n + f.data.byteLength, 0)).toBeLessThanOrEqual(1_500_000)
    for (const { data } of files) {
      const view = new DataView(data)
      expect(view.getUint32(8, true)).toBe(data.byteLength)
      const doc = JSON.parse(new TextDecoder().decode(data.slice(20, 20 + view.getUint32(12, true))))
      expect(doc.extensionsRequired).toContain('EXT_meshopt_compression')
      expect(doc.images ?? []).toHaveLength(0)
      expect(doc.buffers.every((b: { uri?: string }) => !b.uri)).toBe(true)
      expect(doc.bufferViews.every((v: { extensions?: object }) => v.extensions && 'EXT_meshopt_compression' in v.extensions)).toBe(true)
      expect(doc.animations ?? []).toHaveLength(0)
    }
  })
  it.each(['drone', 'so101', 'rover'])('decodes %s to finite geometry with outward normals and kit finishes', async name => {
    const root = await scene(name)
    const dynamic = Object.fromEntries(['owner', 'rotor', 'head', 'tail'].map(n => [n, new THREE.MeshStandardMaterial()]))
    finishPrototype(root, dynamic)
    let triangles = 0, inverted = 0
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3(), normal = new THREE.Vector3(), sum = new THREE.Vector3()
    root.traverse(o => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const p = m.geometry.attributes.position
      const n = m.geometry.attributes.normal, index = m.geometry.index!
      for (let i = 0; i < p.count; i++) expect([p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)].every(Number.isFinite)).toBe(true)
      for (let i = 0; i < index.count; i += 3) {
        const ids = [index.getX(i), index.getX(i+1), index.getX(i+2)]
        a.fromBufferAttribute(p,ids[0]); b.fromBufferAttribute(p,ids[1]); c.fromBufferAttribute(p,ids[2])
        face.crossVectors(b.sub(a),c.sub(a)).normalize(); sum.set(0,0,0)
        for (const id of ids) sum.add(normal.fromBufferAttribute(n,id))
        if (face.dot(sum) < -.01) inverted++
      }
      triangles += (m.geometry.index?.count ?? p.count) / 3
      const material = m.material as THREE.Material
      expect(material.userData.simShared || Object.values(dynamic).includes(material as THREE.MeshStandardMaterial)).toBeTruthy()
    })
    expect(triangles).toBeLessThan(45_000)
    expect(inverted).toBe(0)
  })
  it('keeps the SO-101 frame lengths and gripper contact envelope', async () => {
    const root = await scene('so101')
    const nodes = prototypeNodes(root, ['root', 'yaw', 'shoulder', 'elbow', 'wrist', 'roll', 'fingerLeft', 'fingerRight'])
    for (const [name, y] of [['yaw', SO101.deck], ['shoulder', SO101.geo.H0 - SO101.deck], ['elbow', SO101.geo.L1], ['wrist', SO101.geo.L2], ['roll', SO101.rollAt]] as const) position(nodes[name], [0, y, 0])
    expect(nodes.elbow.parent).toBe(nodes.shoulder); expect(nodes.roll.parent).toBe(nodes.wrist)
    for (const [name, side] of [['fingerLeft', -1], ['fingerRight', 1]] as const) {
      const finger = nodes[name]
      position(finger, [side * (FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL), .095, 0])
      const copy = finger.clone(true); copy.position.set(0, 0, 0); copy.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(copy)
      expect(bounds.max.y).toBeCloseTo(.05, 4); expect(bounds.min.y).toBeCloseTo(-.05, 4)
      expect(bounds.max.x).toBeLessThan(.0091); expect(bounds.min.x).toBeGreaterThan(-.0091)
    }
  })
  it('keeps all four motor pivots, the camera and its attached cable span', async () => {
    const nodes = prototypeNodes(await scene('drone'), ['body', 'prop0', 'prop1', 'prop2', 'prop3', 'gimbal', 'leads'])
    for (const [i, x, z] of [[0,-1,-1],[1,1,-1],[2,-1,1],[3,1,1]]) position(nodes[`prop${i}` as 'prop0'], [x*.17,.133,z*.17])
    position(nodes.gimbal, [0,.065,-.132]); position(nodes.leads, [.065,.067,.055])
    expect(nodes.gimbal.parent).toBe(nodes.body)
  })
  it('keeps the rover steering, rolling, suspension and antenna frames independent', async () => {
    const root = await scene('rover')
    for (const [i,x,z] of [[0,-.17,-.15],[1,.17,-.15],[2,-.17,.15],[3,.17,.15]]) {
      const nodes = prototypeNodes(root, [`steer${i}`, `wheel${i}`])
      position(nodes[`steer${i}`], [x,.065,z]); position(nodes[`wheel${i}`], [0,0,0])
      expect(nodes[`wheel${i}`].parent).toBe(nodes[`steer${i}`])
      expect(nodes[`wheel${i}`].rotation.z).toBeCloseTo(Math.PI/2, 6)
    }
    position(prototypeNodes(root, ['antenna']).antenna, [.1,.135,.17])
    for (const [i,x,z] of [[0,-.135,-.15],[1,-.135,.15],[2,.135,-.15],[3,.135,.15]]) position(prototypeNodes(root, [`shock${i}`])[`shock${i}`], [x,.10,z])
  })
  it('keeps actuator ends attached through joint reversals and suspension travel', async () => {
    for (const name of ['so101', 'rover']) {
      const root = await scene(name)
      const pairs = name === 'so101' ? ['elbow', 'wrist'] : ['shock0', 'shock1', 'shock2', 'shock3']
      for (const key of pairs) {
        const arm = name === 'so101', i = Number(key.slice(-1))
        const sleeve = root.getObjectByName(arm ? key+'Sleeve' : 'shockSleeve'+i)!
        const rod = root.getObjectByName(arm ? key+'Rod' : 'shockRod'+i)!
        const tipFrame = root.getObjectByName(arm ? key : 'body')!
        const base = arm ? new THREE.Vector3(.031, (key === 'elbow' ? .28 : .34)-.09, 0) : new THREE.Vector3(i<2 ? -.135 : .135, .064, i%2 ? .15 : -.15)
        const tip = arm ? new THREE.Vector3(.02,.035,0) : new THREE.Vector3(base.x,.14,base.z)
        const rodLength = arm ? .07 : .05
        const update = telescoping(sleeve,rod,tipFrame,base,tip,.026,rodLength)
        for (const degrees of arm ? [-135,0,140,-135] : [-4,0,4,-4]) {
          tipFrame.rotation.z = THREE.MathUtils.degToRad(degrees); update(); root.updateMatrixWorld(true)
          const actual = rod.localToWorld(new THREE.Vector3(0,rodLength,0))
          const expected = tipFrame.localToWorld(tip.clone())
          expect(actual.distanceTo(expected)).toBeLessThan(1e-6)
          expect(sleeve.scale.toArray()).toEqual([1,1,1])
          expect(rod.scale.y).toBeGreaterThan(0)
        }
      }
    }
  })
})

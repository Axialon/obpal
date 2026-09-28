import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { DEVICES } from '../src/sim/devices/registry'
import type { Stage } from '../src/sim/devices/stage'

vi.mock('../src/ui/markup', () => ({ setMarkup() {}, html() {} }))

// These are scene-graph contracts. Textures need a canvas-shaped stub, not a GPU.
const context = new Proxy({
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  measureText: (text: string) => ({ width: text.length * 12 }),
  getImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }),
}, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) })
function element(): object {
  return { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    append() {}, appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
    querySelector: element, querySelectorAll: () => [], getContext: () => context }
}
beforeAll(() => {
  vi.stubGlobal('document', { createElement: element, body: element(), querySelector: element })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }))
  vi.stubGlobal('innerWidth', 1280); vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('addEventListener', () => {})
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(() => {
  expect(console.error).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

function testStage() {
  const scene = new THREE.Scene()
  return {
    scene, ground: new THREE.Mesh(), camera: new THREE.PerspectiveCamera(), controls: {},
    lights: { hemi: new THREE.HemisphereLight(), key: new THREE.DirectionalLight() },
    renderer: {}, view: { invalidate() {} }, theme: { light: false }, toScreen: () => null,
  } as unknown as Stage
}

it.each(DEVICES.map(entry => [entry.spec.id, entry] as const))('%s supplies one finite +Z camera frame for every seat', async (_id, entry) => {
  const stage = testStage(), { scene } = stage
  const view = (await entry.view()).createView(stage, entry.logic())
  view.update?.(Array(entry.spec.units).fill(null), 0, 1 / 60)
  scene.updateMatrixWorld(true)
  const anchors: THREE.Object3D[] = []
  scene.traverse(node => { if (node.name === 'pov') anchors.push(node) })
  expect(anchors).toHaveLength(entry.spec.units)
  for (const anchor of anchors) {
    expect(anchor.matrixWorld.elements.every(Number.isFinite)).toBe(true)
    expect(anchor.getWorldDirection(new THREE.Vector3()).length()).toBeCloseTo(1)
    anchor.scale.toArray().forEach(value => expect(value).toBeCloseTo(1))
  }
})

it('keeps the helicopter camera clear of both nose skins and its number placard', async () => {
  const entry = DEVICES.find(entry => entry.spec.id === 'helicopter')!
  const stage = testStage(), view = (await entry.view()).createView(stage, entry.logic())
  view.update?.([], 0, 1 / 60)
  const rig = stage.scene.getObjectByName('helicopter-1')!
  const anchor = rig.getObjectByName('pov')!, slot = rig.getObjectByName('cabinSkin')!
  const clear = () => {
    stage.scene.updateMatrixWorld(true)
    const origin = anchor.getWorldPosition(new THREE.Vector3()), rotation = anchor.getWorldQuaternion(new THREE.Quaternion())
    for (const x of [-.5, 0, .5]) for (const y of [-.5, 0, .5]) {
      const direction = new THREE.Vector3(x, y, 1).normalize().applyQuaternion(rotation)
      expect(new THREE.Raycaster(origin, direction, .001, .5).intersectObject(rig, true)).toHaveLength(0)
    }
  }
  clear()
  await MeshoptDecoder.ready
  const source = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readModel('helicopter'), '')).scene
  slot.clear(); slot.add(...[...source.getObjectByName('cabinSkin')!.children])
  clear()
})

it('places, turns and removes instanced channels without moving their board frame', async () => {
  const { MarblerunLogic } = await import('../src/sim/devices/marblerun')
  const { createView } = await import('../src/sim/devices/marblerun.view')
  const logic = new MarblerunLogic(), stage = testStage(), view = createView(stage, logic)
  const unit = logic.units[0]
  unit.track.fill(null); unit.track[0] = { kind: 0, turn: 1 }; unit.track[24] = { kind: 1, turn: 2 }
  unit.tiltX = .5; unit.tiltZ = -.25
  view.update?.([], 0, 1 / 60)
  const straight = stage.scene.getObjectByName('channel-instances-0-0') as THREE.InstancedMesh
  const bend = stage.scene.getObjectByName('channel-instances-1-0') as THREE.InstancedMesh
  expect(straight.count).toBe(1); expect(bend.count).toBe(1)
  const pose = new THREE.Matrix4(); straight.getMatrixAt(0, pose)
  const position = new THREE.Vector3().setFromMatrixPosition(pose)
  expect(position.x).toBeCloseTo(-1.16); expect(position.z).toBeCloseTo(-1.16)
  const forward = new THREE.Vector3(1, 0, 0).transformDirection(pose)
  expect(forward.z).toBeCloseTo(1)
  expect(straight.parent).toBe(bend.parent)
  expect(straight.parent!.rotation.z).toBeCloseTo(-.04)
  bend.getMatrixAt(0, pose)
  expect(new THREE.Vector3().setFromMatrixPosition(pose).x).toBeCloseTo(1.16)
  unit.track[0] = null; view.update?.([], 0, 1 / 60)
  expect(straight.count).toBe(0); expect(bend.count).toBe(1)
})

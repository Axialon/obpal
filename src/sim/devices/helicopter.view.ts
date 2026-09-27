import * as THREE from 'three'
import { batch, floorMaterial, glass, maker, metal, plastic, rubber } from '../kit'
import { HelicopterLogic, HELICOPTER_PADS, HELICOPTER_RINGS } from './helicopter'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, plate, wear, type DeviceView } from './view'

function helicopter(n: number) {
  const root = new THREE.Group(), cabin = new THREE.Group(), tail = new THREE.Group(), skids = new THREE.Group()
  root.name = `helicopter-${n + 1}`; cabin.name = 'cabin'; tail.name = 'tail-boom'; skids.name = 'landing-skids'
  root.add(cabin, tail, skids)
  const paint = plastic(n ? '#609bab' : '#d69b4b'), glow = mats.glow()
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), paint)
  shell.scale.set(0.42, 0.44, 0.8); shell.position.set(0, 0.5, -0.2); shell.castShadow = true; cabin.add(shell)
  const window = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), glass)
  window.scale.set(0.385, 0.35, 0.45); window.position.set(0, 0.58, -0.6); cabin.add(window)
  block(cabin, [0.56, 0.24, 0.6], [0, 0.82, 0.15], plastic('#485058'))
  for (const x of [-0.3, 0.3]) rod(cabin, [x, 0.88, -0.53], [x, 0.29, -0.73], 0.018, metal)
  rod(tail, [0, 0.52, 0.3], [0, 0.66, 2.05], 0.1, paint)
  block(tail, [0.7, 0.045, 0.3], [0, 0.65, 1.73], paint)
  block(tail, [0.055, 0.6, 0.35], [0, 0.84, 1.95], paint)
  for (const s of [-1, 1]) {
    rod(skids, [s * 0.45, 0, -0.92], [s * 0.45, 0, 0.85], 0.045, rubber)
    rod(skids, [s * 0.45, 0, -0.92], [s * 0.45, 0.14, -1.04], 0.045, rubber)
    for (const z of [-0.45, 0.5]) rod(skids, [s * 0.2, 0.34, z], [s * 0.45, 0, z], 0.035)
  }
  const rotor = new THREE.Group(), tailRotor = new THREE.Group()
  rotor.name = 'main-rotor'; rotor.position.set(0, 1.16, 0); root.add(rotor)
  rod(cabin, [0, 0.85, 0], [0, 1.2, 0], 0.045)
  for (const a of [0, Math.PI / 2]) {
    const blade = block(rotor, [3.15, 0.025, 0.12], [0, 0, 0], rubber); blade.rotation.y = a
  }
  disc(rotor, 0.12, 0.07, [0, 0.04, 0], metal)
  tailRotor.name = 'tail-rotor'; tailRotor.position.set(0.11, 0.8, 1.98); root.add(tailRotor)
  for (const a of [0, Math.PI / 2]) {
    const blade = block(tailRotor, [0.035, 0.65, 0.07], [0, 0, 0], rubber); blade.rotation.x = a
  }
  disc(cabin, 0.05, 0.06, [0, 0.96, 0.32], glow)
  const number = plate(n + 1, 0.25); number.position.set(0, 0.54, -0.99); cabin.add(number)
  maker(cabin, 0, 0.95, 0.08, 0.16)
  for (const part of [cabin, tail, skids, rotor, tailRotor]) batch(part)
  return { root, rotor, tailRotor, glow }
}
function trainingField(scene: THREE.Scene, logic: HelicopterLogic) {
  const field = new THREE.Group(); field.name = 'training-field'; scene.add(field)
  block(field, [25, 0.12, 23], [0, -0.12, 0], floorMaterial('#73846c'))
  HELICOPTER_PADS.forEach(([x, z], n) => {
    disc(field, 1.55, 0.07, [x, 0, z], floorMaterial('#495560'))
    for (const dx of [-0.35, 0.35]) block(field, [0.11, 0.02, 1.05], [x + dx, 0.046, z], plastic('#e2e5d9'))
    block(field, [0.7, 0.02, 0.11], [x, 0.046, z], plastic('#e2e5d9'))
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; disc(field, 0.055, 0.1, [x + Math.sin(a) * 1.4, 0.04, z + Math.cos(a) * 1.4], plastic(n ? '#79b3cb' : '#eac37a')) }
  })
  for (const x of [-11.8, 11.8]) {
    rod(field, [x, 0.3, -10.7], [x, 0.3, 10.7], 0.04)
    for (let z = -10; z <= 10; z += 2) rod(field, [x, 0, z], [x, 0.65, z], 0.035)
  }
  block(field, [4, 2.2, 3], [-7, 1, 6], plastic('#8e9c98'))
  block(field, [4.4, 0.13, 3.4], [-7, 2.2, 6], metal)
  block(field, [3, 1.7, 0.06], [-7, 0.88, 7.53], plastic('#4c626b'))
  batch(field)
  const rings = HELICOPTER_RINGS.map((r, n) => {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.055, 10, 48), mats.glow('#d1b976'))
    mesh.name = `training-ring-${n + 1}`; mesh.position.set(r.x, r.y, r.z); mesh.rotation.y = r.face; scene.add(mesh)
    return mesh
  })
  const models = logic.units.map((_, n) => { const m = helicopter(n); scene.add(m.root); return m })
  return {
    step(colors: readonly (string | null)[] = []) {
      models.forEach((m, n) => {
        const u = logic.units[n]
        m.root.position.set(u.x, u.y, u.z); m.root.rotation.set(u.pitch, u.h, u.roll, 'YXZ')
        m.rotor.rotation.y = u.spin; m.tailRotor.rotation.x = u.spin * 1.8
        wear(m.glow, colors[n] ?? null)
      })
      rings.forEach((r, n) => { r.material.emissiveIntensity = logic.units.some((u) => u.next === n) ? 1.8 : 0.3 })
    },
  }
}
export function createView(stage: Stage, logic: HelicopterLogic): DeviceView {
  stage.ground.visible = false
  const w = trainingField(stage.scene, logic), at = (n: number): [number, number, number] => [logic.units[n].x, logic.units[n].y + 0.5, logic.units[n].z]
  return {
    framing: playFrame(at(0), 1.5), overview: playFrame([0, 1.5, 0], 11), inspect: () => playFrame(at(0), 1.15),
    follow: (n) => new THREE.Vector3(...at(n)), update: (colors) => w.step(colors),
  }
}
export function preview() {
  const logic = new HelicopterLogic()
  return showcase((scene) => {
    const w = trainingField(scene, logic)
    return { step(t) { logic.units[0].y = 1.4 + Math.sin(t) * 0.06; logic.units[0].spin = t * 25; w.step() } }
  }, [-2, 1.9, 4], 1.55)
}

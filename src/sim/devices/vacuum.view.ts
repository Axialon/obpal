import * as THREE from 'three'
import { batch, floorMaterial, maker, metal, plastic, rubber } from '../kit'
import { VacuumLogic, DOCK, FURNITURE } from './vacuum'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'
function room(scene: THREE.Scene, logic: VacuumLogic) {
  const set = new THREE.Group()
  scene.add(set)
  block(set, [10, 0.12, 8], [0, -0.06, 0], floorMaterial('#967354'))
  for (let x = -4.8; x < 5; x += 0.4) block(set, [0.008, 0.006, 8], [x, 0.003, 0], plastic('#725238'))
  block(set, [10, 2.5, 0.12], [0, 1.25, -4], plastic('#a7afa4'))
  block(set, [0.12, 2.5, 8], [-5, 1.25, 0], plastic('#a7afa4'))
  const sofa = FURNITURE[0]
  block(set, [sofa.w, 0.35, sofa.d], [sofa.x, 0.42, sofa.z], plastic('#697c81'))
  block(set, [sofa.w, 0.65, 0.22], [sofa.x, 0.72, sofa.z - 0.5], plastic('#697c81'))
  for (let n = 0; n < 3; n++)
    block(set, [0.96, 0.18, 0.92], [sofa.x + (n - 1) * 1.02, 0.66, sofa.z + 0.05], plastic('#8b9e9b'))
  for (const [n, b] of FURNITURE.entries()) {
    if (!n) continue
    block(set, [b.w, 0.1, b.d], [b.x, 0.7, b.z], plastic('#c2a178'))
    for (const x of [-1, 1])
      for (const z of [-1, 1])
        rod(set, [b.x + x * b.w * 0.4, 0, b.z + z * b.d * 0.4], [b.x + x * b.w * 0.4, 0.7, b.z + z * b.d * 0.4], 0.045)
  }
  block(set, [0.9, 0.13, 0.75], [DOCK[0], 0.06, DOCK[1]], rubber)
  block(set, [0.9, 0.45, 0.15], [DOCK[0], 0.23, DOCK[1] + 0.3], plastic('#e8e6dc'))
  block(set, [0.4, 0.05, 0.02], [DOCK[0], 0.3, DOCK[1] + 0.21], plastic('#8cf5be'))
  batch(set)
  const root = new THREE.Group()
  scene.add(root)
  disc(root, 0.38, 0.13, [0, 0.09, 0], rubber)
  disc(root, 0.365, 0.095, [0, 0.18, 0], plastic('#eeeae0'))
  disc(root, 0.105, 0.08, [0, 0.265, 0.07], plastic('#394955'))
  disc(root, 0.078, 0.02, [0, 0.315, 0.07], metal)
  for (const x of [-0.07, 0.07]) disc(root, 0.025, 0.01, [x, 0.232, -0.16], metal)
  for (let n = 0; n < 7; n++) block(root, [0.02, 0.008, 0.075], [(n - 3) * 0.033, 0.232, 0.2], rubber)
  const seam = new THREE.Mesh(new THREE.TorusGeometry(0.375, 0.008, 6, 48), metal)
  seam.rotation.x = Math.PI / 2
  seam.position.y = 0.15
  root.add(seam)
  const glow = mats.glow('#8af0bc')
  block(root, [0.15, 0.015, 0.035], [0, 0.235, -0.17], glow)
  maker(root, 0, 0.238, 0.2, 0.11)
  const brush = new THREE.Group()
  brush.position.set(0.29, 0.045, -0.23)
  root.add(brush)
  for (let n = 0; n < 3; n++) {
    const b = block(brush, [0.025, 0.02, 0.26], [0, 0, 0], rubber)
    b.rotation.y = (n * Math.PI) / 3
  }
  batch(brush)
  batch(root, [brush])
  const dust = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.025, 0), plastic('#e4c893'), logic.dust.length)
  scene.add(dust)
  const dummy = new THREE.Object3D()
  return {
    step(t: number, dt: number, colors: readonly (string | null)[] = []) {
      const u = logic.units[0]
      root.position.set(u.x, 0, u.z)
      root.rotation.y = u.h
      if (u.clean && Math.abs(u.v) > 0.01) brush.rotation.y += dt * 18
      wear(glow, colors[0] ?? null)
      logic.dust.forEach((d, n) => {
        dummy.position.set(d.x, 0.025, d.z)
        dummy.scale.setScalar(d.cleaned ? 0 : 1)
        dummy.rotation.y = n
        dummy.updateMatrix()
        dust.setMatrixAt(n, dummy.matrix)
      })
      dust.instanceMatrix.needsUpdate = true
      void t
    },
  }
}
export function createView(stage: Stage, logic: VacuumLogic): DeviceView {
  const w = room(stage.scene, logic),
    at = (): [number, number, number] => [logic.units[0].x, 0.12, logic.units[0].z]
  return {
    framing: playFrame(at(), 0.5),
    overview: playFrame([0, 0.4, 0], 5.5),
    inspect: () => playFrame(at(), 0.45),
    follow: () => new THREE.Vector3(...at()),
    pickY: 0,
    update: (c, t, dt) => w.step(t, dt, c),
  }
}
export function preview() {
  const l = new VacuumLogic()
  return showcase(
    (s) => {
      const w = room(s, l)
      return {
        step(t, dt) {
          l.units[0].h = Math.sin(t * 0.5)
          w.step(t, dt)
        },
      }
    },
    [-2, 0.1, 1.5],
    0.62,
  )
}

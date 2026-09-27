import * as THREE from 'three'
import { batch, floorMaterial, maker, metal, plastic, rubber } from '../kit'
import { PainterLogic, INKS } from './painter'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'
function studio(scene: THREE.Scene, logic: PainterLogic) {
  const set = new THREE.Group()
  scene.add(set)
  block(set, [10, 0.12, 8], [0, -0.07, 0], floorMaterial('#1d2431'))
  block(set, [10, 4.4, 0.12], [0, 2.2, -3], plastic('#1b2234'))
  for (const x of [-4, 4]) {
    rod(set, [x, 0, -2.5], [x, 3.5, -2.5], 0.03)
    block(set, [0.15, 1.2, 0.12], [x, 2.8, -2.5], plastic('#747891'))
  }
  block(set, [1.7, 0.1, 0.7], [-3.4, 0.7, -2.3], plastic('#656a78'))
  for (const x of [-4, -2.8]) rod(set, [x, 0, -2.3], [x, 0.7, -2.3], 0.025)
  for (const z of [-2, 0, 2]) block(set, [7, 0.007, 0.014], [0, 0.002, z], plastic('#414555'))
  batch(set)
  const root = new THREE.Group()
  scene.add(root)
  disc(root, 0.075, 0.36, [0, 0, 0], rubber)
  disc(root, 0.084, 0.04, [0, -0.17, 0], metal)
  disc(root, 0.084, 0.04, [0, 0.15, 0], metal)
  maker(root, 0, 0.03, 0.076, 0.07)
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 16), new THREE.MeshBasicMaterial({ color: INKS[0] }))
  bulb.position.y = 0.22
  root.add(bulb)
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.19, 16, 12),
    new THREE.MeshBasicMaterial({
      color: INKS[0],
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  halo.position.y = 0.22
  root.add(halo)
  const light = new THREE.PointLight(INKS[0], 4, 4)
  light.position.y = 0.22
  root.add(light)
  batch(root, [bulb, halo])
  const geo = new THREE.CylinderGeometry(0.018, 0.018, 1, 8),
    mat = new THREE.MeshBasicMaterial({ color: 'white' }),
    trail = new THREE.InstancedMesh(geo, mat, 512),
    glow = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1, 8),
      new THREE.MeshBasicMaterial({
        color: 'white',
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      512,
    )
  scene.add(trail, glow)
  trail.frustumCulled = glow.frustumCulled = false
  const dummy = new THREE.Object3D(),
    a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    up = new THREE.Vector3(0, 1, 0),
    color = new THREE.Color()
  return {
    step() {
      const u = logic.units[0]
      root.position.set(u.x, u.y, u.z)
      root.quaternion.set(...u.q)
      bulb.material.color.set(INKS[u.colour])
      halo.material.color.set(INKS[u.colour])
      light.color.set(INKS[u.colour])
      trail.count = glow.count = logic.strokes.length
      logic.strokes.forEach((s, n) => {
        a.set(...s.a)
        b.set(...s.b)
        dummy.position.copy(a).add(b).multiplyScalar(0.5)
        b.sub(a)
        dummy.scale.set(1, b.length(), 1)
        dummy.quaternion.setFromUnitVectors(up, b.normalize())
        dummy.updateMatrix()
        trail.setMatrixAt(n, dummy.matrix)
        glow.setMatrixAt(n, dummy.matrix)
        color.set(INKS[s.colour])
        trail.setColorAt(n, color)
        glow.setColorAt(n, color)
      })
      trail.instanceMatrix.needsUpdate = glow.instanceMatrix.needsUpdate = true
      if (trail.instanceColor) trail.instanceColor.needsUpdate = true
      if (glow.instanceColor) glow.instanceColor.needsUpdate = true
    },
  }
}
export function createView(stage: Stage, logic: PainterLogic): DeviceView {
  const w = studio(stage.scene, logic)
  stage.lights.hemi.intensity = 0.45
  stage.lights.key.intensity = 0.45
  return {
    framing: playFrame([0, 1.5, 0], 0.55, [0.5, 0.25, 1.3]),
    overview: playFrame([0, 1.6, 0], 4.4),
    inspect: () => playFrame([logic.units[0].x, logic.units[0].y, logic.units[0].z], 0.36),
    follow: () => new THREE.Vector3(logic.units[0].x, logic.units[0].y, logic.units[0].z),
    update: () => w.step(),
  }
}
export function preview() {
  const l = new PainterLogic()
  return showcase(
    (s) => {
      const w = studio(s, l)
      return {
        step(t) {
          l.strokes = Array.from({ length: 120 }, (_, n) => {
            const f = (v: number): [number, number, number] => [
              Math.sin(v) * 1.3,
              1.5 + Math.sin(v * 2) * 0.65,
              Math.cos(v) * 0.35,
            ]
            return { a: f(n / 20 + t * 0.2), b: f((n + 1) / 20 + t * 0.2), colour: Math.floor(n / 30) }
          })
          w.step()
        },
      }
    },
    [0, 1.5, 0],
    1.4,
  )
}

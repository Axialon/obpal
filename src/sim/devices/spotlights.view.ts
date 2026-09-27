import * as THREE from 'three'
import { batch, cable, floorMaterial, metal, plastic } from '../kit'
import { SpotlightsLogic, LIGHT_COLOURS } from './spotlights'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'

function gobo(pattern: number) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.strokeStyle = g.fillStyle = 'white'
  g.lineWidth = 9
  g.translate(64, 64)
  if (pattern === 0) {
    for (const r of [18, 38, 54]) {
      g.beginPath()
      g.arc(0, 0, r, 0, Math.PI * 2)
      g.stroke()
    }
  } else
    for (let n = 0; n < 8; n++) {
      g.rotate(Math.PI / 4)
      if (pattern === 1) g.fillRect(17, -5, 39, 10)
      else {
        g.beginPath()
        g.arc(38, 0, 11, 0, Math.PI * 2)
        g.fill()
      }
    }
  return new THREE.CanvasTexture(c)
}
function theatre(scene: THREE.Scene, logic: SpotlightsLogic) {
  const set = new THREE.Group()
  scene.add(set)
  block(set, [12, 0.25, 8], [0, -0.025, 0], floorMaterial('#282332'))
  block(set, [12, 4.8, 0.18], [0, 2.3, -3.8], plastic('#262033'))
  for (const x of [-5.5, 5.5]) {
    for (const z of [-1.8, -1.2]) rod(set, [x, 0, z], [x, 4.2, z], 0.055)
    for (let y = 0; y < 4; y += 0.5) rod(set, [x, y, -1.8], [x, y + 0.5, -1.2], 0.025)
  }
  for (const y of [4, 4.4]) for (const z of [-1.8, -1.2]) rod(set, [-5.5, y, z], [5.5, y, z], 0.045)
  for (let x = -5.5; x < 5.5; x += 0.5) {
    rod(set, [x, 4, -1.2], [x + 0.5, 4.4, -1.2], 0.022)
    rod(set, [x, 4.4, -1.8], [x + 0.5, 4, -1.8], 0.022)
  }
  for (const x of [-4.8, 4.8]) {
    block(set, [0.7, 1.4, 0.6], [x, 0.85, 2], plastic('#171b22'))
    for (const y of [0.55, 1.05]) {
      const speaker = disc(set, 0.24, 0.02, [x, y, 2.32], plastic('#42434b'))
      speaker.rotation.x = Math.PI / 2
    }
  }
  batch(set)
  const maps = [0, 1, 2].map(gobo)
  const heads = logic.units.map((_, n) => {
    const root = new THREE.Group()
    root.position.set((n - 1.5) * 2, 3.65, -1.5)
    scene.add(root)
    block(root, [0.72, 0.16, 0.45], [0, 0.42, 0], plastic('#1b2029'))
    for (const x of [-0.32, 0.32]) block(root, [0.09, 0.5, 0.18], [x, 0.16, 0], metal)
    const head = new THREE.Group()
    root.add(head)
    block(head, [0.5, 0.5, 0.64], [0, 0, 0], plastic('#252c38'))
    for (let j = 0; j < 5; j++) block(head, [0.38, 0.025, 0.025], [0, 0.25, 0.17 - j * 0.065], metal)
    const lens = disc(head, 0.19, 0.07, [0, 0, -0.35], plastic('#e8eeff'))
    lens.rotation.x = Math.PI / 2
    root.add(
      cable(
        [
          [0, 0.45, 0.2],
          [0.4, 0.25, 0.3],
          [0.23, 0, 0.3],
        ],
        0.016,
      ),
    )
    batch(head)
    batch(root, [head])
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.8, 1, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 'white',
        transparent: true,
        opacity: 0.055,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    scene.add(beam)
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 1.7),
      new THREE.MeshBasicMaterial({
        map: maps[0],
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    pool.rotation.x = -Math.PI / 2
    scene.add(pool)
    const light = new THREE.SpotLight('white', 15, 10, 0.24, 0.8, 1.2)
    light.position.copy(root.position)
    scene.add(light, light.target)
    return { root, head, beam, pool, light }
  })
  return {
    step() {
      heads.forEach((m, n) => {
        const h = logic.units[n],
          target = new THREE.Vector3(m.root.position.x + Math.tan(h.pan) * 3.6, 0.12, -1.5 + Math.tan(h.tilt) * 3.6),
          direction = target.clone().sub(m.root.position)
        m.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction.clone().normalize())
        m.beam.position.copy(m.root.position).add(target).multiplyScalar(0.5)
        m.beam.scale.y = direction.length()
        m.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), direction.normalize())
        m.beam.material.color.set(LIGHT_COLOURS[h.colour])
        m.pool.position.copy(target)
        m.pool.material.map = maps[h.gobo]
        m.pool.material.color.set(LIGHT_COLOURS[h.colour])
        m.light.color.set(LIGHT_COLOURS[h.colour])
        m.light.target.position.copy(target)
      })
    },
  }
}
export function createView(stage: Stage, logic: SpotlightsLogic): DeviceView {
  stage.lights.hemi.intensity = 0.5
  stage.lights.key.intensity = 0.65
  const w = theatre(stage.scene, logic)
  return {
    framing: playFrame([-3, 3.4, -1.5], 0.9, [1, 0.2, 1.5]),
    overview: playFrame([0, 1.8, 0], 6),
    inspect: () => playFrame([-3, 3.65, -1.5], 0.65),
    update: () => w.step(),
  }
}
export function preview() {
  const l = new SpotlightsLogic()
  return showcase(
    (s) => {
      const w = theatre(s, l)
      return {
        step(t) {
          l.units.forEach((h, n) => {
            h.pan = Math.sin(t * 0.4 + n) * 0.5
            h.tilt = 0.65
          })
          w.step()
        },
      }
    },
    [-1, 2, 0],
    2.8,
  )
}

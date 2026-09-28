import * as THREE from 'three'
import { batch, glass, maker, metal, plastic, rubber } from '../kit'
import { BoatLogic, BUOYS } from './boat'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { wear, mats, type DeviceView } from './view'
import { ceramic, darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'

function launch() {
  const root = new THREE.Group(),
    hull = new THREE.Shape()
  const skin = skinSlot(root, 'hullSkin')
  pov(root, [0, .59, -.44])
  hull.moveTo(-0.38, 0.8)
  hull.lineTo(0.38, 0.8)
  hull.lineTo(0.43, -0.35)
  hull.lineTo(.16, -.92); hull.lineTo(0, -1)
  hull.lineTo(-.16, -.92); hull.lineTo(-.43, -.35)
  hull.closePath()
  const shell = new THREE.Mesh(
    new THREE.ExtrudeGeometry(hull, {
      depth: 0.28,
      bevelEnabled: true,
      bevelSize: 0.002,
      bevelThickness: 0.002,
      bevelSegments: 1,
      steps: 1,
    }),
    gunmetal,
  )
  shell.rotation.x = Math.PI / 2
  shell.position.y = 0.23
  skin.add(shell)
  block(skin, [0.63, 0.1, 0.65], [0, 0.27, 0.23], darkTitanium)
  block(skin, [0.58, 0.3, 0.53], [0, 0.43, -0.15], gunmetal)
  block(skin, [0.55, 0.2, 0.02], [0, 0.57, -0.43], glass)
  block(skin, [0.65, 0.05, 0.64], [0, 0.66, -0.17], ceramic)
  block(root, [0.3, 0.25, 0.24], [0, 0.18, 0.9], rubber)
  const prop = new THREE.Group()
  prop.position.set(0, -0.08, 1.02)
  root.add(prop)
  for (const angle of [0, Math.PI / 2]) {
    const blade = block(prop, [0.28, 0.045, 0.025], [0, 0, 0], metal)
    blade.rotation.z = angle
  }
  for (const s of [-1, 1]) {
    rod(root, [s * 0.33, 0.3, -0.6], [s * 0.33, 0.48, -0.6], 0.015)
    rod(root, [s * 0.33, 0.48, -0.6], [s * 0.32, 0.48, 0.55], 0.012)
  }
  maker(root, 0, 0.7, -0.17, 0.15)
  const glow = mats.glow('#c6ff34')
  disc(root, 0.04, 0.04, [0, 0.72, -0.2], glow)
  batch(prop)
  batch(root, [prop])
  return { root, prop, glow, skin }
}
function harbour(scene: THREE.Scene, logic: BoatLogic, live?: () => void) {
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 20, 48, 44),
    new THREE.MeshPhysicalMaterial({
      color: '#385c68',
      roughness: 0.26,
      metalness: 0.3,
      clearcoat: 0.8,
      side: THREE.DoubleSide,
    }),
  )
  water.rotation.x = -Math.PI / 2
  water.position.y = -0.05
  scene.add(water)
  const dock = new THREE.Group()
  scene.add(dock)
  const deck = tiledDeck(6.8, 3, .24, .6); deck.position.set(-2.1, 0, 4.45); dock.add(deck)
  for (const x of [-5.3, 1.1])
    for (const z of [3, 5.8]) {
      block(dock, [.2, .8, .2], [x, .28, z], darkTitanium)
      disc(dock, 0.14, 0.06, [x, 0.7, z], metal)
    }
  const buoys = BUOYS.map(([x, z], n) => {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    scene.add(g)
    disc(g, 0.24, 0.16, [0, 0.12, 0], plastic(n % 2 ? '#e97153' : '#f6d267'))
    rod(g, [0, 0.18, 0], [0, 0.95, 0], 0.035)
    block(g, [0.35, 0.2, 0.02], [0.16, 0.85, 0], plastic('#e8ece2'))
    batch(g)
    return g
  })
  batch(dock)
  const boats = logic.units.map(() => {
    const b = launch()
    scene.add(b.root)
    if (live) upgradeSkins('boat', { hullSkin: b.skin }, live)
    return b
  })
  const wakes = boats.map(() => {
    const g = new THREE.Group()
    scene.add(g)
    for (const s of [-1, 1]) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.07, 1.9),
        new THREE.MeshBasicMaterial({ color: '#d7ffff', transparent: true, opacity: 0.35, depthWrite: false }),
      )
      mesh.rotation.set(-Math.PI / 2, 0, s * 0.23)
      mesh.position.set(s * 0.55, 0, 1.65)
      g.add(mesh)
    }
    return g
  })
  return {
    step(t: number, dt: number, colors: readonly (string | null)[] = []) {
      const p = water.geometry.attributes.position
      for (let j = 0; j < p.count; j++)
        p.setZ(j, Math.sin(p.getX(j) * 2 + t) * 0.025 + Math.cos(p.getY(j) * 1.7 + t * 1.3) * 0.02)
      p.needsUpdate = true
      water.geometry.computeVertexNormals()
      boats.forEach((m, n) => {
        const b = logic.units[n]
        m.root.position.set(b.x, Math.sin(t * 1.3 + n) * 0.025, b.z)
        m.root.rotation.set(Math.sin(t + n) * 0.015, b.h, b.rudder * b.v * 0.04)
        m.prop.rotation.z += b.v * dt * 25
        wear(m.glow, colors[n] ?? null)
        wakes[n].position.set(b.x, 0.035, b.z)
        wakes[n].rotation.y = b.h
        wakes[n].visible = Math.abs(b.v) > 0.1
      })
      buoys.forEach((b, n) => {
        b.position.y = Math.sin(t + n) * 0.035
      })
    },
  }
}
export function createView(stage: Stage, logic: BoatLogic): DeviceView {
  stage.ground.visible = false
  const world = harbour(stage.scene, logic, () => stage.view.invalidate())
  const at = (n: number): [number, number, number] => [logic.units[n].x, 0.3, logic.units[n].z]
  return {
    framing: playFrame(at(0), 1.05),
    overview: playFrame([0, 0, 0], 11),
    inspect: () => playFrame(at(0), 0.8),
    follow: (n) => new THREE.Vector3(...at(n)),
    update: (c, t, dt) => {
      world.step(t, dt, c)
      stage.view.invalidate()
    },
  }
}
export function preview() {
  const logic = new BoatLogic()
  return showcase(
    (scene) => {
      const w = harbour(scene, logic)
      return {
        step(t, dt) {
          logic.units[0].h = Math.sin(t * 0.5) * 0.25
          w.step(t, dt)
        },
      }
    },
    [-2, 0.3, 1],
    1.15,
  )
}

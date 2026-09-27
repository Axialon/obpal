import * as THREE from 'three'
import { batch, bolt, floorMaterial, maker, metal, plastic, rubber } from '../kit'
import { TankLogic } from './tank'
import { block, disc, playFrame, rod, showcase, tracks } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'
function tank(n: number) {
  const root = new THREE.Group()
  tracks(root)
  block(root, [1.15, 0.3, 1.7], [0, 0.5, 0], plastic('#447579'))
  block(root, [1.5, 0.09, 1.9], [0, 0.62, 0], plastic('#bed6ca'))
  for (const x of [-0.5, 0.5])
    for (const z of [-0.6, 0.6]) {
      const b = bolt(0.035)
      b.position.set(x, 0.68, z)
      root.add(b)
    }
  for (let j = 0; j < 7; j++) block(root, [0.55, 0.015, 0.045], [0, 0.68, 0.4 + j * 0.06], rubber)
  const turret = new THREE.Group()
  turret.position.y = 0.76
  root.add(turret)
  disc(turret, 0.38, 0.2, [0, 0, 0], plastic('#447579'))
  block(turret, [0.75, 0.25, 0.65], [0, 0.12, 0], plastic('#639592'))
  disc(turret, 0.17, 0.06, [0, 0.28, 0.08], metal)
  const gun = new THREE.Group()
  gun.position.set(0, 0.12, -0.25)
  turret.add(gun)
  rod(gun, [0, 0, 0], [0, 0, -0.95], 0.075, metal)
  rod(gun, [0, 0, -0.85], [0, 0, -1.02], 0.105, plastic('#ffa166'))
  rod(turret, [0.28, 0.25, 0.18], [0.28, 0.85, 0.18], 0.012, rubber)
  maker(turret, 0, 0.255, -0.15, 0.16)
  const glow = mats.glow()
  for (const x of [-0.4, 0.4]) block(root, [0.13, 0.06, 0.03], [x, 0.58, -0.86], glow)
  batch(gun)
  batch(turret, [gun])
  batch(root, [turret])
  void n
  return { root, turret, gun, glow }
}
function range(scene: THREE.Scene, logic: TankLogic) {
  const set = new THREE.Group()
  scene.add(set)
  block(set, [18, 0.12, 16], [0, -0.07, 0], floorMaterial('#8d8167'))
  for (const x of [-8.8, 8.8]) block(set, [0.2, 0.7, 16], [x, 0.3, 0], plastic('#626e67'))
  for (let x = -8; x <= 8; x += 0.8)
    for (let y = 0; y < 3; y++)
      block(set, [0.78, 0.3, 0.65], [x + (y % 2) * 0.2, 0.15 + y * 0.3, -7.8], plastic('#a49a78'))
  batch(set)
  const targets = logic.targets.map((t) => {
    const root = new THREE.Group()
    root.position.set(t.x, 0.2, t.z)
    scene.add(root)
    rod(root, [0, 0, 0], [0, 0.7, 0], 0.04)
    for (const [r, c, z] of [
      [0.55, '#efe1bc', 0],
      [0.36, '#df7960', 0.03],
      [0.15, '#e8ece0', 0.06],
    ] as const) {
      const d = disc(root, r, 0.03, [0, 0.7, z], plastic(c))
      d.rotation.x = Math.PI / 2
    }
    batch(root)
    return root
  })
  const models = logic.units.map((_, n) => {
    const m = tank(n)
    scene.add(m.root)
    return m
  })
  const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 12, 8), plastic('#ffb780'), 24)
  scene.add(balls)
  const dummy = new THREE.Object3D()
  return {
    step(colors: readonly (string | null)[] = []) {
      models.forEach((m, n) => {
        const u = logic.units[n]
        m.root.position.set(u.x, 0, u.z)
        m.root.rotation.y = u.h
        m.turret.rotation.y = u.turret
        m.gun.rotation.x = u.elevation
        wear(m.glow, colors[n] ?? null)
      })
      targets.forEach((t, n) => (t.rotation.x = logic.targets[n].up ? 0 : -Math.PI / 2))
      for (let n = 0; n < 24; n++) {
        const b = logic.balls[n]
        dummy.position.set(b?.x ?? 0, b?.y ?? -10, b?.z ?? 0)
        dummy.scale.setScalar(b ? 1 : 0)
        dummy.updateMatrix()
        balls.setMatrixAt(n, dummy.matrix)
      }
      balls.instanceMatrix.needsUpdate = true
    },
  }
}
export function createView(stage: Stage, logic: TankLogic): DeviceView {
  const w = range(stage.scene, logic),
    at = (n: number): [number, number, number] => [logic.units[n].x, 0.55, logic.units[n].z]
  return {
    framing: playFrame(at(0), 1.25),
    overview: playFrame([0, 0, 0], 9),
    inspect: () => playFrame(at(0), 1),
    follow: (n) => new THREE.Vector3(...at(n)),
    update: (c) => w.step(c),
  }
}
export function preview() {
  const l = new TankLogic()
  return showcase(
    (s) => {
      const w = range(s, l)
      return {
        step(t) {
          l.units[0].turret = Math.sin(t) * 0.5
          w.step()
        },
      }
    },
    [-2, 0.6, 2],
    1.3,
  )
}

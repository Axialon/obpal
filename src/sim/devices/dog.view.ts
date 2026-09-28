import * as THREE from 'three'
import { ceramic, darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'
import { batch, maker, metal, plastic, rubber } from '../kit'
import { DogLogic, DOG_YARD } from './dog'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function robot(n: number, live?: () => void) {
  const root = new THREE.Group(), body = new THREE.Group(), head = new THREE.Group()
  root.name = `dog-${n + 1}`
  body.name = 'torso'
  head.name = 'head'
  root.add(body)
  body.add(head)
  const paint = gunmetal, trim = darkTitanium, glow = mats.glow()
  const slots: Record<string, THREE.Object3D> = {}
  slots.bodySkin = skinSlot(body, 'bodySkin', block(body, [0.52, 0.27, 1.03], [0, 0, 0], paint))
  block(body, [0.43, 0.05, 0.77], [0, 0.16, 0.02], trim)
  block(body, [0.25, 0.06, 0.4], [0, 0.2, 0.08], metal)
  maker(body, 0, 0.238, 0.08, 0.16)
  block(body, [0.06, 0.025, 0.27], [0.21, 0.18, 0.06], glow)
  head.position.set(0, 0.09, -0.62)
  slots.headSkin = skinSlot(head, 'headSkin', block(head, [0.43, 0.3, 0.36], [0, 0.03, 0], paint))
  pov(head, [0, .06, -.242])
  block(head, [0.33, 0.16, 0.05], [0, 0.045, -0.2], rubber)
  for (const x of [-0.105, 0.105]) {
    block(head, [0.065, 0.04, 0.017], [x, 0.06, -0.23], glow)
    block(head, [0.07, 0.16, 0.12], [x * 1.65, 0.24, 0.07], trim)
  }
  const tail = new THREE.Group()
  tail.name = 'tail'
  tail.position.set(0, 0.06, 0.54)
  body.add(tail)
  rod(tail, [0, 0, 0], [0, 0.27, 0.24], 0.045, paint)
  const legs = [-1, 1, -1, 1].map((side, k) => {
    const hip = new THREE.Group(), knee = new THREE.Group()
    hip.name = `${k < 2 ? 'front' : 'rear'}-${side < 0 ? 'left' : 'right'}-hip`
    knee.name = 'knee'
    hip.position.set(side * 0.3, 0, k < 2 ? -0.36 : 0.36)
    knee.position.y = -0.34
    body.add(hip)
    hip.add(knee)
    const joint = disc(hip, 0.095, 0.11, [0, 0, 0], darkTitanium)
    joint.rotation.z = Math.PI / 2
    slots[`hipSkin${k}`] = skinSlot(hip, `hipSkin${k}`, block(hip, [0.115, 0.32, 0.14], [0, -0.17, 0], paint))
    const joint2 = disc(knee, 0.07, 0.12, [0, 0, 0], darkTitanium)
    joint2.rotation.z = Math.PI / 2
    slots[`kneeSkin${k}`] = skinSlot(knee, `kneeSkin${k}`, block(knee, [0.078, 0.32, 0.1], [0, -0.17, 0], trim))
    block(knee, [0.14, 0.08, 0.2], [0, -0.34, -0.025], rubber)
    batch(knee)
    batch(hip, [knee])
    return { hip, knee }
  })
  batch(head)
  batch(tail)
  batch(body, [head, tail, ...legs.map((l) => l.hip)])
  if (live) upgradeSkins('dog', slots, () => {
    for (const slot of Object.values(slots)) slot.userData.static = true
    batch(head)
    for (const leg of legs) { batch(leg.knee); batch(leg.hip, [leg.knee]) }
    batch(body, [head, tail, ...legs.map(leg => leg.hip)])
    live()
  })
  return { root, body, head, legs, tail, glow }
}

function yard(scene: THREE.Scene, logic: DogLogic, live?: () => void) {
  const ground = new THREE.Group(), fence = new THREE.Group(), pads = new THREE.Group()
  ground.name = 'yard'
  fence.name = 'fence'
  pads.name = 'charging-pads'
  scene.add(ground, fence, pads)
  ground.add(tiledDeck(13.4, 11.4, -.05, 2))
  for (const z of [-5.5, 5.5]) {
    for (let x = -6.5; x <= 6.5; x += 1.3) rod(fence, [x, 0, z], [x, 0.7, z], 0.04, metal)
    for (const y of [0.3, 0.64]) rod(fence, [-6.5, y, z], [6.5, y, z], 0.027, metal)
  }
  for (const x of [-6.5, 6.5]) {
    for (let z = -4.2; z < 5.5; z += 1.3) rod(fence, [x, 0, z], [x, 0.7, z], 0.04, metal)
    for (const y of [0.3, 0.64]) rod(fence, [x, y, -5.5], [x, y, 5.5], 0.027, metal)
  }
  for (const u of logic.units) {
    block(pads, [1.25, 0.05, 1.55], [u.x, 0, u.z], rubber)
    for (const x of [-0.5, 0.5]) block(pads, [0.025, 0.015, 1.3], [u.x + x, 0.035, u.z], ceramic)
  }
  batch(ground); batch(fence); batch(pads)
  const dogs = logic.units.map((_, n) => {
    const model = robot(n, live)
    scene.add(model.root)
    return model
  })
  const balls = logic.units.map((_, n) => {
    const root = new THREE.Group()
    root.name = `ball-${n + 1}`
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 12), plastic(n ? '#78bdd2' : '#ead16b'))
    ball.castShadow = true
    ball.position.y = 0.2
    root.add(ball)
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.34, 32), plastic(n ? '#78bdd2' : '#ead16b'))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.008
    root.add(ring)
    scene.add(root)
    return root
  })
  return {
    step(t: number, colors: readonly (string | null)[] = []) {
      dogs.forEach((m, n) => {
        const u = logic.units[n]
        m.root.position.set(u.x, 0.79 - u.sit * 0.15 + Math.sin(u.gait * 2) * u.stride * 0.02, u.z)
        m.root.rotation.y = u.h
        m.body.rotation.x = -u.sit * 0.06
        m.head.rotation.x = u.sit * 0.1
        m.tail.rotation.z = Math.sin(t * (u.stride ? 9 : 3)) * (0.08 + u.stride * 0.25)
        m.legs.forEach((leg, k) => { leg.hip.rotation.x = u.legs[k].hip; leg.knee.rotation.x = u.legs[k].knee })
        balls[n].position.set(u.ball.x, 0, u.ball.z)
        wear(m.glow, colors[n] ?? null)
      })
    },
  }
}

export function createView(stage: Stage, logic: DogLogic): DeviceView {
  const world = yard(stage.scene, logic, () => stage.view.invalidate()),
    at = (n: number): [number, number, number] => [logic.units[n].x, 0.55, logic.units[n].z]
  world.step(0)
  return {
    framing: playFrame(at(0), 1.05, [1, 0.65, -1.5]),
    overview: playFrame([0, 0, 0], DOG_YARD.x),
    inspect: () => playFrame(at(0), 0.75, [1, 0.65, -1.5]),
    follow: (n) => new THREE.Vector3(...at(n)),
    update(colors, t) { world.step(t, colors); stage.view.invalidate() },
  }
}

export function preview() {
  const logic = new DogLogic(), u = logic.units[0]
  const card = showcase((scene) => {
    const world = yard(scene, logic)
    return { step(t) {
      u.stride = 0.7
      u.gait = t * 7
      u.legs.forEach((leg, k) => {
        const swing = Math.sin(u.gait + (k === 0 || k === 3 ? 0 : Math.PI)) * 0.7
        leg.hip = -0.22 + swing * 0.5
        leg.knee = 0.44 + Math.max(0, -swing) * 0.55
      })
      u.ball = { x: u.x - 0.7, z: u.z - 1.1 }
      world.step(t)
    } }
  }, [u.x, 0.55, u.z], 1)
  card.camera.position.set(u.x + 2, 1.85, u.z - 3)
  card.camera.lookAt(u.x, 0.55, u.z)
  return card
}

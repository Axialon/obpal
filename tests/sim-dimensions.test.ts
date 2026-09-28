import { expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { DOG_LEG } from '../src/sim/devices/dog-feet'
import { ROVER } from '../src/sim/devices/rover'
import { DRONE, DRONE_PAD, dronePadHeight } from '../src/sim/devices/drone'
import { BOOM, STICK } from '../src/sim/devices/excavator'
import { seat, supportVertices } from '../src/sim/kit/support'
import { contactPart, contactProbe, contactSurface } from '../src/sim/contact'

async function model(name: string) {
  await MeshoptDecoder.ready
  return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readModel(name), '')).scene
}

it('keeps all eight authored dog links inside the IK lengths with their 10 mm joint clearances', async () => {
  const dog = await model('dog')
  for (let i = 0; i < 4; i++) for (const [name, length] of [['hipSkin', DOG_LEG.upper], ['kneeSkin', DOG_LEG.lower]] as const) {
    const points = supportVertices(dog.getObjectByName(`${name}${i}`)!), ys = points.map(p => p.y)
    expect(Math.min(...ys)).toBeCloseTo(-length + .01, 5)
    expect(Math.max(...ys)).toBeCloseTo(-.01, 5)
  }
})

it('uses the authored rover tyre radius for travel and the procedural placeholder', async () => {
  const rover = await model('rover')
  for (let i = 0; i < 4; i++) {
    const points = supportVertices(rover.getObjectByName(`wheel${i}`)!)
    const radius = Math.max(...points.map(p => Math.hypot(p.x, p.z)))
    expect(radius).toBeCloseTo(ROVER.modelWheelRadius, 5)
    expect(radius * ROVER.radius / .25).toBeCloseTo(ROVER.wheelRadius, 5)
  }
})

it('keeps the authored excavator links inside the shared joint lengths', async () => {
  const digger = await model('excavator')
  for (const [name, length] of [['boomSkin', BOOM], ['stickSkin', STICK]] as const) {
    const points = supportVertices(digger.getObjectByName(name)!), zs = points.map(p => p.z)
    // Quantised asset vertices may move by fractions of a millimetre; the joint length may not drift.
    expect(Math.min(...zs)).toBeCloseTo(-length, 3)
    expect(Math.max(...zs)).toBeCloseTo(0, 3)
  }
})

it('seats the authored drone on the octagonal pad and its sloping edge', async () => {
  const scene = new THREE.Scene(), pad = contactSurface(new THREE.Mesh(new THREE.CylinderGeometry(DRONE_PAD.top, DRONE_PAD.bottom, DRONE_PAD.height, DRONE_PAD.sides)))
  pad.position.y = DRONE_PAD.height / 2
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(4, 4))); floor.rotation.x = -Math.PI / 2
  const body = (await model('drone')).getObjectByName('body')!; body.scale.setScalar(DRONE.radius / .26)
  scene.add(pad, floor, contactPart(body, 'skids', { slope: true }))
  scene.updateMatrixWorld(true)
  const ray = new THREE.Raycaster()
  for (const [x, z] of [[0, 0], [.1, .425], [.17, .41]]) {
    ray.set(new THREE.Vector3(x, 1, z), new THREE.Vector3(0, -1, 0))
    expect(dronePadHeight(x, z)).toBeCloseTo(ray.intersectObjects([pad, floor], false)[0].point.y, 7)
  }
  const points = supportVertices(body), probe = contactProbe(scene)
  for (const radius of [.3, .43, .46, .48, .6]) for (const angle of [0, Math.PI / 8, Math.PI / 4]) {
    body.position.set(radius * Math.sin(angle), 0, radius * Math.cos(angle)); body.rotation.set(.24, angle, -.18)
    seat(body, points, dronePadHeight)
    expect(Math.abs(probe.sample()[0].gapMm!), `${radius}, ${angle}`).toBeLessThan(.01)
  }
  probe.dispose()
})

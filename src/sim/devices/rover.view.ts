import { contactPart } from '../contact'
/** The rovers' look (three.js): a fenced yard, cones, and each rover with its holder's colour on its stripe and antenna. */
import * as THREE from 'three'
import { ROVER, roverGround, RoverLogic, type Rover } from './rover'
import { batch, cable, cylinder } from '../kit'
import { carbon, ceramic, lime, optic, polished, ring, shell, titanium, warmShell } from '../kit/surfaces'
import { buildYard, buildCone, buildCourse, bay } from './rover.yard'
import { Spring } from '../kit/motion'
import { telescoping } from '../kit/mechanism'
import { instanceCopies } from '../kit/instances'
import { finishPrototype, loadPrototype, prototypeNodes, retirePrototype } from '../kit/prototype'
import { holdRig } from '../kit/reveal'
import { pov } from '../kit/precision'
import { seat, supportVertices } from '../kit/support'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { blobShadow, box, mats, plate, previewScene, wear, type DeviceView, type Preview } from './view'

interface RoverModel {
  root: THREE.Group
  body: THREE.Group
  antenna: THREE.Group
  shocks: THREE.Group[]
  shockAnchors: THREE.Vector3[]
  shockBases: THREE.Vector3[]
  mechanisms: (() => void)[]
  pitch: Spring
  lean: Spring
  settle: Spring
  sway: Spring
  speed: number
  front: THREE.Group[]
  wheels: THREE.Object3D[]
  supports: THREE.Vector3[][]
  accent: THREE.MeshStandardMaterial
  head: THREE.MeshStandardMaterial
  tail: THREE.MeshStandardMaterial
  beam: THREE.Mesh
  honk: THREE.Mesh
}

/** The model is drawn a quarter metre in radius, then scaled to the rover's size in the logic. */
const SCALE = ROVER.radius / 0.25

function buildRover(n: number): RoverModel {
  const root = new THREE.Group(), body = new THREE.Group()
  root.name = `rover-${n + 1}`; root.scale.setScalar(SCALE); root.add(body)
  const accent = mats.glow()
  const chassis = shell(.28, .40, .06, carbon); chassis.rotation.x = Math.PI / 2; chassis.position.y = .087; body.add(chassis)
  // Split fenders and an overlapping nose leave the dark structural keel visible between the plates.
  for (const side of [-1, 1]) {
    for (const [z, length, material] of [[-.135, .18, ceramic], [.08, .23, warmShell]] as const) {
      const cover = shell(.112, length, .051, material, .24); cover.rotation.x = Math.PI / 2; cover.position.set(side * .088, .13, z); body.add(cover)
    }
    const sill = shell(.024, .32, .025, titanium); sill.rotation.x = Math.PI / 2; sill.position.set(side * .143, .094, 0); body.add(sill)
    const light = box(.036, .003, .01, lime, .001); light.position.set(side * .075, .153, -.169); body.add(light)
  }
  const canopy = shell(.17, .20, .068, ceramic, .32); canopy.rotation.x = Math.PI / 2; canopy.position.set(0, .173, .02); body.add(canopy)
  const window = shell(.119, .135, .014, optic, .35); window.rotation.x = Math.PI / 2; window.position.set(0, .21, -.006); body.add(window)
  const spine = shell(.023, .31, .014, titanium); spine.rotation.x = Math.PI / 2; spine.position.set(0, .141, -.032); body.add(spine)
  for (const z of [-.245, .245]) { const bumper = shell(.035, .27, .04, carbon); bumper.rotation.z = Math.PI / 2; bumper.position.set(0, .085, z); body.add(bumper) }
  for (let i = 0; i < 4; i++) { const vent = box(.07, .003, .005, carbon, .001); vent.position.set(0, .158, .143 + i * .012); body.add(vent) }
  const lidar = cylinder(.035, .021, titanium, 24); lidar.position.set(0, .236, .045); body.add(lidar)
  const lidarBand = cylinder(.0355, .003, lime, 24); lidarBand.position.set(0, .24, .045); body.add(lidarBand)
  const shocks: THREE.Group[] = []
  for (const x of [-.135, .135]) for (const z of [-.15, .15]) {
    const shock = new THREE.Group(); shock.position.set(x, .10, z)
    const sleeve = cylinder(.011, .039, carbon, 12); sleeve.position.y = -.015
    const rod = cylinder(.004, .074, polished, 12); shock.add(sleeve, rod)
    const turns: [number, number, number][] = Array.from({ length: 49 }, (_, i) => [.014 * Math.cos(i * Math.PI / 4), -.033 + i * .0014, .014 * Math.sin(i * Math.PI / 4)])
    shock.add(cable(turns, .002, titanium)); batch(shock); root.add(shock); shocks.push(shock)
    const axle = cylinder(.009, .11, titanium); axle.rotation.z = Math.PI / 2; axle.position.set(Math.sign(x) * .12, .068, z); root.add(axle)
  }
  const antenna = new THREE.Group(); antenna.position.set(.1, .135, .17); body.add(antenna)
  pov(antenna, [0, .205, -.015])
  const mast = cylinder(.0035, .2, carbon, 8); mast.position.y = .1; antenna.add(mast)
  const collar = cylinder(.008, .019, titanium, 12); collar.position.y = .009; antenna.add(collar)
  const tip = new THREE.Mesh(new THREE.SphereGeometry(.012, 12, 8), accent); tip.position.y = .2; antenna.add(tip); batch(antenna)
  // Head and tail lights, and the beam the headlights throw.
  const head = new THREE.MeshStandardMaterial({ color: '#dfe7f2', emissive: '#fff6d8', emissiveIntensity: 0.15 })
  const tail = new THREE.MeshStandardMaterial({ color: '#3a0d14', emissive: '#ff3b52', emissiveIntensity: 0.25 })
  for (const s of [-1, 1]) {
    const h = box(0.06, 0.022, 0.012, head, 0.005)
    h.position.set(s * 0.09, 0.105, -0.232)
    const t = box(0.05, 0.02, 0.012, tail, 0.005)
    t.position.set(s * 0.1, 0.105, 0.232)
    body.add(h, t)
  }
  const beam = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.3, 32, 1, true), new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }))
  beam.rotation.x = -Math.PI / 2
  beam.position.set(0, 0.1, -0.9)
  beam.visible = false
  root.add(beam)
  // Wheels: the front pair steers, all four roll.
  const rubber = mats.rubber()
  const hubMat = polished
  const front: THREE.Group[] = []
  const wheels: THREE.Mesh[] = []
  for (const [x, z] of [[-0.17, -0.15], [0.17, -0.15], [-0.17, 0.15], [0.17, 0.15]] as const) {
    const pivot = new THREE.Group()
    pivot.position.set(x, 0.065, z)
    const tread = [new THREE.CylinderGeometry(0.062, 0.062, 0.05, 24).toNonIndexed()]
    for (let i = 0; i < 20; i++) {
      const a = i * Math.PI / 10
      const block = new THREE.BoxGeometry(0.018, 0.057, 0.012).rotateY(a).translate(Math.sin(a) * 0.064, 0, Math.cos(a) * 0.064).toNonIndexed()
      tread.push(block)
    }
    const tyre = new THREE.Mesh(mergeGeometries(tread)!, rubber)
    // Match the hero's outer tyre radius before the lazy swap, including tread corners.
    const positions = tyre.geometry.getAttribute('position')
    let radius = 0
    for (let i = 0; i < positions.count; i++) radius = Math.max(radius, Math.hypot(positions.getX(i), positions.getZ(i)))
    tyre.geometry.scale(ROVER.modelWheelRadius / radius, 1, ROVER.modelWheelRadius / radius)
    tyre.castShadow = true
    tread.forEach(g => g.dispose())
    tyre.rotation.z = Math.PI / 2
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.054, 16), hubMat)
    tyre.add(hub)
    const inset = cylinder(.024, .055, carbon, 20); tyre.add(inset)
    for (const side of [-1, 1]) {
      const rim = ring(.033, .0025, titanium); rim.rotation.x = Math.PI / 2; rim.position.y = side * .028; tyre.add(rim)
    }
    batch(tyre)
    pivot.add(contactPart(tyre, `wheel-${wheels.length}`, { slope: true }))
    root.add(pivot)
    wheels.push(tyre)
    if (z < 0) front.push(pivot)
  }
  const num = plate(n + 1, 0.085)
  num.rotation.x = -Math.PI / 2
  num.position.set(0, 0.221, 0.015)
  body.add(num)
  num.name = 'number'
  const honk = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 8, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }))
  honk.rotation.x = Math.PI / 2
  honk.position.y = 0.32
  root.add(honk)
  const shadow = blobShadow(0.3, 0.55); shadow.name = 'shadow'; root.add(shadow)
  batch(root, [...wheels, beam, honk, antenna, ...shocks]); batch(body, [antenna])
  return { root, body, antenna, shocks, shockAnchors: shocks.map(s => s.position.clone()), shockBases: shocks.map(s => s.position.clone().setY(.064)), mechanisms: [], front, wheels, supports: wheels.map(supportVertices), accent, head, tail, beam, honk, pitch: new Spring(0, .24), lean: new Spring(0, .22), settle: new Spring(0, .2), sway: new Spring(0, .3), speed: 0 }
}

function placeRover(m: RoverModel, r: Rover, color: string | null, dt: number) {
  const frontY = roverGround(r.x - Math.sin(r.h) * 0.21, r.z - Math.cos(r.h) * 0.21)
  const rearY = roverGround(r.x + Math.sin(r.h) * 0.21, r.z + Math.cos(r.h) * 0.21)
  m.root.position.set(r.x, (frontY + rearY) / 2, r.z)
  m.root.rotation.x = Math.atan2(rearY - frontY, ROVER.wheelbase)
  m.root.rotation.order = 'YXZ'
  m.root.rotation.y = r.h
  const acceleration = dt > 0 ? Math.max(-9, Math.min(9, (r.v - m.speed) / dt)) : 0
  m.speed = r.v
  m.body.rotation.x = m.pitch.step(-acceleration * .009, dt)
  m.body.rotation.z = m.lean.step(r.v * r.steer * .045, dt)
  m.body.position.y = m.settle.step(-Math.abs(acceleration) * .0006, dt)
  m.antenna.rotation.x = m.sway.step(acceleration * .025, dt)
  m.body.updateMatrix()
  for (const f of m.front) f.rotation.y = -r.steer
  for (const [i, w] of m.wheels.entries()) {
    w.rotation.x = -r.roll
    // Wheel pivots belong to the authored model. Independent suspension seats its actual tyre, including tread.
    seat(w, m.supports[i], roverGround)
  }
  for (const [i, shock] of m.shocks.entries()) {
    const anchor = m.shockAnchors[i]
    const top = new THREE.Vector3(anchor.x, .14, anchor.z).applyMatrix4(m.body.matrix)
    // Shocks are ordered by side, wheels by axle. Their lower bearings follow the seated wheel centres.
    const centre = m.root.worldToLocal(m.wheels[[0, 2, 1, 3][i]].getWorldPosition(new THREE.Vector3()))
    const bottom = m.shockBases[i].set(anchor.x, centre.y, anchor.z)
    const axis = top.clone().sub(bottom)
    shock.position.copy(top).add(bottom).multiplyScalar(.5)
    shock.scale.y = axis.length() / .076
    shock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize())
  }
  m.mechanisms.forEach(update => update())
  wear(m.accent, color)
  m.head.emissiveIntensity = r.lights ? 3 : 0.15
  m.beam.visible = r.lights
  m.tail.emissiveIntensity = r.braking ? 3.2 : r.lights ? 0.9 : 0.25
  const k = r.honk / 0.45
  m.honk.visible = r.honk > 0
  const ring = m.honk.material as THREE.MeshBasicMaterial
  ring.opacity = k * 0.9
  ring.color.set(color ?? '#ffffff')
  m.honk.scale.setScalar(1 + (1 - k) * 1.6)
}

/** All movable cones share four draws, including their contact shadows. */
function coneInstances(count: number) {
  const template = buildCone()
  template.updateMatrixWorld(true)
  const group = new THREE.Group()
  const parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }[] = []
  template.traverse(o => {
    const source = o as THREE.Mesh
    if (!source.isMesh) return
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false
    group.add(mesh); parts.push({ mesh, local: source.matrixWorld.clone() })
  })
  const last = new Array<string>(count), transform = new THREE.Matrix4(), matrix = new THREE.Matrix4()
  return { group, place(i: number, x: number, z: number) {
    const state = `${x}:${z}`
    if (last[i] === state) return
    last[i] = state
    transform.makeTranslation(x, roverGround(x, z), z)
    for (const p of parts) { p.mesh.setMatrixAt(i, matrix.multiplyMatrices(transform, p.local)); p.mesh.instanceMatrix.needsUpdate = true }
  } }
}

export function createView(stage: Stage, logic: RoverLogic): DeviceView {
  const [hx, hz] = ROVER.yard
  const yard = buildYard(hx, hz)
  stage.scene.add(yard.group)
  stage.scene.add(buildCourse())
  const models = logic.rovers.map((r, n) => { const m = buildRover(n); stage.scene.add(m.root, bay(r.home[0], r.home[1])); return m })
  const copies = instanceCopies(stage.scene)
  // The procedural rovers stay out of view until the Blender ones are in (or cannot come).
  const hold = holdRig('rover', models.map(m => m.root), { shown: () => { copies.set(models.map(m => m.root)); stage.view.invalidate() } })
  void Promise.all(models.map(async m => {
    const scene = await loadPrototype('rover')
    if (!scene) return null
    const rig = prototypeNodes(scene, ['root', 'body', 'antenna', 'shock0', 'shock1', 'shock2', 'shock3', 'steer0', 'steer1', 'wheel0', 'wheel1', 'wheel2', 'wheel3',
      'shockSleeve0', 'shockSleeve1', 'shockSleeve2', 'shockSleeve3', 'shockRod0', 'shockRod1', 'shockRod2', 'shockRod3'])
    finishPrototype(scene, { owner: m.accent, head: m.head, tail: m.tail })
    return rig
  })).then(rigs => {
    if (rigs.some(r => !r) || !models.every(m => m.root.parent === stage.scene)) return hold.fallback()
    copies.clear()
    hold.install(() => rigs.forEach((rig, i) => {
      const m = models[i], body = rig!.body as THREE.Group
      rig!.antenna.add(m.antenna.getObjectByName('pov')!)
      body.add(m.body.getObjectByName('number')!)
      const keep = [m.beam, m.honk, m.root.getObjectByName('shadow')]
      for (const old of [...m.root.children]) if (!keep.includes(old as THREE.Mesh)) retirePrototype(old)
      m.root.add(rig!.root); m.body = body; m.antenna = rig!.antenna as THREE.Group
      m.shocks = [rig!.shock0, rig!.shock1, rig!.shock2, rig!.shock3] as THREE.Group[]
      m.front = [rig!.steer0, rig!.steer1] as THREE.Group[]
      m.wheels = [rig!.wheel0, rig!.wheel1, rig!.wheel2, rig!.wheel3]
      m.wheels.forEach((wheel, j) => contactPart(wheel, `wheel-${j}`, { slope: true }))
      m.supports = m.wheels.map(supportVertices)
      m.mechanisms = m.shocks.map((shock, j) => telescoping(rig![`shockSleeve${j}` as 'shockSleeve0'], rig![`shockRod${j}` as 'shockRod0'], body,
        m.shockBases[j], new THREE.Vector3(shock.position.x, .14, shock.position.z), .026, .05))
      m.mechanisms.forEach(update => update())
      m.root.userData.prototype = 'blender'
    }))
    copies.set(models.map(m => m.root)); stage.view.invalidate()
  }).catch(() => hold.fallback()) // The procedural rig remains available if an optional mesh cannot load.
  const cones = coneInstances(logic.cones.length)
  stage.scene.add(cones.group)
  const setTheme = (t: Theme) => {
    yard.pad.color.set(t.light ? '#9ba4a6' : '#454f54')
    yard.edge.emissive.set(t.light ? '#7cb518' : '#c6ff34')
  }
  setTheme(stage.theme)
  return {
    framing: (() => { const r = logic.rovers[0]; return { target: [r.x, 0.17, r.z], wide: [r.x + 0.8, 0.85, r.z + 1], tall: [r.x + 0.8, 1, r.z + 1.3], radius: 0.58, min: 0.4, max: 38 } })(),
    follow(n) { const r = logic.rovers[n]; return new THREE.Vector3(r.x, 0.17, r.z) },
    inspect() { const r = logic.rovers[0]; return { target: [r.x, 0.17, r.z], wide: [r.x + 0.8, 0.85, r.z + 1], tall: [r.x + 0.8, 1, r.z + 1.3], radius: 0.5, min: 0.4, max: 38 } },
    overview: { target: [0, 0, 0], wide: [0, 13.5, 15], tall: [0, 18, 10], radius: 9.5, min: 2, max: 38 },
    pickY: 0,
    update(colors, _t, dt) {
      logic.rovers.forEach((r, n) => placeRover(models[n], r, colors[n], dt))
      copies.update()
      logic.cones.forEach((c, i) => cones.place(i, c.x, c.z))
    },
    setTheme,
  }
}

/** The card: one rover drawing figure eights round two cones, on a path that keeps it in the picture. */
export function preview(): Preview {
  const scene = previewScene()
  const yard = buildYard(1.9, 1.25)
  yard.pad.color.set('#454f54')
  scene.add(yard.group)
  const m = buildRover(0)
  scene.add(m.root)
  for (const [x, z] of [[-0.75, 0], [0.75, 0]]) { const c = buildCone(); c.position.set(x, 0, z); scene.add(c) }
  const camera = new THREE.PerspectiveCamera(36, 16 / 10, 0.05, 40)
  camera.position.set(0, 3.3, 3.5)
  camera.lookAt(0, -0.15, 0.05)
  const r: Rover = { x: 0, z: 0, h: 0, v: 0, steer: 0, lights: true, honk: 0, braking: false, roll: 0, home: [0, 0, 0] }
  // A figure eight (Bernoulli's lemniscate), driven at an even pace: position, heading and steering from the path.
  const at = (u: number): [number, number] => { const k = 1 + Math.sin(u) ** 2; return [(1.45 * Math.cos(u)) / k, (1.45 * Math.sin(u) * Math.cos(u)) / k] }
  let u = 0
  return {
    scene, camera,
    step(_t, dt) {
      const [x0, z0] = at(u)
      u += dt * 0.55
      const [x1, z1] = at(u)
      const [x2, z2] = at(u + 0.05)
      const h = Math.atan2(-(x2 - x1), -(z2 - z1))
      const turn = ((h - r.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      Object.assign(r, { x: x1, z: z1, v: Math.hypot(x1 - x0, z1 - z0) / Math.max(dt, 1e-3), h })
      r.steer += (Math.max(-0.5, Math.min(0.5, -turn * 12)) - r.steer) * Math.min(1, dt * 8)
      r.roll += (r.v / ROVER.wheelRadius) * dt
      placeRover(m, r, '#c6ff34', dt)
    },
  }
}

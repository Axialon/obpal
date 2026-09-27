/** The rovers' look (three.js): a fenced yard, cones, and each rover with its holder's colour on its stripe and antenna. */
import * as THREE from 'three'
import { CONE_R, GATES, RAMPS, ROVER, roverGround, RoverLogic, type Rover } from './rover'
import { batch, bolt, cable, cylinder, floorMaterial, maker, plastic, palette } from '../kit'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { blobShadow, box, mats, plate, previewScene, wear, type DeviceView, type Preview } from './view'

interface RoverModel {
  root: THREE.Group
  front: THREE.Group[]
  wheels: THREE.Mesh[]
  accent: THREE.MeshStandardMaterial
  head: THREE.MeshStandardMaterial
  tail: THREE.MeshStandardMaterial
  beam: THREE.Mesh
  honk: THREE.Mesh
}

/** The model is drawn a quarter metre in radius, then scaled to the rover's size in the logic. */
const SCALE = ROVER.radius / 0.25

function buildRover(n: number): RoverModel {
  const root = new THREE.Group()
  root.scale.setScalar(SCALE)
  const body = mats.body()
  const dark = mats.dark()
  const accent = mats.glow()
  const chassis = box(0.3, 0.07, 0.46, body, 0.025)
  chassis.castShadow = true
  chassis.position.y = 0.1
  const canopy = box(0.2, 0.075, 0.2, mats.glass(), 0.03)
  canopy.position.set(0, 0.17, 0.03)
  const stripe = box(0.026, 0.012, 0.42, accent, 0.005)
  stripe.position.set(0, 0.137, 0)
  const bumperF = box(0.28, 0.045, 0.04, dark, 0.012)
  bumperF.position.set(0, 0.085, -0.245)
  const bumperR = bumperF.clone()
  bumperR.position.z = 0.245
  root.add(chassis, canopy, stripe, bumperF, bumperR)
  const skid = box(0.27, 0.025, 0.39, dark); skid.position.y = 0.06; root.add(skid)
  for (const side of [-1, 1]) {
    const rail = cable([[side * 0.13, 0.13, -0.2], [side * 0.13, 0.205, -0.09], [side * 0.13, 0.205, 0.13], [side * 0.13, 0.13, 0.2]], 0.008, dark)
    root.add(rail)
    for (const z of [-0.15, 0.15]) {
      const axle = cylinder(0.009, 0.11); axle.rotation.z = Math.PI / 2; axle.position.set(side * 0.12, 0.068, z); root.add(axle)
      root.add(cable([[side * 0.12, 0.12, z - 0.03], [side * 0.16, 0.085, z], [side * 0.17, 0.065, z + 0.015]], 0.009))
      const turns: [number, number, number][] = Array.from({ length: 37 }, (_, i) => [side * 0.135 + Math.cos(i * Math.PI / 3) * 0.014, 0.075 + i * 0.0015, z + Math.sin(i * Math.PI / 3) * 0.014])
      root.add(cable(turns, 0.0025, mats.metal()))
      const screw = bolt(0.006); screw.position.set(side * 0.11, 0.14, z); root.add(screw)
    }
  }
  for (let i = 0; i < 5; i++) { const vent = box(0.11, 0.003, 0.006, dark); vent.position.set(0, 0.14, -0.16 + i * 0.012); root.add(vent) }
  const lidar = cylinder(0.035, 0.023, dark); lidar.position.set(0, 0.246, 0.045); root.add(lidar)
  const lidarBand = cylinder(0.036, 0.007, accent); lidarBand.position.set(0, 0.249, 0.045); root.add(lidarBand)
  maker(root, 0, 0.142, 0.16, 0.04)
  // Antenna with a glowing tip: the holder's colour, seen from anywhere.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.2, 6), dark)
  mast.position.set(0.1, 0.23, 0.17)
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), accent)
  tip.position.set(0.1, 0.335, 0.17)
  root.add(mast, tip)
  // Head and tail lights, and the beam the headlights throw.
  const head = new THREE.MeshStandardMaterial({ color: '#dfe7f2', emissive: '#fff6d8', emissiveIntensity: 0.15 })
  const tail = new THREE.MeshStandardMaterial({ color: '#3a0d14', emissive: '#ff3b52', emissiveIntensity: 0.25 })
  for (const s of [-1, 1]) {
    const h = box(0.06, 0.022, 0.012, head, 0.005)
    h.position.set(s * 0.09, 0.105, -0.232)
    const t = box(0.05, 0.02, 0.012, tail, 0.005)
    t.position.set(s * 0.1, 0.105, 0.232)
    root.add(h, t)
  }
  const beam = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.3, 32, 1, true), new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }))
  beam.rotation.x = -Math.PI / 2
  beam.position.set(0, 0.1, -0.9)
  beam.visible = false
  root.add(beam)
  // Wheels: the front pair steers, all four roll.
  const rubber = mats.rubber()
  const hubMat = mats.metal()
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
    tread.forEach(g => g.dispose())
    tyre.rotation.z = Math.PI / 2
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.054, 16), hubMat)
    tyre.add(hub)
    pivot.add(tyre)
    root.add(pivot)
    wheels.push(tyre)
    if (z < 0) front.push(pivot)
  }
  const num = plate(n + 1, 0.085)
  num.rotation.x = -Math.PI / 2
  num.position.set(0, 0.209, 0.03)
  root.add(num)
  const honk = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 8, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }))
  honk.rotation.x = Math.PI / 2
  honk.position.y = 0.32
  root.add(honk)
  root.add(blobShadow(0.3, 0.55))
  batch(root, [...wheels, beam, honk])
  return { root, front, wheels, accent, head, tail, beam, honk }
}

function placeRover(m: RoverModel, r: Rover, color: string | null) {
  const frontY = roverGround(r.x - Math.sin(r.h) * 0.21, r.z - Math.cos(r.h) * 0.21)
  const rearY = roverGround(r.x + Math.sin(r.h) * 0.21, r.z + Math.cos(r.h) * 0.21)
  m.root.position.set(r.x, (frontY + rearY) / 2, r.z)
  m.root.rotation.x = Math.atan2(rearY - frontY, ROVER.wheelbase)
  m.root.rotation.order = 'YXZ'
  m.root.rotation.y = r.h
  for (const f of m.front) f.rotation.y = -r.steer
  for (const w of m.wheels) w.rotation.x = -r.roll
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

function buildCone(): THREE.Group {
  const g = new THREE.Group()
  g.scale.setScalar(CONE_R / 0.09)
  const orange = plastic('#e98d42')
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.24, 24), orange)
  cone.position.y = 0.14
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.056, 0.035, 24), new THREE.MeshStandardMaterial({ color: '#f4f6f8', roughness: 0.4 }))
  band.position.y = 0.15
  const base = box(0.17, 0.02, 0.17, new THREE.MeshStandardMaterial({ color: '#1b2029', roughness: 0.7 }), 0.01)
  base.position.y = 0.01
  g.add(cone, band, base, blobShadow(0.1, 0.35))
  return g
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

/** The yard: a play mat with a low glass wall round it, its top edge lit. */
function buildYard(hx: number, hz: number) {
  const g = new THREE.Group()
  const pad = box(hx * 2 + 0.3, 0.04, hz * 2 + 0.3, floorMaterial(), 0.02)
  pad.position.y = -0.02
  g.add(pad)
  const glass = new THREE.MeshPhysicalMaterial({ color: '#b9c7ff', metalness: 0, roughness: 0.08, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide })
  const edge = new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#c6ff34', emissiveIntensity: 1.1 })
  const H = 0.22
  const wall = (w: number, d: number, x: number, z: number) => {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(w, H, d), glass)
    pane.position.set(x, H / 2, z)
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.014, d + 0.02), edge)
    top.position.set(x, H, z)
    g.add(pane, top)
  }
  wall(hx * 2, 0.02, 0, -hz)
  wall(hx * 2, 0.02, 0, hz)
  wall(0.02, hz * 2, -hx, 0)
  wall(0.02, hz * 2, hx, 0)
  batch(g, [pad])
  return { group: g, pad: pad.material as THREE.MeshStandardMaterial, edge }
}

/** A parking bay's painted lines. */
function bay(x: number, z: number) {
  const g = new THREE.Group()
  const paint = new THREE.MeshBasicMaterial({ color: '#c6ff34', transparent: true, opacity: 0.35, depthWrite: false })
  for (const s of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.9), paint)
    l.rotation.x = -Math.PI / 2
    l.position.set(x + s * 0.42, 0.003, z)
    g.add(l)
  }
  return g
}

export function createView(stage: Stage, logic: RoverLogic): DeviceView {
  const [hx, hz] = ROVER.yard
  const yard = buildYard(hx, hz)
  stage.scene.add(yard.group)
  const course = new THREE.Group()
  for (const r of RAMPS) {
    const shape = new THREE.Shape()
    shape.moveTo(-r.halfLength, 0); shape.lineTo(-r.halfLength / 2, r.height); shape.lineTo(r.halfLength / 2, r.height); shape.lineTo(r.halfLength, 0); shape.closePath()
    const ramp = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: r.halfWidth * 2, bevelEnabled: false }), mats.dark())
    ramp.rotation.y = -Math.PI / 2; ramp.position.set(r.x + r.halfWidth, 0.002, r.z)
    ramp.receiveShadow = true; course.add(ramp)
    for (const side of [-1, 1]) {
      const line = cable([[r.x + side * 0.72, 0.008, r.z - 2], [r.x + side * 0.72, r.height + 0.008, r.z - 1], [r.x + side * 0.72, r.height + 0.008, r.z + 1], [r.x + side * 0.72, 0.008, r.z + 2]], 0.014, plastic(palette.lime)); course.add(line)
    }
  }
  for (const gate of GATES) {
    for (const side of [-1, 1]) { const post = cylinder(0.055, 1.35, mats.dark()); post.position.set(gate.x + side * gate.width / 2, 0.675, gate.z); course.add(post) }
    const bar = box(gate.width + 0.12, 0.1, 0.12, plastic(palette.lime)); bar.position.set(gate.x, 1.32, gate.z); course.add(bar)
  }
  for (let i = 0; i < 32; i++) {
    const a = i / 32 * Math.PI * 2
    const dash = box(0.05, 0.003, 0.38, plastic('#9aa4a2'), 0.001)
    dash.position.set(Math.cos(a) * 7.8, 0.004, Math.sin(a) * 4.7); dash.rotation.y = -a; course.add(dash)
  }
  batch(course); stage.scene.add(course)
  const models = logic.rovers.map((r, n) => { const m = buildRover(n); stage.scene.add(m.root, bay(r.home[0], r.home[1])); return m })
  const cones = coneInstances(logic.cones.length)
  stage.scene.add(cones.group)
  const setTheme = (t: Theme) => {
    yard.pad.color.set(t.light ? '#dde2ea' : '#232833')
    yard.edge.emissive.set(t.light ? '#7cb518' : '#c6ff34')
  }
  setTheme(stage.theme)
  return {
    framing: (() => { const r = logic.rovers[0]; return { target: [r.x, 0.17, r.z], wide: [r.x + 0.8, 0.85, r.z + 1], tall: [r.x + 0.8, 1, r.z + 1.3], radius: 0.58, min: 0.4, max: 38 } })(),
    follow(n) { const r = logic.rovers[n]; return new THREE.Vector3(r.x, 0.17, r.z) },
    inspect() { const r = logic.rovers[0]; return { target: [r.x, 0.17, r.z], wide: [r.x + 0.8, 0.85, r.z + 1], tall: [r.x + 0.8, 1, r.z + 1.3], radius: 0.5, min: 0.4, max: 38 } },
    overview: { target: [0, 0, 0], wide: [0, 13.5, 15], tall: [0, 18, 10], radius: 9.5, min: 2, max: 38 },
    pickY: 0,
    update(colors) {
      logic.rovers.forEach((r, n) => placeRover(models[n], r, colors[n]))
      logic.cones.forEach((c, i) => cones.place(i, c.x, c.z))
    },
    setTheme,
  }
}

/** The card: one rover drawing figure eights round two cones, on a path that keeps it in the picture. */
export function preview(): Preview {
  const scene = previewScene()
  const yard = buildYard(1.9, 1.25)
  yard.pad.color.set('#241d4a')
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
      r.roll += (r.v / 0.088) * dt
      placeRover(m, r, '#c6ff34')
    },
  }
}

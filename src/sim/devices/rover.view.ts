/** The rovers' look (three.js): a fenced yard, cones, and each rover with its holder's colour on its stripe and antenna. */
import * as THREE from 'three'
import { CONE_R, ROVER, RoverLogic, type Rover } from './rover'
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
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.05, 24), rubber)
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
  return { root, front, wheels, accent, head, tail, beam, honk }
}

function placeRover(m: RoverModel, r: Rover, color: string | null) {
  m.root.position.set(r.x, 0, r.z)
  m.root.rotation.y = r.h
  for (const f of m.front) f.rotation.y = -r.steer
  for (const w of m.wheels) w.rotation.x = -r.roll
  wear(m.accent, color)
  m.head.emissiveIntensity = r.lights ? 3 : 0.15
  m.beam.visible = r.lights
  m.tail.emissiveIntensity = r.braking ? 3.2 : r.lights ? 0.9 : 0.25
  const k = r.honk / 0.45
  const ring = m.honk.material as THREE.MeshBasicMaterial
  ring.opacity = k * 0.9
  ring.color.set(color ?? '#ffffff')
  m.honk.scale.setScalar(1 + (1 - k) * 1.6)
}

function buildCone(): THREE.Group {
  const g = new THREE.Group()
  g.scale.setScalar(CONE_R / 0.09)
  const orange = new THREE.MeshStandardMaterial({ color: '#fb923c', roughness: 0.5 })
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.24, 24), orange)
  cone.position.y = 0.14
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.056, 0.035, 24), new THREE.MeshStandardMaterial({ color: '#f4f6f8', roughness: 0.4 }))
  band.position.y = 0.15
  const base = box(0.17, 0.02, 0.17, new THREE.MeshStandardMaterial({ color: '#1b2029', roughness: 0.7 }), 0.01)
  base.position.y = 0.01
  g.add(cone, band, base, blobShadow(0.1, 0.35))
  return g
}

/** The yard: a play mat with a low glass wall round it, its top edge lit. */
function buildYard(hx: number, hz: number) {
  const g = new THREE.Group()
  const pad = box(hx * 2 + 0.3, 0.04, hz * 2 + 0.3, new THREE.MeshStandardMaterial({ color: '#2b313c', roughness: 0.92, metalness: 0.05 }), 0.02)
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
  const models = logic.rovers.map((r, n) => { const m = buildRover(n); stage.scene.add(m.root, bay(r.home[0], r.home[1])); return m })
  const cones = logic.cones.map(() => { const c = buildCone(); stage.scene.add(c); return c })
  const setTheme = (t: Theme) => {
    yard.pad.color.set(t.light ? '#dde2ea' : '#232833')
    yard.edge.emissive.set(t.light ? '#7cb518' : '#c6ff34')
  }
  setTheme(stage.theme)
  return {
    framing: { target: [0, 0, 0.3], wide: [0, 6.4, 7.2], tall: [0, 9, 4], radius: 4.6, min: 3, max: 18 },
    pickY: 0,
    update(colors) {
      logic.rovers.forEach((r, n) => placeRover(models[n], r, colors[n]))
      logic.cones.forEach((c, i) => cones[i].position.set(c.x, 0, c.z))
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

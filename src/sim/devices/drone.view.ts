/**
 * The drones' look (three.js): a netted cage with a lit frame, glowing rings, a pad per drone, and each quadcopter with
 * its holder's colour on its lights, its rotors a blur when they spin, and a shadow that softens as it climbs.
 */
import * as THREE from 'three'
import { DRONE, DroneLogic, PYLONS, RINGS, stepDrone, type Drone, type DroneIntent } from './drone'
import { batch, bolt, cable, cylinder, floorMaterial, maker, plastic } from '../kit'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { blobShadow, box, mats, plate, previewScene, wear, type DeviceView, type Preview } from './view'

interface DroneModel { root: THREE.Group; body: THREE.Group; gimbal: THREE.Group; props: THREE.Group[]; blurs: THREE.Mesh[]; light: THREE.MeshStandardMaterial; shadow: THREE.Mesh }

/** The model is drawn 0.26 m in radius, then scaled to the drone's size in the logic. */
const SCALE = DRONE.radius / 0.26

function buildDrone(n: number): DroneModel {
  const root = new THREE.Group()
  const body = new THREE.Group()
  body.scale.setScalar(SCALE)
  root.add(body)
  const shell = mats.body()
  const dark = mats.dark()
  const light = mats.glow()
  const core = box(0.2, 0.07, 0.26, shell, 0.03)
  core.castShadow = true
  core.position.y = 0.09
  const top = box(0.14, 0.03, 0.18, dark, 0.012)
  top.position.y = 0.135
  const strip = box(0.16, 0.012, 0.012, light, 0.004)
  strip.position.set(0, 0.1, -0.132)
  const tail = strip.clone()
  tail.position.z = 0.132
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 14), dark)
  cam.position.set(0, 0.06, -0.14)
  body.add(core, top, strip, tail, cam)
  const mount = box(0.1, 0.055, 0.07, dark); mount.position.set(0, 0.04, -0.12); body.add(mount)
  const lens = cylinder(0.018, 0.025, plastic('#244c65')); lens.rotation.x = Math.PI / 2; lens.position.set(0, 0.05, -0.167); body.add(lens)
  const gimbal = new THREE.Group()
  gimbal.position.set(0, 0.05, -0.14)
  for (const part of [mount, cam, lens]) { part.position.sub(gimbal.position); gimbal.add(part) }
  body.add(gimbal)
  for (const side of [-1, 1]) {
    body.add(cable([[side * 0.085, 0.035, -0.1], [side * 0.11, 0.01, -0.15], [side * 0.11, 0.01, 0.16], [side * 0.085, 0.035, 0.1]], 0.008, mats.metal()))
    const screw = bolt(0.006); screw.position.set(side * 0.07, 0.129, -0.075); body.add(screw)
  }
  maker(body, 0, 0.153, -0.04, 0.035)
  const props: THREE.Group[] = []
  const blurs: THREE.Mesh[] = []
  const bladeGeo = new THREE.BoxGeometry(0.2, 0.004, 0.022)
  const blurMat = new THREE.MeshBasicMaterial({ color: '#e6ebf2', transparent: true, opacity: 0, depthWrite: false })
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    // An arm out to each motor, the motor, and its propeller.
    const arm = box(0.2, 0.022, 0.03, dark, 0.008)
    arm.position.set(x * 0.1, 0.09, z * 0.1)
    arm.rotation.y = x * z > 0 ? -Math.PI / 4 : Math.PI / 4
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.05, 20), mats.metal())
    motor.position.set(x * 0.17, 0.1, z * 0.17)
    const prop = new THREE.Group()
    prop.position.set(x * 0.17, 0.13, z * 0.17)
    const blade = new THREE.Mesh(bladeGeo, dark)
    prop.add(blade, blade.clone().rotateY(Math.PI / 2))
    const blur = new THREE.Mesh(new THREE.CircleGeometry(0.105, 32), blurMat)
    blur.rotation.x = -Math.PI / 2
    blur.position.copy(prop.position)
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.006, 8, 48), shell)
    guard.rotation.x = Math.PI / 2
    guard.position.copy(prop.position)
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 6), dark)
    foot.position.set(x * 0.08, 0.035, z * 0.1)
    body.add(arm, motor, prop, blur, guard, foot)
    const collar = cylinder(0.029, 0.008, dark); collar.position.set(x * 0.17, 0.113, z * 0.17); body.add(collar)
    const cap = cylinder(0.012, 0.015); cap.position.y = 0.006; prop.add(cap)
    batch(prop)
    const lead = cable([[x * 0.05, 0.1, z * 0.04], [x * 0.11, 0.108, z * 0.11], [x * 0.16, 0.108, z * 0.16]], 0.003, plastic('#b5693b')); body.add(lead)
    props.push(prop)
    blurs.push(blur)
  }
  const num = plate(n + 1, 0.07)
  num.rotation.x = -Math.PI / 2
  num.position.set(0, 0.152, 0.02)
  body.add(num)
  const shadow = blobShadow(0.3 * SCALE, 0.5)
  batch(body, [...props, ...blurs])
  return { root, body, gimbal, props, blurs, light, shadow }
}

function placeDrone(m: DroneModel, d: Drone, color: string | null) {
  m.root.position.set(d.x, d.y, d.z)
  m.root.rotation.y = d.yaw
  m.body.rotation.set(d.pitch, 0, -d.roll, 'YXZ')
  m.gimbal.quaternion.copy(m.body.quaternion).invert()
  m.props.forEach((p, i) => { p.rotation.y = d.spin * (i % 3 === 0 ? 1 : -1) })
  for (const b of m.blurs) { b.visible = d.rotor > 0.02; (b.material as THREE.MeshBasicMaterial).opacity = d.rotor * 0.28 }
  for (const p of m.props) p.visible = d.rotor < 0.7
  wear(m.light, color, 0.5, 2.6)
  // The shadow stays on the floor, softer and wider the higher it flies.
  m.shadow.position.set(d.x, 0.003, d.z)
  const k = 1 + d.y * 0.35
  m.shadow.scale.setScalar(k)
  ;(m.shadow.material as THREE.MeshBasicMaterial).opacity = 0.5 / (k * k)
}

function buildRing(r: typeof RINGS[number]) {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#b3a4ff', emissiveIntensity: 1.6 })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r.r, 0.035, 16, 96), mat)
  g.add(ring)
  g.position.set(r.x, r.y, r.z)
  g.rotation.y = r.face
  // A slim stand down to the floor.
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, r.y - r.r, 8), mats.dark())
  stand.position.y = -(r.r + (r.y - r.r) / 2)
  g.add(stand)
  return { group: g, mat }
}

/** The cage: a floor, a lit frame, and net on its sides (drawn faintly, so the drones show through). */
function buildCage(hx: number, hz: number, h: number) {
  const g = new THREE.Group()
  const floor = box(hx * 2 + 0.3, 0.04, hz * 2 + 0.3, floorMaterial(), 0.02)
  floor.position.y = -0.02
  g.add(floor)
  const edge = new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#c6ff34', emissiveIntensity: 0.9 })
  const bar = (w: number, hh: number, d: number, x: number, y: number, z: number) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), edge); b.position.set(x, y, z); g.add(b) }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(0.03, h, 0.03, sx * hx, h / 2, sz * hz)
  for (const y of [0.01, h]) {
    bar(hx * 2, 0.02, 0.02, 0, y, -hz); bar(hx * 2, 0.02, 0.02, 0, y, hz)
    bar(0.02, 0.02, hz * 2, -hx, y, 0); bar(0.02, 0.02, hz * 2, hx, y, 0)
  }
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  const net = (w: number, x: number, z: number, ry: number) => {
    const t = tex.clone()
    t.repeat.set(w / 0.3, h / 0.3)
    t.needsUpdate = true
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }))
    m.position.set(x, h / 2, z)
    m.rotation.y = ry
    g.add(m)
  }
  // The far side and the two ends; the side facing the screen stays open.
  net(hx * 2, 0, -hz, 0)
  net(hz * 2, -hx, 0, Math.PI / 2)
  net(hz * 2, hx, 0, Math.PI / 2)
  batch(g, [floor])
  return { group: g, floor: floor.material as THREE.MeshStandardMaterial, edge }
}

function buildPad(n: number) {
  const g = new THREE.Group()
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.48, 0.02, 48), new THREE.MeshStandardMaterial({ color: '#2f3642', roughness: 0.7 }))
  disc.position.y = 0.01
  const glow = mats.glow()
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.014, 8, 64), glow)
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.022
  const num = plate(n + 1, 0.18)
  num.rotation.x = -Math.PI / 2
  num.position.set(0, 0.022, 0.3)
  g.add(disc, ring, num)
  return { group: g, glow }
}

export function createView(stage: Stage, logic: DroneLogic): DeviceView {
  const [hx, hz] = DRONE.cage
  const cage = buildCage(hx, hz, DRONE.ceiling)
  stage.scene.add(cage.group)
  const obstacles = new THREE.Group()
  for (const p of PYLONS) {
    const body = cylinder(p.radius, p.height, mats.dark()); body.position.set(p.x, p.height / 2, p.z); obstacles.add(body)
    for (let i = 0; i < 3; i++) { const band = cylinder(p.radius + 0.006, 0.07, plastic('#c6ff34')); band.position.set(p.x, p.height - 0.1 - i * 0.2, p.z); obstacles.add(band) }
  }
  batch(obstacles); stage.scene.add(obstacles)
  const rings = logic.rings.map((r) => { const m = buildRing(r); stage.scene.add(m.group); return m })
  const pads = logic.drones.map((d, n) => { const p = buildPad(n); p.group.position.set(d.home[0], 0, d.home[1]); stage.scene.add(p.group); return p })
  const models = logic.drones.map((_, n) => { const m = buildDrone(n); stage.scene.add(m.root, m.shadow); return m })
  // The rings glow lavender on a dark surface, ultraviolet on the light one.
  let ringColor = '#b3a4ff'
  const setTheme = (t: Theme) => {
    cage.floor.color.set(t.light ? '#dde2ea' : '#232833')
    cage.edge.emissive.set(t.light ? '#7cb518' : '#c6ff34')
    ringColor = t.light ? '#6d4dff' : '#b3a4ff'
  }
  setTheme(stage.theme)
  const flash = rings.map(() => 0)
  const passed = logic.drones.map((d) => d.rings)
  return {
    inspect() { const d = logic.drones[0]; return { target: [d.x, d.y + 0.12, d.z], wide: [d.x + 0.8, d.y + 0.9, d.z + 1], tall: [d.x + 0.8, d.y + 1, d.z + 1.3], radius: 0.52, min: 0.4, max: 38 } },
    framing: { target: [0, 1.7, 0], wide: [0, 10.5, 18], tall: [0, 13, 17], radius: 7.5, min: 2, max: 38 },
    pickY: 0,
    update(colors, t, dt) {
      logic.drones.forEach((d, n) => {
        placeDrone(models[n], d, colors[n])
        wear(pads[n].glow, colors[n], 0.4, 1.8)
        // A ring flown through flashes in the pilot's colour.
        if (d.rings !== passed[n]) {
          passed[n] = d.rings
          const i = (d.next + logic.rings.length - 1) % logic.rings.length
          flash[i] = 1
          rings[i].mat.emissive.set(colors[n] ?? '#ffffff')
        }
      })
      rings.forEach((r, i) => {
        flash[i] = Math.max(0, flash[i] - dt * 1.2)
        if (!flash[i]) r.mat.emissive.set(ringColor)
        r.mat.emissiveIntensity = 1.4 + 0.3 * Math.sin(t * 2 + i) + flash[i] * 3
      })
    },
    setTheme,
  }
}

/** The card: a drone taking off, flying a loop through a ring, and landing again. */
export function preview(): Preview {
  const scene = previewScene()
  const floor = box(3.4, 0.04, 2.4, new THREE.MeshStandardMaterial({ color: '#241d4a', roughness: 0.9 }), 0.02)
  floor.position.y = -0.02
  scene.add(floor)
  const ring = buildRing({ x: 0, y: 1.1, z: -0.5, face: 0, r: 0.5 })
  scene.add(ring.group)
  const m = buildDrone(0)
  scene.add(m.root, m.shadow)
  const camera = new THREE.PerspectiveCamera(36, 16 / 10, 0.05, 40)
  camera.position.set(0, 2.1, 3.6)
  camera.lookAt(0, 0.8, -0.2)
  const d: Drone = { x: 0, y: 0, z: 0.6, vx: 0, vy: 0, vz: 0, yaw: 0, phase: 'flying', pitch: 0, roll: 0, rotor: 1, spin: 0, next: 0, rings: 0, home: [0, 0.6], spot: null }
  return {
    scene, camera,
    step(t, dt) {
      // A slow orbit that passes through the ring, climbing and dipping.
      const a = t * 0.55
      const goal: [number, number, number] = [Math.sin(a) * 1.1, 0.95 + 0.25 * Math.sin(a * 2), -0.5 + Math.cos(a) * 1]
      const i: DroneIntent = { fwd: 0, right: 0, climb: 0, turn: 0, goal, toggle: false }
      stepDrone(d, i, dt)
      d.yaw = Math.atan2(-Math.cos(a), Math.sin(a))
      placeDrone(m, d, '#c6ff34')
      ring.mat.emissiveIntensity = 1.5 + 0.3 * Math.sin(t * 2)
    },
  }
}

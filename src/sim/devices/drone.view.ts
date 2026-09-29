import { contactPart, contactSurface } from '../contact'
/**
 * The drones' look (three.js): a netted cage with a lit frame, glowing rings, a pad per drone, and each quadcopter with
 * its holder's colour on its lights, its rotors a blur when they spin, and a shadow that softens as it climbs.
 */
import * as THREE from 'three'
import { DRONE, DRONE_PAD, dronePadHeight, DroneLogic, PYLONS, RINGS, stepDrone, type Drone, type DroneIntent } from './drone'
import { batch, cable, cylinder, floorMaterial } from '../kit'
import { carbon, ceramic, duct, lime, optic, polished, ring, shell, titanium, warmShell } from '../kit/surfaces'
import { Spring } from '../kit/motion'
import { instanceCopies } from '../kit/instances'
import { finishPrototype, loadPrototype, prototypeNodes, retirePrototype } from '../kit/prototype'
import { holdRig } from '../kit/reveal'
import { pov, tiledDeck } from '../kit/precision'
import { seat, supportVertices } from '../kit/support'
import { darkTitanium, gunmetal } from '../kit/surfaces'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { blobShadow, box, mats, plate, previewScene, wear, type DeviceView, type Preview } from './view'

interface DroneModel { root: THREE.Group; body: THREE.Group; support: THREE.Vector3[]; gimbal: THREE.Group; props: THREE.Group[]; blurs: THREE.Mesh[]; blades: THREE.MeshStandardMaterial; light: THREE.MeshStandardMaterial; shadow: THREE.Mesh; pitch: Spring; roll: Spring; leads: THREE.Group; sway: Spring }

/** The model is drawn 0.26 m in radius, then scaled to the drone's size in the logic. */
const SCALE = DRONE.radius / 0.26

function buildDrone(n: number): DroneModel {
  const root = new THREE.Group(), body = new THREE.Group()
  root.name = `drone-${n + 1}`; body.scale.setScalar(SCALE); root.add(body)
  contactPart(body, 'landing-gear')
  const light = mats.glow()
  // A flattened capsule, split into six curved panels over a continuous carbon pressure hull.
  const core = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), carbon)
  core.scale.set(0.101, 0.06, 0.136); core.position.y = 0.102; core.castShadow = true; body.add(core)
  for (let i = 0; i < 6; i++) {
    const panel = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 10, i * Math.PI / 3 + 0.018, Math.PI / 3 - 0.036, 0.12, 1.48), i % 3 === 0 ? warmShell : ceramic)
    panel.scale.set(0.108, 0.064, 0.14); panel.position.y = 0.104; panel.castShadow = true; body.add(panel)
  }
  const spine = shell(0.038, 0.19, 0.013, titanium); spine.rotation.x = Math.PI / 2; spine.position.y = 0.168; body.add(spine)
  for (const side of [-1, 1]) {
    const cheek = shell(0.018, 0.145, 0.042, titanium); cheek.rotation.x = Math.PI / 2; cheek.position.set(side * 0.093, 0.094, 0.005); body.add(cheek)
    body.add(cable([[side * 0.067, 0.071, -.08], [side * .09, .012, -.12], [side * .09, .012, .12], [side * .067, .071, .08]], .007, polished))
    const seam = box(.028, .003, .006, lime, .001); seam.position.set(side * .045, .155, -.07); body.add(seam)
  }
  const gimbal = new THREE.Group(); gimbal.position.set(0, .065, -.132); body.add(gimbal)
  pov(gimbal, [0, 0, -.032])
  const camera = shell(.067, .041, .049, carbon); gimbal.add(camera)
  const window = shell(.043, .021, .008, optic); window.position.z = -.026; gimbal.add(window)
  const eye = box(.022, .003, .009, lime, .001); eye.position.set(0, -.012, -.027); gimbal.add(eye)
  const leads = new THREE.Group(); leads.position.set(.065, .067, .055); body.add(leads)
  leads.add(cable([[0, 0, 0], [.012, -.025, .02], [.012, -.02, .045], [0, 0, .06]], .003, carbon))
  batch(leads)
  const props: THREE.Group[] = [], blurs: THREE.Mesh[] = []
  const blades = titanium.clone(); blades.userData = {}; blades.transparent = true; blades.depthWrite = false
  const blurMat = new THREE.MeshBasicMaterial({ color: '#b9c4c4', transparent: true, opacity: 0, depthWrite: false })
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const arm = shell(.038, .19, .025, carbon); arm.rotation.set(Math.PI / 2, 0, x * z > 0 ? Math.PI / 4 : -Math.PI / 4); arm.position.set(x * .105, .086, z * .105); body.add(arm)
    const casing = duct(.112, .038); casing.position.set(x * .17, .12, z * .17); body.add(casing)
    const lip = ring(.106, .003, polished); lip.rotation.x = Math.PI / 2; lip.position.set(x * .17, .138, z * .17); body.add(lip)
    const foot = cylinder(.008, .068, carbon, 8); foot.position.set(x * .08, .034, z * .10); body.add(foot)
    const motor = cylinder(.027, .04, titanium, 24); motor.position.set(x * .17, .10, z * .17); body.add(motor)
    // Fixed stators sit below three swept blades; the casing stays still as the rotor accelerates.
    for (let j = 0; j < 5; j++) {
      const a = j * Math.PI * 2 / 5
      const fin = box(.075, .009, .004, carbon, .001); fin.rotation.y = -a
      fin.position.set(x * .17 + Math.cos(a) * .06, .11, z * .17 + Math.sin(a) * .06); body.add(fin)
    }
    const prop = new THREE.Group(); prop.position.set(x * .17, .133, z * .17)
    for (let j = 0; j < 3; j++) {
      const blade = shell(.023, .087, .003, blades, .36); blade.rotation.x = Math.PI / 2
      const rotor = new THREE.Group(); rotor.userData.static = true; rotor.rotation.y = j * Math.PI * 2 / 3
      blade.position.z = .049; blade.rotation.z = -.22; rotor.add(blade); prop.add(rotor)
    }
    const cap = new THREE.Mesh(new THREE.SphereGeometry(.016, 16, 10), polished); cap.scale.y = .45; prop.add(cap)
    batch(prop, [], true)
    const blur = new THREE.Mesh(new THREE.CircleGeometry(.098, 40), blurMat); blur.rotation.x = -Math.PI / 2; blur.position.copy(prop.position); blur.position.y += .001
    body.add(prop, blur); props.push(prop); blurs.push(blur)
    const lead = cable([[x * .06, .09, z * .04], [x * .1, .102, z * .10], [x * .16, .101, z * .16]], .0025, carbon); body.add(lead)
  }
  const tail = box(.046, .006, .009, light, .002); tail.position.set(0, .095, .136); body.add(tail)
  const num = plate(n + 1, .045); num.rotation.x = -Math.PI / 2; num.position.set(0, .177, .028); body.add(num)
  num.name = 'number'
  const shadow = blobShadow(.3 * SCALE, .5)
  batch(body, [...props, ...blurs, gimbal, leads]); batch(gimbal)
  return { root, body, support: supportVertices(body), gimbal, props, blurs, blades, light, shadow, pitch: new Spring(), roll: new Spring(), leads, sway: new Spring(0, .24) }
}

function placeDrone(m: DroneModel, d: Drone, color: string | null, dt: number, ground: (x: number, z: number) => number = () => 0) {
  m.root.userData.contactMode = d.y > 0 ? 'clear' : 'touch'
  m.root.position.set(d.x, d.y, d.z)
  m.root.rotation.y = d.yaw
  m.body.rotation.set(d.pitch, 0, -d.roll, 'YXZ')
  // Physics altitude is clearance above the landing surface, not the optional mesh's origin.
  m.body.position.y = 0
  seat(m.body, m.support, ground, d.y)
  m.gimbal.rotation.set(m.pitch.step(-d.pitch, dt), 0, m.roll.step(d.roll, dt), 'YXZ')
  m.leads.rotation.z = m.sway.step(d.pitch * .45, dt)
  m.props.forEach((p, i) => { p.rotation.y = d.spin * (i % 3 === 0 ? 1 : -1) })
  for (const b of m.blurs) (b.material as THREE.MeshBasicMaterial).opacity = d.rotor * 0.28
  const fade = Math.max(0, Math.min(1, (d.rotor - .12) / .65))
  m.blades.opacity = 1 - fade * fade * (3 - 2 * fade)
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
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r.r, 0.035, 8, 64), titanium)
  g.add(ring)
  const status = box(.12, .014, .006, mat); status.position.y = r.r; g.add(status)
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
  floor.position.y = -0.028
  g.add(floor)
  g.add(tiledDeck(hx * 2, hz * 2, 0, 1.5))
  const edge = darkTitanium.clone()
  const bar = (w: number, hh: number, d: number, x: number, y: number, z: number) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), edge); b.position.set(x, y, z); g.add(b) }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(0.03, h, 0.03, sx * hx, h / 2, sz * hz)
  for (const sx of [-1, 1]) {
    const station = box(.12, .24, .06, gunmetal); station.position.set(sx*hx, .65, -hz); g.add(station)
    const slit = box(.07, .008, .003, lime); slit.position.set(sx*hx, .69, -hz+.031); g.add(slit)
  }
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
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(DRONE_PAD.top, DRONE_PAD.bottom, DRONE_PAD.height, DRONE_PAD.sides), gunmetal)
  disc.position.y = DRONE_PAD.height / 2
  disc.receiveShadow = true
  const glow = mats.glow()
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.41, 0.43, 8), ceramic)
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.022
  const num = plate(n + 1, 0.18)
  num.rotation.x = -Math.PI / 2
  num.position.set(0, 0.022, 0.3)
  g.add(contactSurface(disc), ring, num)
  const status = box(.12, .004, .016, glow); status.position.set(0, .023, -.3); g.add(status)
  return { group: g, glow }
}

export function createView(stage: Stage, logic: DroneLogic): DeviceView {
  const [hx, hz] = DRONE.cage
  const cage = buildCage(hx, hz, DRONE.ceiling)
  stage.scene.add(cage.group)
  const obstacles = new THREE.Group()
  for (const p of PYLONS) {
    const body = cylinder(p.radius, p.height, darkTitanium, 8); body.position.set(p.x, p.height / 2, p.z); obstacles.add(body)
    for (let i = 0; i < 3; i++) { const band = cylinder(p.radius + 0.006, 0.07, ceramic, 8); band.position.set(p.x, p.height - 0.1 - i * 0.2, p.z); obstacles.add(band) }
  }
  batch(obstacles); stage.scene.add(obstacles)
  const rings = logic.rings.map((r) => { const m = buildRing(r); stage.scene.add(m.group); return m })
  const pads = logic.drones.map((d, n) => { const p = buildPad(n); p.group.position.set(d.home[0], 0, d.home[1]); stage.scene.add(p.group); return p })
  const ground = (x: number, z: number) => {
    let height = 0
    for (const d of logic.drones) height = Math.max(height, dronePadHeight(x - d.home[0], z - d.home[1]))
    return height
  }
  const models = logic.drones.map((_, n) => { const m = buildDrone(n); stage.scene.add(m.root, m.shadow); return m })
  const copies = instanceCopies(stage.scene)
  // The procedural drones stay out of view until the Blender ones are in (or cannot come).
  const hold = holdRig('drone', models.map(m => m.root), { also: models.map(m => m.shadow), shown: () => { copies.set(models.map(m => m.root)); stage.view.invalidate() } })
  void Promise.all(models.map(async m => {
    const scene = await loadPrototype('drone')
    if (!scene) return null
    const nodes = prototypeNodes(scene, ['body', 'gimbal', 'leads', 'prop0', 'prop1', 'prop2', 'prop3'])
    finishPrototype(scene, { owner: m.light, rotor: m.blades })
    return nodes
  })).then(rigs => {
    if (rigs.some(r => !r) || !models.every(m => m.root.parent === stage.scene)) return hold.fallback()
    copies.clear()
    hold.install(() => rigs.forEach((rig, i) => {
      const m = models[i], old = m.body, body = rig!.body as THREE.Group
      body.scale.copy(old.scale)
      body.add(...m.blurs, old.getObjectByName('number')!)
      m.root.add(body); m.body = contactPart(body, 'landing-gear'); m.support = supportVertices(body)
      m.gimbal = rig!.gimbal as THREE.Group; m.leads = rig!.leads as THREE.Group
      m.gimbal.add(old.getObjectByName('pov')!)
      m.props = [rig!.prop0, rig!.prop1, rig!.prop2, rig!.prop3] as THREE.Group[]
      retirePrototype(old)
      m.root.userData.prototype = 'blender'
    }))
    copies.set(models.map(m => m.root)); stage.view.invalidate()
  }).catch(() => hold.fallback()) // A malformed optional asset leaves the procedural models in place.
  // The rings glow lavender on a dark surface, ultraviolet on the light one.
  let ringColor = '#b3a4ff'
  const setTheme = (t: Theme) => {
    cage.floor.color.set(t.light ? '#dde2ea' : '#232833')
    cage.edge.color.set(t.light ? '#68767d' : '#3d484f')
    ringColor = t.light ? '#6d4dff' : '#b3a4ff'
  }
  setTheme(stage.theme)
  const flash = rings.map(() => 0)
  const passed = logic.drones.map((d) => d.rings)
  return {
    framing: (() => { const d = logic.drones[0]; return { target: [d.x, d.y + 0.12, d.z], wide: [d.x + 0.8, d.y + 0.9, d.z + 1], tall: [d.x + 0.8, d.y + 1, d.z + 1.3], radius: 0.58, min: 0.4, max: 38 } })(),
    follow(n) { const d = logic.drones[n]; return new THREE.Vector3(d.x, d.y + 0.12, d.z) },
    inspect() { const d = logic.drones[0]; return { target: [d.x, d.y + 0.12, d.z], wide: [d.x + 0.8, d.y + 0.9, d.z + 1], tall: [d.x + 0.8, d.y + 1, d.z + 1.3], radius: 0.52, min: 0.4, max: 38 } },
    overview: { target: [0, 1.7, 0], wide: [0, 10.5, 18], tall: [0, 13, 17], radius: 7.5, min: 2, max: 38 },
    pickY: 0,
    update(colors, t, dt) {
      logic.drones.forEach((d, n) => {
        placeDrone(models[n], d, colors[n], dt, ground)
        wear(pads[n].glow, colors[n], 0.4, 1.8)
        // A ring flown through flashes in the pilot's colour.
        if (d.rings !== passed[n]) {
          passed[n] = d.rings
          const i = (d.next + logic.rings.length - 1) % logic.rings.length
          flash[i] = 1
          rings[i].mat.emissive.set(colors[n] ?? '#ffffff')
        }
      })
      copies.update()
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
      placeDrone(m, d, '#c6ff34', dt)
      ring.mat.emissiveIntensity = 1.5 + 0.3 * Math.sin(t * 2)
    },
  }
}

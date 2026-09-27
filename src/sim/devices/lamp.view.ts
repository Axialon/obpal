/**
 * The lamps' look (three.js): a room at dusk (a sofa, a rug, a side table and a coffee table) with an arc floor lamp, a
 * desk lamp, a pendant and a light bar, each lighting the room in its colour, with a soft halo round its bulb, a ring in
 * its holder's colour, and what's being typed to it floating beside it.
 */
import * as THREE from 'three'
import { batch, bolt, cable, cylinder, floorMaterial, maker, plastic } from '../kit'
import { LampLogic, rgbOf, type Lamp } from './lamp'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { box, mats, previewScene, wear, type DeviceView, type Preview } from './view'

let haloTex: THREE.Texture | null = null
function halo(size: number) {
  if (!haloTex) {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const g = c.getContext('2d')!
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.25, 'rgba(255,255,255,0.45)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
    haloTex = new THREE.CanvasTexture(c)
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  s.scale.setScalar(size)
  return s
}

interface LampModel { bulb: THREE.Mesh; bulbMat: THREE.MeshStandardMaterial; light: THREE.PointLight; glow: THREE.Sprite; ring: THREE.MeshStandardMaterial; at: THREE.Vector3; power: number }

/** A bulb with its light and halo, where a lamp's light comes from; `world` is where the lamp stands (its ring). */
function bulbAt(parent: THREE.Object3D, p: THREE.Vector3, r: number, power: number, world: THREE.Vector3): LampModel {
  const bulbMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 2 })
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), bulbMat)
  bulb.position.copy(p)
  const light = new THREE.PointLight('#ffffff', power, 7, 1.6)
  light.position.copy(p)
  const glow = halo(r * 14)
  glow.position.copy(p)
  const ring = mats.glow()
  parent.add(bulb, light, glow)
  return { bulb, bulbMat, light, glow, ring, at: world.clone().setY(p.y), power }
}

function buildRoom() {
  const g = new THREE.Group()
  const floorMat = floorMaterial('#645448')
  const floor = box(8.8, 0.05, 6.8, floorMat, 0.02)
  floor.position.set(0, -0.025, 0.95)
  const wallMat = new THREE.MeshStandardMaterial({ color: '#2d3140', roughness: 0.95 })
  const back = new THREE.Mesh(new THREE.BoxGeometry(8.8, 2.7, 0.08), wallMat)
  back.position.set(0, 1.35, -2.4)
  const side = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.7, 6.8), wallMat)
  side.position.set(-4.4, 1.35, 0.95)
  const rug = box(2.8, 0.02, 1.7, new THREE.MeshStandardMaterial({ color: '#8b86a8', roughness: 1 }), 0.01)
  rug.position.set(0.2, 0.01, -0.3)
  const fabric = new THREE.MeshStandardMaterial({ color: '#56607a', roughness: 0.9 })
  const seat = box(2.1, 0.42, 0.85, fabric, 0.1)
  seat.position.set(0.2, 0.21, -1.75)
  const backrest = box(2.1, 0.55, 0.22, fabric, 0.08)
  backrest.position.set(0.2, 0.62, -2.13)
  const armL = box(0.22, 0.58, 0.85, fabric, 0.08)
  armL.position.set(-0.86, 0.29, -1.75)
  const armR = armL.clone()
  armR.position.x = 1.26
  const cushionMat = new THREE.MeshStandardMaterial({ color: '#b3a4ff', roughness: 0.9 })
  const cushion = box(0.42, 0.36, 0.14, cushionMat, 0.07)
  cushion.position.set(-0.45, 0.6, -1.95)
  cushion.rotation.z = 0.15
  const wood = new THREE.MeshStandardMaterial({ color: '#6b4f3a', roughness: 0.6 })
  const coffee = box(1.1, 0.06, 0.6, wood, 0.03)
  coffee.position.set(0.25, 0.36, -0.35)
  for (const [x, z] of [[-0.25, -0.58], [0.75, -0.58], [-0.25, -0.12], [0.75, -0.12]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.34, 8), mats.dark())
    leg.position.set(x, 0.17, z)
    g.add(leg)
  }
  const side1 = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 40), wood)
  side1.position.set(1.95, 0.58, -1.65)
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.56, 12), mats.dark())
  stem.position.set(1.95, 0.28, -1.65)
  const plant = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 14), new THREE.MeshStandardMaterial({ color: '#3f6b4a', roughness: 0.9 }))
  plant.position.set(-2.55, 0.62, -1.9)
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.42, 20), new THREE.MeshStandardMaterial({ color: '#d8cfc4', roughness: 0.7 }))
  pot.position.set(-2.55, 0.21, -1.9)
  g.add(floor, back, side, rug, seat, backrest, armL, armR, cushion, coffee, side1, stem, plant, pot)
  // The reading end of the room: shelving, books, a chair and a framed print.
  const extra = new THREE.Group()
  const timber = plastic('#806544'), dark = mats.dark()
  for (const y of [0.18, 0.7, 1.22, 1.74]) { const shelf = box(1.4, 0.055, 0.42, timber); shelf.position.set(3.3, y, -2.08); extra.add(shelf) }
  for (const x of [2.62, 3.98]) { const support = box(0.05, 1.85, 0.4, dark); support.position.set(x, 0.94, -2.08); extra.add(support) }
  for (let i = 0; i < 12; i++) {
    const book = box(0.08, 0.26 + (i % 3) * 0.04, 0.21, plastic(['#a1aba4', '#ba8f60', '#596b74'][i % 3]), 0.004)
    book.position.set(2.82 + (i % 6) * 0.12, 0.89 + Math.floor(i / 6) * 0.52, -2.02); extra.add(book)
  }
  const chair = box(0.8, 0.18, 0.8, fabric, 0.07); chair.position.set(2.75, 0.4, 0.7); extra.add(chair)
  const chairBack = box(0.8, 0.68, 0.16, fabric, 0.065); chairBack.position.set(2.75, 0.72, 1.03); extra.add(chairBack)
  for (const x of [2.43, 3.07]) for (const z of [0.4, 1]) { const leg = cylinder(0.028, 0.36, timber); leg.position.set(x, 0.18, z); extra.add(leg) }
  const art = box(1.35, 0.85, 0.045, dark); art.position.set(-0.2, 1.72, -2.33); extra.add(art)
  const paper = box(1.22, 0.72, 0.01, plastic('#b6b5a6')); paper.position.set(-0.2, 1.72, -2.3); extra.add(paper)
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.25, 32), plastic('#76806c')); disc.position.set(-0.34, 1.72, -2.29); extra.add(disc)
  batch(extra); g.add(extra)
  batch(g, [floor, back, side])
  return { group: g, floorMat, wallMat }
}

/** The four lamps, in LAMP_SPEC's order: floor lamp, desk lamp, pendant, light bar. */
function buildLamps(parent: THREE.Object3D): LampModel[] {
  const metal = mats.metal()
  const dark = mats.dark()
  const shade = new THREE.MeshStandardMaterial({ color: '#f1ede6', roughness: 0.5, side: THREE.DoubleSide })
  // The arc floor lamp: a heavy base, an arc over the sofa's end, a dome.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.05, 32), dark)
  base.position.set(-2.1, 0.025, -1.3)
  const arc = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-2.1, 0.05, -1.3), new THREE.Vector3(-2.2, 2.6, -1.3), new THREE.Vector3(-1.05, 1.9, -1.3))
  const pole = new THREE.Mesh(new THREE.TubeGeometry(arc, 40, 0.018, 8), metal)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.24, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), shade)
  dome.position.set(-1.05, 1.88, -1.3)
  parent.add(base, pole, dome)
  const floorLamp = bulbAt(parent, new THREE.Vector3(-1.05, 1.8, -1.3), 0.05, 7, new THREE.Vector3(-2.1, 0, -1.3))
  // The desk lamp on the side table: a foot, two arms, a cone.
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.03, 24), dark)
  foot.position.set(1.95, 0.615, -1.65)
  const arm1 = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 8), metal)
  arm1.position.set(1.9, 0.8, -1.62)
  arm1.rotation.z = 0.35
  const arm2 = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 8), metal)
  arm2.position.set(1.76, 1.02, -1.55)
  arm2.rotation.z = -0.9
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.18, 24, 1, true), shade)
  cone.position.set(1.6, 1.02, -1.5)
  cone.rotation.z = 0.5
  parent.add(foot, arm1, arm2, cone)
  const desk = bulbAt(parent, new THREE.Vector3(1.6, 0.98, -1.5), 0.035, 3.5, new THREE.Vector3(1.95, 0, -1.65))
  // The pendant over the coffee table, on a cord from the ceiling.
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 1.1, 6), dark)
  cord.position.set(0.25, 2.2, -0.35)
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.26, 0.26, 32, 1, true), new THREE.MeshStandardMaterial({ color: '#c9d1dc', metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide }))
  bell.position.set(0.25, 1.55, -0.35)
  parent.add(cord, bell)
  const rose = cylinder(0.085, 0.045, dark); rose.position.set(0.25, 2.74, -0.35); parent.add(rose)
  const socket = cylinder(0.034, 0.11, metal); socket.position.set(0.25, 1.59, -0.35); parent.add(socket)
  for (const y of [0.72, 1]) { const pivot = cylinder(0.024, 0.032, dark); pivot.rotation.z = Math.PI / 2; pivot.position.set(1.9, y, -1.62); parent.add(pivot) }
  parent.add(cable([[1.95, 0.6, -1.64], [1.87, 0.77, -1.6], [1.8, 1.03, -1.55], [1.64, 1.04, -1.5]], 0.005))
  maker(parent, -2.1, 0.052, -1.3, 0.06)
  const screw = bolt(0.012); screw.position.set(1.95, 0.634, -1.65); parent.add(screw)
  const pendant = bulbAt(parent, new THREE.Vector3(0.25, 1.46, -0.35), 0.05, 6, new THREE.Vector3(0.25, 0, -0.35))
  // The light bar on the wall over the sofa.
  const bar = box(1.2, 0.05, 0.05, dark, 0.02)
  bar.position.set(1.05, 1.72, -2.33)
  parent.add(bar)
  const strip = bulbAt(parent, new THREE.Vector3(1.05, 1.7, -2.28), 0.03, 5, new THREE.Vector3(1.05, 0, -2.0))
  strip.bulb.scale.set(19, 0.7, 0.7)
  strip.glow.scale.set(1.8, 0.45, 1)
  return [floorLamp, desk, pendant, strip]
}

function placeLamp(m: LampModel, l: Lamp, color: string | null) {
  const [r, g, b] = rgbOf(l)
  const lit = Math.max(r, g, b)
  m.light.color.setRGB(r / (lit || 1), g / (lit || 1), b / (lit || 1))
  m.light.intensity = m.power * lit
  m.bulbMat.emissive.setRGB(r / (lit || 1), g / (lit || 1), b / (lit || 1))
  m.bulbMat.emissiveIntensity = 0.2 + lit * 2.6
  ;(m.glow.material as THREE.SpriteMaterial).color.setRGB(r, g, b)
  ;(m.glow.material as THREE.SpriteMaterial).opacity = 0.2 + lit * 0.6
  wear(m.ring, color, 0.3, 2)
}

export function createView(stage: Stage, logic: LampLogic): DeviceView {
  const room = buildRoom()
  stage.scene.add(room.group)
  const models = buildLamps(stage.scene)
  for (const m of models) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.008, 8, 48), m.ring)
    band.rotation.x = Math.PI / 2
    band.position.set(m.at.x, 0.012, m.at.z)
    stage.scene.add(band)
  }
  // What's being typed to a lamp, beside it.
  const labels = models.map(() => {
    const el = document.createElement('div')
    el.className = 'lamp-typing'
    el.hidden = true
    document.body.appendChild(el)
    return el
  })
  const setTheme = (t: Theme) => {
    // Warm ambient fill keeps the furnishing visible while the bulbs supply the colour.
    stage.renderer.toneMappingExposure = 1.1
    stage.lights.key.color.set('#ffe0b0')
    stage.lights.hemi.intensity = t.light ? 1.1 : 0.85
    stage.lights.key.intensity = t.light ? 1.2 : 0.95
    stage.scene.environmentIntensity = t.light ? 0.6 : 0.5
    room.wallMat.color.set(t.light ? '#c6b7a8' : '#8d7765')
    room.floorMat.color.set(t.light ? '#a17e5d' : '#78583e')
  }
  setTheme(stage.theme)
  const v = new THREE.Vector3()
  return {
    framing: { target: [0, 1.05, -1.1], wide: [2.5, 3.0, 4.7], tall: [0.7, 3.3, 5.6], radius: 2.25, min: 0.6, max: 24 },
    inspect() { return { target: [1.8, 0.95, -1.6], wide: [2.6, 1.4, -0.6], tall: [2.5, 1.6, -0.4], radius: 0.5, min: 0.4, max: 20 } },
    overview: { target: [0, 0.8, -0.3], wide: [3.8, 4.8, 8.2], tall: [1, 6, 10], radius: 4.5, min: 1.5, max: 20 },
    anchor: (n) => models[n].at.clone(),
    update(colors) {
      logic.lamps.forEach((l, n) => {
        placeLamp(models[n], l, colors[n])
        const el = labels[n]
        el.hidden = !l.typing
        if (!l.typing) return
        el.textContent = l.typing
        const s = stage.toScreen(v.copy(models[n].at))
        if (s) el.style.transform = `translate(${s.x}px, ${s.y - 40}px) translate(-50%, -100%)`
        el.style.setProperty('--c', colors[n] ?? '#ffffff')
      })
    },
    setTheme,
  }
}

/** The card: the room with its lamps changing colour, slowly, one after another. */
export function preview(): Preview {
  const scene = previewScene()
  const hemi = scene.children.find((o) => (o as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight
  hemi.intensity = 0.35
  const room = buildRoom()
  scene.add(room.group)
  const models = buildLamps(scene)
  const logic = new LampLogic()
  const camera = new THREE.PerspectiveCamera(40, 16 / 10, 0.05, 30)
  camera.position.set(1.7, 2.3, 3.6)
  camera.lookAt(0, 0.9, -1.2)
  return {
    scene, camera,
    step(t) {
      logic.lamps.forEach((l, n) => {
        l.h = (t * 24 + n * 90) % 360
        l.s = 0.7
        l.v = 0.55 + 0.35 * Math.sin(t * 0.8 + n)
        placeLamp(models[n], l, null)
      })
    },
  }
}

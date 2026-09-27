/**
 * The claw machines' look (three.js): two glass cabinets lit in their players' colours, a gantry riding over a pit of
 * glass orbs and cubes, the claw on its cable opening and closing, and the chute in the corner.
 */
import * as THREE from 'three'
import { CABINETS, CLAW, ClawLogic, type Claw, type Prize } from './claw'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { restInput } from './types'
import { box, mats, plate, previewScene, wear, type DeviceView, type Preview } from './view'

interface ClawModel {
  root: THREE.Group
  trolley: THREE.Group
  bridge: THREE.Mesh
  cable: THREE.Mesh
  hub: THREE.Group
  fingers: THREE.Group[]
  sign: THREE.MeshStandardMaterial
  base: THREE.MeshStandardMaterial
  prizes: THREE.Mesh[]
}

function buildCabinet(n: number, prizes: readonly Prize[]): ClawModel {
  const root = new THREE.Group()
  const H = CLAW.half + 0.08
  const baseMat = new THREE.MeshStandardMaterial({ color: '#232838', roughness: 0.55, metalness: 0.2 })
  const base = box(H * 2, CLAW.floor, H * 2, baseMat, 0.03)
  base.position.y = CLAW.floor / 2
  root.add(base)
  const sign = mats.glow()
  const trim = new THREE.Mesh(new THREE.BoxGeometry(H * 2 + 0.01, 0.02, H * 2 + 0.01), sign)
  trim.position.y = CLAW.floor
  root.add(trim)
  // The pit's floor, and the chute in its near left corner with a lit rim and a low glass guard.
  const pit = new THREE.Mesh(new THREE.PlaneGeometry(CLAW.half * 2, CLAW.half * 2), new THREE.MeshStandardMaterial({ color: '#3b3470', roughness: 0.9 }))
  pit.rotation.x = -Math.PI / 2
  pit.position.y = CLAW.floor + 0.001
  root.add(pit)
  const ch = CLAW.chute
  const hole = new THREE.Mesh(new THREE.PlaneGeometry(ch.half * 2, ch.half * 2), new THREE.MeshBasicMaterial({ color: '#05060a' }))
  hole.rotation.x = -Math.PI / 2
  hole.position.set(ch.x, CLAW.floor + 0.002, ch.z)
  root.add(hole)
  const rim = new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#c6ff34', emissiveIntensity: 1.4 })
  const guardGlass = new THREE.MeshPhysicalMaterial({ color: '#dfe8ff', transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false })
  for (const [dx, dz, w, d] of [[0, -1, 2, 0], [1, 0, 0, 2]] as const) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(w ? ch.half * 2 : 0.008, 0.1, d ? ch.half * 2 : 0.008), guardGlass)
    guard.position.set(ch.x + dx * ch.half, CLAW.floor + 0.05, ch.z + dz * ch.half)
    const lit = new THREE.Mesh(new THREE.BoxGeometry(w ? ch.half * 2 : 0.012, 0.01, d ? ch.half * 2 : 0.012), rim)
    lit.position.set(ch.x + dx * ch.half, CLAW.floor + 0.1, ch.z + dz * ch.half)
    root.add(guard, lit)
  }
  // Glass walls and corner posts up to the header.
  const glass = new THREE.MeshPhysicalMaterial({ color: '#c9d6ff', transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0, depthWrite: false, side: THREE.DoubleSide })
  const wallH = 1.62 - CLAW.floor
  for (const [x, z, ry] of [[0, -H, 0], [0, H, 0], [-H, 0, Math.PI / 2], [H, 0, Math.PI / 2]] as const) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, wallH), glass)
    pane.position.set(x, CLAW.floor + wallH / 2, z)
    pane.rotation.y = ry
    root.add(pane)
  }
  const metal = mats.metal()
  for (const x of [-H, H]) for (const z of [-H, H]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, wallH, 8), metal)
    post.position.set(x, CLAW.floor + wallH / 2, z)
    root.add(post)
  }
  const header = box(H * 2 + 0.04, 0.2, H * 2 + 0.04, baseMat, 0.03)
  header.position.y = 1.72
  root.add(header)
  const band = new THREE.Mesh(new THREE.BoxGeometry(H * 2 + 0.05, 0.03, H * 2 + 0.05), sign)
  band.position.y = 1.66
  root.add(band)
  const num = plate(n + 1, 0.13)
  num.position.set(0, 1.74, H + 0.022)
  root.add(num)
  // The gantry: rails along the sides, a bridge across, and the trolley on it.
  const railMat = mats.dark()
  for (const z of [-CLAW.half, CLAW.half]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(CLAW.half * 2, 0.02, 0.02), railMat)
    rail.position.set(0, CLAW.top + 0.06, z)
    root.add(rail)
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, CLAW.half * 2), metal)
  bridge.position.y = CLAW.top + 0.06
  root.add(bridge)
  const trolley = new THREE.Group()
  trolley.add(box(0.08, 0.05, 0.08, railMat, 0.012))
  trolley.position.y = CLAW.top + 0.04
  root.add(trolley)
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 6), railMat)
  root.add(cable)
  // The claw: a hub and three fingers that swing in to close.
  const hub = new THREE.Group()
  const hubBody = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.028, 0.05, 24), metal)
  hub.add(hubBody)
  const fingers: THREE.Group[] = []
  for (let k = 0; k < 3; k++) {
    const pivot = new THREE.Group()
    pivot.rotation.y = (k / 3) * Math.PI * 2
    const f = new THREE.Group()
    f.position.set(0.028, -0.02, 0)
    const upper = box(0.012, 0.06, 0.016, metal, 0.004)
    upper.position.set(0.012, -0.03, 0)
    upper.rotation.z = 0.35
    const lower = box(0.012, 0.055, 0.016, metal, 0.004)
    lower.position.set(0.012, -0.075, 0)
    lower.rotation.z = -0.35
    f.add(upper, lower)
    pivot.add(f)
    hub.add(pivot)
    fingers.push(f)
  }
  root.add(hub)
  const prizeMeshes = prizes.map((p) => {
    const m = new THREE.MeshPhysicalMaterial({ color: p.color, roughness: 0.12, metalness: 0.05, clearcoat: 1, emissive: p.color, emissiveIntensity: 0.08 })
    const mesh = p.kind === 'orb' ? new THREE.Mesh(new THREE.SphereGeometry(p.r, 28, 18), m) : box(p.r * 1.7, p.r * 1.7, p.r * 1.7, m, p.r * 0.3)
    root.add(mesh)
    return mesh
  })
  return { root, trolley, bridge, cable, hub, fingers, sign, base: baseMat, prizes: prizeMeshes }
}

function placeClaw(m: ClawModel, c: Claw, prizes: readonly Prize[], color: string | null, t: number) {
  m.bridge.position.x = c.x
  m.trolley.position.set(c.x, CLAW.top + 0.04, c.z)
  m.hub.position.set(c.x, c.y, c.z)
  const top = CLAW.top + 0.02
  m.cable.position.set(c.x, (top + c.y) / 2, c.z)
  m.cable.scale.y = Math.max(0.01, top - c.y)
  // Open, the fingers splay out; closed, they meet under the hub.
  for (const f of m.fingers) f.rotation.z = 0.55 - c.close * 0.75
  wear(m.sign, color, 0.5, 1.8 + (color ? 0.4 * Math.sin(t * 3) : 0))
  prizes.forEach((p, k) => {
    const mesh = m.prizes[k]
    mesh.visible = !p.won || p.y > CLAW.floor - 0.15
    mesh.position.set(p.x, p.y, p.z)
    if (p.kind === 'cube') mesh.rotation.y = k * 0.7
  })
}

export function createView(stage: Stage, logic: ClawLogic): DeviceView {
  const models = logic.claws.map((_, n) => {
    const m = buildCabinet(n, logic.prizes[n])
    const [x, z] = CABINETS[n] ?? [0, 0]
    m.root.position.set(x, 0, z)
    stage.scene.add(m.root)
    return m
  })
  const setTheme = (t: Theme) => { for (const m of models) m.base.color.set(t.light ? '#dfe3ea' : '#232838') }
  setTheme(stage.theme)
  return {
    framing: { target: [0, 1, 0], wide: [0, 2.05, 3.95], tall: [0, 2.4, 5], radius: 1.35, min: 1.4, max: 8 },
    pickY: CLAW.floor + 0.05,
    pointFrom: (n) => new THREE.Vector3((CABINETS[n] ?? [0, 0])[0], CLAW.floor + 0.05, (CABINETS[n] ?? [0, 0])[1]),
    update(colors, t) { logic.claws.forEach((c, n) => placeClaw(models[n], c, logic.prizes[n], colors[n], t)) },
    setTheme,
  }
}

/** The card: one cabinet whose claw roams, drops on a prize and carries it to the chute. */
export function preview(): Preview {
  const scene = previewScene()
  const logic = new ClawLogic(1)
  const m = buildCabinet(0, logic.prizes[0])
  m.base.color.set('#2b2358')
  scene.add(m.root)
  const camera = new THREE.PerspectiveCamera(34, 16 / 10, 0.05, 20)
  camera.position.set(0.9, 1.75, 2.1)
  camera.lookAt(0, 1, 0)
  let next = 0
  return {
    scene, camera,
    step(t, dt) {
      const c = logic.claws[0]
      // Every few seconds it picks a prize to go for, rides over it and drops.
      if (c.phase === 'idle' && t > next) {
        const free = logic.prizes[0].filter((p) => !p.won && !p.held)
        const p = free[Math.floor((t * 7) % free.length)]
        c.goal = p ? [p.x, p.z] : null
        next = t + 3.2
      }
      const arrived = !!c.goal && Math.hypot(c.goal[0] - c.x, c.goal[1] - c.z) < 0.004
      logic.step([{ ...restInput('face.trackpad', 0), presses: arrived ? ['drop'] : [] }], dt)
      logic.drain()
      placeClaw(m, c, logic.prizes[0], '#c6ff34', t)
    },
  }
}

import { contactPart, contactSurface, contactInstances } from '../contact'
/**
 * The claw machines' look (three.js): two glass cabinets lit in their players' colours, a gantry riding over a pit of
 * glass orbs and cubes, the claw on its cable opening and closing, and the chute in the corner.
 */
import * as THREE from 'three'
import { darkTitanium, carbon } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { batch, bolt, cylinder, maker, plastic, rounded } from '../kit'
import { CABINETS, CLAW, ClawLogic, prizeSupport, type Claw, type Prize } from './claw'
import { fitFingers, fingerPenetration } from './claw-fingers'
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
  prizes: { mesh: THREE.InstancedMesh; index: number; last: string }[]
}

function buildCabinet(n: number, prizes: readonly Prize[]): ClawModel {
  const root = new THREE.Group()
  const H = CLAW.half + 0.08
  const baseMat = new THREE.MeshStandardMaterial({ color: '#3d484f', roughness: .24, metalness: .9 })
  const base = box(H * 2, CLAW.floor, H * 2, baseMat, 0.03)
  base.castShadow = true
  base.position.y = CLAW.floor / 2
  root.add(contactPart(base, `cabinet-${n}`))
  for (const side of [-1, 1]) { const panel = service(H * 1.5, CLAW.floor * .6); panel.position.set(side * (H + .005), CLAW.floor / 2, 0); panel.rotation.y = side * Math.PI / 2; root.add(panel) }
  const dark = mats.dark(), metalTrim = mats.metal()
  const console = box(H * 1.65, 0.09, 0.2, dark); console.position.set(0, 0.58, H + 0.075); root.add(console)
  const joystick = cylinder(0.013, 0.09, metalTrim); joystick.position.set(-0.22, 0.665, H + 0.075); root.add(joystick)
  const grip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), dark); grip.position.set(-0.22, 0.72, H + 0.075); root.add(grip)
  const button = cylinder(0.035, 0.022, plastic('#c6ff34')); button.position.set(0.2, 0.636, H + 0.075); root.add(button)
  const hatch = box(0.34, 0.23, 0.018, dark); hatch.position.set(-0.22, 0.22, H + 0.005); root.add(hatch)
  const lip = box(0.34, 0.026, 0.05, metalTrim); lip.position.set(-0.22, 0.12, H + 0.025); root.add(lip)
  const coin = box(0.075, 0.13, 0.012, metalTrim); coin.position.set(0.29, 0.32, H + 0.006); root.add(coin)
  const slot = box(0.009, 0.065, 0.006, dark); slot.position.set(0.29, 0.33, H + 0.014); root.add(slot)
  for (const side of [-1, 1]) {
    const screw = bolt(0.012); screw.rotation.x = Math.PI / 2; screw.position.set(side * H * 0.85, 0.4, H + 0.01); root.add(screw)
    for (const z of [-1, 1]) { const foot = cylinder(0.055, 0.025, dark); foot.position.set(side * H * 0.86, 0.012, z * H * 0.86); root.add(foot) }
  }
  const mark = maker(root, 0.3, 0.16, H + 0.017, 0.065); mark.rotation.x = Math.PI / 2
  const sign = mats.glow()
  const trim = new THREE.Mesh(new THREE.BoxGeometry(H * 2 + 0.01, 0.02, H * 2 + 0.01), darkTitanium)
  trim.position.y = CLAW.floor
  root.add(trim)
  // The pit's floor, and the chute in its near left corner with a lit rim and a low glass guard.
  const pit = new THREE.Mesh(new THREE.PlaneGeometry(CLAW.half * 2, CLAW.half * 2), carbon)
  pit.rotation.x = -Math.PI / 2
  pit.position.y = CLAW.floor + 0.001
  pit.receiveShadow = true
  root.add(contactSurface(pit, `pit-${n}`))
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
  const band = new THREE.Mesh(new THREE.BoxGeometry(H * 2 + 0.05, 0.03, H * 2 + 0.05), darkTitanium)
  band.position.y = 1.66
  root.add(band)
  const status = box(.13, .015, .003, sign); status.position.set(0, 1.64, H + .028); root.add(status)
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
    f.name = `claw-${n}-finger-${k}`
    f.position.set(0.028, -0.02, 0)
    const upper = box(0.012, 0.06, 0.016, metal, 0.004)
    upper.position.set(0.012, -0.03, 0)
    upper.rotation.z = 0.35
    const lower = box(0.012, 0.055, 0.016, metal, 0.004)
    lower.position.set(0.012, -0.075, 0)
    lower.rotation.z = -0.35
    upper.castShadow = lower.castShadow = true
    f.add(upper, lower)
    contactPart(f, `claw-${n}-finger-${k}`, { surface: `pit-${n}`, mode: 'clear', penetration: () => fingerPenetration([f], root, prizes) })
    pivot.add(f)
    hub.add(pivot)
    fingers.push(f)
  }
  root.add(hub)
  pov(hub, [0, -.03, 0], [0, -1, 0])
  // One instance buffer per shape and colour; every prize still moves independently.
  const buckets = new Map<string, { mesh: THREE.InstancedMesh; used: number }>()
  const prizeMeshes = prizes.map(p => {
    const key = `${p.kind}:${p.color}`
    let bucket = buckets.get(key)
    if (!bucket) {
      const count = prizes.filter(q => q.kind === p.kind && q.color === p.color).length
      const geometry = p.kind === 'orb' ? new THREE.SphereGeometry(p.r, 20, 12) : rounded(p.r * 2, p.r * 2, p.r * 2, p.r * 0.3)
      const mesh = new THREE.InstancedMesh(geometry, plastic(p.color), count)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false
      mesh.castShadow = mesh.receiveShadow = true
      const same = prizes.filter(q => q.kind === p.kind && q.color === p.color)
      contactInstances(mesh, `prize-${n}-${p.kind}-${buckets.size}`, i => ({
        supports: `prize-${n}-${prizes.indexOf(same[i])}`,
        surface: () => { const under = same[i].held ? null : prizeSupport(same[i], prizes); return under ? `prize-${n}-${prizes.indexOf(under)}` : `pit-${n}` },
        active: () => !same[i].won,
        mode: () => { const q = same[i], under = prizeSupport(q, prizes); return q.held || q.y > (under ? under.y + under.r : CLAW.floor) + q.r + .002 ? 'clear' : 'touch' },
      }))
      bucket = { mesh, used: 0 }; buckets.set(key, bucket); root.add(mesh)
    }
    return { mesh: bucket.mesh, index: bucket.used++, last: '' }
  })
  batch(root, [bridge, cable, ...fingers, ...prizeMeshes.map(p => p.mesh)])
  return { root, trolley, bridge, cable, hub, fingers, sign, base: baseMat, prizes: prizeMeshes }
}

const prizeTransform = new THREE.Object3D()
function placeClaw(m: ClawModel, c: Claw, prizes: readonly Prize[], color: string | null, t: number) {
  m.bridge.position.x = c.x
  m.trolley.position.set(c.x, CLAW.top + 0.04, c.z)
  m.hub.position.set(c.x, c.y, c.z)
  const top = CLAW.top + 0.02
  m.cable.position.set(c.x, (top + c.y) / 2, c.z)
  m.cable.scale.y = Math.max(0.01, top - c.y)
  // Open, the fingers splay out; closed, they meet under the hub.
  fitFingers(m.fingers, m.root, prizes, c.close)
  wear(m.sign, color, 0.5, 1.8 + (color ? 0.4 * Math.sin(t * 3) : 0))
  prizes.forEach((p, k) => {
    if (!m.prizes[k]) return
    const { mesh, index } = m.prizes[k]
    const state = `${p.x}:${p.y}:${p.z}:${p.won}`
    if (m.prizes[k].last === state) return
    m.prizes[k].last = state
    prizeTransform.scale.setScalar(!p.won || p.y > CLAW.floor - 0.15 ? 1 : 0)
    prizeTransform.position.set(p.x, p.y, p.z)
    prizeTransform.rotation.y = p.kind === 'cube' ? k * 0.7 : 0
    prizeTransform.updateMatrix(); mesh.setMatrixAt(index, prizeTransform.matrix); mesh.instanceMatrix.needsUpdate = true
  })
}

export function createView(stage: Stage, logic: ClawLogic): DeviceView {
  stage.scene.add(tiledDeck(4.5, 3.8, 0, 1))
  const models = logic.claws.map((_, n) => {
    const m = buildCabinet(n, logic.prizes[n])
    const [x, z] = CABINETS[n] ?? [0, 0]
    m.root.position.set(x, 0, z)
    stage.scene.add(m.root)
    return m
  })
  const setTheme = (t: Theme) => { for (const m of models) m.base.color.set(t.light ? '#8a9499' : '#3d484f') }
  setTheme(stage.theme)
  return {
    framing: (() => { const [x, z] = CABINETS[0]; return { target: [x, 1.1, z], wide: [x + 1.1, 2.1, z + 2.3], tall: [x + 0.8, 2.2, z + 2.5], radius: 1.25, min: 0.5, max: 12 } })(),
    inspect() { const [x, z] = CABINETS[0]; return { target: [x, 1.1, z], wide: [x + 1.1, 2.1, z + 2.3], tall: [x + 0.8, 2.2, z + 2.5], radius: 0.87, min: 0.5, max: 12 } },
    overview: { target: [0, 0.95, 0], wide: [0.6, 2.8, 5.6], tall: [0, 3.1, 6.5], radius: 1.85, min: 0.8, max: 12 },
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
  m.base.color.set('#3d484f')
  scene.add(m.root)
  const camera = new THREE.PerspectiveCamera(34, 16 / 10, 0.05, 20)
  camera.position.set(1.2, 2.1, 2.8)
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

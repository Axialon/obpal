/** A small rehearsal room made from the shared kit. Static shells batch; heads, cymbals and keys keep their pivots. */
import * as THREE from 'three'
import * as kit from '../kit'
import { ceramic, darkTitanium, gunmetal, carbon } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'
import { previewScene, type DeviceView, type Preview } from './view'
import type { Stage } from './stage'
import { STATIONS, StudioLogic } from './studio'
import { attachStudio } from './studio.session'
import '../../styles/studio.css'

const POS: [number, number][] = [[-0.8, -1.5], [-3.2, -0.2], [1.8, -1.7], [-3.1, 1.85], [-0.45, 2.05], [2.55, 1.65], [3.7, -0.15], [-3.55, -2.3]]
interface Moving { mesh: THREE.Object3D; unit: number; n: number; kind: 'head' | 'cymbal' | 'key' | 'air'; y: number }

function room(live?: () => void) {
  const root = new THREE.Group(), moving: Moving[] = [], glows: THREE.MeshStandardMaterial[] = []
  const wood = darkTitanium, dark = gunmetal, trim = carbon
  const slots: Record<string, THREE.Object3D> = {}
  const skin = ceramic, brass = new THREE.MeshStandardMaterial({ color: '#bda064', metalness: 0.8, roughness: 0.36 })
  const red = gunmetal, ivory = ceramic
  const add = (mesh: THREE.Mesh, parent: THREE.Object3D, x: number, y: number, z: number) => {
    mesh.position.set(x, y, z); mesh.castShadow = true; parent.add(mesh); return mesh
  }
  const b = (p: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, m: THREE.Material, r = 0.018) => add(kit.box(w, h, d, m, r), p, x, y, z)
  const c = (p: THREE.Object3D, x: number, y: number, z: number, radius: number, height: number, m: THREE.Material) => add(kit.cylinder(radius, height, m, 32), p, x, y, z)
  const animate = (mesh: THREE.Object3D, unit: number, n: number, kind: Moving['kind']) => { moving.push({ mesh, unit, n, kind, y: mesh.position.y }); return mesh }
  root.add(tiledDeck(10.4, 7.4, -.005, 1.3))
  for (const x of [-4.6, -1.75, 1.75, 4.6]) { const panel = service(.55, 1.75); panel.position.set(x, 1.15, -3.475); root.add(panel) }
  b(root, 0, 1.05, -3.65, 10.4, 2.35, 0.16, dark)
  b(root, -5.12, 0.6, -1.8, 0.14, 1.45, 3.7, dark)
  for (let i = 0; i < 29; i++) b(root, -4.9 + i * 0.35, 1.16, -3.51, 0.09, 1.9, 0.075, wood)
  for (const x of [-3.5, 0, 3.5]) {
    b(root, x, 1.27, -3.36, 1.45, 1.25, 0.14, trim)
    for (let k = 0; k < 7; k++) b(root, x - 0.6 + k * 0.2, 1.27, -3.27, 0.04, 1.1, 0.03, dark)
  }
  const light = ceramic
  b(root, 0, 0.12, -3.47, 9.8, 0.025, 0.03, light)
  // The kick's tilted head remains one animated object, as do all horizontal drum heads.
  function drum(p: THREE.Group, unit: number, n: number, x: number, y: number, z: number, r: number, height: number, hand = false) {
    const key = `drum_${unit}_${n}`; slots[key] = skinSlot(p, key, c(p, x, y, z, r, height, hand ? wood : red))
    c(p, x, y + height / 2, z, r + 0.025, 0.045, kit.metal)
    c(p, x, y - height / 2, z, r + 0.02, 0.035, kit.metal)
    animate(c(p, x, y + height / 2 + 0.025, z, r * 0.94, 0.022, skin), unit, n, 'head')
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; c(p, x + Math.cos(a) * (r + 0.013), y, z + Math.sin(a) * (r + 0.013), 0.014, height * 0.8, kit.metal) }
    if (!hand) c(p, x, y / 2, z, 0.018, y, kit.metal)
  }
  function cymbal(p: THREE.Group, unit: number, n: number, x: number, y: number, z: number, r: number) {
    c(p, x, y / 2, z, 0.014, y, kit.metal)
    b(p, x, 0.05, z, 0.5, 0.025, 0.035, kit.metal)
    const pivot = new THREE.Group(); pivot.position.set(x, y, z); p.add(pivot)
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r, 0.065, 40), brass); pivot.add(disc)
    c(pivot, 0, 0.045, 0, 0.018, 0.055, trim)
    animate(pivot, unit, n, 'cymbal')
  }
  POS.forEach(([x, z], unit) => {
    const p = new THREE.Group(); p.position.set(x, 0.03, z); p.userData.static = true; root.add(p)
    pov(p, [0, 1.35, unit === 0 ? -.9 : .8], [0, -.55, unit === 0 ? 1 : -1])
    const glow = new THREE.MeshStandardMaterial({ color: '#343d29', emissive: '#b9ee6d', emissiveIntensity: 0.2, roughness: 0.5 })
    glows.push(glow)
    b(p, 0, 0.013, 0, unit === 0 ? 2.6 : 1.9, 0.025, unit === 0 ? 2 : 1.5, carbon)
    b(p, 0, 0.04, unit === 0 ? 1 : 0.76, .12, 0.015, 0.025, glow)
    // Seat numbers and instrument names are generated, original artwork.
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96
    const g = canvas.getContext('2d')!; g.fillStyle = '#dce6ce'; g.font = '600 31px sans-serif'; g.textAlign = 'center'; g.fillText(`${unit + 1}  ${STATIONS[unit]}`, 256, 58)
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1.65, 0.31), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }))
    label.rotation.x = -Math.PI / 2; label.position.set(0, 0.04, unit === 0 ? 1.22 : 0.96); p.add(label)
    if (unit === 0) {
      const kick = new THREE.Group(); kick.position.set(0, 0.48, 0.2); kick.rotation.x = Math.PI / 2; kick.userData.static = true; p.add(kick)
      drum(kick, unit, 0, 0, 0, 0, 0.46, 0.55)
      drum(p, unit, 1, -0.64, 0.64, 0.55, 0.28, 0.18)
      drum(p, unit, 4, 0.73, 0.52, 0.22, 0.34, 0.39)
      drum(p, unit, 5, 0.3, 1, -0.14, 0.25, 0.24)
      drum(p, unit, 6, -0.26, 1.03, -0.13, 0.22, 0.22)
      cymbal(p, unit, 2, -0.92, 0.95, 0.1, 0.26); cymbal(p, unit, 3, -0.92, 0.88, 0.1, 0.26)
      cymbal(p, unit, 7, -0.84, 1.42, -0.6, 0.4); cymbal(p, unit, 8, 0.88, 1.26, -0.58, 0.42)
      c(p, 0, 0.44, -0.8, 0.23, 0.11, trim); c(p, 0, 0.22, -0.8, 0.026, 0.4, kit.metal)
    } else if (unit === 1 || unit === 7) {
      drum(p, unit, 9, -0.43, 0.46, -0.12, 0.26, 0.75, true)
      drum(p, unit, 10, 0.24, 0.65, -0.22, 0.2, 0.26, true)
      drum(p, unit, 12, 0.58, 0.32, 0.4, 0.26, 0.5, true)
      const cajon = b(p, -0.35, 0.26, 0.5, 0.35, 0.48, 0.32, wood)
      animate(cajon, unit, 11, 'head')
    } else if (unit === 2) {
      slots[`case_${unit}`] = skinSlot(p, `case_${unit}`, b(p, 0, 0.8, 0, 1.4, 0.14, 0.95, dark))
      for (let n = 0; n < 9; n++) animate(b(p, (n % 3 - 1) * 0.42, 0.89, (Math.floor(n / 3) - 1) * 0.28, 0.36, 0.04, 0.23, n % 2 ? trim : ivory), unit, n, 'key')
      for (const x of [-0.55, 0.55]) b(p, x, 0.4, 0, 0.04, 0.8, 0.6, kit.metal)
    } else if (unit === 3 || unit === 4 || unit === 5) {
      slots[`case_${unit}`] = skinSlot(p, `case_${unit}`, b(p, 0, 0.72, 0, 1.8, 0.18, 0.8, unit === 4 ? trim : wood))
      for (let n = 0; n < 16; n++) {
        const key = b(p, (n - 7.5) * 0.102, 0.835, unit === 5 ? (n % 2) * 0.06 : 0.12, 0.092, 0.035, unit === 5 ? 0.62 - n * 0.019 : 0.45, unit === 5 ? wood : skin, 0.008)
        animate(key, unit, n, 'key')
        if (unit !== 5 && ![2, 6].includes(n % 7)) b(p, (n - 7) * 0.102, 0.875, -0.02, 0.058, 0.04, 0.26, trim, 0.006)
      }
      if (unit === 3) { for (let k = 0; k < 6; k++) c(p, -0.65 + k * 0.17, 0.84, -0.29, 0.032, 0.045, brass); b(p, 0.55, 0.826, -0.28, 0.25, 0.015, 0.13, glow) }
      if (unit === 4) b(p, 0, 1.04, -0.26, 1.8, 0.56, 0.16, trim)
      for (const x of [-0.7, 0.7]) b(p, x, 0.35, 0, 0.055, 0.7, 0.5, kit.metal)
      if (unit === 5) for (let n = 0; n < 12; n++) c(p, (n - 5.5) * 0.125, 0.45, 0.04, 0.038, 0.4 - n * 0.016, brass)
    } else {
      // Air feedback lives on the instrument's base, with no floating orb or stalk.
      animate(c(p, 0, 0.12, 0, 0.52, 0.2, glow), unit, 0, 'air')
    }
  })
  kit.batch(root, moving.map(m => m.mesh))
  for (const part of moving) part.y = part.mesh.position.y
  const instances: { mesh: THREE.InstancedMesh; sources: THREE.Mesh[] }[] = []
  const byShape = new Map<string, THREE.Mesh[]>()
  for (const part of moving) if (part.kind === 'key') {
    const m = part.mesh as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    const key = `${m.geometry.uuid}:${m.material.uuid}`
    const list = byShape.get(key) ?? []; list.push(m); byShape.set(key, list)
  }
  for (const sources of byShape.values()) if (sources.length > 1) {
    const mesh = new THREE.InstancedMesh(sources[0].geometry, sources[0].material, sources.length)
    mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(mesh)
    sources.forEach(s => { s.visible = false }); instances.push({ mesh, sources })
  }
  const aimMaterial = new THREE.MeshBasicMaterial({ color: '#c6ff34', toneMapped: false, transparent: true, opacity: 0.68, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const highlights = moving.map(part => {
    const surface = (part.mesh as THREE.Mesh).isMesh ? part.mesh as THREE.Mesh : part.mesh.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh
    const mesh = new THREE.Mesh(surface.geometry, aimMaterial)
    mesh.name = 'aim-surface'; mesh.matrixAutoUpdate = false; mesh.visible = false; root.add(mesh)
    return { mesh, surface, unit: part.unit, n: part.n }
  })
  if (live) upgradeSkins('studio', slots, () => {
    for (const slot of Object.values(slots)) slot.userData.static = true
    kit.batch(root, [...moving.map(m => m.mesh), ...highlights.map(h => h.mesh)])
    live()
  })
  return { root, moving, glows, instances, highlights }
}

function paint(model: ReturnType<typeof room>, logic: StudioLogic, colors: readonly (string | null)[], t: number, reduced: boolean) {
  model.glows.forEach((m, n) => { m.emissive.set(colors[n] ?? '#b9ee6d'); m.emissiveIntensity = 0.18 + Math.max(...logic.hits[n]) * 2.5 })
  for (const a of model.moving) {
    const hit = a.kind === 'air' ? Math.max(...logic.hits[a.unit]) : logic.hits[a.unit][a.n]
    if (a.kind === 'cymbal') a.mesh.rotation.z = reduced ? 0 : Math.sin(t * 45) * hit * 0.16
    else if (a.kind === 'air') a.mesh.scale.set(1 + hit * (reduced ? 0 : 0.08), 1, 1 + hit * (reduced ? 0 : 0.08))
    else a.mesh.position.y = a.y - (reduced ? 0 : hit * (a.kind === 'head' ? 0.028 : 0.018))
  }
  model.root.updateMatrixWorld(true)
  for (const h of model.highlights) {
    h.mesh.visible = logic.aimed[h.unit].has(h.n)
    h.mesh.matrix.copy(h.surface.matrixWorld)
  }
  for (const group of model.instances) {
    group.sources.forEach((s, i) => group.mesh.setMatrixAt(i, s.matrixWorld))
    group.mesh.instanceMatrix.needsUpdate = true
  }
}

export function createView(stage: Stage, logic: StudioLogic): DeviceView {
  const model = room(() => stage.view.invalidate()); stage.scene.add(model.root)
  document.body.classList.add('studio')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  stage.lights.hemi.intensity = 1.1
  stage.controls.maxPolarAngle = Math.PI * 0.46
  const panel = document.querySelector('.dev-panel')!
  panel.querySelector('#home-all')!.textContent = 'Silence all'
  return {
    framing: { target: [-0.5, 0.65, -0.9], wide: [4.6, 5.4, 6.3], tall: [3.2, 5.7, 5.7], radius: 2.65 },
    overview: { target: [0, 0.55, 0], wide: [10, 10.5, 14], tall: [9, 12, 16], radius: 6.4 },
    inspect: () => ({ target: [-0.8, 0.55, -1.5], wide: [1.8, 2.8, 3.8], tall: [1.8, 3.8, 4.8], radius: 1.8 }),
    anchor: n => new THREE.Vector3(POS[n][0], 0.8, POS[n][1]),
    connect: sim => attachStudio(sim, logic, stage, n => [POS[n][0], 0.8, POS[n][1]]),
    update(colors, t) { paint(model, logic, colors, t, reduced.matches); if (logic.hits.some(h => h.some(v => v > 0.002))) stage.view.invalidate() },
  }
}

export function preview(): Preview {
  const model = room(), scene = previewScene(), logic = new StudioLogic()
  scene.add(model.root)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80); camera.position.set(10, 11, 14); camera.lookAt(0, 0, 0)
  return { scene, camera, step(t, dt) {
    logic.step([], dt)
    const unit = Math.floor(t * 2) % 8
    logic.hits[unit][Math.floor(t * 4) % 9] = 0.65 * Math.max(0, Math.sin(t * Math.PI * 4))
    paint(model, logic, Array(8).fill(null), t, false)
  } }
}

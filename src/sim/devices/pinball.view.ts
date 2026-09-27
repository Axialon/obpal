/** Two cabinet tables with exposed playfields, moving flippers and readable backbox scores. */
import * as THREE from 'three'
import { batch, floorMaterial, maker, metal, plastic, rubber } from '../kit'
import { PINBALL_BUMPERS, PinballLogic } from './pinball'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

const tableX = (n: number) => (n - 0.5) * 1.9
function group(parent: THREE.Object3D, name: string) { const g = new THREE.Group(); g.name = name; parent.add(g); return g }

function scoreboard(parent: THREE.Object3D) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 160
  const context = canvas.getContext('2d')!, texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.4), new THREE.MeshBasicMaterial({ map: texture }))
  screen.position.set(0, 1.43, -1.405); screen.name = 'score-display'; parent.add(screen)
  let before = ''
  return (score: number, number: number) => {
    const text = String(score).padStart(6, '0')
    if (before === text) return false
    before = text
    context.fillStyle = '#17201e'; context.fillRect(0, 0, 512, 160)
    context.fillStyle = '#c6ff34'; context.font = 'bold 80px monospace'; context.textAlign = 'center'; context.fillText(text, 256, 101)
    context.fillStyle = '#a2b4a6'; context.font = '21px monospace'; context.fillText(`TABLE ${number}   •   BUMPER / 100`, 256, 140)
    texture.needsUpdate = true
    return true
  }
}

function arcade(scene: THREE.Scene, logic: PinballLogic) {
  const floor = group(scene, 'arcade-floor')
  block(floor, [4.2, 0.09, 3.65], [0, -0.055, 0], floorMaterial('#45514e'))
  batch(floor)
  const tables = logic.units.map((_, n) => {
    const root = group(scene, `pinball-table-${n + 1}`); root.position.x = tableX(n)
    const cabinet = group(root, 'cabinet'), accent = plastic(n ? '#81bad4' : '#c6ff34')
    block(cabinet, [1.56, 0.37, 2.82], [0, 0.75, 0], plastic('#303b40'))
    for (const x of [-0.66, 0.66]) for (const z of [-1.16, 1.16]) {
      rod(cabinet, [x * 1.08, 0.07, z * 1.06], [x, 0.71, z], 0.045)
      disc(cabinet, 0.073, 0.035, [x * 1.08, 0.035, z * 1.06], rubber)
    }
    for (const side of [-1, 1]) {
      block(cabinet, [0.025, 0.075, 2.35], [side * 0.785, 0.79, 0], accent)
      const button = disc(cabinet, 0.055, 0.035, [side * 0.805, 0.81, 0.96], accent); button.rotation.z = Math.PI / 2
    }
    block(cabinet, [1.58, 0.66, 0.17], [0, 1.4, -1.52], plastic('#243136'))
    block(cabinet, [1.43, 0.49, 0.025], [0, 1.43, -1.425], rubber)
    block(cabinet, [0.26, 0.16, 0.035], [-0.19, 0.72, 1.425], rubber)
    maker(cabinet, 0.13, 0.89, 1.39, 0.085)
    batch(cabinet)
    const score = scoreboard(root)
    const playfield = group(root, 'playfield'); playfield.position.y = 0.96; playfield.rotation.x = 0.1
    const deck = group(playfield, 'deck-and-rails')
    block(deck, [1.43, 0.065, 2.65], [0, -0.035, 0], plastic('#42645b'))
    for (const x of [-0.73, 0.73]) block(deck, [0.065, 0.13, 2.72], [x, 0.04, 0], metal)
    block(deck, [1.46, 0.13, 0.055], [0, 0.04, -1.33], metal)
    for (const side of [-1, 1]) block(deck, [0.44, 0.1, 0.07], [side * 0.45, 0.02, 1.31], metal)
    rod(deck, [0.49, 0.035, -0.78], [0.49, 0.035, 1.3], 0.017)
    rod(deck, [-0.65, 0.04, 0.38], [-0.43, 0.04, 0.89], 0.023, rubber)
    rod(deck, [0.45, 0.04, 0.38], [0.43, 0.04, 0.89], 0.023, rubber)
    for (const side of [-1, 1]) {
      const arrow = block(deck, [0.035, 0.008, 0.43], [side * 0.22, 0.005, 0.34], accent)
      arrow.rotation.y = side * 0.3
      disc(deck, 0.055, 0.012, [side * 0.29, 0.01, 0.16], accent)
    }
    block(deck, [0.43, 0.012, 0.09], [0, 0, 1.22], rubber)
    batch(deck)
    const bumpers = PINBALL_BUMPERS.map((b, index) => {
      const bumper = group(playfield, `bumper-${index + 1}`)
      disc(bumper, b.r, 0.09, [b.x, 0.045, b.z], rubber)
      disc(bumper, b.r * 0.75, 0.11, [b.x, 0.09, b.z], metal)
      const glow = mats.glow(n ? '#81bad4' : '#c6ff34')
      disc(bumper, b.r * 0.92, 0.025, [b.x, 0.155, b.z], glow)
      batch(bumper)
      return glow
    })
    const flippers = [-1, 1].map((side) => {
      const pivot = group(playfield, side < 0 ? 'left-flipper' : 'right-flipper'); pivot.position.set(side * 0.43, 0.05, 0.91)
      block(pivot, [0.4, 0.07, 0.075], [-side * 0.17, 0, 0], plastic('#efe8cd'))
      block(pivot, [0.3, 0.074, 0.025], [-side * 0.17, 0, 0], accent)
      disc(pivot, 0.045, 0.085, [0, 0, 0], metal)
      batch(pivot)
      return pivot
    })
    const plunger = group(playfield, 'plunger')
    rod(plunger, [0.59, 0.03, 1.15], [0.59, 0.03, 1.59], 0.022)
    block(plunger, [0.11, 0.08, 0.05], [0.59, 0.03, 1.59], accent)
    batch(plunger)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), metal)
    ball.name = 'steel-ball'; ball.castShadow = true; playfield.add(ball)
    const holder = mats.glow(), band = block(root, [0.9, 0.028, 0.03], [0, 1.69, -1.418], holder)
    band.name = 'holder-light'
    return { root, score, ball, flippers, plunger, bumpers, holder }
  })
  return {
    step(colors: readonly (string | null)[] = []) {
      let changed = false
      tables.forEach((m, n) => {
        const u = logic.units[n]
        m.ball.position.set(u.x, 0.055, u.z)
        m.flippers[0].rotation.y = -(0.4 - u.left * 0.92)
        m.flippers[1].rotation.y = 0.4 - u.right * 0.92
        m.plunger.position.z = u.plunger * 0.14
        m.root.rotation.z = Math.sin(u.nudge * Math.PI * 4) * u.nudge * 0.012
        m.bumpers.forEach((b, index) => { b.emissiveIntensity = 0.7 + u.bumperCooldown[index] * 16 })
        wear(m.holder, colors[n] ?? null)
        changed = m.score(u.score, n + 1) || changed
      })
      return changed
    },
  }
}

export function createView(stage: Stage, logic: PinballLogic): DeviceView {
  const model = arcade(stage.scene, logic)
  return {
    framing: playFrame([tableX(0), 0.96, 0], 0.98, [0.55, 1.2, 1.3]),
    overview: playFrame([0, 0.85, 0], 2.05, [0.3, 1.1, 1.5]),
    inspect: () => playFrame([tableX(0), 0.99, 0.55], 0.64, [0.2, 1.4, 1.1]),
    anchor: (n) => new THREE.Vector3(tableX(n), 0.96, 0),
    follow: (n) => new THREE.Vector3(tableX(n), 0.96, 0),
    update: (colors) => { if (model.step(colors)) stage.view.invalidate() },
  }
}

export function preview() {
  const logic = new PinballLogic()
  return showcase((scene) => {
    const model = arcade(scene, logic)
    return { step(t) {
      logic.units.forEach((u, n) => {
        u.x = Math.sin(t * 1.8 + n) * 0.36; u.z = Math.cos(t * 1.3 + n) * 0.78
        u.left = Math.max(0, Math.sin(t * 3)); u.right = Math.max(0, Math.cos(t * 3)); u.score = 1200 + n * 500
      })
      model.step()
    } }
  }, [tableX(0), 1, 0], 0.92)
}

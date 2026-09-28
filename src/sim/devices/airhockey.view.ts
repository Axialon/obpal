import { contactPart, contactSurface } from '../contact'
/** A low camera above a full-size tabletop keeps both mallets, goals and the puck in view. */
import * as THREE from 'three'
import { ceramic, darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { batch, maker, metal, plastic, rubber } from '../kit'
import { AIRHOCKEY, AirhockeyLogic } from './airhockey'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function group(parent: THREE.Object3D, name: string) { const g = new THREE.Group(); g.name = name; parent.add(g); return g }
function table(scene: THREE.Scene, logic: AirhockeyLogic) {
  const M = AIRHOCKEY, root = group(scene, 'air-hockey-table'), base = group(root, 'cabinet')
  base.add(tiledDeck(3.1, 4.1, 0, 1))
  block(base, [2.22, 0.28, 3.43], [0, 0.76, 0], gunmetal)
  for (const x of [-0.84, 0.84]) for (const z of [-1.3, 1.3]) {
    rod(base, [x * 1.12, 0.07, z * 1.06], [x, 0.7, z], 0.07)
    contactPart(disc(base, 0.12, 0.04, [x * 1.12, 0.02, z * 1.06], rubber), `table-foot-${x}-${z}`)
  }
  for (const side of [-1, 1]) block(base, [0.035, 0.055, 2.9], [side * 1.12, 0.79, 0], darkTitanium)
  maker(base, 0.82, 0.905, 1.61, 0.09)
  for (const side of [-1, 1]) { const panel = service(1.8, .17); panel.rotation.y = side * Math.PI / 2; panel.position.set(side * 1.113, .75, 0); base.add(panel) }
  batch(base)
  const playfield = group(root, 'perforated-playfield')
  contactSurface(block(playfield, [2, 0.045, 3.2], [0, M.height - 0.0225, 0], ceramic), 'playfield')
  block(playfield, [1.99, 0.003, 0.02], [0, M.height + 0.003, 0], plastic('#7e98a2'))
  const lineMaterial = plastic('#7e98a2')
  const centre = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.29, 48), lineMaterial)
  centre.rotation.x = -Math.PI / 2; centre.position.y = M.height + 0.005; playfield.add(centre)
  // One instanced draw call for the table's small air holes.
  const holes = new THREE.InstancedMesh(new THREE.CircleGeometry(0.006, 6), plastic('#a6b7b8'), 19 * 29)
  holes.name = 'air-holes'
  const pose = new THREE.Object3D(); let index = 0
  for (let x = -9; x <= 9; x++) for (let z = -14; z <= 14; z++) {
    pose.position.set(x * 0.098, M.height + 0.005, z * 0.106); pose.rotation.x = -Math.PI / 2; pose.updateMatrix(); holes.setMatrixAt(index++, pose.matrix)
  }
  playfield.add(holes)
  for (const x of [-1.035, 1.035]) block(playfield, [0.07, 0.09, 3.35], [x, M.height + 0.025, 0], metal)
  for (const side of [-1, 1]) {
    const accent = plastic(side > 0 ? '#d18b6b' : '#75adc2'), goal = group(playfield, side > 0 ? 'near-goal' : 'far-goal')
    for (const x of [-0.66, 0.66]) block(goal, [0.7, 0.09, 0.08], [x, M.height + 0.025, side * 1.64], metal)
    block(goal, [M.goal, 0.12, 0.035], [0, M.height - 0.015, side * 1.75], rubber)
    block(goal, [M.goal + 0.08, 0.045, 0.045], [0, M.height + 0.09, side * 1.7], accent)
    block(goal, [1.92, 0.004, 0.022], [0, M.height + 0.004, side * 1.22], accent)
    batch(goal)
  }
  batch(playfield, [holes])
  const mallets = logic.units.map((_, n) => {
    const mallet = group(root, `mallet-${n + 1}`), paint = plastic(n ? '#75adc2' : '#d18b6b')
    disc(mallet, M.mallet, 0.055, [0, 0.04, 0], paint)
    disc(mallet, M.mallet * 0.89, 0.016, [0, 0.008, 0], rubber)
    disc(mallet, 0.052, 0.13, [0, 0.11, 0], paint)
    disc(mallet, 0.076, 0.035, [0, 0.19, 0], paint)
    const light = mats.glow()
    disc(mallet, 0.055, 0.009, [0, 0.211, 0], light)
    pov(mallet, [0, .3, 0], [0, -.15, n ? 1 : -1])
    contactPart(mallet, `mallet-${n + 1}`, { surface: 'playfield' }); batch(mallet)
    return { mallet, light }
  })
  const puck = group(root, 'puck')
  disc(puck, M.puck, 0.025, [0, 0.0125, 0], rubber)
  disc(puck, M.puck * 0.73, 0.004, [0, 0.032, 0], plastic('#c6ff34'))
  contactPart(puck, 'puck', { surface: 'playfield' }); batch(puck)
  const scores = logic.units.map((_, n) => {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
    const context = canvas.getContext('2d')!, texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const display = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.25), new THREE.MeshBasicMaterial({ map: texture }))
    display.name = `score-${n + 1}`; display.rotation.x = -Math.PI / 2; display.position.set(n ? -0.73 : 0.73, M.height + 0.005, n ? -1.42 : 1.42)
    root.add(display)
    let before = -1
    return (score: number) => {
      if (score === before) return false
      before = score
      context.fillStyle = '#29363b'; context.fillRect(0, 0, 256, 128)
      context.fillStyle = n ? '#86c0d6' : '#edaa87'; context.font = 'bold 94px monospace'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(score).padStart(2, '0'), 128, 70)
      texture.needsUpdate = true
      return true
    }
  })
  return {
    step(colors: readonly (string | null)[] = []) {
      let changed = false
      mallets.forEach((m, n) => {
        m.mallet.position.set(logic.units[n].x, M.height, logic.units[n].z)
        wear(m.light, colors[n] ?? null)
        changed = scores[n](logic.units[n].score) || changed
      })
      puck.position.set(logic.puck.x, M.height, logic.puck.z)
      return changed
    },
  }
}

export function createView(stage: Stage, logic: AirhockeyLogic): DeviceView {
  const model = table(stage.scene, logic)
  return {
    framing: playFrame([0, AIRHOCKEY.height, 0], 1.36, [0.45, 1.45, 1.3]),
    overview: playFrame([0, 0.7, 0], 2.1),
    inspect: () => playFrame([0, AIRHOCKEY.height, 0.7], 0.7, [0.4, 1.4, 1.2]),
    pickY: AIRHOCKEY.height,
    pointFrom: (n) => new THREE.Vector3(0, AIRHOCKEY.height, n === 0 ? 1.05 : -1.05),
    anchor: (n) => new THREE.Vector3(logic.units[n].x, AIRHOCKEY.height, logic.units[n].z),
    update: (colors) => { if (model.step(colors)) stage.view.invalidate() },
  }
}

export function preview() {
  const logic = new AirhockeyLogic()
  return showcase((scene) => {
    const model = table(scene, logic)
    return { step(t) {
      logic.units[0].x = Math.sin(t * 1.1) * 0.55; logic.units[1].x = Math.sin(t * 1.1 + 1.8) * 0.55
      logic.puck.x = Math.sin(t * 1.7) * 0.52; logic.puck.z = Math.cos(t * 1.3) * 0.82
      model.step()
    } }
  }, [0, AIRHOCKEY.height, 0], 1.28)
}

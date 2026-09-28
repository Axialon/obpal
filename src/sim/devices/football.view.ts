import { contactPart, contactSurface } from '../contact'
import * as THREE from 'three'
import { darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { batch, metal, plastic, rubber } from '../kit'
import { FOOTBALL, FootballLogic, RODS, footballMen } from './football'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function table(scene: THREE.Scene, logic: FootballLogic) {
  const root = new THREE.Group(); root.name = 'football-cabinet'; scene.add(root)
  root.add(tiledDeck(3.7, 4.2, -.01, 1))
  block(root, [2.24, 0.3, 3.62], [0, 0.82, 0], gunmetal)
  for (const x of [-0.85, 0.85]) for (const z of [-1.4, 1.4]) contactPart(rod(root, [x * 1.1, 0, z], [x, 0.8, z], 0.08, rubber), `table-leg-${x}-${z}`)
  contactSurface(block(root, [2, 0.04, 3.4], [0, 1, 0], plastic('#425b59')), 'pitch')
  for (const x of [-1.06, 1.06]) block(root, [0.12, 0.17, 3.62], [x, 1.08, 0], darkTitanium)
  for (const z of [-1.76, 1.76]) for (const x of [-0.69, 0.69]) block(root, [0.73, 0.17, 0.12], [x, 1.08, z], darkTitanium)
  for (const z of [-1.82, 1.82]) { block(root, [0.65, 0.17, 0.06], [0, 1.02, z], rubber); rod(root, [-0.36, 1.19, z], [0.36, 1.19, z], 0.028) }
  for (const side of [-1, 1]) { const panel = service(2.2, .17); panel.rotation.y = side * Math.PI / 2; panel.position.set(side * 1.123, .82, 0); root.add(panel) }
  for (let n = 0; n < 4; n++) pov(root, [n % 2 ? 1.65 : -1.65, 1.65, n < 2 ? -.8 : .8], [n % 2 ? -1 : 1, -.3, 0])
  const lines = new THREE.Group(); lines.name = 'pitch-markings'; root.add(lines)
  block(lines, [1.95, 0.002, 0.018], [0, 1.023, 0], plastic('#dce8c9'))
  for (const z of [-1.32, 1.32]) block(lines, [1.1, 0.002, 0.02], [0, 1.023, z], plastic('#dce8c9'))
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.315, 40), plastic('#dce8c9')); ring.rotation.x = -Math.PI / 2; ring.position.y = 1.024; lines.add(ring)
  batch(root)
  const rods = RODS.map((r, n) => {
    const g = new THREE.Group(); g.name = `rod-${n + 1}`; g.position.set(0, 1.24, r.z); scene.add(g)
    rod(g, [-1.6, 0, 0], [1.6, 0, 0], 0.021, metal)
    const side = r.seat % 2 ? 1 : -1
    rod(g, [side * 1.3, 0, 0], [side * 1.7, 0, 0], 0.063, rubber)
    const light = mats.glow(); rod(g, [side * 1.68, 0, 0], [side * 1.73, 0, 0], 0.066, light)
    const color = plastic(r.seat % 2 ? '#70adc7' : '#e3a660')
    for (const x of footballMen(r.count)) {
      block(g, [0.12, 0.15, 0.1], [x, -0.07, 0], color)
      // The swept corner stays above the pitch through a full turn, not just with the foot pointing down.
      contactPart(block(g, [0.14, 0.08, 0.09], [x, -0.175, 0], color), `player-${n}-${x}`, { surface: 'pitch', mode: 'clear' })
      rod(g, [x, 0, 0], [x, 0.06, 0], 0.025, color)
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), color); head.position.set(x, 0.105, 0); g.add(head)
    }
    batch(g); return { g, light }
  })
  const ball = new THREE.Mesh(new THREE.SphereGeometry(FOOTBALL.ball, 20, 12), plastic('#eee8cc')); ball.name = 'football'; ball.castShadow = true; scene.add(contactPart(ball, 'football', { surface: 'pitch' }))
  const score = [0, 1].map(n => {
    const g = new THREE.Group(); g.name = `score-beads-${n + 1}`; scene.add(g)
    rod(g, [-0.5, 1.35, n ? -1.88 : 1.88], [0.5, 1.35, n ? -1.88 : 1.88], 0.014)
    return Array.from({ length: 10 }, (_, j) => { const bead = disc(g, 0.04, 0.045, [j * 0.075 - 0.35, 1.35, n ? -1.88 : 1.88], plastic(n ? '#70adc7' : '#e3a660')); bead.rotation.z = Math.PI / 2; return bead })
  })
  return { step(colors: readonly (string | null)[] = []) {
    rods.forEach((m, n) => { m.g.position.x = logic.rods[n].x; m.g.rotation.x = logic.rods[n].angle; wear(m.light, colors[RODS[n].seat] ?? null) })
    ball.position.set(logic.ball.x, FOOTBALL.height + FOOTBALL.ball, logic.ball.z)
    score.forEach((beads, n) => beads.forEach((b, j) => { b.position.x = -0.43 + j * 0.06 + (j < logic.scores[n] % 11 ? 0.25 : 0) }))
  } }
}
export function createView(stage: Stage, logic: FootballLogic): DeviceView {
  const model = table(stage.scene, logic)
  return { framing: playFrame([0, 1, 0], 1.85, [0.35, 1.2, 1.15]), overview: playFrame([0, 0.8, 0], 2.4), inspect: () => playFrame([0, 1.15, 0.4], 0.65), update: colors => model.step(colors) }
}
export function preview() {
  const logic = new FootballLogic()
  return showcase(scene => { const m = table(scene, logic); return { step(t) { logic.rods.forEach((r, j) => { r.x = Math.sin(t + j) * 0.2; r.angle = Math.sin(t * 2 + j) * 1.3 }); logic.ball.x = Math.sin(t) * 0.55; logic.ball.z = Math.cos(t * 1.4) * 0.5; m.step() } } }, [0, 1, 0], 1.4)
}

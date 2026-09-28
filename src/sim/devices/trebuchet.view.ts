import { contactPart, contactSurface } from '../contact'
import * as THREE from 'three'
import { darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { batch, metal, plastic, rubber } from '../kit'
import { RANGE_TARGETS, TrebuchetLogic } from './trebuchet'
import { block, disc, playFrame, rod, showcase } from './parts'
import { caption, part } from './optics.view'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function range(scene: THREE.Scene, logic: TrebuchetLogic, count = 2) {
  const floor = part(scene, 'launch-range'); const deck = tiledDeck(12, 44, 0, 3); deck.position.set(2.4, 0, -18); floor.add(deck)
  for (const x of [-2, 2, 3, 7]) block(floor, [0.04, 0.012, 35], [x, 0.003, -14], plastic('#bac3a5'))
  batch(floor)
  const models = logic.units.slice(0, count).map((_, n) => {
    const root = part(scene, `trebuchet-${n + 1}`); root.position.x = n * 5
    const timber = gunmetal, trim = darkTitanium
    for (const x of [-0.65, 0.65]) {
      block(root, [0.16, 0.18, 2.6], [x, 0.22, 0], timber)
      rod(root, [x, 0.25, -0.95], [x, 1.85, 0], 0.065, timber); rod(root, [x, 0.25, 0.95], [x, 1.85, 0], 0.065, timber)
      for (const z of [-0.85, 0.85]) { const wheel = disc(root, 0.19, 0.13, [x * 1.13, 0.19, z], trim); wheel.rotation.z = Math.PI / 2; contactPart(wheel, `wheel-${x}-${z}`) }
    }
    rod(root, [-0.8, 1.85, 0], [0.8, 1.85, 0], 0.07, metal)
    for (const z of [-0.9, 0.9]) block(root, [1.4, 0.12, 0.12], [0, 0.25, z], timber)
    const light = mats.glow(); block(root, [0.22, 0.025, 0.1], [0, 0.33, 0.9], light); batch(root)
    const arm = part(root, 'throwing-arm'); arm.position.y = 1.85
    pov(root, [0, 2.03, .32], [0, -.15, -1])
    rod(arm, [0, 0, 0.65], [0, 0, -1.65], 0.065, timber)
    const weight = part(arm, 'counterweight'); weight.position.z = 0.65
    rod(weight, [0, 0, 0], [0, -0.3, 0], 0.025); block(weight, [0.62, 0.55, 0.5], [0, -0.52, 0], trim); const panel = service(.42, .3); panel.position.set(0, -.52, .253); weight.add(panel); batch(weight)
    const sling = part(arm, 'sling'); rod(sling, [0, 0, -1.6], [0, -0.38, -2.12], 0.018, rubber)
    const cup = part(sling, 'sling-cup'); cup.position.set(0, -.4, -2.12)
    contactSurface(disc(cup, .13, .06, [0, 0, 0], rubber), `sling-${n}`)
    const waiting = new THREE.Mesh(new THREE.SphereGeometry(.12, 18, 12), plastic('#d5d8be'))
    waiting.position.y = .15; waiting.castShadow = true; cup.add(contactPart(waiting, `waiting-load-${n}`, { surface: `sling-${n}`, active: () => waiting.visible }))
    batch(sling, [cup])
    const projectile = new THREE.Mesh(new THREE.SphereGeometry(0.12, 18, 12), plastic('#d5d8be')); projectile.name = 'projectile'; scene.add(contactPart(projectile, `load-${n + 1}`, { active: () => projectile.visible, mode: () => logic.units[n].phase === 'flight' ? 'clear' : 'touch' }))
    projectile.castShadow = true
    const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(240 * 3), 3)); lineGeo.setDrawRange(0, 0)
    const arc = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: n ? '#90bfdb' : '#eac28b' })); arc.name = 'flight-arc'; arc.frustumCulled = false; scene.add(arc)
    const targets = RANGE_TARGETS.map((d, j) => {
      const g = part(scene, `target-${n + 1}-${j + 1}`); g.position.set(n * 5, 0.03, -d)
      for (let k = 0; k < 3; k++) { const target = disc(g, 1.2 - k * 0.35, 0.012, [0, 0.012 * k, 0], plastic(k % 2 ? '#e4dac4' : '#ad694c')); target.castShadow = false }
      const label = caption(`${d} m · ${(j + 1) * 10}`, '#dce4c6', 1.5); label.position.set(0, 0.55, -0.9); g.add(label); batch(g)
      return g
    })
    return { arm, weight, sling, cup, waiting, projectile, arc, targets, light }
  })
  return { step(colors: readonly (string | null)[] = []) {
    models.forEach((m, n) => {
      const u = logic.units[n]; m.arm.rotation.x = u.arm; m.weight.rotation.x = -u.arm; m.weight.scale.setScalar(0.7 + u.weight / 100); wear(m.light, colors[n] ?? null)
      m.cup.rotation.x = -u.arm; m.waiting.visible = u.phase !== 'flight' && !u.arc.length
      m.sling.visible = u.phase !== 'flight'; m.projectile.visible = u.phase === 'flight' || u.arc.length > 0; m.projectile.position.set(n * 5, u.y, u.z)
      const points = m.arc.geometry.attributes.position as THREE.BufferAttribute
      u.arc.forEach(([z, y], j) => points.setXYZ(j, n * 5, y, z)); points.needsUpdate = true; m.arc.geometry.setDrawRange(0, u.arc.length)
      m.targets.forEach((g, j) => { g.scale.y = u.hits.includes(j) ? 1.2 : 1 })
    })
  } }
}
export function createView(stage: Stage, logic: TrebuchetLogic): DeviceView {
  const m = range(stage.scene, logic)
  return { framing: playFrame([0, 1, -1.6], 2.65, [1.1, 0.9, 1.4]), overview: playFrame([2.5, 0, -11], 14, [0.5, 1.1, 1.1]), inspect: () => playFrame([0, 1.6, 0], 0.95), update: colors => m.step(colors) }
}
export function preview() {
  const l = new TrebuchetLogic()
  return showcase(scene => { const m = range(scene, l, 1); return { step(t) { l.units[0].arm = Math.sin(t * 0.9) * 0.7; m.step() } } }, [0, 1, -0.3], 1.8)
}

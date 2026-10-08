import { contactPart, contactSurface } from '../contact'
import * as THREE from 'three'
import { darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { batch, metal, plastic, rubber } from '../kit'
import { RANGE_TARGETS, TrebuchetLogic } from './trebuchet'
import { AXLE_HEIGHT, LOAD_HEIGHT, LOAD_RADIUS, READY_ARM, releaseArm, SLING_Y, SLING_Z } from './trebuchet.geometry'
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
      rod(root, [x, 0.25, -0.95], [x, AXLE_HEIGHT, 0], 0.09, timber); rod(root, [x, 0.25, 0.95], [x, AXLE_HEIGHT, 0], 0.09, timber)
      block(root, [.22, .26, .24], [x, AXLE_HEIGHT, 0], trim)
      rod(root, [x, .65, -.7], [x, .65, .7], .055, timber)
      for (const z of [-0.85, 0.85]) { const wheel = disc(root, 0.19, 0.13, [x * 1.13, 0.19, z], trim); wheel.rotation.z = Math.PI / 2; contactPart(wheel, `wheel-${x}-${z}`) }
    }
    rod(root, [-0.8, AXLE_HEIGHT, 0], [0.8, AXLE_HEIGHT, 0], 0.09, metal)
    for (const z of [-0.9, 0.9]) block(root, [1.4, 0.12, 0.12], [0, 0.25, z], timber)
    const light = mats.glow(); block(root, [0.22, 0.025, 0.1], [0, 0.33, 0.9], light); batch(root)
    const direction = caption('TARGETS · −Z', '#dce4c6', 1.1); direction.position.set(.85, .45, -.85); root.add(direction)
    const arm = part(root, 'throwing-arm'); arm.position.y = AXLE_HEIGHT
    pov(root, [0, 2.03, .32], [0, -.15, -1])
    rod(arm, [0, 0, -.65], [0, 0, 1.65], .09, timber)
    for (const z of [-.65, 1.6]) rod(arm, [-.18, 0, z], [.18, 0, z], .045, metal)
    const weight = part(arm, 'counterweight'); weight.position.z = -.65
    for (const x of [-.2, .2]) rod(weight, [x, 0, 0], [x, -.3, 0], .035, metal)
    const ballast = part(weight, 'ballast'); block(ballast, [.62, .55, .5], [0, 0, 0], trim)
    const panel = service(.42, .3); panel.position.set(0, 0, .253); ballast.add(panel); batch(ballast); batch(weight, [ballast])
    const sling = part(arm, 'sling')
    for (const x of [-.11, .11]) rod(sling, [x, 0, 1.6], [x, SLING_Y, SLING_Z], .018, rubber)
    const cup = part(sling, 'sling-cup'); cup.position.set(0, SLING_Y, SLING_Z)
    contactSurface(disc(cup, .13, .06, [0, 0, 0], rubber), `sling-${n}`)
    const waiting = new THREE.Mesh(new THREE.SphereGeometry(LOAD_RADIUS, 18, 12), plastic('#d5d8be')); waiting.name = 'practice-load'
    waiting.position.y = LOAD_HEIGHT; waiting.castShadow = true; cup.add(contactPart(waiting, `waiting-load-${n}`, { surface: `sling-${n}`, active: () => waiting.visible }))
    batch(sling, [cup])
    const projectile = new THREE.Mesh(new THREE.SphereGeometry(LOAD_RADIUS, 18, 12), plastic('#d5d8be')); projectile.name = `projectile-${n + 1}`; scene.add(contactPart(projectile, `load-${n + 1}`, { active: () => projectile.visible, mode: () => logic.units[n].phase === 'flight' ? 'clear' : 'touch' }))
    projectile.castShadow = true
    const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(240 * 3), 3)); lineGeo.setDrawRange(0, 0)
    const arc = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: n ? '#90bfdb' : '#eac28b' })); arc.name = 'flight-arc'; arc.frustumCulled = false; scene.add(arc)
    const targets = RANGE_TARGETS.map((d, j) => {
      const g = part(scene, `target-${n + 1}-${j + 1}`); g.position.set(n * 5, 0.03, -d)
      for (let k = 0; k < 3; k++) { const target = disc(g, 1.2 - k * 0.35, 0.012, [0, 0.012 * k, 0], plastic(k % 2 ? '#e4dac4' : '#ad694c')); target.castShadow = false }
      for (const x of [-1.1, 1.1]) { block(g, [.12, .45, .12], [x, .225, -.9], rubber); block(g, [.16, .04, .16], [x, .47, -.9], plastic('#e4dac4')) }
      const label = caption(`${d} m · ${(j + 1) * 10}`, '#dce4c6', 1.5); label.position.set(0, 0.55, -0.9); g.add(label); batch(g)
      return g
    })
    return { arm, weight, ballast, sling, cup, waiting, projectile, arc, targets, light }
  })
  return { step(colors: readonly (string | null)[] = []) {
    models.forEach((m, n) => {
      const u = logic.units[n]; m.arm.rotation.x = u.arm; m.weight.rotation.x = -u.arm
      const scale = .7 + u.weight / 100; m.ballast.scale.setScalar(scale); m.ballast.position.y = -.3 - .275 * scale; wear(m.light, colors[n] ?? null)
      m.cup.rotation.x = -u.arm; m.waiting.visible = u.phase !== 'flight' && !u.arc.length
      m.projectile.visible = u.phase === 'flight' || u.arc.length > 0; m.projectile.position.set(n * 5, u.y, u.z)
      const points = m.arc.geometry.attributes.position as THREE.BufferAttribute
      u.arc.forEach(([z, y], j) => points.setXYZ(j, n * 5, y, z)); points.needsUpdate = true; m.arc.geometry.setDrawRange(0, u.arc.length)
      m.targets.forEach((g, j) => { g.scale.y = u.hits.includes(j) ? 1.2 : 1 })
    })
  } }
}
export function createView(stage: Stage, logic: TrebuchetLogic): DeviceView {
  const m = range(stage.scene, logic)
  return { framing: playFrame([0, 1.6, .2], 3.2, [1.1, .9, 1.4]), overview: playFrame([2.5, 0, -11], 14, [.5, 1.1, 1.1]), inspect: () => playFrame([0, 1.6, 0], .95), update: colors => m.step(colors) }
}
export function preview() {
  const l = new TrebuchetLogic()
  return showcase(scene => { const m = range(scene, l, 1); return { step(t) { l.units[0].arm = READY_ARM + (Math.sin(t * .9) + 1) / 2 * (releaseArm(45) - READY_ARM); m.step() } } }, [0, 1.6, .2], 2.3)
}

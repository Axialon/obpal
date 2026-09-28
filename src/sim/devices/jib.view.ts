import { contactPart } from '../contact'
import * as THREE from 'three'
import { batch, metal, plastic, rubber } from '../kit'
import { JibLogic, jibTip } from './jib'
import { block, disc, playFrame, rod, showcase } from './parts'
import { filmCamera, filmSet } from './filming.view'
import { monitor, part } from './optics.view'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function cranes(scene: THREE.Scene, logic: JibLogic, count = 2, live?: () => void) {
  const set = filmSet(scene)
  const models = logic.units.slice(0, count).map((_, n) => {
    const root = part(scene, `jib-crane-${n + 1}`); root.position.set(n ? 2.2 : -2.2, 0, 1)
    for (let j = 0; j < 3; j++) {
      const a = j * Math.PI * 2 / 3, x = Math.sin(a) * 0.8, z = Math.cos(a) * 0.8
      rod(root, [0, 0.95, 0], [x, 0.1, z], 0.055); contactPart(disc(root, 0.13, 0.1, [x, 0.05, z], rubber), `foot-${j}`)
      rod(root, [0, 0.36, 0], [x * 0.7, 0.36, z * 0.7], 0.025)
    }
    rod(root, [0, 0.2, 0], [0, 1.5, 0], 0.1); batch(root)
    const swing = part(root, 'jib-swing'); swing.position.y = 1.5
    disc(swing, 0.21, 0.16, [0, -0.06, 0], plastic('#788b95'))
    const boom = part(swing, 'jib-boom')
    for (const x of [-0.12, 0.12]) {
      rod(boom, [x, 0, 1.2], [x, 0, -2.5], 0.047, plastic('#647984'))
      rod(boom, [x, 0.22, 0.7], [x, 0.22, -2.5], 0.02, metal)
      for (const z of [-2.45, -1.3, 0, 0.7]) rod(boom, [x, 0, z], [x, 0.22, z], 0.018)
    }
    for (let j = 0; j < 4; j++) block(boom, [0.65, 0.12, 0.55], [0, -0.03 - j * 0.13, 1], rubber)
    rod(boom, [-0.4, 0, 1.3], [0.4, 0, 1.3], 0.035, rubber)
    const light = mats.glow(); block(boom, [0.18, 0.018, 0.12], [0, 0.25, 0.5], light); batch(boom)
    const head = part(root, 'levelled-camera-platform'), camera = filmCamera(head, live)
    block(head, [0.5, 0.06, 0.45], [0, -0.09, 0], metal)
    return { root, swing, boom, camera, head, light }
  })
  return { models, step(t: number, colors: readonly (string | null)[] = []) {
    set.step(t)
    models.forEach((m, n) => {
      const u = logic.units[n], tip = jibTip(u.swing, u.boom)
      m.swing.rotation.y = u.swing; m.boom.rotation.x = u.boom
      m.head.position.set(tip.x, tip.y, tip.z); m.camera.pan.rotation.y = u.swing + u.pan + (n ? 0.825 : -0.825); m.camera.tilt.rotation.x = u.tilt
      wear(m.light, colors[n] ?? null)
    })
  } }
}
export function createView(stage: Stage, logic: JibLogic): DeviceView {
  const m = cranes(stage.scene, logic, 2, () => stage.view.invalidate()); let viewed = 0
  return { framing: playFrame([-2.2, 1.5, -0.3], 2.5, [0.9, 0.65, 1.15]), overview: playFrame([0, 1.2, -1.5], 5.4), inspect: () => { const p = jibTip(logic.units[viewed].swing, logic.units[viewed].boom); return playFrame([p.x + (viewed ? 2.2 : -2.2), p.y + 0.2, p.z + 1], 0.65) }, follow: n => { viewed = n; return new THREE.Vector3(n ? 2.2 : -2.2, 1.5, -0.3) }, update: (colors, t) => m.step(t, colors), afterRender: monitor(stage, stage.scene, () => m.models[viewed].camera.eye, () => logic.units[viewed].recording ? `● REC ${logic.units[viewed].time.toFixed(1)} s` : `Jib ${viewed + 1} · camera`, m.models.map(m => m.root)) }
}
export function preview() {
  const l = new JibLogic()
  return showcase(scene => { const m = cranes(scene, l, 1); return { step(t) { l.units[0].swing = Math.sin(t * 0.5) * 0.3; l.units[0].boom = 0.3 + Math.sin(t * 0.35) * 0.15; m.step(t) } } }, [-2.2, 1.5, -0.3], 2.15)
}

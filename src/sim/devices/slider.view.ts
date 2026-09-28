import * as THREE from 'three'
import { batch, metal, plastic, rubber } from '../kit'
import { SliderLogic } from './slider'
import { block, disc, playFrame, rod, showcase } from './parts'
import { filmCamera, filmSet } from './filming.view'
import { monitor, part } from './optics.view'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function sliders(scene: THREE.Scene, logic: SliderLogic, count = 2, live?: () => void) {
  const set = filmSet(scene, count === 1 ? 10 : 15, count === 1 ? 0 : 2.5)
  const models = logic.units.slice(0, count).map((_, n) => {
    const root = part(scene, `camera-slider-${n + 1}`); root.position.x = n * 5
    for (const x of [-1.9, 1.9]) {
      block(root, [0.25, 0.16, 0.65], [x, 0.7, 0], plastic('#465563'))
      for (const z of [-0.3, 0.3]) rod(root, [x, 0.72, z * 0.5], [x * 1.04, 0.04, z * 1.5], 0.04)
    }
    for (const z of [-0.2, 0.2]) rod(root, [-1.9, 0.78, z], [1.9, 0.78, z], 0.036, metal)
    rod(root, [-1.9, 0.76, 0], [1.9, 0.76, 0], 0.012, rubber)
    block(root, [0.2, 0.19, 0.25], [-1.98, 0.83, 0], plastic('#465563')); batch(root)
    const carriage = part(root, 'motor-carriage'); carriage.position.y = 0.85
    block(carriage, [0.52, 0.12, 0.6], [0, 0, 0], plastic('#a2b2b8'))
    for (const x of [-0.19, 0.19]) for (const z of [-0.2, 0.2]) disc(carriage, 0.045, 0.025, [x, -0.07, z], rubber)
    const light = mats.glow(); block(carriage, [0.14, 0.015, 0.08], [0, 0.068, 0.22], light); batch(carriage)
    const camera = filmCamera(carriage, live); camera.pan.position.y = 0.12
    const keys = Array.from({ length: 6 }, (_, j) => { const g = part(root, `keyframe-${j + 1}`); const bead = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), plastic('#dfb875')); g.add(bead); return g })
    return { root, carriage, camera, light, keys }
  })
  return { models, step(t: number, colors: readonly (string | null)[] = []) {
    set.step(t)
    models.forEach((m, n) => { const u = logic.units[n]; m.carriage.position.x = u.x; m.camera.pan.rotation.y = u.pan + Math.atan2(n * 5, 3.5); m.camera.tilt.rotation.x = u.tilt; wear(m.light, colors[n] ?? null); m.keys.forEach((g, j) => { g.visible = j < u.keys.length; g.position.set(u.keys[j]?.x ?? 0, 0.84, 0.38 + j * 0.06) }) })
  } }
}
export function createView(stage: Stage, logic: SliderLogic): DeviceView {
  const m = sliders(stage.scene, logic, 2, () => stage.view.invalidate()); let viewed = 0
  return { framing: playFrame([0, 1.1, 0], 2.25, [0.65, 0.65, 1.25]), overview: playFrame([2.5, 1, -1], 6.2), inspect: () => playFrame([logic.units[viewed].x + viewed * 5, 1.15, 0], 0.6), follow: n => { viewed = n; return new THREE.Vector3(n * 5, 1.1, 0) }, update: (colors, t) => m.step(t, colors), afterRender: monitor(stage, stage.scene, () => m.models[viewed].camera.eye, () => logic.units[viewed].playing ? '● PLAYBACK' : `Slider ${viewed + 1} · camera`, m.models.map(m => m.root)) }
}
export function preview() {
  const l = new SliderLogic()
  return showcase(scene => { const m = sliders(scene, l, 1); return { step(t) { l.units[0].x = Math.sin(t * 0.5) * 1.5; l.units[0].pan = Math.atan(l.units[0].x / 3.5); m.step(t) } } }, [0, 1.05, 0], 1.6)
}

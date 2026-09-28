import { contactPart } from '../contact'
import * as THREE from 'three'
import { batch, metal, plastic, rubber } from '../kit'
import { SKY_OBJECTS, TelescopeLogic } from './telescope'
import { block, disc, playFrame, rod, showcase } from './parts'
import { caption, monitor, part } from './optics.view'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'
import { darkTitanium, gunmetal, optic } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'

function sky() {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#080f21')
  const points = new Float32Array(2400)
  for (let n = 0; n < 800; n++) {
    const az = Math.sin(n * 127.1) * Math.PI, el = 0.08 + Math.abs(Math.cos(n * 311.7)) * 1.4
    points.set([-Math.sin(az) * Math.cos(el) * 28, Math.sin(el) * 28, -Math.cos(az) * Math.cos(el) * 28], n * 3)
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(points, 3))
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#d6dff0', size: 0.045 })); stars.name = 'star-field'; scene.add(stars)
  SKY_OBJECTS.forEach((s, n) => {
    const g = part(scene, s.name); g.position.set(-Math.sin(s.pan) * Math.cos(s.elevation) * 25, Math.sin(s.elevation) * 25, -Math.cos(s.pan) * Math.cos(s.elevation) * 25)
    const orb = new THREE.Mesh(new THREE.SphereGeometry(n === 0 ? 0.42 : 0.22, 24, 16), new THREE.MeshBasicMaterial({ color: s.color })); g.add(orb)
    if (n === 1) { const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.52, 32), new THREE.MeshBasicMaterial({ color: '#b9a386', side: THREE.DoubleSide })); ring.rotation.x = 0.8; g.add(ring) }
    if (n === 2) { const cloud = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 12), new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.3 })); cloud.scale.set(1.6, 0.7, 1); g.add(cloud) }
    const label = caption(s.name, s.color, 4.2); label.position.y = 0.95; g.add(label)
  })
  return scene
}
function observatory(scene: THREE.Scene, logic: TelescopeLogic, count = 2) {
  const floor = part(scene, 'observatory-platform'); const deck = tiledDeck(9, 9, 0, 1.5); deck.position.x = 1.4; floor.add(deck)
  for (const x of [-2.5, 5.3]) { rod(floor, [x, 0, -2], [x, 1.3, -2], 0.06); block(floor, [0.13, 0.03, 0.13], [x, 1.35, -2], plastic('#bac687')) }
  batch(floor)
  const models = logic.units.slice(0, count).map((_, n) => {
    const base = part(scene, `telescope-${n + 1}`); base.position.x = n * 3
    for (let j = 0; j < 3; j++) { const a = j * Math.PI * 2 / 3; rod(base, [0, 0.9, 0], [Math.sin(a) * 0.65, 0.04, Math.cos(a) * 0.65], 0.055); contactPart(disc(base, 0.09, 0.05, [Math.sin(a) * 0.65, 0.025, Math.cos(a) * 0.65], rubber), `foot-${j}`) }
    rod(base, [0, 0.8, 0], [0, 1.15, 0], 0.1); batch(base)
    const pan = part(base, 'azimuth-mount'); pan.position.y = 1.2
    disc(pan, 0.2, 0.12, [0, 0, 0], gunmetal); block(pan, [0.12, 0.6, 0.16], [0.32, 0.28, 0], darkTitanium)
    rod(pan, [0, 0.5, 0], [0.38, 0.5, 0], 0.045, metal)
    const light = mats.glow(); disc(pan, 0.08, 0.03, [0.32, 0.6, 0], light); batch(pan)
    const elevation = part(pan, 'elevation-tube'); elevation.position.y = 0.5
    const tube = disc(elevation, 0.23, 1.25, [0, 0, -0.1], darkTitanium); tube.rotation.x = Math.PI / 2
    const cover = service(.24, .72); cover.rotation.x = -Math.PI/2; cover.position.set(0, .233, -.1); elevation.add(cover)
    pov(elevation, [0, 0, -.79])
    for (const z of [-0.72, 0.48]) { const collar = disc(elevation, 0.24, 0.1, [0, 0, z], rubber); collar.rotation.x = Math.PI / 2 }
    const lens = disc(elevation, 0.2, 0.015, [0, 0, -0.777], optic); lens.rotation.x = Math.PI / 2
    rod(elevation, [0.08, 0.2, 0], [0.08, 0.2, -0.45], 0.035); batch(elevation)
    return { pan, elevation, light }
  })
  return { models, step(colors: readonly (string | null)[] = []) { models.forEach((m, n) => { const u = logic.units[n]; m.pan.rotation.y = u.pan; m.elevation.rotation.x = u.elevation; wear(m.light, colors[n] ?? null) }) } }
}
export function createView(stage: Stage, logic: TelescopeLogic): DeviceView {
  const model = observatory(stage.scene, logic), stars = sky(), eye = new THREE.PerspectiveCamera(48, 1.6, 0.01, 60)
  const distant = stars.clone(); distant.name = 'named-sky'; stage.scene.add(distant)
  let viewed = 0
  return { framing: playFrame([0, 1.3, 0], 1.2, [1.1, 0.45, 1.5]), overview: playFrame([1.4, 2.2, -4], 5.5), inspect: () => playFrame([viewed * 3, 1.65, 0], 0.65), follow: n => { viewed = n; return new THREE.Vector3(n * 3, 1.3, 0) }, update: colors => { model.step(colors); const u = logic.units[viewed]; eye.rotation.set(u.elevation, u.pan, 0, 'YXZ'); eye.fov = 48 / u.zoom }, afterRender: monitor(stage, stars, () => eye, () => `Eyepiece ${viewed + 1} · ${logic.units[viewed].zoom.toFixed(1)}×`, [], true),
    // The pan rings the mount's turntable, the elevation the tube's trunnion, the zoom its eyepiece end.
    partAt: (n, part) => {
      const t = model.models[n]
      if (!t) return null
      return part === 'pan' ? { object: t.pan, axis: 'y', radius: 0.3 } : part === 'elevation' ? { object: t.elevation, axis: 'x', radius: 0.34 }
        : part === 'zoom' ? { object: t.elevation, axis: 'z', radius: 0.3, at: [0, 0, 0.5] } : null
    } }
}
export function preview() {
  const l = new TelescopeLogic()
  return showcase(scene => { const m = observatory(scene, l, 1); return { step(t) { l.units[0].pan = Math.sin(t * 0.5) * 0.5; m.step() } } }, [0, 1.3, 0], 1)
}

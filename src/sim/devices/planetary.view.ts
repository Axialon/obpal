import * as THREE from 'three'
import { batch, floorMaterial, metal, plastic } from '../kit'
import { PlanetaryLogic, terrain } from './planetary'
import { block, disc, playFrame, rod, showcase, wheel } from './parts'
import { caption, monitor, part } from './optics.view'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'
import { ceramic, darkTitanium, gunmetal } from '../kit/surfaces'
import { pov } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'

function expedition(scene: THREE.Scene, logic: PlanetaryLogic, count = 2, live?: () => void) {
  const ground = part(scene, 'crater-terrain')
  const geo = new THREE.PlaneGeometry(18, 18, 70, 70); geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrain(pos.getX(i), pos.getZ(i)))
  geo.computeVertexNormals()
  const soilMaterial = floorMaterial('#80786b'); soilMaterial.metalness = .12; soilMaterial.roughness = .7
  const soil = new THREE.Mesh(geo, soilMaterial); soil.receiveShadow = true; ground.add(soil)
  for (let j = 0; j < 26; j++) {
    const x = Math.sin(j * 42.7) * 7.8, z = Math.cos(j * 27.3) * 7.8
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.14 + (j % 3) * 0.09), plastic('#807467')); rock.position.set(x, terrain(x, z) + 0.08, z); rock.scale.y = 0.65; ground.add(rock)
  }
  batch(ground)
  const rocks = logic.rocks.map((r, j) => {
    const g = part(scene, `sample-rock-${j + 1}`); g.position.set(r.x, r.y, r.z)
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2), plastic('#cbbba0')); rock.position.y = 0.12; g.add(rock)
    const tag = caption(r.name, '#dfe8bd', 0.65); tag.position.y = 0.5; g.add(tag)
    return g
  })
  const rovers = logic.units.slice(0, count).map((_, n) => {
    const root = part(scene, `planetary-explorer-${n + 1}`)
    const skin = skinSlot(root, 'chassisSkin', block(root, [0.95, 0.28, 1.2], [0, 0.57, 0], gunmetal))
    block(root, [1.28, 0.04, 0.7], [0, 0.74, 0.28], plastic('#354c64'))
    for (const x of [-0.5, 0, 0.5]) block(root, [0.012, 0.008, 0.66], [x, 0.768, 0.28], metal)
    for (const x of [-0.63, 0.63]) for (const z of [-0.48, 0, 0.48]) { rod(root, [0, 0.53, z], [x, 0.28, z], 0.036); wheel(root, x, 0.24, z, 0.23).userData.static = true }
    const light = mats.glow(); block(root, [0.36, 0.035, 0.03], [0, 0.72, -0.59], light)
    rod(root, [0, 0.7, -0.14], [0, 1.35, -0.14], 0.045)
    batch(root)
    const mast = part(root, 'mast-pan-tilt'); mast.position.set(0, 1.4, -0.14)
    const mastSkin = skinSlot(mast, 'mastSkin', block(mast, [0.38, 0.18, 0.23], [0, 0, 0], darkTitanium))
    pov(mast, [0, 0, -.2])
    for (const x of [-0.12, 0.12]) { const lens = disc(mast, 0.065, 0.06, [x, 0, -0.14], plastic('#293f4b')); lens.rotation.x = Math.PI / 2 }
    const eye = new THREE.PerspectiveCamera(58, 1.6, 0.04, 60); eye.position.z = -0.2; mast.add(eye); batch(mast)
    const swing = part(root, 'sampler-swing'); swing.position.y = 0.62
    rod(swing, [0, 0, 0], [0, 0, -0.55], 0.065)
    const boom = part(swing, 'sampler-boom'); boom.position.z = -0.55
    rod(boom, [0, 0, 0], [0, 0, -0.7], 0.055, ceramic)
    const tool = part(boom, 'sampling-tool'); tool.position.z = -0.7
    disc(tool, 0.11, 0.16, [0, 0, 0], metal); batch(boom, [tool])
    const dust = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: '#cdb395', size: 0.045, transparent: true, opacity: 0.55, depthWrite: false }))
    dust.name = 'wheel-dust'; const dustPoints = new Float32Array(72); dust.geometry.setAttribute('position', new THREE.BufferAttribute(dustPoints, 3)); root.add(dust)
    if (live) upgradeSkins('planetary', { chassisSkin: skin, mastSkin }, live)
    return { root, mast, eye, swing, boom, tool, light, dust, dustPoints }
  })
  return { rovers, step(t: number, colors: readonly (string | null)[] = []) {
    rocks.forEach((r, n) => { r.visible = !logic.rocks[n].sampled })
    rovers.forEach((m, n) => {
      const u = logic.units[n]; m.root.position.set(u.x, u.y, u.z); m.root.rotation.y = u.h
      m.mast.rotation.set(u.mastTilt, u.mastPan, 0, 'YXZ'); m.swing.rotation.y = u.swing; m.boom.rotation.x = u.boom; m.tool.rotation.y = u.sampling * 20
      wear(m.light, colors[n] ?? null); m.dust.visible = Math.abs(u.v) > 0.05
      for (let j = 0; j < 24; j++) { const age = (t * 1.4 + j / 24) % 1; m.dustPoints.set([(j % 2 ? -0.63 : 0.63) + Math.sin(j * 8) * age * 0.2, 0.18 + age * 0.25, 0.4 + age * Math.abs(u.v)], j * 3) }
      m.dust.geometry.attributes.position.needsUpdate = true
    })
  } }
}
export function createView(stage: Stage, logic: PlanetaryLogic): DeviceView {
  stage.ground.visible = false
  const m = expedition(stage.scene, logic, 2, () => stage.view.invalidate()); let viewed = 0
  return { framing: playFrame([-2, 0.6, 3], 1.7, [1, 0.8, -1.4]), overview: playFrame([0, 0, 0], 8), inspect: () => playFrame([logic.units[viewed].x, logic.units[viewed].y + 0.8, logic.units[viewed].z - 0.3], 1.1, [1, 0.6, -1.4]), follow: n => { viewed = n; const u = logic.units[n]; return new THREE.Vector3(u.x, u.y + 0.6, u.z) }, update: (colors, t) => m.step(t, colors), afterRender: monitor(stage, stage.scene, () => m.rovers[viewed].eye, () => `Explorer ${viewed + 1} · mast`, m.rovers.map(r => r.root)) }
}
export function preview() {
  const l = new PlanetaryLogic()
  return showcase(scene => { const m = expedition(scene, l, 1); return { step(t) { l.units[0].swing = Math.sin(t) * 0.4; l.units[0].mastPan = Math.sin(t * 0.7) * 0.35; m.step(t) } } }, [-2, 0.65, 3], 1.4)
}

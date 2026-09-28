import { contactSurface } from '../contact'
import * as THREE from 'three'
import { batch, floorMaterial, maker, metal, plastic, rubber } from '../kit'
import { KartLogic, KART_CHECKPOINTS } from './kart'
import { block, disc, playFrame, rod, showcase, wheel } from './parts'
import type { Stage } from './stage'
import { mats, plate, wear, type DeviceView } from './view'
import { ceramic, darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'
import { instanceCopies } from '../kit/instances'

function kart(n: number) {
  const root = new THREE.Group(), chassis = new THREE.Group(), cockpit = new THREE.Group()
  root.name = `kart-${n + 1}`; chassis.name = 'chassis'; cockpit.name = 'cockpit'
  root.add(chassis, cockpit)
  const paint = gunmetal, glow = mats.glow(), skin = skinSlot(chassis, 'chassisSkin')
  pov(cockpit, [0, .77, -.1])
  block(chassis, [0.93, 0.13, 1.55], [0, 0.25, 0], rubber)
  block(skin, [0.66, 0.2, 0.68], [0, 0.36, -0.53], paint)
  block(skin, [0.9, 0.13, 0.2], [0, 0.3, -0.96], paint)
  block(chassis, [0.94, 0.12, 0.14], [0, 0.26, 0.87], metal)
  for (const x of [-0.5, 0.5]) {
    block(skin, [0.18, 0.25, 0.63], [x, 0.34, 0.05], paint)
    rod(chassis, [x, 0.18, -0.7], [x, 0.18, 0.8], 0.05, metal)
  }
  block(chassis, [0.45, 0.12, 0.47], [0, 0.38, 0.12], rubber)
  block(chassis, [0.46, 0.43, 0.12], [0, 0.55, 0.39], rubber)
  rod(chassis, [0, 0.36, -0.2], [0, 0.65, -0.31], 0.027, metal)
  const steering = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, 24), rubber)
  steering.position.set(0, 0.66, -0.32); steering.rotation.x = -0.6; cockpit.add(steering)
  block(chassis, [0.27, 0.24, 0.38], [0.25, 0.44, 0.57], metal)
  for (let k = 0; k < 5; k++) block(chassis, [0.28, 0.018, 0.035], [0.25, 0.57, 0.43 + k * 0.065], rubber)
  const wheels = [-0.6, 0.6].flatMap((x) => [-0.62, 0.59].map((z) => {
    const w = wheel(root, x, 0.23, z, 0.23)
    w.name = z < 0 ? 'front-wheel' : 'rear-wheel'
    return w
  }))
  disc(chassis, 0.055, 0.04, [0, 0.49, -0.78], glow)
  const number = plate(n + 1, 0.24)
  number.position.set(0, 0.474, -0.51); number.rotation.x = -Math.PI / 2; chassis.add(number)
  maker(chassis, 0.25, 0.474, -0.54, 0.12)
  batch(chassis); batch(cockpit, [steering])
  return { root, chassis, glow, wheels, steering, skin }
}
function raceway(scene: THREE.Scene, logic: KartLogic, live?: () => void) {
  const track = new THREE.Group(); track.name = 'track-and-checkpoints'; scene.add(track)
  track.add(tiledDeck(27, 27, 0, 3))
  const asphalt = new THREE.Mesh(new THREE.RingGeometry(4.9, 10.55, 128), floorMaterial('#30383e'))
  asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = .0005; asphalt.receiveShadow = true; track.add(contactSurface(asphalt))
  for (const radius of [4.9, 10.55]) for (let n = 0; n < 72; n++) {
    const a = n / 72 * Math.PI * 2
    const kerb = block(track, [0.3, 0.14, radius * 0.085], [Math.sin(a) * radius, 0, Math.cos(a) * radius], n % 2 ? ceramic : darkTitanium)
    kerb.rotation.y = a + Math.PI / 2
  }
  for (let n = 0; n < 12; n++) for (let row = 0; row < 2; row++)
    block(track, [0.22, 0.001, 0.4], [row * 0.22, 0.001, 5.25 + n * 0.4], plastic((n + row) % 2 ? '#e7e9df' : '#171c22'))
  KART_CHECKPOINTS.forEach((a, n) => {
    for (const r of [4.8, 10.7]) {
      rod(track, [Math.sin(a) * r, 0, Math.cos(a) * r], [Math.sin(a) * r, 1.5, Math.cos(a) * r], 0.045)
      const flag = block(track, [0.06, 0.26, 0.48], [Math.sin(a) * (r + 0.22), 1.35, Math.cos(a) * (r + 0.22)], plastic(n === 7 ? '#c6ff34' : '#617a87'))
      flag.rotation.y = a
    }
  })
  block(track, [4.4, 0.22, 1.4], [0, 0.2, 0], plastic('#48525b'))
  for (let n = 0; n < 3; n++) block(track, [4.4, 0.2, 0.4], [0, 0.4 + n * 0.2, -0.3 - n * 0.4], metal)
  batch(track)
  const copies = instanceCopies(scene)
  let loaded = 0
  const models = logic.units.map((_, n) => {
    const m = kart(n); scene.add(m.root)
    if (live) upgradeSkins('kart', { chassisSkin: m.skin }, () => {
      m.skin.userData.static = true; batch(m.chassis)
      if (++loaded === models.length) copies.set(models.map(model => model.root))
      live()
    })
    return m
  })
  return {
    step(colors: readonly (string | null)[] = []) {
      models.forEach((m, n) => {
        const u = logic.units[n]
        m.root.position.set(u.x, 0, u.z); m.root.rotation.y = u.h
        m.wheels.forEach((w) => { w.rotation.y = w.name === 'front-wheel' ? -u.steer * 0.4 : 0 })
        m.steering.rotation.z = -u.steer * 0.7
        wear(m.glow, colors[n] ?? null)
      })
      copies.update()
    },
  }
}
export function createView(stage: Stage, logic: KartLogic): DeviceView {
  stage.ground.visible = false
  const w = raceway(stage.scene, logic, () => stage.view.invalidate()), at = (n: number): [number, number, number] => [logic.units[n].x, 0.4, logic.units[n].z]
  return {
    framing: playFrame(at(0), 1.4, [1.2, 1, -1]), overview: playFrame([0, 0, 0], 12), inspect: () => playFrame(at(0), 0.95, [1.2, 1, -1]),
    follow: (n) => new THREE.Vector3(...at(n)), update: (colors) => w.step(colors),
  }
}
export function preview() {
  const logic = new KartLogic()
  const card = showcase((scene) => {
    const w = raceway(scene, logic)
    return { step(t) { logic.units[0].steer = Math.sin(t) * 0.6; w.step() } }
  }, [logic.units[0].x, 0.35, logic.units[0].z], 1.35)
  card.camera.position.set(logic.units[0].x + 3.2, 3.1, logic.units[0].z - 2.8)
  card.camera.lookAt(logic.units[0].x, 0.35, logic.units[0].z)
  return card
}

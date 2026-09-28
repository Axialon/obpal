import { contactPart } from '../contact'
import * as THREE from 'three'
import { darkTitanium, gunmetal, optic } from '../kit/surfaces'
import { pov, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'
import { batch, maker, metal, plastic, rubber } from '../kit'
import { GimbalLogic } from './gimbal'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'
function filming(scene: THREE.Scene, logic: GimbalLogic, live?: () => void) {
  const set = new THREE.Group()
  scene.add(set)
  const deck = tiledDeck(10, 12, 0, 1.5); deck.position.z = -2; set.add(deck)
  block(set, [9, 4, 0.12], [0, 2, -6], darkTitanium)
  for (const x of [-3.5, 3.5]) {
    rod(set, [x, 0, -3], [x, 3.3, -3], 0.035)
    block(set, [0.8, 1.1, 0.12], [x, 3.1, -3], plastic('#eee9d9'))
    for (const z of [-0.3, 0.3]) rod(set, [x, 0.6, -3], [x + z, 0, -3.25], 0.03)
  }
  disc(set, 0.9, 0.22, [0, 0.1, -3.6], gunmetal)
  batch(set)
  const subject = new THREE.Group()
  subject.position.set(0, 1.4, -3.6)
  scene.add(subject)
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.5, 0.13, 72, 12), metal)
  subject.add(knot)
  rod(scene, [0, 0.2, -3.6], [0, 0.9, -3.6], 0.08)
  const root = new THREE.Group()
  scene.add(root)
  contactPart(disc(root, 0.38, 0.12, [0, 0.06, 0], rubber), 'base')
  rod(root, [0, 0.1, 0], [0, 1.25, 0], 0.085, metal)
  for (let n = 0; n < 3; n++) {
    const a = (n * Math.PI * 2) / 3
    rod(root, [0, 0.5, 0], [Math.cos(a) * 0.6, 0.03, Math.sin(a) * 0.6], 0.04)
  }
  const yaw = new THREE.Group()
  yaw.position.y = 1.35
  root.add(yaw)
  disc(yaw, 0.16, 0.18, [0, 0, 0], darkTitanium)
  block(yaw, [0.12, 0.7, 0.14], [0.31, 0.24, 0], metal)
  block(yaw, [0.42, 0.1, 0.14], [0.16, -0.06, 0], metal)
  const pitch = new THREE.Group()
  pitch.position.y = 0.52
  yaw.add(pitch)
  block(pitch, [0.72, 0.08, 0.18], [0, -0.2, 0.1], metal)
  block(pitch, [0.08, 0.43, 0.18], [-0.34, 0, 0.1], metal)
  const roll = new THREE.Group()
  pitch.add(roll)
  const skin = skinSlot(roll, 'cameraSkin', block(roll, [0.52, 0.35, 0.3], [0, 0, 0], gunmetal))
  pov(roll, [0, 0, -.535])
  if (live) upgradeSkins('gimbal', { cameraSkin: skin }, live)
  block(roll, [0.46, 0.27, 0.025], [0, 0, 0.165], optic)
  for (const [r, z] of [
    [0.15, -0.25],
    [0.17, -0.4],
    [0.12, -0.46],
  ]) {
    const d = disc(roll, r, 0.13, [0, 0, z], z === -0.46 ? optic : rubber)
    d.rotation.x = Math.PI / 2
  }
  maker(roll, 0, 0.185, 0, 0.13)
  const eye = new THREE.PerspectiveCamera(48, 16 / 9, 0.05, 40)
  eye.position.z = -0.47
  roll.add(eye)
  batch(roll)
  batch(pitch, [roll])
  batch(yaw, [pitch])
  batch(root, [yaw])
  const euler = new THREE.Euler(0, 0, 0, 'YXZ')
  return {
    eye,
    root,
    step(t: number) {
      subject.rotation.y = t * 0.3
      subject.rotation.z = Math.sin(t * 0.4) * 0.1
      euler.setFromQuaternion(new THREE.Quaternion(...logic.units[0].q), 'YXZ')
      yaw.rotation.y = euler.y
      pitch.rotation.x = euler.x
      roll.rotation.z = euler.z
    },
  }
}
export function createView(stage: Stage, logic: GimbalLogic): DeviceView {
  const w = filming(stage.scene, logic, () => stage.view.invalidate()),
    size = new THREE.Vector2(),
    clear = new THREE.Color()
  const label = document.createElement('div')
  label.className = 'gimbal-feed'
  label.setAttribute('aria-label', 'Gimbal camera view')
  label.style.cssText =
    'position:fixed;right:16px;top:80px;pointer-events:none;border:1px solid #91a6b4;border-radius:8px;color:white;padding:6px;font:12px system-ui;box-sizing:border-box'
  document.body.append(label)
  return {
    framing: playFrame([0, 1.3, 0], 1.15),
    overview: playFrame([0, 1, -2], 5),
    inspect: () => playFrame([0, 1.8, 0], 0.6),
    update: (_, t) => {
      w.step(t)
      label.textContent = logic.units[0].recording ? '● REC' : 'Camera view'
    },
    afterRender() {
      const r = stage.renderer
      r.getSize(size)
      r.getClearColor(clear)
      const alpha = r.getClearAlpha(),
        k = size.x / stage.view.width,
        width = Math.min(260, innerWidth * 0.32),
        height = (width * 9) / 16,
        x = innerWidth - width - 16,
        y = 80
      label.style.width = `${width}px`
      label.style.height = `${height}px`
      r.setScissorTest(true)
      r.setScissor(x * k, size.y - (y + height) * k, width * k, height * k)
      r.setViewport(x * k, size.y - (y + height) * k, width * k, height * k)
      r.setClearColor('#252f39', 1)
      r.clear()
      w.root.visible = false
      stage.view.drawInset(stage.scene, w.eye)
      w.root.visible = true
      r.setScissorTest(false)
      r.setViewport(0, 0, size.x, size.y)
      r.setClearColor(clear, alpha)
    },
  }
}
export function preview() {
  const l = new GimbalLogic()
  return showcase(
    (s) => {
      const w = filming(s, l)
      return {
        step(t) {
          l.units[0].q = [0, Math.sin(t * 0.25) * 0.2, 0, 1]
          w.step(t)
        },
      }
    },
    [0, 1.3, 0],
    1.15,
  )
}

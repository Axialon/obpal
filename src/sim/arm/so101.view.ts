/** Ceramic plates over the SO-101's servo skeleton, inside the original collision shapes. */
import * as THREE from 'three'
import { batch, bolt, box, cable, cylinder } from '../kit'
import { Spring } from '../kit/motion'
import { telescoping } from '../kit/mechanism'
import { carbon, ceramic, lime, polished, ring, shell, titanium, warmShell } from '../kit/surfaces'
import type { ArmMaterials } from './kin'
import type { SerialSpec } from './serial'
import { buildSerial } from './serial3d'
import { meshOf } from './shapes3d'
import { finishPrototype, loadPrototype, prototypeNodes, retirePrototype } from '../kit/prototype'
import { contactFrame } from '../contact'

export function buildSO101(spec: SerialSpec, n: number, _mats: ArmMaterials) {
  const stuff = { metal: titanium, dark: carbon, black: carbon, shell: ceramic }
  const model = buildSerial(spec, n, stuff, {
    plate: [.24, .08, 0], plateRing: .17,
    finish(groups) {
      const rings: THREE.Mesh[] = []
      const cables: { group: THREE.Group; pivot: THREE.Group; spring: Spring; previous: number }[] = []
      for (const [name, s] of spec.look) {
        const parent = groups[name]
        if ('ring' in s) {
          const glow = meshOf(s, stuff)
          ;(glow.material as THREE.MeshStandardMaterial).emissive.set('#c6ff34'); glow.userData.idleColor = '#c6ff34'
          parent.add(glow); rings[s.joint] = glow
          const bearing = new THREE.Group(); bearing.userData.static = true; bearing.position.set(...s.at)
          if (s.axis === 'y') bearing.rotation.x = Math.PI / 2
          const r = s.ring[0]
          const rim = ring(r * .85, r * .075, polished); bearing.add(rim)
          const hub = cylinder(r * .64, .009, titanium, 24); hub.rotation.x = Math.PI / 2; bearing.add(hub)
          const core = cylinder(r * .34, .012, carbon, 20); core.rotation.x = Math.PI / 2; bearing.add(core)
          for (let i = 0; i < 3; i++) {
            const a = i * Math.PI * 2 / 3, fastener = bolt(r * .06)
            fastener.rotation.x = Math.PI / 2; fastener.position.set(Math.cos(a) * r * .48, Math.sin(a) * r * .48, .006); bearing.add(fastener)
          }
          parent.add(bearing)
          if (s.axis === 'z') { const back = bearing.clone(true); back.position.z = -s.at[2]; back.rotation.y = Math.PI; parent.add(back) }
        } else if ('box' in s && s.stuff === 'shell') {
          const [w, h, d] = s.box
          const chassis = box(w * .64, h * .98, d * .64, carbon); chassis.position.set(...s.at); parent.add(chassis)
          // Two overlapping sections on each face leave a narrow, recessed service seam.
          for (const side of [-1, 1]) for (const [fraction, offset, material] of [[.54, -.205, ceramic], [.40, .28, warmShell]] as const) {
            const cover = shell(w, h * fraction, d * .29, material, .19)
            cover.position.set(s.at[0], s.at[1] + h * offset, s.at[2] + side * d * .355); parent.add(cover)
          }
          if (h > w * 1.8) {
            for (const side of [-1, 1]) {
              const sleeve = cylinder(w * .085, h * .26, titanium, 12); sleeve.position.set(side * w * .34, s.at[1] - h * .18, 0); parent.add(sleeve)
              const rod = cylinder(w * .041, h * .42, polished, 12); rod.position.set(side * w * .34, s.at[1] + h * .14, 0); parent.add(rod)
            }
            const loom = new THREE.Group(); loom.position.set(w * .18, s.at[1] - h * .38, -d * .34)
            loom.add(cable([[0, 0, 0], [w * .16, h * .2, -d * .1], [w * .16, h * .5, -d * .1], [0, h * .76, 0]], w * .042, carbon))
            parent.add(loom); cables.push({ group: loom, pivot: parent, spring: new Spring(0, .24), previous: 0 })
          }
        } else {
          const m = meshOf(s, stuff); parent.add(m)
          if ('box' in s) {
            const [w, h, d] = s.box
            const cap = shell(w * .78, h * .67, .006, titanium); cap.position.set(s.at[0], s.at[1], s.at[2] + d / 2 - .003); parent.add(cap)
            for (const side of [-1, 1]) { const slit = box(w * .05, h * .24, .004, lime, .001); slit.position.set(s.at[0] + side * w * .29, s.at[1], s.at[2] + d / 2 - .001); parent.add(slit) }
          }
        }
      }
      for (const g of Object.values(groups)) batch(g, [...rings, ...cables.map(c => c.group)])
      return {
        rings,
        secondary(dt: number) {
          for (const c of cables) {
            const angle = c.pivot.rotation.z, speed = dt > 0 ? (angle - c.previous) / dt : 0
            c.previous = angle
            // Both anchors lie on this axis, so only the free cable span moves.
            c.group.rotation.y = c.spring.step(Math.max(-.25, Math.min(.25, -speed * .08)), dt)
          }
        },
      }
    },
  })
  model.root.userData.prototype = 'procedural'
  const mechanisms: (() => void)[] = [], secondary = model.secondary
  model.secondary = dt => { secondary?.(dt); mechanisms.forEach(update => update()) }
  model.upgrade = async () => {
    const scene = await loadPrototype('so101')
    if (!scene) return null
    const names = ['root', 'yaw', 'shoulder', 'elbow', 'wrist', 'roll', 'fingerLeft', 'fingerRight'] as const
    const source = prototypeNodes(scene, names), target = prototypeNodes(model.root, names)
    const actuators = prototypeNodes(scene, ['elbowSleeve', 'elbowRod', 'wristSleeve', 'wristRod'])
    finishPrototype(scene)
    return () => {
      for (const name of names) {
        const frame = target[name]
        for (const old of [...frame.children]) {
          // Keep control frames, the live joint rings, number and secondary cable pivots.
          if (!(old as THREE.Mesh).isMesh || model.rings.includes(old as THREE.Mesh) || old === model.plate || Object.values(target).includes(old)) continue
          retirePrototype(old)
        }
        if (name.startsWith('finger')) (frame as THREE.Mesh).geometry = new THREE.BufferGeometry()
        for (const part of [...source[name].children]) if ((part as THREE.Mesh).isMesh || Object.values(actuators).includes(part)) frame.add(part)
      }
      for (const [name, length] of [['elbow', .28], ['wrist', .34]] as const) {
        const update = telescoping(actuators[`${name}Sleeve`], actuators[`${name}Rod`], target[name], new THREE.Vector3(.031, length - .09, 0), new THREE.Vector3(.02, .035, 0))
        mechanisms.push(update); update()
      }
      model.root.userData.prototype = 'blender'
      contactFrame(model.root, 'arm-so101-base')
      performance.mark('obpal:so101:visible')
    }
  }
  return model
}

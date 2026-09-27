/** An open-front living room keeps all four appliances legible from the play camera. */
import * as THREE from 'three'
import { batch, floorMaterial, maker, metal, plastic, rounded, rubber } from '../kit'
import { SmarthomeLogic, roomChannel, roomSetpoint } from './smarthome'
import { block, disc, playFrame, rod, showcase } from './parts'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

const APPLIANCES: [number, number, number][] = [[-1.65, 1.8, -2.05], [0.1, 2.5, 0.15], [0.95, 1.5, -2.08], [2.6, 1.65, -2.08]]
function group(parent: THREE.Object3D, name: string) { const g = new THREE.Group(); g.name = name; parent.add(g); return g }

function room(scene: THREE.Scene, logic: SmarthomeLogic) {
  const root = group(scene, 'smart-home-room'), shell = group(root, 'room-shell'), furniture = group(root, 'furnishings')
  const wood = plastic('#a27e59'), fabric = plastic('#7a9389'), trim = plastic('#343b40')
  block(shell, [6.3, 0.16, 4.8], [0, -0.08, 0], floorMaterial('#97836a'))
  block(shell, [6.3, 2.8, 0.12], [0, 1.4, -2.3], plastic('#c4c5b7'))
  block(shell, [0.12, 2.8, 4.8], [-3.1, 1.4, 0], plastic('#a9b5ae'))
  for (let x = -2.8; x < 3; x += 0.42) block(shell, [0.012, 0.008, 4.6], [x, 0.008, 0], wood)
  block(shell, [6.1, 0.12, 0.035], [0, 0.06, -2.22], wood)
  batch(shell)
  block(furniture, [2.8, 0.025, 2.25], [-0.3, 0.025, 0.3], plastic('#d2c7a4'))
  block(furniture, [2.5, 0.42, 0.95], [-0.6, 0.32, 1.25], fabric)
  block(furniture, [2.5, 0.7, 0.2], [-0.6, 0.67, 1.65], fabric)
  for (const x of [-1.82, 0.62]) block(furniture, [0.19, 0.56, 0.95], [x, 0.55, 1.25], fabric)
  for (const x of [-1.38, -0.6, 0.18]) block(furniture, [0.71, 0.16, 0.72], [x, 0.58, 1.18], plastic('#9faf9e'))
  for (const x of [-1.64, 0.45]) for (const z of [0.92, 1.58]) rod(furniture, [x, 0, z], [x, 0.28, z], 0.035)
  block(furniture, [1.5, 0.075, 0.72], [-0.4, 0.48, 0], wood)
  for (const x of [-1.03, 0.23]) for (const z of [-0.25, 0.25]) rod(furniture, [x, 0.03, z], [x, 0.45, z], 0.025)
  block(furniture, [0.28, 0.04, 0.2], [-0.6, 0.54, 0], plastic('#718d9c'))
  disc(furniture, 0.08, 0.12, [-0.05, 0.58, 0.08], plastic('#e7e2d0'))
  block(furniture, [2.3, 0.38, 0.48], [1, 0.3, -1.98], wood)
  for (const x of [0.35, 1, 1.65]) block(furniture, [0.61, 0.27, 0.03], [x, 0.3, -1.715], trim)
  const plant = group(furniture, 'plant')
  disc(plant, 0.23, 0.4, [2.45, 0.2, 1.6], plastic('#e6d8bc'))
  for (let n = 0; n < 6; n++) {
    const a = n * Math.PI / 3, leaf = block(plant, [0.15, 0.55, 0.055], [2.45 + Math.cos(a) * 0.17, 0.63, 1.6 + Math.sin(a) * 0.17], plastic('#5f7958'))
    leaf.rotation.set(Math.cos(a) * 0.4, a, Math.sin(a) * 0.4)
  }
  batch(furniture)

  const blinds = group(root, 'blinds')
  block(blinds, [2.03, 1.7, 0.1], [-1.65, 1.76, -2.2], wood)
  const sky = new THREE.MeshStandardMaterial({ color: '#a0cfda', emissive: '#719eac', emissiveIntensity: 0.35 })
  block(blinds, [1.85, 1.52, 0.05], [-1.65, 1.76, -2.13], sky)
  block(blinds, [0.04, 1.52, 0.06], [-1.65, 1.76, -2.08], wood)
  block(blinds, [1.85, 0.04, 0.06], [-1.65, 1.76, -2.08], wood)
  block(blinds, [2, 0.1, 0.16], [-1.65, 2.59, -2.04], plastic())
  const slats = new THREE.InstancedMesh(rounded(1.9, 0.09, 0.075), plastic('#e7dfc9'), 15)
  slats.name = 'blind-slats'; slats.castShadow = true; blinds.add(slats)
  batch(blinds, [slats])
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 2), new THREE.MeshBasicMaterial({ color: '#ffe1a0', transparent: true, opacity: 0.15, depthWrite: false }))
  sun.rotation.x = -Math.PI / 2; sun.position.set(-1.65, 0.028, -0.9); root.add(sun)

  const fan = group(root, 'ceiling-fan')
  rod(fan, [0.1, 2.5, 0.15], [0.1, 2.86, 0.15], 0.035)
  disc(fan, 0.18, 0.06, [0.1, 2.85, 0.15], trim)
  disc(fan, 0.16, 0.13, [0.1, 2.51, 0.15], metal)
  const rotor = group(fan, 'fan-rotor'); rotor.position.set(0.1, 2.52, 0.15)
  for (let n = 0; n < 3; n++) {
    const blade = group(rotor, `blade-${n + 1}`); blade.rotation.y = n * Math.PI * 2 / 3
    block(blade, [0.77, 0.035, 0.19], [0.47, 0, 0], wood); blade.userData.static = true
  }
  batch(rotor); batch(fan, [rotor])

  const television = group(root, 'television')
  block(television, [2.03, 1.2, 0.12], [1, 1.47, -2.15], rubber)
  const screenMat = new THREE.MeshStandardMaterial({ color: '#20333d', emissive: '#568e9f', emissiveIntensity: 0.65, roughness: 0.25 })
  block(television, [1.84, 1.02, 0.03], [1, 1.47, -2.07], screenMat)
  const picture = group(television, 'television-picture')
  for (let n = 0; n < 5; n++) {
    const bar = block(picture, [0.22, 0.18 + (n % 3) * 0.2, 0.02], [0.38 + n * 0.3, 1.3, -2.045], plastic(['#8aaf96', '#ced590', '#809ab2'][n % 3]))
    bar.rotation.z = n % 2 ? 0.15 : -0.15
  }
  batch(picture); batch(television, [picture])

  const thermostat = group(root, 'thermostat')
  block(thermostat, [0.51, 0.62, 0.11], [2.62, 1.67, -2.15], plastic())
  block(thermostat, [0.39, 0.35, 0.025], [2.62, 1.76, -2.075], trim)
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 160
  const context = canvas.getContext('2d')!, texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const display = new THREE.Mesh(new THREE.PlaneGeometry(0.37, 0.24), new THREE.MeshBasicMaterial({ map: texture }))
  display.position.set(2.62, 1.78, -2.054); thermostat.add(display)
  const gauge = block(thermostat, [0.36, 0.045, 0.025], [2.62, 1.47, -2.07], plastic('#c6ff34'))
  maker(thermostat, 2.62, 1.37, -2.065, 0.07)
  batch(thermostat, [display, gauge])
  const lights = APPLIANCES.map((at, n) => {
    const material = mats.glow(), dot = disc(root, 0.05, 0.02, [at[0], at[1] - (n === 1 ? 0.04 : 0.45), at[2] + 0.14], material)
    if (n !== 1) dot.rotation.x = Math.PI / 2
    return material
  })
  const pose = new THREE.Object3D()
  let label = ''
  return {
    step(colors: readonly (string | null)[] = []) {
      logic.units.forEach((_, n) => wear(lights[n], colors[n] ?? null))
      for (let n = 0; n < 15; n++) {
        pose.position.set(-1.65, 2.49 - n * (0.012 + (1 - logic.units[0].level) * 0.091), -2.02)
        pose.updateMatrix(); slats.setMatrixAt(n, pose.matrix)
      }
      slats.instanceMatrix.needsUpdate = true
      rotor.rotation.y = logic.units[1].phase
      sun.material.opacity = logic.units[0].level * 0.25
      const tv = logic.units[2], channel = roomChannel(tv)
      screenMat.emissive.set(['#477e6b', '#a470a3', '#697cbb', '#c4a75d'][channel])
      screenMat.emissiveIntensity = tv.on ? 0.7 : 0
      picture.visible = tv.on
      picture.scale.y = 0.8 + channel * 0.07
      gauge.scale.x = 0.12 + logic.units[3].target * 0.88
      const next = logic.units[3].on ? `${roomSetpoint(logic.units[3])}°` : 'OFF'
      if (label === next) return false
      label = next
      context.fillStyle = '#202c31'; context.fillRect(0, 0, 256, 160)
      context.fillStyle = '#d9f7ba'; context.font = 'bold 94px monospace'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(next, 128, 83)
      texture.needsUpdate = true
      return true
    },
  }
}

export function createView(stage: Stage, logic: SmarthomeLogic): DeviceView {
  const model = room(stage.scene, logic)
  return {
    framing: { target: [0, 1.25, -0.35], wide: [5.2, 4.8, 6.8], tall: [4.9, 5.8, 8.5], radius: 3.1, min: 0.7, max: 20 },
    overview: playFrame([0, 1, 0], 3.8),
    inspect: () => playFrame([1.35, 1.45, -2.05], 1.15, [0.3, 0.35, 1.6]),
    anchor: (n) => new THREE.Vector3(...APPLIANCES[n]),
    update: (colors) => { if (model.step(colors)) stage.view.invalidate() },
  }
}

export function preview() {
  const logic = new SmarthomeLogic()
  return showcase((scene) => {
    const model = room(scene, logic)
    return { step(t, dt) { logic.units[0].level = 0.5 + Math.sin(t * 0.4) * 0.4; logic.units[1].phase += dt * 4; logic.units[2].on = true; model.step() } }
  }, [0, 1.25, -0.3], 2.3)
}

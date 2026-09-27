/**
 * One arm in the scene: base (yaw) → shoulder → upper arm → elbow → forearm → wrist → roll → gripper, with a ring
 * per joint that wears its holder's colour. Lengths match the kinematics (./kinematics.ts). The arm reaches along its
 * local −x, turned by the base.
 */
import * as THREE from 'three'
import { FINGER_IN, FINGER_TRAVEL, FINGER_W } from './grasp'
import { ARM } from './kinematics'
import { machining, plateLabel } from './shapes3d'

import { batch, rounded } from '../kit'

const D2R = Math.PI / 180

export interface JointSpec {
  /** Its name in node ids (`a1.shoulder`), unique in its arm; the gripper is always 'gripper'. */
  key: string
  name: string
  /** Degrees, or metres for a joint that slides (the gripper: 0 closed … 1 open). */
  min: number
  max: number
  home: number
  /** Speed and acceleration caps, units per second (per second). */
  vmax: number
  amax: number
  unit: '°' | 'm' | ''
}

export const JOINTS: JointSpec[] = [
  { key: 'base', name: 'Base', min: -170, max: 170, home: 0, vmax: 70, amax: 220, unit: '°' },
  { key: 'shoulder', name: 'Shoulder', min: -80, max: 95, home: 18, vmax: 55, amax: 160, unit: '°' },
  { key: 'elbow', name: 'Elbow', min: -135, max: 140, home: 72, vmax: 70, amax: 220, unit: '°' },
  { key: 'wrist', name: 'Wrist', min: -115, max: 115, home: 62, vmax: 90, amax: 300, unit: '°' },
  { key: 'roll', name: 'Wrist roll', min: -180, max: 180, home: 0, vmax: 120, amax: 400, unit: '°' },
  { key: 'gripper', name: 'Gripper', min: 0, max: 1, home: 1, vmax: 1.4, amax: 6, unit: '' },
]

export interface ArmModel {
  root: THREE.Group
  /** Set a joint (in JOINTS order) to a value. */
  apply: ((v: number) => void)[]
  rings: THREE.Mesh[]
  /** The ring around the base: the whole arm's holder. */
  plate: THREE.Mesh
  /** Where held blocks sit, between the fingers. */
  grasp: THREE.Object3D
  /** Secondary mechanisms after the authoritative pose has been applied. */
  secondary?(dt: number): void
  /** Optional live-page mesh upgrade; installing is synchronous so instances can be rebuilt atomically. */
  upgrade?(): Promise<(() => void) | null>
  dispose(): void
}

export interface ArmMaterials { metal: THREE.Material; dark: THREE.Material }

const accent = (c: string) => new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: c, emissiveIntensity: 0.25, metalness: 0.2, roughness: 0.4 })

function ringAt(radius: number, tube = 0.012) {
  return new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 48), accent('#5b6472'))
}

export function buildArm(n: number, mats: ArmMaterials): ArmModel {
  const { metal, dark } = mats
  const root = new THREE.Group()
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, 0.1, 64), dark)
  base.position.y = 0.05
  root.add(base)
  const plate = ringAt(0.28, 0.01)
  plate.rotation.x = Math.PI / 2
  plate.position.y = 0.012
  root.add(plate)
  // Behind the base, facing whoever looks.
  const label = plateLabel(n)
  label.position.set(0.36, 0.1, 0)
  root.add(label)

  const yaw = new THREE.Group()
  yaw.position.y = 0.1
  root.add(yaw)
  yaw.add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.16, 64), metal).translateY(0.08))
  const yawRing = ringAt(0.2)
  yawRing.rotation.x = Math.PI / 2
  yawRing.position.y = 0.02
  yaw.add(yawRing)

  const shoulder = new THREE.Group()
  shoulder.position.y = ARM.H0 - 0.1
  yaw.add(shoulder)
  const hub = (r: number, w: number) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 48), dark); m.rotation.x = Math.PI / 2; return m }
  shoulder.add(hub(0.085, 0.2))
  const shoulderRing = ringAt(0.1)
  shoulderRing.position.z = 0.105
  shoulder.add(shoulderRing)
  shoulder.add(new THREE.Mesh(rounded(0.1, ARM.L1, 0.11), metal).translateY(ARM.L1 / 2))

  const elbow = new THREE.Group()
  elbow.position.y = ARM.L1
  shoulder.add(elbow)
  elbow.add(hub(0.07, 0.17))
  const elbowRing = ringAt(0.082)
  elbowRing.position.z = 0.09
  elbow.add(elbowRing)
  elbow.add(new THREE.Mesh(rounded(0.08, ARM.L2, 0.09), metal).translateY(ARM.L2 / 2))

  const wrist = new THREE.Group()
  wrist.position.y = ARM.L2
  elbow.add(wrist)
  wrist.add(hub(0.055, 0.13))
  const wristRing = ringAt(0.065)
  wristRing.position.z = 0.07
  wrist.add(wristRing)
  wrist.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.1, 40), metal).translateY(0.06))

  const roll = new THREE.Group()
  roll.position.y = 0.12
  wrist.add(roll)
  const rollRing = ringAt(0.052)
  rollRing.rotation.x = Math.PI / 2
  roll.add(rollRing)
  const palm = new THREE.Mesh(rounded(0.14, 0.035, 0.07), dark)
  palm.position.y = 0.03
  roll.add(palm)
  // The fingers as ./grasp.ts has them: 0.1 long, their tips 0.035 past the point between them (the grasp, below).
  const fingerGeo = rounded(FINGER_W, 0.1, 0.055)
  const fingers = [new THREE.Mesh(fingerGeo, metal), new THREE.Mesh(fingerGeo, metal)]
  for (const f of fingers) { f.position.y = 0.095; roll.add(f) }
  const gripRing = ringAt(0.03, 0.008)
  gripRing.position.y = 0.05
  gripRing.rotation.x = Math.PI / 2
  roll.add(gripRing)
  const grasp = new THREE.Object3D()
  grasp.position.y = ARM.LT - 0.12
  roll.add(grasp)

  const detail = (g: THREE.Object3D, w: number, h: number, d: number) => machining(g, { box: [w, h, d], at: [0, h / 2, 0], stuff: 'metal' })
  detail(shoulder, 0.1, ARM.L1, 0.11)
  detail(elbow, 0.08, ARM.L2, 0.09)
  for (const [group, ring] of [[shoulder, shoulderRing], [elbow, elbowRing], [wrist, wristRing]] as const) {
    const radius = (ring.geometry as THREE.TorusGeometry).parameters.radius
    machining(group, { ring: [radius, 0.012], axis: 'z', at: [0, 0, ring.position.z], joint: 0 })
  }
  machining(root, { cyl: [0.24, 0.27, 0.1], axis: 'y', at: [0, 0.05, 0], stuff: 'dark' })
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = (o as THREE.Mesh).material === metal || (o as THREE.Mesh).material === dark; o.receiveShadow = true } })
  batch(root, [plate, yawRing, shoulderRing, elbowRing, wristRing, rollRing, gripRing, ...fingers])
  const apply = [
    (v: number) => { yaw.rotation.y = v * D2R },
    (v: number) => { shoulder.rotation.z = v * D2R },
    (v: number) => { elbow.rotation.z = v * D2R },
    (v: number) => { wrist.rotation.z = v * D2R },
    (v: number) => { roll.rotation.y = v * D2R },
    (v: number) => { const x = FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL * v; fingers[0].position.x = -x; fingers[1].position.x = x },
  ]
  return {
    root, apply, rings: [yawRing, shoulderRing, elbowRing, wristRing, rollRing, gripRing], plate, grasp,
    dispose() {
      root.removeFromParent()
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh && !(o as THREE.Sprite).isSprite) return
        if (m.isMesh && !m.geometry.userData.simShared) m.geometry.dispose()
        const mat = m.material as THREE.Material
        if (mat !== metal && mat !== dark && !mat.userData.simShared) { (mat as THREE.SpriteMaterial).map?.dispose(); mat.dispose() }
      })
    },
  }
}

/**
 * A serial arm's model (./serial.ts): its groups nested as its frames are, its parts from its look, the gripper
 * every arm has, and a number plate behind the base. A level arm's wrist follows its shoulder and elbow, so its tool
 * points straight down.
 */
import * as THREE from 'three'
import { rounded } from '../kit'
import { FINGER_IN, FINGER_TRAVEL, FINGER_W } from './grasp'
import type { ArmModel } from './model'
import { FINGER_Y, levelWrist, type SerialSpec } from './serial'
import { accent, disposeModel, dress, plateLabel, type Stuffs } from './shapes3d'

const D2R = Math.PI / 180

/**
 * Build a serial arm: `level`, its wrist keeps the tool pointing down (its joints are then base, shoulder, elbow,
 * roll and the gripper); `plate`, where its number stands (in the base's terms).
 */
export function buildSerial(spec: SerialSpec, n: number, stuff: Stuffs, opts: { level?: boolean; plate: [number, number, number]; plateRing: number }): ArmModel {
  const g = spec.geo
  const root = new THREE.Group()
  const yaw = new THREE.Group()
  yaw.position.y = spec.deck
  root.add(yaw)
  const shoulder = new THREE.Group()
  shoulder.position.y = g.H0 - spec.deck
  yaw.add(shoulder)
  const elbow = new THREE.Group()
  elbow.position.y = g.L1
  shoulder.add(elbow)
  const wrist = new THREE.Group()
  wrist.position.y = g.L2
  elbow.add(wrist)
  const roll = new THREE.Group()
  roll.position.y = spec.rollAt
  wrist.add(roll)
  const grasp = new THREE.Object3D()
  grasp.position.y = g.LT - spec.rollAt
  roll.add(grasp)
  const joints = opts.level ? 5 : 6
  const rings = dress(spec.look, { root, yaw, shoulder, elbow, wrist, roll }, stuff, joints)
  // The base's ring, the whole arm's: it wears the holder of the whole arm.
  const plate = new THREE.Mesh(new THREE.TorusGeometry(opts.plateRing, 0.01, 8, 48), accent())
  plate.rotation.x = Math.PI / 2
  plate.position.y = 0.012
  root.add(plate)
  const label = plateLabel(n)
  label.position.set(...opts.plate)
  root.add(label)
  // The gripper as ./grasp.ts has it: fingers 0.1 long, their middles FINGER_Y along the roll's group.
  const fingerGeo = rounded(FINGER_W, 0.1, 0.055)
  const fingers = [new THREE.Mesh(fingerGeo, stuff.metal), new THREE.Mesh(fingerGeo, stuff.metal)]
  for (const f of fingers) { f.position.y = FINGER_Y; roll.add(f) }
  const open = (v: number) => { const x = FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL * v; fingers[0].position.x = -x; fingers[1].position.x = x }
  let sh = 0, el = 0
  const level = () => { wrist.rotation.z = levelWrist(sh, el) * D2R }
  const apply = opts.level
    ? [
        (v: number) => { yaw.rotation.y = v * D2R },
        (v: number) => { sh = v; shoulder.rotation.z = v * D2R; level() },
        (v: number) => { el = v; elbow.rotation.z = v * D2R; level() },
        (v: number) => { roll.rotation.y = v * D2R },
        open,
      ]
    : [
        (v: number) => { yaw.rotation.y = v * D2R },
        (v: number) => { shoulder.rotation.z = v * D2R },
        (v: number) => { elbow.rotation.z = v * D2R },
        (v: number) => { wrist.rotation.z = v * D2R },
        (v: number) => { roll.rotation.y = v * D2R },
        open,
      ]
  return { root, apply, rings, plate, grasp, dispose: () => disposeModel(root, Object.values(stuff)) }
}

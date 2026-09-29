/** The authored skins share the simulation's named frames, at both levels of detail. */
import * as THREE from 'three'
import { finishPrototype } from '../kit/prototype'
import type { RigProfile } from './profile'

// glTF animation names cannot contain dots; the anatomical IDs remain unchanged.
export const pivotName = (id: string) => id.replaceAll('.', '_')
export const modelName = (profile: RigProfile) => (profile.id === 'morrow-v1' ? 'morrow' : 'keel')

/** Reject a whole asset before touching a live rig, including rotated or scaled frames. */
export function modelPivots(scene: THREE.Group, profile: RigProfile) {
  const nodes = new Map<string, THREE.Object3D>()
  const validate = (id: string, offset: readonly number[], parent?: THREE.Object3D) => {
    const name = pivotName(id)
    const matches: THREE.Object3D[] = []
    scene.traverse((node) => {
      if (node.name === name) matches.push(node)
    })
    const node = matches[0]
    if (
      matches.length !== 1 ||
      !node ||
      node.position.distanceTo(new THREE.Vector3(...offset)) > 0.00001 ||
      node.quaternion.angleTo(new THREE.Quaternion()) > 0.00001 ||
      node.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 0.00001 ||
      (parent && node.parent !== parent)
    ) {
      throw new Error(`Invalid humanoid pivot: ${id}`)
    }
    return node
  }
  for (const joint of profile.joints) {
    const node = validate(joint.id, joint.offset, joint.parent ? nodes.get(joint.parent) : undefined)
    nodes.set(joint.id, node)
  }
  const scale = profile.height / 1.8
  for (const chain of profile.chains.filter((c) => c.group === 'arms')) {
    const first = validate(`${chain.id}.fingers`, [0, -0.08 * scale, -0.022 * scale], nodes.get(chain.end))
    validate(`${chain.id}.tips`, [0, -0.035 * scale, 0], first)
  }
  finishPrototype(scene)
  return nodes
}

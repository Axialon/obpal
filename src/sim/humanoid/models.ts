/** The authored skins share the simulation's named frames, at both levels of detail. */
import * as THREE from 'three'
import { finishPrototype } from '../kit/prototype'
import { obsidian, smokedGlass } from '../kit/surfaces'
import type { RigProfile } from './profile'
import { forgetPrototype, type Prototype } from '../kit/models'
import { softDesktop, softPhone } from './soft-materials'

// glTF animation names cannot contain dots; the anatomical IDs remain unchanged.
export const pivotName = (id: string) => id.replaceAll('.', '_')
export const modelName = (profile: RigProfile) => profile.model ?? (profile.id === 'morrow-v1' ? 'morrow' : 'keel')
const users = new Map<Prototype, number>()
export function retainSkin(profile: RigProfile) {
  const primary = modelName(profile)
  const names: Prototype[] = [primary, `${primary}-lod`]
  for (const name of names) users.set(name, (users.get(name) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    for (const name of names) {
      const count = (users.get(name) ?? 1) - 1
      if (count) users.set(name, count)
      else { users.delete(name); forgetPrototype(name) }
    }
  }
}

// Coarse-pointer Viewers omit the second specular lobe. The same shell colour,
// roughness and environment reflection keep the material hierarchy on phones.
const mobileFinishes = Object.fromEntries(
  Object.entries({ obsidian, smokedGlass }).map(([name, source]) => {
    const material = new THREE.MeshStandardMaterial({
      color: source.color,
      metalness: source.metalness,
      roughness: source.roughness,
    })
    material.userData.simShared = true
    return [name, material]
  }),
)
export function finishHumanoid(scene: THREE.Group, signal?: THREE.Material) {
  const mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const soft = mobile ? softPhone : softDesktop
  finishPrototype(scene, { ...(mobile ? mobileFinishes : {}), ...soft, softSignal: signal ?? soft.softAccent })
}

/** A soft model's knit suit: skinned meshes at the scene root, weighted to the named pivots. */
export function suitMeshes(scene: THREE.Object3D) {
  const suits: THREE.SkinnedMesh[] = []
  scene.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) suits.push(node as THREE.SkinnedMesh)
  })
  return suits
}

/**
 * Bind a suit to the given pivots (the live rig's), keeping the asset's own rest inverses. The rig root is the asset's
 * scene root, so the bind frame is the identity; attached binding then follows the rig wherever it is placed. The suit
 * is never culled, since a raised limb leaves its rest bounds.
 */
export function bindSuit(suit: THREE.SkinnedMesh, pivots: ReadonlyMap<string, THREE.Object3D>) {
  const byName = new Map([...pivots].map(([id, node]) => [pivotName(id), node]))
  const bones = suit.skeleton.bones.map((bone) => {
    const node = byName.get(bone.name)
    if (!node) throw new Error(`Invalid humanoid suit joint: ${bone.name}`)
    return node as THREE.Bone
  })
  suit.bind(new THREE.Skeleton(bones, suit.skeleton.boneInverses.map((m) => m.clone())), new THREE.Matrix4())
  suit.frustumCulled = false
}

/** Reject a whole asset before touching a live rig, including rotated or scaled frames. */
export function modelPivots(scene: THREE.Group, profile: RigProfile, signal?: THREE.Material) {
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
    const second = validate(`${chain.id}.tips`, [0, -0.035 * scale, 0], first)
    validate(`${chain.id}.distal`, [0, -0.029 * scale, 0], second)
  }
  for (const suit of suitMeshes(scene)) {
    if (suit.parent !== scene || !suit.matrix.equals(new THREE.Matrix4())) throw new Error('Invalid humanoid suit frame')
    bindSuit(suit, nodes)
  }
  finishHumanoid(scene, signal)
  return nodes
}

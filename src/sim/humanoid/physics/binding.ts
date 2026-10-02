/** Pure read-only conversion. Validate the entire frame BEFORE a renderer mutates any Object3D. */
import type { RigProfile } from '../profile'
import { vector } from '../../physics/schema'
import { IDENTITY, ZERO, quaternion, conjugate, multiply, rotate, sub } from '../../physics/math'
import type { WorldFrame } from './model'
export function localRigFrames(profile: RigProfile, input: Readonly<Record<string, WorldFrame>>) {
  if (Object.keys(input).length !== profile.joints.length) throw new RangeError('Incomplete rig frame set')
  const world: Record<string, WorldFrame> = {}
  for (const j of profile.joints) {
    const f = input[j.id]
    if (!f) throw new RangeError(`Missing rig frame ${j.id}`)
    world[j.id] = { position: vector(f.position, 10000, 'render position'), rotation: quaternion(f.rotation) }
  }
  const root = world[profile.root], joints: Record<string, WorldFrame> = {}
  for (const j of profile.joints) {
    const f = world[j.id], parent = j.parent ? world[j.parent] : root, inverse = conjugate(parent.rotation)
    joints[j.id] = j.parent ? { position: rotate(inverse, sub(f.position, parent.position)), rotation: quaternion(multiply(inverse, f.rotation)) } :
      { position: { ...ZERO }, rotation: { ...IDENTITY } }
  }
  return { root, joints, world }
}

/** Replace only explicitly declared appearance slots. The unit stays out of view until its skins are in. */
import * as THREE from 'three'
import { batch } from './index'
import { finishPrototype, loadPrototype, prototypeNodes, retirePrototype, type Prototype } from './prototype'
import { holdRig, type RigHold } from './reveal'

export function skinSlot(parent: THREE.Object3D, name: string, ...parts: THREE.Object3D[]) {
  const slot = new THREE.Group(); slot.name = name; parent.add(slot)
  if (parts.length) slot.add(...parts)
  return slot
}

/** The unit a slot belongs to: the top of its tree, or the child of the scene it stands in. */
function unitOf(slot: THREE.Object3D) {
  let top = slot
  while (top.parent && !(top.parent as THREE.Scene).isScene) top = top.parent
  return top
}

/**
 * Swaps the procedural stand-ins in `slots` for the Blender mesh, once it is here. Until then the whole `unit` (the
 * tree the slots stand in, unless a view says otherwise) is held out of view, and comes in with the finished skins. If
 * the mesh cannot come, the unit is shown as it was built. The hold it returns takes what stands beside the unit (alongside).
 */
export function upgradeSkins(name: Prototype, slots: Record<string, THREE.Object3D>, invalidate: () => void = () => {}, unit?: THREE.Object3D): RigHold {
  const owners = Object.values(slots).map(slot => slot.parent)
  const hold = holdRig(name, [unit ?? unitOf(Object.values(slots)[0])])
  void loadPrototype(name).then(scene => {
    if (!scene || Object.values(slots).some((slot, i) => slot.parent !== owners[i])) return hold.fallback()
    const source = prototypeNodes(scene, Object.keys(slots))
    finishPrototype(scene)
    hold.install(() => {
      for (const [key, slot] of Object.entries(slots)) {
        for (const part of [...slot.children]) retirePrototype(part)
        for (const part of [...source[key].children]) slot.add(part)
        slot.traverse(part => { if (part !== slot && (part.type === 'Object3D' || part instanceof THREE.Group)) part.userData.static = true })
        batch(slot)
      }
      invalidate()
    })
  }).catch(() => hold.fallback()) // A failed optional skin leaves its working placeholder in place.
  return hold
}

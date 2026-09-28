/** Replace only explicitly declared appearance slots, after the procedural first paint. */
import * as THREE from 'three'
import { batch } from './index'
import { finishPrototype, loadPrototype, prototypeNodes, retirePrototype, type Prototype } from './prototype'

export function skinSlot(parent: THREE.Object3D, name: string, ...parts: THREE.Object3D[]) {
  const slot = new THREE.Group(); slot.name = name; parent.add(slot)
  if (parts.length) slot.add(...parts)
  return slot
}

export function upgradeSkins(name: Prototype, slots: Record<string, THREE.Object3D>, invalidate: () => void = () => {}) {
  const owners = Object.values(slots).map(slot => slot.parent)
  void loadPrototype(name).then(scene => {
    if (!scene || Object.values(slots).some((slot, i) => slot.parent !== owners[i])) return
    const source = prototypeNodes(scene, Object.keys(slots))
    finishPrototype(scene)
    for (const [key, slot] of Object.entries(slots)) {
      for (const part of [...slot.children]) retirePrototype(part)
      for (const part of [...source[key].children]) slot.add(part)
      slot.traverse(part => { if (part !== slot && (part.type === 'Object3D' || part instanceof THREE.Group)) part.userData.static = true })
      batch(slot)
    }
    invalidate()
    performance.mark(`obpal:${name}:visible`)
  }).catch(() => { /* A failed optional skin leaves its working placeholder intact. */ })
}

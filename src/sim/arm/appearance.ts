import { contactPart, contactFrame } from '../contact'
/** Optional authored rigid skins. The original joints, fingers and contact frames remain authoritative. */
import * as THREE from 'three'
import type { ArmModel } from './model'
import type { ArmKindId } from './kinds'
import { finishPrototype, loadPrototype, retirePrototype } from '../kit/prototype'
import { pov } from '../kit/precision'
import { supportVertices } from '../kit/support'

export function armAppearance(name: ArmKindId, model: ArmModel): ArmModel {
  contactFrame(model.root, `arm-${name}-base`)
  let finger = 0
  model.root.traverse(part => { if (part.name.startsWith('finger')) {
    part.castShadow = true
    contactPart(part, `finger-${++finger}`, { mode: 'clear', collides: 'stock' })
  } })
  pov(model.grasp.parent!, [0, .035, .05], [0, 1, 0])
  if (name === 'so101') return model
  model.root.userData.prototype = 'procedural'
  model.upgrade = async () => {
    const scene = await loadPrototype(name)
    if (!scene) return null
    finishPrototype(scene)
    const replacements: { source: THREE.Object3D; target: THREE.Object3D }[] = []
    for (const source of scene.children) {
      const target = model.root.getObjectByName(source.name)
      if (!target) throw new Error(`Missing ${name} appearance frame: ${source.name}`)
      replacements.push({ source, target })
    }
    return () => {
      for (const { source, target } of replacements) {
        if (target === model.root) {
          // Authored base chamfers leave their face above the mounting plane. Correct the skin, never the joint frame.
          const bottom = Math.min(...supportVertices(source).map(p => p.y))
          if (Number.isFinite(bottom)) for (const mesh of source.children) mesh.position.y -= bottom
        }
        for (const old of [...target.children]) {
          if (!(old as THREE.Mesh).isMesh || old.children.length || old.name.startsWith('finger') || old.name === 'rod' || model.rings.includes(old as THREE.Mesh) || old === model.plate) continue
          retirePrototype(old)
        }
        for (const part of [...source.children]) target.add(part)
      }
      contactFrame(model.root, `arm-${name}-base`)
      model.root.userData.prototype = 'blender'
      performance.mark(`obpal:${name}:visible`)
    }
  }
  return model
}

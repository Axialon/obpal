/** Rest-pose landmarks of a loaded soft humanoid, in metres at the profile's scale.
 *
 * Shared by the vitest form check and scripts/humanoid-proportions.mjs. Parts
 * belong to their nearest named pivot, so a merged multi-material mesh still
 * counts toward its frame. Targets and tolerances live in humanoid-forms.json.
 */
import * as THREE from 'three'

const owner = (object, pivots) => {
  let node = object.parent
  while (node && !pivots.has(node.name)) node = node.parent
  return node?.name
}

/** World-space vertices grouped by owning pivot, skipping the face light signature. */
export function partPoints(scene, pivots) {
  scene.updateMatrixWorld(true)
  const groups = new Map()
  const v = new THREE.Vector3()
  scene.traverse((object) => {
    if (!object.isMesh || object.material?.name === 'softSignal') return
    if (object.isSkinnedMesh) {
      // A skinned suit's vertex belongs to its most heavily weighted pivot, at its current pose.
      const { position, skinIndex, skinWeight } = object.geometry.attributes
      for (let i = 0; i < position.count; i++) {
        let heaviest = 0
        for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, heaviest)) heaviest = k
        const name = object.skeleton.bones[skinIndex.getComponent(i, heaviest)].name
        if (!pivots.has(name)) continue
        const list = groups.get(name) ?? []
        list.push(object.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(object.matrixWorld))
        groups.set(name, list)
      }
      return
    }
    const name = owner(object, pivots)
    if (!name) return
    const list = groups.get(name) ?? []
    const position = object.geometry.attributes.position
    for (let i = 0; i < position.count; i++) list.push(v.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).clone())
    groups.set(name, list)
  })
  return groups
}

const extent = (points, axis) => {
  let lo = Infinity, hi = -Infinity
  for (const p of points) { lo = Math.min(lo, p.getComponent(axis)); hi = Math.max(hi, p.getComponent(axis)) }
  return [lo, hi]
}
const size = (points, axis) => { const [lo, hi] = extent(points, axis); return hi - lo }

/** Landmarks named as in humanoid-forms.json. */
export function measure(scene, profile) {
  const pivots = new Set(profile.joints.map((j) => j.id.replaceAll('.', '_')))
  const groups = partPoints(scene, pivots)
  const s = profile.height / 1.8
  const get = (...names) => names.flatMap((name) => groups.get(name) ?? [])
  const all = [...groups.values()].flat()
  const top = extent(all, 1)[1]
  const head = get('head_pitch')
  const chin = Math.min(...head.filter((p) => p.z < -.055 * s && Math.abs(p.x) < .025 * s).map((p) => p.y))
  const node = (name) => scene.getObjectByName(name).getWorldPosition(new THREE.Vector3())
  const spine = node('spine_roll').y, hip = node('pelvis').y
  const slab = (points, y, half) => points.filter((p) => Math.abs(p.y - y) < half)
  const trunk = get('spine_roll', 'pelvis')
  const hips = slab(get('pelvis', 'left_leg_yaw', 'right_leg_yaw'), hip - .03 * s, .09 * s)
  const waist = slab(trunk, spine + .07 * s, .012 * s)
  return {
    height: top,
    headHeight: top - chin,
    headsTall: profile.height / (top - chin),
    headBreadth: size(head, 0),
    headDepthRatio: size(head, 2) / size(head, 0),
    shoulderSpan: size(get('spine_roll', 'left_arm_yaw', 'right_arm_yaw'), 0),
    upperArmWidth: size(get('right_arm_yaw'), 0),
    hipBreadth: size(hips, 0),
    waistBreadth: size(waist, 0),
    waistToHip: size(waist, 0) / size(hips, 0),
  }
}

/** The right shoe in its ankle frame, against the physics foot box (profile skin). */
export function shoe(scene, profile) {
  scene.updateMatrixWorld(true)
  const ankle = scene.getObjectByName('right_leg_ankle_roll')
  const pivots = new Set(profile.joints.map((j) => j.id.replaceAll('.', '_')))
  const inverse = ankle.matrixWorld.clone().invert()
  const points = (partPoints(scene, pivots).get('right_leg_ankle_roll') ?? []).map((p) => p.applyMatrix4(inverse))
  const skin = profile.skins.find((k) => k.joint === 'right.leg.ankle.roll' && k.finish === 'trim')
  const box = {
    min: skin.offset.map((o, i) => o - skin.size[i] / 2),
    max: skin.offset.map((o, i) => o + skin.size[i] / 2),
  }
  const [z0, z1] = extent(points, 2)
  const toe = points.filter((p) => p.z < z0 + (z1 - z0) * .15)
  return {
    box,
    min: [0, 1, 2].map((axis) => extent(points, axis)[0]),
    max: [0, 1, 2].map((axis) => extent(points, axis)[1]),
    lengthCoverage: (z1 - z0) / skin.size[2],
    toeSpring: Math.min(...toe.map((p) => p.y)) - box.min[1],
  }
}

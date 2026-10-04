/**
 * The v3 soft suits' glTF skin. Blender exports the suit as a plain mesh; humanoid_skin.py writes its weights and knit
 * tones beside the GLB, keyed by vertex position. This adds JOINTS_0, WEIGHTS_0 and COLOR_0 to the suit's primitives and
 * a skin whose joints are the existing pivot nodes, so no extra node, name or transform enters the rig.
 */

const key = (x, y, z) => `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`

/** Rest world translation of a node: the pivots carry translation only, which is checked here. */
function restWorld(doc, index) {
  const parents = new Map()
  doc.nodes.forEach((node, i) => (node.children ?? []).forEach(child => parents.set(child, i)))
  const p = [0, 0, 0]
  for (let n = index; n !== undefined; n = parents.get(n)) {
    const node = doc.nodes[n]
    const q = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1]
    if (Math.abs(q[3]) < 1 - 1e-9 || s.some(v => Math.abs(v - 1) > 1e-9) || node.matrix) throw new Error(`Rotated or scaled pivot: ${node.name}`)
    const t = node.translation ?? [0, 0, 0]
    for (let k = 0; k < 3; k++) p[k] += t[k]
  }
  return p
}

/**
 * Adds the skin to `doc`. `read(accessor)` returns an accessor's float data; `append(typed, accessor)` stores new
 * attribute data and returns its accessor index. Returns the inverse bind matrices for the caller to store.
 */
export function addSkin(doc, sidecar, read, append) {
  const nodeIndex = doc.nodes.findIndex(n => n.name === sidecar.mesh && n.mesh !== undefined)
  if (nodeIndex < 0) throw new Error(`Skinned ${sidecar.mesh} is missing from the export`)
  const node = doc.nodes[nodeIndex]
  if (doc.nodes.some(n => (n.children ?? []).includes(nodeIndex))) throw new Error('The suit must sit at the scene root')
  if (node.translation || node.rotation || node.scale || node.matrix) throw new Error('The suit must be untransformed')
  const joints = sidecar.joints.map(name => {
    const matches = doc.nodes.flatMap((n, i) => n.name === name ? [i] : [])
    if (matches.length !== 1) throw new Error(`Suit joint ${name} must name one pivot`)
    return matches[0]
  })
  const table = new Map()
  for (const [co, ids, weights, tint] of sidecar.vertices) table.set(key(...co), { ids, weights, tint })
  for (const primitive of doc.meshes[node.mesh].primitives) {
    const positions = read(primitive.attributes.POSITION)
    const count = positions.length / 3
    const ids = new Uint16Array(count * 4), weights = new Float32Array(count * 4), colours = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const row = table.get(key(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]))
      if (!row) throw new Error(`Suit vertex ${i} has no weights`)
      const total = row.weights.reduce((a, b) => a + b, 0)
      row.ids.forEach((id, k) => { ids[i * 4 + k] = id; weights[i * 4 + k] = row.weights[k] / total })
      colours.set(row.tint, i * 3)
    }
    primitive.attributes.JOINTS_0 = append(ids, { componentType: 5123, count, type: 'VEC4' })
    primitive.attributes.WEIGHTS_0 = append(weights, { componentType: 5126, count, type: 'VEC4' })
    primitive.attributes.COLOR_0 = append(colours, { componentType: 5126, count, type: 'VEC3' })
  }
  const inverse = new Float32Array(joints.length * 16)
  joints.forEach((joint, j) => {
    const p = restWorld(doc, joint)
    inverse.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], j * 16)
  })
  doc.skins = [{ name: 'Suit', joints }]
  node.skin = 0
  return inverse
}

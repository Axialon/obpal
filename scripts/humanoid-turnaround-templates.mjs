/** Orthographic turnaround templates for commissioning soft-humanoid reference art.
 *
 * node scripts/humanoid-turnaround-templates.mjs [out-dir]
 * For each soft form: front, side and back sheets at 1 px/mm with a 10 cm grid,
 * the live profile's pivots (lime), the physics boxes of the head and feet
 * (dashed) and the current hero mesh as a grey orthographic silhouette. The
 * overlay comes from profile data, so reference art drawn on it respects the
 * fixed joint frames. Writes PNGs to the given or a new temporary folder.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { readModel } from '../assets/blender/read-model.mjs'
import { SOFT_PROFILES } from '../src/sim/humanoid/profile.ts'

const sharp = createRequire(import.meta.url)('sharp')
const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'obpal-turnarounds-'))
mkdirSync(out, { recursive: true })
await MeshoptDecoder.ready
const W = 1000, H = 2000, floor = 1900, mm = 1000
const views = { front: (p) => [W / 2 - p.x * mm, floor - p.y * mm], side: (p) => [W / 2 - p.z * mm, floor - p.y * mm], back: (p) => [W / 2 + p.x * mm, floor - p.y * mm] }
const rest = (profile) => {
  const at = new Map()
  for (const joint of profile.joints) {
    const parent = joint.parent ? at.get(joint.parent) : new THREE.Vector3()
    at.set(joint.id, parent.clone().add(new THREE.Vector3(...joint.offset)))
  }
  return at
}
for (const profile of Object.values(SOFT_PROFILES).flat().filter((p) => p.model.startsWith('cairn'))) {
  const scene = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(readModel(profile.model), '')).scene
  scene.updateMatrixWorld(true)
  const triangles = []
  scene.traverse((o) => {
    if (!o.isMesh) return
    const position = o.geometry.attributes.position, index = o.geometry.index
    for (let i = 0; i < index.count; i++) triangles.push(new THREE.Vector3().fromBufferAttribute(position, index.getX(i)).applyMatrix4(o.matrixWorld))
  })
  const pivots = rest(profile)
  for (const [view, project] of Object.entries(views)) {
    const parts = [`<rect width="${W}" height="${H}" fill="#f4f4f2"/>`]
    for (let x = W / 2 % 100; x < W; x += 100) parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#d6d8d6" stroke-width="${Math.abs(x - W / 2) < 1 ? 2 : 1}"/>`)
    for (let y = floor; y > 0; y -= 100) parts.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#d6d8d6" stroke-width="${y === floor ? 3 : 1}"/><text x="6" y="${y - 4}" font-size="18" fill="#888" font-family="monospace">${((floor - y) / 1000).toFixed(1)} m</text>`)
    // Rasterise the silhouette directly: an SVG path of every triangle is too large to render.
    const mask = new Uint8Array(W * H)
    for (let i = 0; i < triangles.length; i += 3) {
      const [a, b, c] = triangles.slice(i, i + 3).map(project)
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
      if (!area) continue
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + .5, py = y + .5
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) mask[y * W + x] = 1
      }
    }
    const silhouette = Buffer.alloc(W * H * 4)
    for (let i = 0; i < mask.length; i++) if (mask[i]) silhouette.writeUInt32BE(0x9aa09d8c, i * 4)
    for (const skin of profile.skins.filter((s) => (s.joint === 'head.pitch' && s.finish === 'shell') || s.joint.endsWith('ankle.roll'))) {
      const centre = pivots.get(skin.joint).clone().add(new THREE.Vector3(...skin.offset))
      const half = new THREE.Vector3(...skin.size).multiplyScalar(.5)
      const corners = [[-1, -1, -1], [1, 1, 1]].map(([a, b, c]) => project(centre.clone().add(new THREE.Vector3(a * half.x, b * half.y, c * half.z))))
      const [x0, x1] = [corners[0][0], corners[1][0]].sort((a, b) => a - b), [y0, y1] = [corners[0][1], corners[1][1]].sort((a, b) => a - b)
      parts.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#5a6bd8" stroke-width="2" stroke-dasharray="8 6"/>`)
    }
    for (const [id, p] of pivots) {
      const [x, y] = project(p)
      parts.push(`<circle cx="${x}" cy="${y}" r="6" fill="#8fbf1a" stroke="#253200" stroke-width="2"><title>${id}</title></circle>`)
    }
    parts.push(`<text x="${W - 12}" y="40" text-anchor="end" font-size="26" font-family="monospace" fill="#333">${profile.model.replace('cairn-', 'Form ').toUpperCase()} ${view} · ${profile.height.toFixed(2)} m · 1 px = 1 mm</text>`)
    const [background, ...overlay] = parts
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${background}</svg>`))
      .composite([{ input: silhouette, raw: { width: W, height: H, channels: 4 } },
        { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${overlay.join('')}</svg>`) }])
      .png().toFile(join(out, `${profile.model.endsWith('-ii') ? 'form-ii' : 'form-i'}-${view}.png`))
  }
}
console.log(`Turnaround templates: ${out}`)

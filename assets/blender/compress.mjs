/** Meshopt-compress Blender's separate index/attribute streams; no external geometry or textures. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { MeshoptEncoder } from 'meshoptimizer/encoder'
import { MeshoptDecoder } from 'meshoptimizer/decoder'

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready])
const [input, name] = process.argv.slice(2)
if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid model name')
const raw = await readFile(input), jsonLength = raw.readUInt32LE(12)
const doc = JSON.parse(raw.subarray(20, 20 + jsonLength).toString())
const binary = raw.subarray(28 + jsonLength)
const buffers = [], views = [], accessors = [], remaps = new Map()
let offset = 0, fallback = 0
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
  for (const [semantic, index] of [...Object.entries(primitive.attributes), ['indices', primitive.indices]]) {
    if (remaps.has(index)) { if (semantic === 'indices') primitive.indices = remaps.get(index); else primitive.attributes[semantic] = remaps.get(index); continue }
    const a = doc.accessors[index], v = doc.bufferViews[a.bufferView]
    const size = components[a.type] * ({ 5126: 4, 5125: 4, 5123: 2 }[a.componentType])
    if (!size || v.byteStride && v.byteStride !== size) throw new Error('Expected separate Blender streams')
    let source = new Uint8Array(binary.subarray((v.byteOffset || 0) + (a.byteOffset || 0), (v.byteOffset || 0) + (a.byteOffset || 0) + a.count * size))
    const mode = semantic === 'indices' ? 'TRIANGLES' : 'ATTRIBUTES'
    let filter = 'NONE'
    if (a.componentType === 5126) {
      source = MeshoptEncoder.encodeFilterExp(new Float32Array(source.buffer), a.count, size, semantic === 'POSITION' ? 18 : 12, 'SharedComponent')
      filter = 'EXPONENTIAL'
    }
    const compressed = MeshoptEncoder.encodeGltfBuffer(source, a.count, size, mode)
    const ext = { buffer: 0, byteOffset: offset, byteLength: compressed.length, byteStride: size, count: a.count, mode, filter }
    // Decode every stream during authoring, catching invalid assets before they reach a browser.
    const decoded = new Uint8Array(a.count * size)
    MeshoptDecoder.decodeGltfBuffer(decoded, a.count, size, compressed, mode, filter)
    const view = { buffer: 1, byteOffset: fallback, byteLength: decoded.length, target: mode === 'TRIANGLES' ? 34963 : 34962, extensions: { EXT_meshopt_compression: ext } }
    views.push(view)
    const next = { ...a, bufferView: views.length - 1, byteOffset: 0 }
    if (semantic === 'POSITION') {
      const values = new Float32Array(decoded.buffer)
      next.min = [Infinity, Infinity, Infinity]; next.max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < values.length; i++) { next.min[i % 3] = Math.min(next.min[i % 3], values[i]); next.max[i % 3] = Math.max(next.max[i % 3], values[i]) }
    }
    remaps.set(index, accessors.length)
    if (semantic === 'indices') primitive.indices = accessors.length; else primitive.attributes[semantic] = accessors.length
    accessors.push(next)
    const pad = (4 - compressed.length % 4) % 4
    buffers.push(compressed, Buffer.alloc(pad)); offset += compressed.length + pad
    fallback += (decoded.length + 3) & ~3
  }
}
doc.accessors = accessors; doc.bufferViews = views
doc.buffers = [{ byteLength: offset }, { byteLength: fallback, extensions: { EXT_meshopt_compression: { fallback: true } } }]
doc.extensionsUsed = [...new Set([...(doc.extensionsUsed || []), 'EXT_meshopt_compression'])]
doc.extensionsRequired = [...new Set([...(doc.extensionsRequired || []), 'EXT_meshopt_compression'])]
doc.asset.generator = 'ob.Pal Blender scripts and meshoptimizer'
const text = Buffer.from(JSON.stringify(doc)), padding = Buffer.alloc((4 - text.length % 4) % 4, 32)
const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4)
header.writeUInt32LE(28 + text.length + padding.length + offset, 8); header.writeUInt32LE(text.length + padding.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(offset); binHeader.writeUInt32LE(0x004e4942, 4)
const glb = Buffer.concat([header, text, padding, binHeader, ...buffers])
await mkdir(new URL('../../public/models/', import.meta.url), { recursive: true })
await writeFile(new URL(`../../public/models/${name}.glb`, import.meta.url), glb)
const triangles = doc.meshes.flatMap(m => m.primitives).reduce((n, p) => n + accessors[p.indices].count / 3, 0)
console.log(JSON.stringify({ name, bytes: glb.length, triangles, draws: doc.meshes.flatMap(m => m.primitives).length }))

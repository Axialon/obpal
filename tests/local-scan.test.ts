import { describe, expect, it } from 'vitest'
import {
  describeModel, FileIndex, glbJson, gltfDependencies, isIgnoredDir, modelFormat, normalizePath, objMaterialLibs, refCandidates,
  scanFileList, scanTree, SCAN_LIMITS, stripTextureOptions, type ScanDir,
} from '../src/viewer/local-scan'

/** An in-memory folder tree for the scanner: strings are files, objects are folders. */
type Tree = { [name: string]: Tree | string }
function fake(tree: Tree, visits: string[] = [], at = ''): ScanDir<string> {
  return {
    async *entries() {
      visits.push(at)
      // Unsorted on purpose: the scanner sorts each folder itself.
      for (const name of Object.keys(tree).reverse()) {
        const v = tree[name]
        const p = at ? `${at}/${name}` : name
        yield typeof v === 'string' ? { kind: 'file', name, file: p } : { kind: 'dir', name, dir: fake(v, visits, p) }
      }
    },
  }
}
const nest = (depth: number, leaf: Tree): Tree => (depth === 0 ? leaf : { [`d${depth}`]: nest(depth - 1, leaf) })
const many = (n: number, ext = 'glb'): Tree => Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}.${ext}`, 'x']))

describe('supported files', () => {
  it('recognises the six model formats, case-insensitively', () => {
    expect(['a.glb', 'a.gltf', 'a.obj', 'a.stl', 'a.ply', 'a.fbx'].map(modelFormat)).toEqual(['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'])
    expect(modelFormat('Car.GLB')).toBe('glb')
    expect(modelFormat('my model.v2.Obj')).toBe('obj')
  })

  it('leaves out dependencies, other files and hidden files', () => {
    for (const n of ['scene.bin', 'wood.png', 'model.mtl', 'notes.txt', 'glb', 'obj.', '.glb', '._model.glb', '.hidden.fbx', 'model.glb.bak']) expect(modelFormat(n)).toBeNull()
  })

  it('never enters hidden folders, node_modules or zip debris', () => {
    for (const n of ['.git', '.cache', 'node_modules', '__MACOSX']) expect(isIgnoredDir(n)).toBe(true)
    for (const n of ['models', 'node', 'modules', 'textures.old']) expect(isIgnoredDir(n)).toBe(false)
  })

  it('describes a model for its tile: name without extension, folder as subtitle, format glyph', () => {
    expect(describeModel({ path: 'cars/sport/Rally car.glb', format: 'glb' }, 'Models')).toEqual({ id: 'local:cars/sport/Rally car.glb', name: 'Rally car', subtitle: 'cars/sport', glyph: 'GLB' })
    expect(describeModel({ path: 'bunny.ply', format: 'ply' }, 'Models').subtitle).toBe('Models')
    expect(describeModel({ path: 'x/scene.gltf', format: 'gltf' }, 'M').glyph).toBe('glTF')
  })
})

describe('relative paths for model dependencies', () => {
  const index = new FileIndex(
    ['car/scene.gltf', 'car/scene.bin', 'car/tex/Wood Grain.png', 'car/tex/metal.jpg', 'shared/textures/wood.png', 'shared/rough.png', 'deep/a/b/wood.png', 'crate/crate.obj', 'crate/crate.mtl', 'crate/crate_diffuse.tga', 'x.bin']
      .map((p) => [p, `file:${p}`] as [string, string]),
  )
  const find = (dir: string, ref: string) => index.find(dir, ref)?.path ?? null

  it('normalises paths: backslashes, "." and "..", never above the root', () => {
    expect(normalizePath('a\\b\\..\\c/./d.png')).toBe('a/c/d.png')
    expect(normalizePath('../../x.png')).toBe('x.png')
    expect(normalizePath('/a//b/')).toBe('a/b')
  })

  it('resolves glTF buffers and images next to, below and beside the model', () => {
    expect(find('car', 'scene.bin')).toBe('car/scene.bin')
    expect(find('car', './tex/metal.jpg')).toBe('car/tex/metal.jpg')
    expect(find('car', '../shared/rough.png')).toBe('shared/rough.png')
    expect(find('car', '../../../x.bin')).toBe('x.bin') // clamped at the folder root
  })

  it('decodes percent-encoded URIs and ignores a query or fragment', () => {
    expect(find('car', 'tex/Wood%20Grain.png')).toBe('car/tex/Wood Grain.png')
    expect(find('car', 'tex/metal.jpg?v=2')).toBe('car/tex/metal.jpg')
    expect(find('car', 'scene.bin#chunk')).toBe('car/scene.bin')
    expect(find('car', 'tex/50%.png')).toBeNull() // malformed escapes stay raw instead of throwing
  })

  it('matches case-insensitively and with Windows separators', () => {
    expect(find('car', 'TEX\\METAL.JPG')).toBe('car/tex/metal.jpg')
    expect(find('crate', 'Crate_Diffuse.TGA')).toBe('crate/crate_diffuse.tga')
  })

  it('maps an absolute path from the author machine by its trailing folders, then by name', () => {
    expect(find('car', 'C:\\Users\\art\\proj\\shared\\textures\\wood.png')).toBe('shared/textures/wood.png')
    expect(find('car', '/Users/art/Desktop/rough.png')).toBe('shared/rough.png')
    expect(find('car', 'file:///C:/art/tex/metal.jpg')).toBe('car/tex/metal.jpg')
  })

  it('falls back to the same file name elsewhere, nearest the model first', () => {
    expect(find('shared', 'maps/wood.png')).toBe('shared/textures/wood.png') // shares "shared/" with the model
    expect(find('deep/a', 'wood.png')).toBe('deep/a/b/wood.png')
    expect(find('car', 'nothing-like-this.png')).toBeNull()
  })

  it('strips MTL texture options before the file name', () => {
    expect(stripTextureOptions('-bm 0.5 -s 1 1 1 -clamp on crate_diffuse.tga')).toBe('crate_diffuse.tga')
    expect(stripTextureOptions('-o 0.2 0.1 my texture.png')).toBe('my texture.png')
    expect(stripTextureOptions('-imfchan l bump.png')).toBe('bump.png')
    expect(stripTextureOptions('-weird.png')).toBe('-weird.png')
    expect(find('crate', '-bm 0.3 crate_diffuse.tga')).toBe('crate/crate_diffuse.tga')
  })

  it('leaves web, data and blob URLs to the loader', () => {
    for (const u of ['https://example.com/a.bin', 'data:application/octet-stream;base64,AAAA', 'blob:http://localhost/1', '//cdn/x.png']) expect(index.find('car', u)).toBeNull()
  })

  it('tries relative paths before same-name matches', () => {
    expect(refCandidates('car', '../shared/rough.png')[0]).toBe('shared/rough.png')
    expect(refCandidates('', 'a%20b/c.png')).toEqual(['a b/c.png', 'a%20b/c.png'])
  })

  it('lists the files a glTF loads, skipping embedded data', () => {
    const json = { buffers: [{ uri: 'scene.bin' }, { uri: 'data:application/octet-stream;base64,AA==' }, { byteLength: 4 }], images: [{ uri: 'tex/Wood%20Grain.png' }, { bufferView: 2 }, { uri: 'scene.bin' }] }
    expect(gltfDependencies(json)).toEqual(['scene.bin', 'tex/Wood%20Grain.png'])
    expect(gltfDependencies(null)).toEqual([])
    expect(gltfDependencies({ buffers: 'nope' })).toEqual([])
  })

  it('reads the JSON chunk of a .glb', () => {
    const json = '{"asset":{"version":"2.0"},"buffers":[{"uri":"x.bin"}]} '
    const body = new TextEncoder().encode(json)
    const buf = new ArrayBuffer(20 + body.length)
    const v = new DataView(buf)
    v.setUint32(0, 0x46546c67, true)
    v.setUint32(4, 2, true)
    v.setUint32(8, buf.byteLength, true)
    v.setUint32(12, body.length, true)
    v.setUint32(16, 0x4e4f534a, true)
    new Uint8Array(buf, 20).set(body)
    expect(gltfDependencies(JSON.parse(glbJson(buf)!))).toEqual(['x.bin'])
    expect(glbJson(new TextEncoder().encode(json).buffer as ArrayBuffer)).toBeNull()
  })

  it('finds OBJ material libraries, names with spaces included', () => {
    expect(objMaterialLibs('# cube\nmtllib crate.mtl\r\nv 0 0 0\n  mtllib my model.mtl  \nusemtl a')).toEqual([['crate.mtl'], ['my model.mtl', 'my', 'model.mtl']])
    expect(objMaterialLibs('v 0 0 0\nf 1 2 3')).toEqual([])
  })
})

describe('scan limits', () => {
  it('walks breadth-first, lists models in folder order, indexes every file', async () => {
    const tree: Tree = { 'b.obj': 'x', 'b.mtl': 'x', cars: { 'z.glb': 'x', 'scene.bin': 'x', sport: { 'fast.gltf': 'x' } }, 'a.glb': 'x', trees: { 'oak 10.stl': 'x', 'oak 2.stl': 'x' } }
    const scan = await scanTree(fake(tree))
    expect(scan.models.map((m) => m.path)).toEqual(['a.glb', 'b.obj', 'cars/z.glb', 'cars/sport/fast.gltf', 'trees/oak 2.stl', 'trees/oak 10.stl'])
    expect(scan.models[0].format).toBe('glb')
    expect([...scan.files.keys()]).toContain('cars/scene.bin')
    expect(scan.files.get('b.mtl')).toBe('b.mtl')
    expect(scan.skipped).toEqual({ overLimit: 0, tooDeep: 0, ignored: 0, truncated: false })
  })

  it('skips hidden folders and node_modules without entering them', async () => {
    const visits: string[] = []
    const tree: Tree = { 'a.glb': 'x', '.git': { 'x.glb': 'x' }, node_modules: { pkg: { 'y.glb': 'x' } }, src: { '.cache': { 'z.glb': 'x' }, 'b.fbx': 'x', '._b.fbx': 'x' } }
    const scan = await scanTree(fake(tree, visits))
    expect(scan.models.map((m) => m.path)).toEqual(['a.glb', 'src/b.fbx'])
    expect(scan.skipped.ignored).toBe(3)
    expect(visits.some((v) => /git|node_modules|cache/.test(v))).toBe(false)
  })

  it('does not enter folders past the depth limit and counts them', async () => {
    const visits: string[] = []
    const tree: Tree = { 'top.glb': 'x', ...nest(10, { 'bottom.glb': 'x' }), side: nest(3, { 'mid.glb': 'x' }) }
    const scan = await scanTree(fake(tree, visits), { ...SCAN_LIMITS, maxDepth: 8 })
    expect(scan.models.map((m) => m.path)).toEqual(['top.glb', 'side/d3/d2/d1/mid.glb'])
    expect(scan.skipped.tooDeep).toBe(1)
    expect(Math.max(...visits.map((v) => (v ? v.split('/').length : 0)))).toBe(8)
  })

  it('lists at most maxModels models, shallow ones first, and counts the rest', async () => {
    const tree: Tree = { ...many(3), sub: many(5, 'stl') }
    const scan = await scanTree(fake(tree), { ...SCAN_LIMITS, maxModels: 4 })
    expect(scan.models.map((m) => m.path)).toEqual(['m0.glb', 'm1.glb', 'm2.glb', 'sub/m0.stl'])
    expect(scan.skipped.overLimit).toBe(4)
    expect(scan.skipped.truncated).toBe(false)
  })

  it('has a 500-model default limit', async () => {
    const scan = await scanTree(fake(many(520)))
    expect(scan.models.length).toBe(500)
    expect(scan.skipped.overLimit).toBe(20)
  })

  it('stops after maxEntries entries and says so', async () => {
    let seen = 0
    const visits: string[] = []
    const scan = await scanTree(fake({ ...many(30), more: many(30) }, visits), { ...SCAN_LIMITS, maxEntries: 20 }, (n) => { seen = n })
    expect(scan.skipped.truncated).toBe(true)
    expect(seen).toBe(20)
    expect(scan.models.length).toBe(19) // the 20 entries read were "more" and 19 files
    expect(visits).toEqual(['']) // stopped before entering "more"
    expect((await scanTree(fake(many(30)), { ...SCAN_LIMITS, maxEntries: 20 })).models.length).toBe(20)
  })

  it('leaves out an unreadable subfolder but fails when the folder itself is unreadable', async () => {
    const broken: ScanDir<string> = { entries: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('denied')) }) }) }
    const root: ScanDir<string> = { async *entries() { yield { kind: 'file', name: 'a.glb', file: 'a.glb' }; yield { kind: 'dir', name: 'locked', dir: broken } } }
    expect((await scanTree(root)).models.map((m) => m.path)).toEqual(['a.glb'])
    await expect(scanTree(broken)).rejects.toThrow('denied')
  })

  it('gives the same listing for a webkitdirectory file list', async () => {
    const tree: Tree = { 'a.glb': 'x', cars: { 'z.glb': 'x', 'scene.bin': 'x' }, '.git': { 'x.glb': 'x' }, node_modules: { pkg: { 'y.glb': 'x' } }, ...nest(10, { 'bottom.glb': 'x' }) }
    const flat: { path: string; file: string }[] = []
    const walk = (t: Tree, at: string) => { for (const [k, v] of Object.entries(t)) typeof v === 'string' ? flat.push({ path: `Models/${at}${k}`, file: `${at}${k}` }) : walk(v, `${at}${k}/`) }
    walk(tree, '')
    const list = scanFileList(flat)
    const walked = await scanTree(fake(tree))
    expect(list.root).toBe('Models')
    expect(list.models).toEqual(walked.models)
    expect(list.skipped).toEqual(walked.skipped)
    expect(list.files.get('cars/scene.bin')).toBe('cars/scene.bin')
  })

  it('applies the list limit to a file list, shallow files first', () => {
    const flat = [...Array.from({ length: 4 }, (_, i) => ({ path: `F/deep/m${i}.glb`, file: i })), ...Array.from({ length: 3 }, (_, i) => ({ path: `F/m${i}.obj`, file: i }))]
    const list = scanFileList(flat, { ...SCAN_LIMITS, maxModels: 5 })
    expect(list.models.map((m) => m.path)).toEqual(['m0.obj', 'm1.obj', 'm2.obj', 'deep/m0.glb', 'deep/m1.glb'])
    expect(list.skipped.overLimit).toBe(2)
  })

  it('handles a plain multi-file pick (no folder paths)', () => {
    const list = scanFileList([{ path: 'a.glb', file: 1 }, { path: 'b.png', file: 2 }])
    expect(list.root).toBe('')
    expect(list.models.map((m) => m.path)).toEqual(['a.glb'])
    expect(list.files.size).toBe(2)
  })
})

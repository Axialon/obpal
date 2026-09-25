/**
 * Pure parts of the Local folder catalogue (./local-folder.ts): which files are models, how a folder is walked
 * (what is skipped, depth and count limits), and how a path written inside a model file (a glTF buffer or image URI,
 * an OBJ `mtllib`, an MTL or FBX texture) resolves to a file in the connected folder.
 * No DOM and no three.js, so it runs in the unit tests.
 */

/** Formats the Local catalogue lists, by file extension, with the glyph their tiles show. */
export const MODEL_FORMATS = { glb: 'GLB', gltf: 'glTF', obj: 'OBJ', stl: 'STL', ply: 'PLY', fbx: 'FBX' } as const
export type ModelFormat = keyof typeof MODEL_FORMATS
const FORMAT_EXTS = new Set<string>(Object.keys(MODEL_FORMATS))

/** A scan lists at most maxModels files, enters folders at most maxDepth levels below the root and stops after maxEntries entries. */
export const SCAN_LIMITS = { maxModels: 500, maxDepth: 8, maxEntries: 20000 }
export type ScanLimits = typeof SCAN_LIMITS

/** What a scan left out: files past the list limit, folders past the depth limit, hidden and node_modules folders, and whether it stopped early. */
export interface Skipped { overLimit: number; tooDeep: number; ignored: number; truncated: boolean }
export interface ModelEntry { path: string; format: ModelFormat }
/** Listed models (folder-relative paths, sorted) and every file seen, for resolving model dependencies. */
export interface Scan<F> { models: ModelEntry[]; files: Map<string, F>; skipped: Skipped }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const natural = (a: string, b: string) => collator.compare(a, b)

export const dirname = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** The model format of a file name, or null: unsupported, or hidden (such as macOS "._model.glb" debris). */
export function modelFormat(name: string): ModelFormat | null {
  if (name.startsWith('.')) return null
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return FORMAT_EXTS.has(ext) ? (ext as ModelFormat) : null
}

/** Folders a scan never enters: hidden ones (.git, .cache, …), node_modules and macOS zip debris. */
export const isIgnoredDir = (name: string) => name.startsWith('.') || name === 'node_modules' || name === '__MACOSX'

/** "a/b/../c/./d.png" → "a/c/d.png". Backslashes count as slashes, and ".." never climbs above the folder root. */
export function normalizePath(p: string): string {
  const out: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** Web, data and blob URLs load as they are; they are never looked up in the folder. */
export const isExternalRef = (ref: string) => /^\s*(https?:|data:|blob:|\/\/)/i.test(ref)

/** MTL texture statements put options before the file name: "-bm 0.4 -clamp on normal map.png" → "normal map.png". */
const TEXTURE_OPTION_ARGS: Record<string, number> = {
  '-blendu': 1, '-blendv': 1, '-boost': 1, '-bm': 1, '-cc': 1, '-clamp': 1, '-imfchan': 1, '-mm': 2, '-o': 3, '-s': 3, '-t': 3, '-texres': 1, '-type': 1,
}
export function stripTextureOptions(value: string): string {
  const t = value.trim().split(/\s+/)
  let i = 0
  while (i < t.length - 1 && Object.prototype.hasOwnProperty.call(TEXTURE_OPTION_ARGS, t[i].toLowerCase())) {
    const max = TEXTURE_OPTION_ARGS[t[i].toLowerCase()]
    i++
    for (let n = 0; n < max && i < t.length - 1 && /^(-?\d*\.?\d+(e[-+]?\d+)?|on|off|[rgbmlz]|sphere|cube_\w+)$/i.test(t[i]); n++) i++
  }
  return i ? t.slice(i).join(' ') : value.trim()
}

const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/**
 * Folder paths to try, best first, for `ref` as written inside a model file that sits in `baseDir` ('' is the root).
 * glTF URIs are percent-encoded ("wood%20grain.png"); MTL and FBX paths are raw and may use backslashes, texture
 * options, or an absolute path from the author's machine ("C:\\art\\proj\\tex\\wood.png"). An absolute path is tried by
 * its trailing segments ("proj/tex/wood.png", "tex/wood.png", …), next to the model first, then from the root.
 */
export function refCandidates(baseDir: string, ref: string): string[] {
  let r = stripTextureOptions(ref).replace(/\\/g, '/')
  r = r.replace(/^file:\/\/(localhost)?/i, '')
  const variants = [decode(r), r]
  const q = r.search(/[?#]/)
  if (q > 0) variants.push(decode(r.slice(0, q)))
  const out: string[] = []
  for (const v of variants) {
    const absolute = /^\/|^[a-z]:\//i.test(v)
    if (!absolute) { out.push(normalizePath(`${baseDir}/${v}`)); continue }
    const segs = normalizePath(v.replace(/^[a-z]:/i, '')).split('/').filter(Boolean)
    for (let i = 0; i < segs.length; i++) {
      const tail = segs.slice(i).join('/')
      out.push(normalizePath(`${baseDir}/${tail}`))
      if (baseDir) out.push(tail)
    }
  }
  return [...new Set(out)].filter(Boolean)
}

/** Folder files by path, with case-insensitive and same-name fallbacks for references written on other machines. */
export class FileIndex<F> {
  private exact = new Map<string, F>()
  private lower = new Map<string, string>()
  private names = new Map<string, string[]>()

  constructor(files: Iterable<[string, F]> = []) {
    for (const [p, f] of files) this.add(p, f)
  }

  get size() { return this.exact.size }

  add(path: string, file: F) {
    if (this.exact.has(path)) return
    this.exact.set(path, file)
    const low = path.toLowerCase()
    if (!this.lower.has(low)) this.lower.set(low, path)
    const name = basename(low)
    const list = this.names.get(name)
    if (list) list.push(path)
    else this.names.set(name, [path])
  }

  get(path: string) { return this.exact.get(path) }

  /** The folder file `ref` points to, for a model file in `baseDir`; null for web/data/blob URLs or when nothing matches. */
  find(baseDir: string, ref: string): { path: string; file: F } | null {
    if (!ref.trim() || isExternalRef(ref)) return null
    const cands = refCandidates(baseDir, ref)
    for (const c of cands) {
      const p = this.exact.has(c) ? c : this.lower.get(c.toLowerCase())
      if (p !== undefined) return { path: p, file: this.exact.get(p)! }
    }
    // Last resort: a file with the same name anywhere in the folder, nearest the model first.
    for (const name of new Set(cands.map((c) => basename(c).toLowerCase()))) {
      const hits = this.names.get(name)
      if (!hits) continue
      const best = hits.reduce((a, b) => (nearer(baseDir, b, a) ? b : a))
      return { path: best, file: this.exact.get(best)! }
    }
    return null
  }
}

/** Is `a` a better same-name match than `b` for a model in `dir`: shares more leading folders, then is shallower. */
function nearer(dir: string, a: string, b: string) {
  const shared = (p: string) => {
    const x = dir ? dir.split('/') : []
    const y = dirname(p) ? dirname(p).split('/') : []
    let n = 0
    while (n < x.length && n < y.length && x[n].toLowerCase() === y[n].toLowerCase()) n++
    return n
  }
  const sa = shared(a)
  const sb = shared(b)
  if (sa !== sb) return sa > sb
  const da = a.split('/').length
  const db = b.split('/').length
  return da !== db ? da < db : a < b
}

/** Listing order: folder by folder (the root first), then by name, both in natural order ("part 2" before "part 10"). */
export function sortModels(models: ModelEntry[]): ModelEntry[] {
  return models.sort((a, b) => natural(dirname(a.path), dirname(b.path)) || natural(basename(a.path), basename(b.path)) || (a.path < b.path ? -1 : 1))
}

// ---- scanning ------------------------------------------------------------------------

export interface ScanFile<F> { kind: 'file'; name: string; file: F }
export interface ScanFolder<F> { kind: 'dir'; name: string; dir: ScanDir<F> }
/** A folder as the scanner sees it: a File System Access directory handle, or a fake one in the tests. */
export interface ScanDir<F> { entries(): AsyncIterable<ScanFile<F> | ScanFolder<F>> }

/**
 * Walk a folder breadth-first (so, when the list limit is reached, shallow files win), skipping hidden and node_modules
 * folders, folders deeper than maxDepth and hidden files, listing at most maxModels models and stopping after maxEntries entries.
 */
export async function scanTree<F>(root: ScanDir<F>, limits: ScanLimits = SCAN_LIMITS, progress?: (seen: number) => void): Promise<Scan<F>> {
  const files = new Map<string, F>()
  const models: ModelEntry[] = []
  const skipped: Skipped = { overLimit: 0, tooDeep: 0, ignored: 0, truncated: false }
  let seen = 0
  let level: { dir: ScanDir<F>; path: string; depth: number }[] = [{ dir: root, path: '', depth: 0 }]
  while (level.length && !skipped.truncated) {
    const next: typeof level = []
    for (const { dir, path, depth } of level) {
      const entries: (ScanFile<F> | ScanFolder<F>)[] = []
      try {
        for await (const e of dir.entries()) {
          if (seen >= limits.maxEntries) { skipped.truncated = true; break }
          seen++
          entries.push(e)
        }
      } catch (e) {
        if (!path) throw e // the folder itself is unreadable; an unreadable subfolder is left out
      }
      entries.sort((a, b) => natural(a.name, b.name))
      for (const e of entries) {
        const p = path ? `${path}/${e.name}` : e.name
        if (e.kind === 'dir') {
          if (isIgnoredDir(e.name)) skipped.ignored++
          else if (depth + 1 > limits.maxDepth) skipped.tooDeep++
          else next.push({ dir: e.dir, path: p, depth: depth + 1 })
        } else if (!e.name.startsWith('.')) {
          files.set(p, e.file)
          const format = modelFormat(e.name)
          if (!format) continue
          if (models.length < limits.maxModels) models.push({ path: p, format })
          else skipped.overLimit++
        }
      }
      progress?.(seen)
      if (skipped.truncated) break
    }
    level = next
  }
  return { models: sortModels(models), files, skipped }
}

/**
 * The same listing from a flat file list, as <input webkitdirectory> gives it (paths like "Folder/sub/model.glb").
 * The shared first segment is the folder's name (`root`); without one (a plain multi-file pick) root is ''.
 * The browser has already read the whole list, so nothing stops early; the list and depth limits still apply.
 */
export function scanFileList<F>(list: readonly { path: string; file: F }[], limits: ScanLimits = SCAN_LIMITS): Scan<F> & { root: string } {
  const split = list.map((f) => ({ segs: f.path.replace(/\\/g, '/').split('/').filter(Boolean), file: f.file })).filter((s) => s.segs.length)
  const first = split[0]?.segs[0]
  const root = split.length && split.every((s) => s.segs.length > 1 && s.segs[0] === first) ? first : ''
  const ignored = new Set<string>()
  const deep = new Set<string>()
  const kept: { path: string; depth: number; file: F }[] = []
  for (const s of split) {
    const segs = root ? s.segs.slice(1) : s.segs
    const dirs = segs.slice(0, -1)
    // Walk down the file's folders as scanTree would: the first ignored or too-deep folder decides.
    let k = 0
    while (k < dirs.length && !isIgnoredDir(dirs[k]) && k < limits.maxDepth) k++
    if (k < dirs.length) (isIgnoredDir(dirs[k]) ? ignored : deep).add(dirs.slice(0, k + 1).join('/'))
    else if (!segs[segs.length - 1].startsWith('.')) kept.push({ path: segs.join('/'), depth: dirs.length, file: s.file })
  }
  kept.sort((a, b) => a.depth - b.depth || natural(a.path, b.path))
  const files = new Map<string, F>()
  const models: ModelEntry[] = []
  let overLimit = 0
  for (const k of kept) {
    files.set(k.path, k.file)
    const format = modelFormat(basename(k.path))
    if (!format) continue
    if (models.length < limits.maxModels) models.push({ path: k.path, format })
    else overLimit++
  }
  return { root, models: sortModels(models), files, skipped: { overLimit, tooDeep: deep.size, ignored: ignored.size, truncated: false } }
}

// ---- catalogue entries and model dependencies ----------------------------------------------------

/** Catalogue id, tile name (file name without extension), subtitle (its folder, relative to the root) and format glyph of a model. */
export function describeModel(m: ModelEntry, rootName: string) {
  const file = basename(m.path)
  const dot = file.lastIndexOf('.')
  return { id: `local:${m.path}`, name: dot > 0 ? file.slice(0, dot) : file, subtitle: dirname(m.path) || rootName, glyph: MODEL_FORMATS[m.format] }
}

/** Files a glTF asset loads besides itself (buffers and images), as written in its JSON; embedded data URIs are skipped. */
export function gltfDependencies(json: unknown): string[] {
  const j = (json ?? {}) as { buffers?: unknown; images?: unknown }
  const list = [j.buffers, j.images].flatMap((a) => (Array.isArray(a) ? a : []))
  const uris = list.map((x) => (x as { uri?: unknown } | null)?.uri).filter((u): u is string => typeof u === 'string' && u.trim() !== '' && !/^data:/i.test(u))
  return [...new Set(uris)]
}

/** The JSON chunk of a binary glTF (.glb), or null when the buffer is not one. */
export function glbJson(buf: ArrayBuffer): string | null {
  if (buf.byteLength < 20) return null
  const v = new DataView(buf)
  if (v.getUint32(0, true) !== 0x46546c67) return null // 'glTF'
  const len = v.getUint32(12, true)
  if (v.getUint32(16, true) !== 0x4e4f534a || 20 + len > buf.byteLength) return null // 'JSON'
  return new TextDecoder().decode(new Uint8Array(buf, 20, len))
}

/**
 * The material libraries an OBJ names on its `mtllib` lines. Each entry lists the names to try: the whole value first
 * (exporters write "mtllib my model.mtl" unquoted), then its space-separated parts (the spec allows several files).
 */
export function objMaterialLibs(text: string): string[][] {
  const out: string[][] = []
  for (const m of text.matchAll(/^[ \t]*mtllib[ \t]+([^\r\n]+)/gm)) {
    const whole = m[1].trim()
    const parts = whole.split(/\s+/)
    if (whole) out.push(parts.length > 1 ? [whole, ...parts] : [whole])
  }
  return out
}

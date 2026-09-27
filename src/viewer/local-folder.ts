/**
 * Local folder catalogue: connect a folder on this device and its 3D files appear under "Local" in the catalogue and in
 * the phone's model picker, to view and control like the built-in models.
 *
 * - Chromium: showDirectoryPicker(), scanned recursively (limits and skips: ./local-scan.ts). The handle is kept in
 *   IndexedDB, so the next visit offers "Reconnect <folder>": the read permission prompt needs a click, so nothing is
 *   asked on load (a folder the browser still allows, e.g. "Allow on every visit", is read straight away).
 * - Other browsers: <input type="file" webkitdirectory>, for this session only.
 * - A file is read each time it is opened or added, so edits on disk show up. What it references (glTF buffers and
 *   images, OBJ material libraries, MTL and FBX textures) resolves to folder files through per-load LoadingManagers.
 *   Object URLs are made on demand and revoked, with the object's GPU memory, when it leaves the scene.
 * - Nothing leaves the device: files are never uploaded, and a reference that is not in the folder fails offline.
 *
 * Viewer hooks (main.ts): init() at boot, renderPanel() after the Local tiles render, release() when an object leaves the scene.
 */import { type Content, html, setMarkup } from '../ui/markup'

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { CATALOG, LOCAL_CATEGORY, setCategoryItems, type CatalogItem } from './catalog'
import { ICONS } from '../ui/icons'
import {
  describeModel, dirname, FileIndex, glbJson, gltfDependencies, isExternalRef, MODEL_FORMATS, objMaterialLibs, refCandidates,
  scanFileList, scanTree, SCAN_LIMITS, type ModelEntry, type ModelFormat, type Scan, type ScanDir, type Skipped,
} from './local-scan'

export interface LocalHost {
  /** A short status note. */
  note(text: string): void
  /** The Local panel changed (connected, scanning, disconnected…); `items` is true when local models were added or removed. */
  changed(items: boolean): void
}

type Permission = 'granted' | 'denied' | 'prompt'
/** Chromium's File System Access permission calls, which lib.dom does not declare. */
interface FolderHandle extends FileSystemDirectoryHandle {
  queryPermission?(o: { mode: 'read' }): Promise<Permission>
  requestPermission?(o: { mode: 'read' }): Promise<Permission>
}
type Picker = (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FolderHandle>
const pickerApi = () => window as unknown as { showDirectoryPicker?: Picker }

type Entry = FileSystemFileHandle | File
interface Source {
  /** 'handle': a File System Access folder (rescannable, remembered); 'files': an <input webkitdirectory> pick (this session). */
  kind: 'handle' | 'files'
  name: string
  index: FileIndex<Entry>
  /** Read a file the scan did not index (added since, or past the scan limit). */
  lookup?: (path: string) => Promise<File | null>
}
type Loaded = { scene: THREE.Object3D; animations: THREE.AnimationClip[] }

let host: LocalHost = { note: () => {}, changed: () => {} }
/** Chromium: the connected folder, or the remembered one waiting for a click to be read again. */
let handle: FolderHandle | null = null
let waiting = false
/** What the listed Local items read from, and what their scan left out. */
let source: Source | null = null
let skipped: Skipped | null = null
let busy: { name: string; seen: number } | null = null
let scanId = 0
let progress: HTMLElement | null = null
let input: HTMLInputElement | null = null
const sessions = new Set<Session>()

const notify = (items: boolean) => { try { host.changed(items) } catch (e) { console.error(e) } }
const count = (n: number) => n.toLocaleString('en')

// ---- remembering the folder (IndexedDB can store directory handles) ----------------------------

function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('obpal-local', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('folders')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      try {
        const tx = db.transaction('folders', mode)
        const req = op(tx.objectStore('folders'))
        tx.oncomplete = () => { db.close(); resolve(req.result) }
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error) }
      } catch (e) {
        db.close()
        reject(e)
      }
    }
  })
}
const remember = (h: FolderHandle | null) =>
  idb('readwrite', (s) => (h ? s.put(h, 'folder') : s.delete('folder')) as IDBRequest<unknown>).catch((e) => console.warn('Local folder: not remembered', e))
const remembered = () => idb<unknown>('readonly', (s) => s.get('folder')).catch(() => undefined)

/** Read permission for a folder handle; `ask` prompts (only valid inside a click). */
async function permission(h: FolderHandle, ask: boolean): Promise<Permission> {
  try {
    const now = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted'
    return now === 'granted' || !ask ? now : ((await h.requestPermission?.({ mode: 'read' })) ?? 'granted')
  } catch {
    return 'denied'
  }
}

// ---- connecting and scanning ----------------------------------------------------------------------

/** A Chromium folder, as the scanner walks it. */
const walk = (h: FileSystemDirectoryHandle): ScanDir<Entry> => ({
  async *entries() {
    for await (const e of h.values()) {
      if (e.kind === 'file') yield { kind: 'file' as const, name: e.name, file: e as FileSystemFileHandle }
      else yield { kind: 'dir' as const, name: e.name, dir: walk(e as FileSystemDirectoryHandle) }
    }
  },
})

async function lookup(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  try {
    const segs = path.split('/')
    let dir = root
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s)
    return await (await dir.getFileHandle(segs[segs.length - 1])).getFile()
  } catch {
    return null
  }
}

/** Show a scan's models as the Local collection, or clear it. */
function list(src: Source | null, scan?: Scan<Entry>) {
  source = src
  skipped = scan?.skipped ?? null
  setCategoryItems(LOCAL_CATEGORY, src && scan ? scan.models.map((m) => item(src, m)) : [])
}

function item(src: Source, m: ModelEntry): CatalogItem {
  return { ...describeModel(m, src.name), category: LOCAL_CATEGORY, load: () => load(src, m) }
}

/** Scan a folder into the Local collection; `cleared` when the previous listing was just removed (the phone must hear of it). */
async function scanFolder(h: FolderHandle, cleared = false) {
  const id = ++scanId
  busy = { name: h.name, seen: 0 }
  notify(cleared)
  try {
    const scan = await scanTree(walk(h), SCAN_LIMITS, (seen) => {
      if (id !== scanId || !busy) return
      busy.seen = seen
      if (progress) progress.textContent = `${count(seen)} scanned`
    })
    if (id !== scanId) return
    waiting = false
    list({ kind: 'handle', name: h.name, index: new FileIndex(scan.files), lookup: (p) => lookup(h, p) }, scan)
  } catch (e) {
    if (id !== scanId) return
    console.error(e)
    host.note(`Couldn't read ${h.name}`)
    list(null)
    waiting = true // offer Reconnect, or Forget
  } finally {
    if (id === scanId) {
      busy = null
      progress = null
      notify(true)
    }
  }
}

/** Connect a folder picked with showDirectoryPicker (or any directory handle). */
function useFolder(h: FolderHandle) {
  const had = !!source
  handle = h
  waiting = false
  list(null)
  void remember(h)
  return scanFolder(h, had)
}

/** Connect the files of an <input webkitdirectory> pick: the same listing, for this session only. */
function useFiles(files: File[]) {
  const scan = scanFileList(files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f as Entry })))
  scanId++
  busy = null
  if (handle) void remember(null)
  handle = null
  waiting = false
  list({ kind: 'files', name: scan.root || 'Files', index: new FileIndex(scan.files) }, scan)
  notify(true)
}

function pickFiles() {
  if (!input) {
    input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.webkitdirectory = true
    input.hidden = true
    input.addEventListener('change', () => {
      const files = Array.from(input!.files ?? [])
      input!.value = ''
      if (files.length) useFiles(files)
    })
    document.body.appendChild(input)
  }
  input.click()
}

/** "Connect a folder" (and "Change folder"): the folder picker where there is one, else the directory input. */
function connect() {
  const api = pickerApi()
  if (typeof api.showDirectoryPicker !== 'function') return pickFiles()
  api.showDirectoryPicker({ id: 'obpal-local', mode: 'read' }).then(
    (h) => useFolder(h),
    (e: unknown) => {
      const name = (e as DOMException | null)?.name
      if (name === 'AbortError') return
      if (name === 'SecurityError') return pickFiles() // pickers are blocked in this context
      console.error(e)
      host.note("Couldn't open that folder")
    },
  )
}

async function reconnect() {
  const h = handle
  if (!h || busy) return
  if ((await permission(h, true)) === 'granted') await scanFolder(h)
  else host.note('Folder access was not allowed')
}

async function refresh() {
  if (source?.kind === 'files') return pickFiles() // an input pick is a snapshot: pick again to see changes
  const h = handle
  if (!h || busy) return
  if ((await permission(h, true)) === 'granted') await scanFolder(h)
  else host.note('Folder access was not allowed')
}

function disconnect() {
  scanId++
  busy = null
  handle = null
  waiting = false
  void remember(null)
  list(null)
  notify(true)
}

/** Boot: offer the remembered folder again. Reads it only if the browser still allows it; never prompts on load. */
async function init(h: LocalHost) {
  host = h
  if (typeof pickerApi().showDirectoryPicker !== 'function' || typeof indexedDB === 'undefined') return
  const saved = (await remembered()) as FolderHandle | undefined
  if (saved?.kind !== 'directory' || handle || source || busy) return // nothing saved, or already connected meanwhile
  handle = saved
  if ((await permission(saved, false)) === 'granted') await scanFolder(saved)
  else {
    waiting = true
    notify(false)
  }
}

// ---- loading a model ---------------------------------------------------------------------------

/** A URL that fails without touching the network, for references that are not in the folder. */
const MISSING = 'obpal-missing:'
const NEUTRAL = '#cbd5e1' // the finish of a dropped STL (main.ts loadFile)

const materials = (o: THREE.Object3D): THREE.Material[] => {
  const m = (o as THREE.Mesh).material
  return Array.isArray(m) ? m : m ? [m] : []
}

const decodeImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('unreadable image'))
    img.src = src
  })

/** One loaded Local file, from loading until it leaves the scene: the files it read, their object URLs, its GPU resources. */
class Session {
  root: THREE.Object3D | null = null
  readonly missing = new Set<string>()
  private opened = new Map<string, Promise<{ path: string; file: File } | null>>()
  private files = new Map<string, File>()
  private urls = new Map<string, string>()
  private failed = new Set<THREE.Texture>()
  private pending = 0
  private disposed = false

  constructor(private src: Source) {}

  /** The folder file `ref` names, for a model file in `dir`; each file is read once per load. */
  open(dir: string, ref: string): Promise<{ path: string; file: File } | null> {
    if (isExternalRef(ref)) return Promise.resolve(null)
    const hit = this.src.index.find(dir, ref)
    const path = hit?.path ?? refCandidates(dir, ref)[0]
    if (path === undefined) return Promise.resolve(null)
    let p = this.opened.get(path)
    if (!p) {
      const read = hit ? (hit.file instanceof File ? Promise.resolve(hit.file) : hit.file.getFile()) : (this.src.lookup?.(path) ?? Promise.resolve(null))
      p = read.then((file) => (file ? (this.files.set(path, file), { path, file }) : null), () => null)
      this.opened.set(path, p)
    }
    return p
  }

  /** An object URL for a file this load opened, made on first use and revoked with the session. */
  url(path: string, file: File) {
    let u = this.urls.get(path)
    if (!u) this.urls.set(path, (u = URL.createObjectURL(file)))
    return u
  }

  /** Synchronous lookup (glTF loads its buffers and images through a URL modifier): only files opened beforehand resolve. */
  resolve(dir: string, ref: string) {
    if (isExternalRef(ref)) return ref
    const path = this.src.index.find(dir, ref)?.path ?? refCandidates(dir, ref)[0]
    const file = path === undefined ? undefined : this.files.get(path)
    if (path !== undefined && file) return this.url(path, file)
    this.missing.add(ref)
    return MISSING + encodeURIComponent(ref)
  }

  /** A LoadingManager for glTF files in `dir`: relative URLs map to the folder's files. */
  gltfManager(dir: string) {
    return new THREE.LoadingManager().setURLModifier((url) => this.resolve(dir, url))
  }

  /** A LoadingManager for MTL and FBX textures in `dir`: read on demand; nothing else may reach the network. */
  textureManager(dir: string) {
    return new THREE.LoadingManager().addHandler(/./, new FolderTextures(this, dir)).setURLModifier((url) => (isExternalRef(url) ? url : MISSING))
  }

  /** Follow a texture read in the background: a failure removes that map (instead of rendering black) and is reported. */
  track(tex: THREE.Texture, ref: string, job: Promise<void>) {
    this.pending++
    job
      .catch((e) => {
        if (this.disposed) return
        console.warn(`Local folder: texture ${ref}`, e)
        this.failed.add(tex)
        this.missing.add(ref)
      })
      .finally(() => {
        this.pending--
        this.settle()
      })
  }

  /** Parsed; `root` is what the viewer will show. */
  done(root: THREE.Object3D) {
    this.root = root
    this.settle()
  }

  private settle() {
    if (this.pending || !this.root || this.disposed) return
    if (this.failed.size) {
      this.root.traverse((o) => {
        for (const mat of materials(o)) {
          const m = mat as unknown as Record<string, unknown>
          let hit = false
          for (const [k, v] of Object.entries(m)) if (v instanceof THREE.Texture && this.failed.has(v)) { m[k] = null; hit = true }
          if (hit) mat.needsUpdate = true
        }
      })
      this.failed.clear()
    }
    if (this.missing.size) {
      const n = this.missing.size
      host.note(n === 1 ? `Not in the folder: ${[...this.missing][0].split(/[\\/]/).pop()}` : `${n} files are not in the folder`)
      this.missing.clear()
    }
  }

  /** Free what this model holds: its object URLs, geometry, materials and textures. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    sessions.delete(this)
    for (const u of this.urls.values()) URL.revokeObjectURL(u)
    this.urls.clear()
    this.root?.traverse((o) => {
      ;(o as THREE.Mesh).geometry?.dispose()
      ;(o as THREE.SkinnedMesh).skeleton?.dispose()
      for (const mat of materials(o)) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose()
        mat.dispose()
      }
    })
    this.root = null
  }
}

/** The texture loader MTL and FBX materials get: returns the texture at once and fills it when the folder file is decoded. */
class FolderTextures extends THREE.Loader<THREE.Texture> {
  constructor(private session: Session, private dir: string) {
    super()
  }

  override load(url: string, onLoad?: (t: THREE.Texture) => void, _onProgress?: unknown, onError?: (e: unknown) => void): THREE.Texture {
    const ref = (this.path || '') + url
    // Images embedded in an FBX arrive as blob: or data: URLs.
    if (/^(blob|data):/i.test(ref)) return new THREE.TextureLoader().load(ref, onLoad, undefined, onError)
    const tga = /\.tga$/i.test(ref)
    const tex = tga ? new THREE.DataTexture() : new THREE.Texture()
    const job = this.fill(tex, ref, tga).then(() => onLoad?.(tex), (e) => { onError?.(e); throw e })
    this.session.track(tex, ref, job)
    return tex
  }

  private async fill(tex: THREE.Texture, ref: string, tga: boolean) {
    const hit = await this.session.open(this.dir, ref)
    if (!hit) throw new Error('not in the folder')
    if (tga) {
      const { TGALoader } = await import('three/addons/loaders/TGALoader.js')
      const d = new TGALoader().parse(await hit.file.arrayBuffer())
      // What DataTextureLoader would do, minus the wrapping, which the MTL settings already chose.
      Object.assign(tex, { image: { data: d.data, width: d.width, height: d.height }, flipY: d.flipY ?? true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter })
    } else {
      tex.image = await decodeImage(this.session.url(hit.path, hit.file))
    }
    tex.needsUpdate = true
  }
}

/** OBJ material libraries, with textures read relative to each library. Several libraries merge, first definition wins. */
async function materialLibs(s: Session, dir: string, libs: string[][]): Promise<MTLLoader.MaterialCreator | null> {
  if (!libs.length) return null
  const mtl = await import('three/addons/loaders/MTLLoader.js')
  const creators: MTLLoader.MaterialCreator[] = []
  for (const names of libs) {
    const whole = await s.open(dir, names[0])
    const hits = whole ? [whole] : (await Promise.all(names.slice(1).map((n) => s.open(dir, n)))).filter((h) => h !== null)
    if (!hits.length) s.missing.add(names[0])
    for (const h of hits) {
      const creator = new mtl.MTLLoader(s.textureManager(dirname(h.path))).parse(await h.file.text(), '')
      creator.preload()
      creators.push(creator)
    }
  }
  if (creators.length < 2) return creators[0] ?? null
  return { create: (name: string) => (creators.find((c) => name in c.materialsInfo) ?? creators[0]).create(name) } as unknown as MTLLoader.MaterialCreator
}

/** Read and parse one model file. */
async function parse(s: Session, path: string, format: ModelFormat): Promise<Loaded> {
  const hit = await s.open('', path)
  if (!hit) throw new Error(`${path} is no longer in the folder`)
  const dir = dirname(path)
  if (format === 'glb' || format === 'gltf') {
    const buf = await hit.file.arrayBuffer()
    let json: unknown = null
    try { json = JSON.parse(glbJson(buf) ?? new TextDecoder().decode(buf)) } catch { /* GLTFLoader reports it */ }
    // glTF fetches buffers and images through a synchronous URL modifier: open them first.
    await Promise.all(gltfDependencies(json).map((u) => s.open(dir, u)))
    const gltf = await new GLTFLoader(s.gltfManager(dir)).parseAsync(buf, '')
    return { scene: gltf.scene, animations: gltf.animations }
  }
  if (format === 'obj') {
    const [{ OBJLoader }, text] = await Promise.all([import('three/addons/loaders/OBJLoader.js'), hit.file.text()])
    const loader = new OBJLoader()
    const mats = await materialLibs(s, dir, objMaterialLibs(text))
    if (mats) loader.setMaterials(mats)
    return { scene: loader.parse(text), animations: [] }
  }
  if (format === 'fbx') {
    const [{ FBXLoader }, buf] = await Promise.all([import('three/addons/loaders/FBXLoader.js'), hit.file.arrayBuffer()])
    const group = new FBXLoader(s.textureManager(dir)).parse(buf, '')
    return { scene: group, animations: group.animations }
  }
  // STL and PLY are bare geometry: the neutral finish of a dropped STL, or vertex colours when the file has them.
  const buf = await hit.file.arrayBuffer()
  const geo = format === 'stl'
    ? new (await import('three/addons/loaders/STLLoader.js')).STLLoader().parse(buf)
    : new (await import('three/addons/loaders/PLYLoader.js')).PLYLoader().parse(buf)
  const colored = geo.hasAttribute('color')
  const color = colored ? '#ffffff' : NEUTRAL
  if (format === 'ply' && !geo.index) {
    // A PLY without faces is a point cloud.
    return { scene: new THREE.Points(geo, new THREE.PointsMaterial({ color, vertexColors: colored, size: 2, sizeAttenuation: false })), animations: [] }
  }
  if (format === 'stl' || !geo.hasAttribute('normal')) geo.computeVertexNormals()
  return { scene: new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, vertexColors: colored, metalness: 0.25, roughness: 0.42 })), animations: [] }
}

async function load(src: Source, m: ModelEntry): Promise<Loaded> {
  const s = new Session(src)
  sessions.add(s)
  try {
    const out = await parse(s, m.path, m.format)
    s.done(out.scene)
    return out
  } catch (e) {
    s.dispose()
    throw e
  }
}

/** An object left the scene (or its load lost to a newer pick): if it is a Local file, revoke its object URLs and free its GPU memory. */
function release(obj: THREE.Object3D) {
  for (const s of sessions) {
    if (s.root !== obj) continue
    s.dispose()
    break
  }
}

// ---- the Local panel -------------------------------------------------------------------------------

/** The supported formats as a small wrapping row of labels. */
const FORMATS = html`<span class="lf-sub lf-formats">${Object.values(MODEL_FORMATS).map((f) => html`<i>${f}</i>`)}</span>`
const FOLDER_ADD = html`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7H9l1.9 2h7.9a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z"/><path d="M12 11.3v5M9.5 13.8h5"/></svg>`

function el(tag: string, cls: string, content: Content = '') {
  const e = document.createElement(tag)
  e.className = cls
  setMarkup(e, content)
  return e
}

function button(cls: string, content: Content, label: string, tip: string | null, run: () => void) {
  const b = el('button', cls, content) as HTMLButtonElement
  b.type = 'button'
  b.setAttribute('aria-label', label)
  if (tip) b.dataset.tip = tip
  b.onclick = run
  return b
}

/** Connect, reconnect or scanning card, or the connected folder's bar. */
function head(): HTMLElement {
  if (source) {
    const session = source.kind === 'files'
    const bar = el('div', 'lf-bar')
    const where = button('lf-where', html`${ICONS.folder}<span></span>`, `Change folder: ${source.name}`, session ? 'Pick another folder · this session only' : 'Change folder', connect)
    where.querySelector('span')!.textContent = source.name
    const again = button(busy ? 'lf-btn busy' : 'lf-btn', ICONS.rotate, 'Refresh', session ? 'Pick the folder again' : 'Refresh', () => void refresh())
    bar.append(where, again, button('lf-btn', ICONS.close, 'Disconnect', 'Disconnect', disconnect))
    return bar
  }
  const card = el('div', 'lf-card')
  if (busy) {
    card.classList.add('busy')
    card.setAttribute('role', 'status')
    setMarkup(card, html`<span class="lf-art"><i class="lf-ring"></i></span><span class="lf-title"></span><span class="lf-sub"></span>`)
    card.querySelector('.lf-title')!.textContent = busy.name
    progress = card.querySelector('.lf-sub')
    if (busy.seen) progress!.textContent = `${count(busy.seen)} scanned`
  } else if (waiting && handle) {
    const go = button('lf-go', html`<span class="lf-art">${ICONS.folder}</span><span class="lf-title">Reconnect</span><span class="lf-name"></span>`, `Reconnect ${handle.name}`, null, () => void reconnect())
    go.querySelector('.lf-name')!.textContent = handle.name
    card.append(go, button('lf-x', ICONS.close, 'Forget this folder', 'Forget', disconnect))
  } else {
    card.append(button('lf-go', html`<span class="lf-art">${FOLDER_ADD}</span><span class="lf-title">Connect a folder</span>${FORMATS}`, 'Connect a folder', null, connect))
  }
  return card
}

/** What the scan left out, as small pills (details on hover). */
function footnote(sk: Skipped) {
  const pills: [string, string][] = []
  if (sk.overLimit) pills.push([`+${count(sk.overLimit)} not listed`, `Lists the first ${count(SCAN_LIMITS.maxModels)} files`])
  if (sk.truncated) pills.push(['Scan stopped early', `Stops after ${count(SCAN_LIMITS.maxEntries)} files and folders`])
  if (sk.tooDeep) pills.push([`${count(sk.tooDeep)} too deep`, `Folders more than ${SCAN_LIMITS.maxDepth} levels down are skipped`])
  if (sk.ignored) pills.push([`${count(sk.ignored)} hidden`, 'Hidden folders and node_modules are skipped'])
  if (!pills.length) return null
  const foot = el('div', 'lf-foot')
  for (const [text, tip] of pills) {
    const p = el('span', 'lf-pill')
    p.textContent = text
    p.dataset.tip = tip
    foot.append(p)
  }
  return foot
}

/** Hook at the end of the viewer's renderTiles for the Local collection: it has built one tile per file already. */
function renderPanel(tiles: HTMLElement) {
  progress = null
  if (!source) document.getElementById('cat-count')!.textContent = ''
  const byId = new Map(CATALOG.map((i) => [i.id, i]))
  tiles.querySelectorAll<HTMLElement>('.tile').forEach((b) => {
    const it = byId.get(b.dataset.id ?? '')
    if (!it) return
    b.classList.add('lf-tile')
    b.dataset.tip = it.id.replace(/^local:/, '')
    const sub = el('span', 'tile-sub')
    sub.textContent = it.subtitle
    b.appendChild(sub)
  })
  tiles.prepend(head())
  if (source && !tiles.querySelector('.tile')) tiles.append(el('div', 'lf-empty', html`<span class="lf-art">${ICONS.cube}</span><span>No 3D files here</span>${FORMATS}`))
  const foot = source && skipped ? footnote(skipped) : null
  if (foot) tiles.append(foot)
}

export const localFolder = { init, renderPanel, release, connect, refresh, disconnect, useFolder, useFiles }

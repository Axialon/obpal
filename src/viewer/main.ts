import { setMarkup, insertMarkup, html } from '../ui/markup'
import { family } from '../family'
import '../styles/base.css'
import '../styles/viewer.css'
import * as THREE from 'three'
import CameraControls from 'camera-controls'
import { mountBodyCapture } from '../ui/body-capture'
import { mountSound } from '../sim/audio/session'
import { ObjectSound } from '../sim/audio/objects'
import { listenFrom } from '../sim/audio/context'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { GlowFollower, handMove, headingOf, Mode, PairingChip, PointerFlag, Remote, type Frame, type Layout, type ModeId, type PadState, type Participant, type PointerState } from '@obpal/host'
import { poseRelativeInView } from '@obpal/core'
import { CATALOG, CATEGORIES, DEFAULT_ITEM, LOCAL_CATEGORY, type CatalogItem } from './catalog'
import { localFolder } from './local-folder'
import { applyGamepad, type GamepadContext } from './gamepad-input'
import { ViewerHandInput } from './hand-input'
import { handGrabs } from '../ui/hand-control'
import { ENGINE_OF, Parts, type Hand, type Part } from './nodes'
import { ScreenPointer } from './pointer'
import { Tradeoff } from './tradeoff'
import { LIGHT_CONTROLS, LIGHT_PRESETS, loadLighting, saveLighting, type Lighting } from './lighting'
import { ICONS, logo, settleMotion } from '../ui/icons'
import { dismissHint, hint } from '../ui/hints'
import { initTips } from '../ui/tips'
import { holdForPhone } from '../ui/recover'
import { enhanceSelects } from '../ui/kit/select'
import { mountQuick, quickAction, quickViews } from '../ui/quick'
import { HandCursor } from '../ui/hand-cursor'
import { applyTheme, initialTheme, THEMES, themeById, type Theme } from '../ui/themes'
import { Experience } from '../sim/vr/experience'
import { SharedPresence } from '../sim/vr/presence'
import { looking, type Ride } from '../sim/vr/rigs'
import { ControlSession } from '../sim/control-space'

CameraControls.install({ THREE })
mountBodyCapture()

const D2R = Math.PI / 180
const GROUND_Y = -1.62
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

/** Visual identity per collection: rail icon and accent colour. */
const CAT_ART: Record<string, { color: string; icon?: string; image?: string }> = {
  cvc: { color: '#c4b5fd', image: '/models/cvc/icons/CVC_flat.svg' },
  engines: { color: '#22d3ee', icon: 'orbit' },
  pillars: { color: '#38bdf8', icon: 'diamond' },
  industries: { color: '#7dd3fc', icon: 'matrix' },
  studio: { color: '#a78bfa', icon: 'cube' },
  [LOCAL_CATEGORY]: { color: '#93c5fd', icon: 'folder' }, // Local folder catalogue (./local-folder.ts)
}

// ---- renderer, lighting, stage ---------------------------------------------

const canvas = $<HTMLCanvasElement>('scene')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
renderer.toneMapping = THREE.NeutralToneMapping // keeps brand colours true
renderer.toneMappingExposure = 0.82

const scene = new THREE.Scene()
scene.background = gradientTexture(512, 512, (ctx) => {
  const g = ctx.createRadialGradient(256, 210, 10, 256, 256, 400)
  g.addColorStop(0, '#16233b')
  g.addColorStop(0.5, '#0c1526')
  g.addColorStop(1, '#070d17')
  return g
})
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.55

// Studio rig: warm key, cool rim to separate dark metal from the backdrop, soft sky fill.
const key = new THREE.DirectionalLight(0xfff1e0, 1.35)
key.position.set(3.5, 5, 4.5)
const rim = new THREE.DirectionalLight(0x9cc3ff, 1.5)
rim.position.set(-4.5, 2.5, -4.5)
scene.add(key, rim, new THREE.HemisphereLight(0xd4e4ff, 0x0a1220, 0.22))

const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 500)
const controls = new CameraControls(camera, canvas)
controls.smoothTime = 0.09
controls.draggingSmoothTime = 0.05
controls.minDistance = 1.2
controls.maxDistance = 30
const HOME = new THREE.Vector3(0, 0.75, 6.2)
controls.setLookAt(HOME.x, HOME.y, HOME.z, 0, 0, 0, false)

// Procedural grid: lines are anti-aliased per pixel with screen-space derivatives and fade with distance,
// so they stay smooth at grazing angles instead of stepping like 1px GL lines.
const grid = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#6d86b3') }, uFade: { value: new THREE.Vector2(2.5, 14) }, uAlpha: { value: 1 } },
    vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
      varying vec3 vW;
      uniform vec3 uColor;
      uniform vec2 uFade;
      uniform float uAlpha;
      float gridLine(vec2 p, float size, float width) {
        vec2 r = p / size;
        vec2 d = abs(fract(r - 0.5) - 0.5) / fwidth(r);
        return 1.0 - clamp(min(d.x, d.y) / width, 0.0, 1.0);
      }
      void main() {
        float minor = gridLine(vW.xz, 0.5, 1.0);
        float major = gridLine(vW.xz, 2.5, 1.25);
        float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(vW.xz));
        float a = max(minor * 0.13, major * 0.3) * fade * uAlpha;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  }),
)
grid.rotation.x = -Math.PI / 2
grid.position.y = GROUND_Y
scene.add(grid)

const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(4.6, 4.6),
  new THREE.MeshBasicMaterial({
    map: gradientTexture(256, 256, (ctx) => {
      const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
      g.addColorStop(0, 'rgba(0,0,0,0.6)')
      g.addColorStop(0.55, 'rgba(0,0,0,0.25)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      return g
    }),
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  }),
)
shadow.rotation.x = -Math.PI / 2
shadow.position.y = GROUND_Y + 0.003
scene.add(shadow)

const holder = new THREE.Group()
scene.add(holder)

// Parts of the current model: hover cards, selection and per-part manipulation, for the screen and each device.
const partsSent = new Map<string, string>()
const partCamera = camera.clone()
const parts = new Parts(partCamera, scene, {
  changed: (hand) => {
    // The trade-off model highlights what the screen is on, else what the hand that just changed holds.
    const lead = parts.selected || parts.hovered ? parts.host : hand
    const focus = lead.selected ?? lead.hovered
    for (const e of sceneObjects) e.tradeoff?.setFocus(focus?.root === e.obj ? focus.key ?? null : null)
    if (hand.id !== 'host') {
      // Each device hears about its own hand: what it holds and what its cursor is on.
      const part = hand.selected?.title ?? ''
      const hov = hand.hovered?.title ?? ''
      if (partsSent.get(hand.id) !== `${part}\n${hov}`) {
        partsSent.set(hand.id, `${part}\n${hov}`)
        remote?.setValues({ part, hoverPart: hov, ...pillarValues(hand) }, hand.id)
      }
    } else if (hand.hovered?.movable && !anyPointer()) {
      hint('parts', () => document.querySelector('.node-card'), 'Click to select · drag to move · double-click to reset', { place: 'bottom', delay: 900 })
    }
    publishScene()
  },
  taken: (from, part) => remote?.feedback({ haptic: 'bump', toast: `The screen took ${part.title}` }, from.id),
})

// The composer renders off-screen, where the canvas's built-in anti-aliasing does not apply: use 4x MSAA targets.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }))
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.4, 0.9) // only the brightest emissive cuts glow
composer.addPass(bloom)
composer.addPass(new OutputPass())

/** Recolour the stage for a UI theme: backdrop gradient, grid tint and a rim light that picks up the accent. */
function applySceneTheme(t: Theme) {
  const old = scene.background as THREE.Texture | null
  scene.background = gradientTexture(512, 512, (ctx) => {
    const g = ctx.createRadialGradient(256, 210, 10, 256, 256, 400)
    g.addColorStop(0, t.scene[0])
    g.addColorStop(0.5, t.scene[1])
    g.addColorStop(1, t.scene[2])
    return g
  })
  old?.dispose?.()
  ;((grid.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).set(t.grid)
  rim.color.set(family.accentColor()).lerp(new THREE.Color('#ffffff'), 0.45)
  stageLight = t.light
  if (lighting) applyLighting()
}
/** Bloom reads as haze on a light backdrop, so the light surface keeps only a trace of the glow. */
let stageLight = false

function gradientTexture(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => CanvasGradient) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = paint(ctx)
  ctx.fillRect(0, 0, w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// ---- chrome: logo and icons -------------------------------------------------

setMarkup($('logo'), logo())
settleMotion()
initTips()
document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => insertMarkup(el, 'afterbegin', ICONS[el.dataset.icon!] ?? ''))

// ---- view state -----------------------------------------------------------

const view = {
  grid: store.get('obpal.view.grid') !== '0',
  glow: store.get('obpal.view.glow') !== '0',
  spin: false,
}

function applyView() {
  grid.visible = view.grid
  bloom.enabled = view.glow
  $('t-grid').setAttribute('aria-pressed', String(view.grid))
  $('t-glow').setAttribute('aria-pressed', String(view.glow))
  $('t-spin').setAttribute('aria-pressed', String(view.spin))
  store.set('obpal.view.grid', view.grid ? '1' : '0')
  store.set('obpal.view.glow', view.glow ? '1' : '0')
  remote?.setValues({ grid: view.grid, glow: view.glow, spin: view.spin })
}

// ---- lighting ------------------------------------------------------------------

let lighting = loadLighting()
const shadowMat = shadow.material as THREE.MeshBasicMaterial
function applyLighting() {
  const L = lighting.values
  renderer.toneMappingExposure = L.exposure
  scene.environmentIntensity = L.env
  scene.backgroundIntensity = L.backdrop
  key.intensity = L.key
  rim.intensity = L.rim
  bloom.strength = stageLight ? L.glow * 0.3 : L.glow
  bloom.threshold = stageLight ? Math.max(L.threshold, 0.96) : L.threshold
  bloom.radius = L.radius
  ;(grid.material as THREE.ShaderMaterial).uniforms.uAlpha.value = L.grid
  shadowMat.opacity = Math.min(1, L.shadow)
  saveLighting(lighting.preset, L)
  syncLightingUI()
}
function setPreset(id: string) {
  const p = LIGHT_PRESETS.find((x) => x.id === id)
  if (!p) return
  lighting = { preset: p.id, values: { ...p.values } }
  applyLighting()
  remote?.setValues({ light: p.id })
}
function syncLightingUI() {
  document.querySelectorAll<HTMLElement>('#lt-presets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === lighting.preset)))
  document.querySelectorAll<HTMLInputElement>('#lt-sliders input').forEach((i) => {
    const k = i.dataset.key as keyof Lighting
    if (document.activeElement !== i) i.value = String(lighting.values[k])
    i.closest('label')!.querySelector('output')!.textContent = lighting.values[k].toFixed(2)
  })
  family.syncRanges($('lt-sliders'))
}
function buildLightingUI() {
  const presets = $('lt-presets')
  for (const p of LIGHT_PRESETS) {
    const b = document.createElement('button')
    b.className = 'lt-chip'
    b.dataset.preset = p.id
    b.textContent = p.name
    b.onclick = () => setPreset(p.id)
    presets.appendChild(b)
  }
  const sliders = $('lt-sliders')
  for (const c of LIGHT_CONTROLS) {
    const l = document.createElement('label')
    l.className = 'bb-field'
    setMarkup(l, html`<span>${c.label}</span><output></output><input class="bb-range" type="range" min="${c.min}" max="${c.max}" step="${c.step}" data-key="${c.key}">`)
    l.querySelector('input')!.oninput = (e) => {
      lighting = { preset: 'custom', values: { ...lighting.values, [c.key]: Number((e.target as HTMLInputElement).value) } }
      applyLighting()
    }
    sliders.appendChild(l)
  }
  $('lt-reset').onclick = () => setPreset('studio')
}
function toggleLighting(open = $('lighting').hidden) {
  $('lighting').hidden = !open
  $('t-light').setAttribute('aria-pressed', String(open))
  if (open && !$('themes').hidden) toggleThemes(false)
}

function frameModel() { void controls.fitToBox(holder, true, { paddingTop: 0.55, paddingBottom: 0.55, paddingLeft: 0.55, paddingRight: 0.55 }) }
function resetView() {
  holder.quaternion.identity()
  void controls.setLookAt(HOME.x, HOME.y, HOME.z, 0, 0, 0, true)
}

// ---- catalogue: rail of collections, tiles of models --------------------------------

const loader = new GLTFLoader()
const cache = new Map<string, Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[] }>>()
let current: CatalogItem | null = null
let activeCat = CATEGORIES[0].id
let loadToken = 0
let pop = 1
const categoryName = (id: string) => CATEGORIES.find((c) => c.id === id)?.name ?? ''

function art(color: string, iconName?: string, image?: string, glyph?: string) {
  if (image) return html`<img src="${image}" alt="" loading="lazy" decoding="async">`
  if (iconName) return ICONS[iconName] ?? ''
  return html`<span style="color:${color}">${glyph ?? ''}</span>`
}

function renderRail() {
  const rail = $('rail')
  rail.replaceChildren()
  for (const cat of CATEGORIES) {
    const a = CAT_ART[cat.id]
    const b = document.createElement('button')
    b.className = 'cat-btn'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-label', cat.name)
    b.dataset.tip = cat.name
    b.dataset.tipSide = 'right'
    b.dataset.cat = cat.id
    setMarkup(b, art('', a.icon, a.image))
    b.onclick = () => {
      dismissHint('catalog')
      if ($('catalog').dataset.state === 'rail' || activeCat !== cat.id) { activeCat = cat.id; setCatalog(true); renderTiles(true) }
      else setCatalog(false)
    }
    rail.appendChild(b)
  }
  const t = document.createElement('button')
  t.className = 'rail-toggle'
  t.id = 'rail-toggle'
  t.setAttribute('aria-label', 'Collapse catalogue')
  t.dataset.tip = 'Collapse'
  t.dataset.tipSide = 'right'
  setMarkup(t, ICONS.left)
  t.onclick = () => setCatalog($('catalog').dataset.state === 'rail')
  rail.appendChild(t)
}

function renderTiles(animate = false) {
  const cat = CATEGORIES.find((c) => c.id === activeCat)!
  const items = CATALOG.filter((i) => i.category === cat.id)
  $('cat-name').textContent = cat.name
  $('cat-count').textContent = String(items.length)
  const tiles = $('tiles')
  tiles.replaceChildren()
  for (const item of items) {
    const b = document.createElement('button')
    b.className = 'tile'
    b.dataset.id = item.id
    b.dataset.tip = item.subtitle
    setMarkup(b, html`<span class="tile-art">${art('', undefined, item.icon, item.glyph)}</span><span class="tile-name"></span>`)
    b.querySelector('.tile-name')!.textContent = item.name
    b.onclick = (e) => { dismissHint('catalog'); void selectItem(item, e.shiftKey); if (innerWidth <= 860) setCatalog(false) }
    // Add alongside what's already in the scene (shift-click does the same).
    const add = document.createElement('span')
    add.className = 'tile-add'
    add.setAttribute('role', 'button')
    add.setAttribute('aria-label', `Add ${item.name} to the scene`)
    add.dataset.tip = 'Add to scene'
    setMarkup(add, ICONS.plus)
    add.onclick = (e) => { e.stopPropagation(); dismissHint('catalog'); dismissHint('add'); void selectItem(item, true) }
    b.appendChild(add)
    tiles.appendChild(b)
  }
  // Local folder: connect / reconnect card or folder bar, file paths under the tile names, what the scan skipped.
  if (cat.id === LOCAL_CATEGORY) localFolder.renderPanel(tiles)
  document.querySelectorAll<HTMLElement>('.cat-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cat === activeCat && $('catalog').dataset.state === 'open')))
  markCurrent()
  if (animate) { tiles.classList.remove('swap'); void tiles.offsetWidth; tiles.classList.add('swap') }
}

function setCatalog(open: boolean) {
  $('catalog').dataset.state = open ? 'open' : 'rail'
  watchInset()
  $('rail-toggle').setAttribute('aria-label', open ? 'Collapse catalogue' : 'Expand catalogue')
  $('rail-toggle').dataset.tip = open ? 'Collapse' : 'Expand'
  document.querySelectorAll<HTMLElement>('.cat-btn').forEach((b) => b.setAttribute('aria-selected', String(open && b.dataset.cat === activeCat)))
}

function markCurrent() {
  const inScene = new Set(sceneObjects.map((e) => e.item?.id))
  document.querySelectorAll<HTMLElement>('.tile').forEach((el) => el.setAttribute('aria-current', String(inScene.has(el.dataset.id))))
}

/**
 * The caption names what's on stage. With several objects it becomes the scene strip: one chip per object
 * (select it whole, or remove it), then arrange and clear.
 */
function renderScene(animate = true) {
  const cap = $('caption')
  const many = sceneObjects.length > 1
  cap.classList.toggle('scene', many)
  const strip = $('scene-strip')
  strip.hidden = !many
  $('cap-single').hidden = many
  if (!many) {
    const e = sceneObjects[0]
    $('cap-cat').textContent = e ? (e.catId ? categoryName(e.catId) : 'Your file') : ''
    $('cap-name').textContent = e?.name ?? 'Empty scene'
  } else {
    const sel = parts.selected?.kind === 'object' ? parts.selected.root : null
    strip.replaceChildren(...sceneObjects.map((e) => {
      const chip = document.createElement('div')
      chip.className = 'sc-chip'
      chip.setAttribute('aria-selected', String(sel === e.obj))
      setMarkup(chip, html`<button class="sc-pick"><span class="sc-dot"></span><span class="sc-name"></span></button><button class="sc-x">${ICONS.close}</button>`)
      chip.querySelector('.sc-name')!.textContent = e.name
      chip.querySelector('.sc-x')!.setAttribute('aria-label', `Remove ${e.name}`) // file names are user data: never through innerHTML
      ;(chip.querySelector('.sc-pick') as HTMLButtonElement).onclick = () => { parts.select(sel === e.obj ? null : parts.objectPart(e.obj)); renderScene(false) }
      ;(chip.querySelector('.sc-x') as HTMLButtonElement).onclick = () => { removeObject(e); renderScene(false) }
      return chip
    }))
    const tools = document.createElement('div')
    tools.className = 'sc-tools'
    setMarkup(tools, html`<button class="sc-tool" data-act="arrange" aria-label="Arrange in a row" data-tip="Arrange">${ICONS.arrange}</button><button class="sc-tool" data-act="clear" aria-label="Keep only the selected object" data-tip="Keep only this">${ICONS.solo}</button>`)
    ;(tools.querySelector('[data-act=arrange]') as HTMLButtonElement).onclick = () => { arrange(); frameModel() }
    ;(tools.querySelector('[data-act=clear]') as HTMLButtonElement).onclick = () => keepOnly(sceneObjects.find((e) => e.obj === sel) ?? sceneObjects[sceneObjects.length - 1])
    strip.appendChild(tools)
  }
  if (animate) { cap.classList.remove('swap'); void cap.offsetWidth; cap.classList.add('swap') }
  markCurrent()
  store.set('obpal.view.scene', JSON.stringify(sceneObjects.filter((e) => e.item).map((e) => e.item!.id)))
}

/** Tame authored emission so crystals glow without washing out the metal around them. */
function calm<T extends THREE.Object3D>(root: T): T {
  const seen = new Set<THREE.Material>()
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      if (seen.has(m)) continue
      seen.add(m)
      const std = m as THREE.MeshStandardMaterial
      if (typeof std.emissiveIntensity === 'number') std.emissiveIntensity *= 0.6
    }
  })
  return root
}

/** Open a catalogue model (replacing the scene), or add it alongside what's there. */
async function selectItem(item: CatalogItem, add = false) {
  const token = add ? loadToken : ++loadToken
  const loading = setTimeout(() => { $('loading').hidden = false; $('loading-text').textContent = item.name }, 160)
  try {
    let obj: THREE.Object3D
    let clips: THREE.AnimationClip[] = []
    if (item.make) {
      obj = item.make()
    } else if (item.load) {
      // Local folder files: read fresh each time (edits on disk show up), so not cached; freed when they leave the scene.
      const g = await item.load()
      obj = calm(g.scene)
      clips = g.animations
    } else {
      if (!cache.has(item.id)) cache.set(item.id, loader.loadAsync(item.src!).then((g) => ({ scene: calm(g.scene), clips: g.animations })))
      const g = await cache.get(item.id)!
      obj = g.scene.clone(true)
      clips = g.clips
    }
    if (token !== loadToken) { localFolder.release(obj); return } // a newer pick won (frees a Local file's resources)
    current = item
    if (add && sceneObjects.length) addAlongside(obj, clips, item, item.name, item.category)
    else showOnly(obj, clips, item, item.name, item.category)
    if (activeCat !== item.category) { activeCat = item.category; renderTiles() }
    remote?.setValues({ model: item.id })
    store.set('obpal.view.model', item.id)
  } catch (e) {
    cache.delete(item.id)
    console.error(e)
    note(`Couldn't load ${item.name}`)
  } finally {
    clearTimeout(loading)
    if (token === loadToken) $('loading').hidden = true
  }
}

function stepItem(dir: number) {
  const i = Math.max(0, CATALOG.findIndex((x) => x.id === current?.id))
  void selectItem(CATALOG[(i + dir + CATALOG.length) % CATALOG.length])
}

// ---- scene: one or more objects -------------------------------------------------------------------------------

interface SceneObject {
  item: CatalogItem | null
  name: string
  catId: string | null
  /** The loaded model, centred; `wrap` normalises its size and places it in the scene. */
  obj: THREE.Object3D
  wrap: THREE.Group
  /** Centred size in the model's own units (times wrap.scale = size on stage). */
  size: THREE.Vector3
  mixer: THREE.AnimationMixer | null
  tradeoff: Tradeoff | null
  tags: HTMLElement | null
  /** Its own contact shadow, once the scene has more than one object (one object keeps the stage shadow). */
  shadow: THREE.Mesh
  /** Entrance ease, 0..1. */
  pop: number
}
const sceneObjects: SceneObject[] = []
const OBJECT_SIZE = 3.1
const OBJECT_GAP = 0.5

function addObject(obj: THREE.Object3D, clips: THREE.AnimationClip[], item: CatalogItem | null, name: string, catId: string | null): SceneObject {
  const box = new THREE.Box3().setFromObject(obj)
  const size = box.getSize(new THREE.Vector3())
  obj.position.sub(box.getCenter(new THREE.Vector3()))
  const wrap = new THREE.Group()
  wrap.add(obj)
  wrap.scale.setScalar(OBJECT_SIZE / (size.length() || 1))
  holder.add(wrap)
  const e: SceneObject = { item, name, catId, obj, wrap, size, mixer: null, tradeoff: null, tags: null, shadow: shadow.clone(), pop: 1 }
  e.shadow.visible = false
  scene.add(e.shadow)
  parts.add(obj, wrap, item?.id ?? null, name)
  // A Blackboxes engine is a live trade-off model: its pillars re-solve as they move, with their own value tags.
  const engine = item ? ENGINE_OF[item.id] ?? null : null
  if (engine) {
    const tags = document.createElement('div')
    tags.className = 'to-group'
    $('tags').appendChild(tags)
    e.tradeoff = Tradeoff.attach(obj, engine, tags)
    if (e.tradeoff) {
      e.tags = tags
      parts.setTradeoff(obj, e.tradeoff)
      e.tradeoff.onChange = () => { parts.refreshCard(); sendPillar() }
    } else tags.remove()
  }
  if (clips.length) {
    e.mixer = new THREE.AnimationMixer(obj)
    for (const c of clips) e.mixer.clipAction(c).play() // authored motion (e.g. the CVC hover) loops
  }
  sceneObjects.push(e)
  $('tags').hidden = !sceneObjects.some((o) => o.tradeoff)
  return e
}

function removeObject(e: SceneObject) {
  const i = sceneObjects.indexOf(e)
  if (i < 0) return
  sceneObjects.splice(i, 1)
  parts.remove(e.obj)
  e.tradeoff?.dispose()
  e.tags?.remove()
  e.mixer?.stopAllAction()
  holder.remove(e.wrap)
  scene.remove(e.shadow)
  $('tags').hidden = !sceneObjects.some((o) => o.tradeoff)
  localFolder.release(e.obj) // a Local folder file: revoke its object URLs, free its GPU memory
}

/** Opening a model: it replaces the whole scene. */
function showOnly(obj: THREE.Object3D, clips: THREE.AnimationClip[], item: CatalogItem | null, name: string, catId: string | null) {
  for (const e of [...sceneObjects]) removeObject(e)
  parts.clear()
  holder.quaternion.identity()
  pop = 0
  addObject(obj, clips, item, name, catId)
  renderScene()
}

/** Adding a model: it joins the row to the right, and the camera takes in the whole scene. */
function addAlongside(obj: THREE.Object3D, clips: THREE.AnimationClip[], item: CatalogItem | null, name: string, catId: string | null) {
  const right = Math.max(...sceneObjects.map((o) => o.wrap.position.x + halfWidth(o)))
  const e = addObject(obj, clips, item, name, catId)
  e.wrap.position.set(right + OBJECT_GAP + halfWidth(e), 0, 0)
  e.pop = 0
  centreRow()
  renderScene()
  frameModel()
  hint('scene', () => document.querySelector('#scene-strip .sc-chip'), 'Pick a name to move that whole object · × removes it', { place: 'top', delay: 900 })
}

const halfWidth = (e: SceneObject) => (e.size.x * e.wrap.scale.x) / 2

/** Keep the row centred on the turntable (relative placement stays as the user left it). */
function centreRow() {
  if (!sceneObjects.length) return
  const lo = Math.min(...sceneObjects.map((o) => o.wrap.position.x - halfWidth(o)))
  const hi = Math.max(...sceneObjects.map((o) => o.wrap.position.x + halfWidth(o)))
  const dx = -(lo + hi) / 2
  for (const o of sceneObjects) { o.wrap.position.x += dx; parts.rebase(o.wrap) }
}

/** Tidy the scene into an evenly spaced row, in the order the objects were added. */
function arrange() {
  let x = 0
  for (const o of sceneObjects) {
    const h = halfWidth(o)
    o.wrap.position.set(x + h, 0, 0)
    x += 2 * h + OBJECT_GAP
  }
  centreRow()
}

function keepOnly(keep: SceneObject | undefined) {
  if (!keep) return
  for (const e of [...sceneObjects]) if (e !== keep) removeObject(e)
  keep.wrap.position.set(0, 0, 0)
  parts.rebase(keep.wrap)
  current = keep.item
  renderScene()
  frameModel()
}

// ---- files ------------------------------------------------------------------

async function loadFile(file: File, add = false) {
  const ext = file.name.split('.').pop()?.toLowerCase()
  const url = URL.createObjectURL(file)
  try {
    let obj: THREE.Object3D
    let clips: THREE.AnimationClip[] = []
    if (ext === 'glb' || ext === 'gltf') {
      const g = await loader.loadAsync(url)
      obj = g.scene
      clips = g.animations
    } else if (ext === 'stl') {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js')
      const geo = new STLLoader().parse(await file.arrayBuffer())
      geo.computeVertexNormals()
      obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.25, roughness: 0.42 }))
    } else if (ext === 'obj') {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js')
      obj = new OBJLoader().parse(await file.text())
    } else {
      return note(`Can't open .${ext ?? '?'} files yet. Try GLB, STL or OBJ.`)
    }
    if (add && sceneObjects.length) addAlongside(obj, clips, null, file.name, null)
    else { loadToken++; current = null; showOnly(obj, clips, null, file.name, null) }
    remote?.feedback({ toast: `Opened ${file.name}` })
  } catch (e) {
    console.error(e)
    note(`Couldn't open ${file.name}`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const drop = $('drop')
addEventListener('dragover', (e) => { e.preventDefault(); drop.hidden = false })
addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.hidden = true })
addEventListener('drop', (e) => {
  e.preventDefault()
  drop.hidden = true
  void openFiles([...(e.dataTransfer?.files ?? [])], e.shiftKey)
})
/** Several files at once make one scene; holding shift adds them to the current one. */
async function openFiles(files: File[], add = false) {
  for (const [i, f] of files.entries()) await loadFile(f, add || i > 0)
}
const fileInput = $<HTMLInputElement>('file')
$('open').onclick = () => fileInput.click()
fileInput.onchange = () => { void openFiles([...(fileInput.files ?? [])]); fileInput.value = '' }

let noteTimer: ReturnType<typeof setTimeout> | undefined
function note(text: string) {
  const n = $('note')
  n.textContent = text
  n.classList.add('show')
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => n.classList.remove('show'), 2400)
}

// ---- live trade-off models: engine pillars re-solve as they move --------------------------------

/** A hand's held part's live value, for its phone (empty unless it is a pillar of a live trade-off model). */
function pillarValues(hand: Hand = parts.host) {
  const sel = hand.selected
  const live = sel && parts.live_(sel) ? parts.tradeoffOf(sel)!.describe(sel.key!) : null
  return { partLive: !!live, partValue: live?.text ?? '' }
}
let pillarTimer: ReturnType<typeof setTimeout> | undefined
/** Values change continuously while dragging: send at most ~10 updates a second. */
function sendPillar() {
  if (pillarTimer) return
  pillarTimer = setTimeout(() => {
    pillarTimer = undefined
    for (const h of parts.holders()) if (h.id !== 'host') remote?.setValues(pillarValues(h), h.id)
  }, 100)
}

// ---- mouse: hover cards, select, drag parts ---------------------------------------

let dragging = false
let downAt: [number, number] = [0, 0]
let lastXY: [number, number] = [0, 0]
canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    parts.move(e.clientX - lastXY[0], e.clientY - lastXY[1])
    lastXY = [e.clientX, e.clientY]
    return
  }
  if (e.pointerType === 'mouse' && e.buttons === 0 && !anyPointer()) parts.hover(e.clientX, e.clientY)
  canvas.style.cursor = parts.hovered?.movable ? (parts.selected?.object === parts.hovered.object ? 'grab' : 'pointer') : ''
})
canvas.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY]
  if (e.button !== 0 || e.pointerType !== 'mouse') return
  const h = parts.hovered
  if (!h?.movable) return
  heldBefore = parts.holdsHovered()
  if (!heldBefore) parts.select(h)
  dragging = true
  lastXY = [e.clientX, e.clientY]
  controls.enabled = false
  canvas.setPointerCapture(e.pointerId)
  canvas.style.cursor = 'grabbing'
  e.stopImmediatePropagation()
}, { capture: true })
let heldBefore = false
const endDrag = (e: PointerEvent) => {
  const still = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 4
  if (dragging) {
    dragging = false
    controls.enabled = true
    canvas.style.cursor = 'grab'
    // Clicking what's already selected steps between the part and its whole object.
    if (still && heldBefore) { parts.pick(); renderScene(false) }
    return
  }
  // A click on empty space releases the selection (but not after an orbit drag).
  if (still && !parts.hovered && parts.selected) { parts.select(null); renderScene(false) }
}
canvas.addEventListener('pointerup', endDrag)
canvas.addEventListener('pointercancel', () => { dragging = false; controls.enabled = true })
canvas.addEventListener('dblclick', () => { if (parts.selected) parts.resetSelected() })
canvas.addEventListener('pointerleave', () => { if (!dragging && !anyPointer()) parts.hover(null, null) })

// ---- toolbar and keyboard ---------------------------------------------------

$('t-grid').onclick = () => { view.grid = !view.grid; applyView(); dismissHint('tools') }
$('t-glow').onclick = () => { view.glow = !view.glow; applyView(); dismissHint('tools') }
$('t-spin').onclick = () => { view.spin = !view.spin; applyView(); dismissHint('tools') }
$('t-frame').onclick = () => { frameModel(); dismissHint('tools') }
$('t-reset').onclick = () => { resetView(); dismissHint('tools') }

// ---- themes -------------------------------------------------------------------

let theme = initialTheme()
function setTheme(t: Theme, sync = true) {
  theme = t
  applyTheme(t) // sets the ob.Pal product first, so the accent below is ours rather than the family default
  parts.setAccent(family.accentColor())
  applySceneTheme(t)
  if (!$('themes').hidden) setMarkup($('themes'), family.themeMenu())
  if (sync) remote?.setValues({ theme: t.id })
}
/** Accent changed (here, on the phone or in the menu): recolour the stage and part highlights. */
function setAccent(id: string, sync = true) {
  family.setAccent(id)
  parts.setAccent(family.accentColor())
  remote?.setHostPerson({ color: family.accentColor() })
  applySceneTheme(theme)
  if (!$('themes').hidden) setMarkup($('themes'), family.themeMenu())
  if (sync) remote?.setValues({ accent: family.getAccent() })
}
function toggleThemes(open = $('themes').hidden) {
  const pop = $('themes')
  if (open) setMarkup(pop, family.themeMenu())
  pop.hidden = !open
  $('t-theme').setAttribute('aria-pressed', String(open))
}
$('themes').onclick = (e) => {
  e.stopPropagation()
  const el = e.target as Element
  const t = el.closest<HTMLElement>('[data-bb-theme-id]')
  const a = el.closest<HTMLElement>('[data-bb-accent-id]')
  if (t) family.setTheme(t.dataset.bbThemeId!)
  else if (a) setAccent(a.dataset.bbAccentId!)
}
// A surface picked on another Blackboxes tab applies here when this tab regains focus.
addEventListener('bb-theme', (e) => { const id = (e as CustomEvent<{ theme: string }>).detail.theme; if (id !== theme.id) setTheme(themeById(id)) })
addEventListener('bb-accent', () => setAccent(family.getAccent()))
$('t-theme').onclick = (e) => { e.stopPropagation(); if (!$('lighting').hidden) toggleLighting(false); toggleThemes() }
$('t-light').onclick = (e) => { e.stopPropagation(); toggleLighting() }

// ---- ecosystem switcher: every Blackboxes site, one tap away ----
setMarkup($('t-switch'), family.icons.chevron)
family.mountSwitcher($('t-switch'), $('switcher'), 'obpal')
// The scene's selects (the viewpoint's ride) are the kit's glass ones, never the system's list.
enhanceSelects()

// ---- overflow: secondary tools fold into a glass tile menu on narrower screens ----
function buildMore() {
  const menu = $('more')
  menu.replaceChildren()
  document.querySelectorAll<HTMLElement>('#tools .tool.t2').forEach((src) => {
    const b = document.createElement('button')
    b.className = 'more-tile'
    b.setAttribute('role', 'menuitem')
    b.dataset.for = src.id
    setMarkup(b, html`${[...src.childNodes].map((n) => n.cloneNode(true))}<span></span>`)
    b.querySelector('span')!.textContent = (src.getAttribute('aria-label') ?? '').replace(/ ob\.Pal$/, '')
    b.onclick = (e) => {
      e.stopPropagation()
      const keepOpen = src.id === 't-grid' || src.id === 't-glow' || src.id === 't-spin'
      if (!keepOpen) toggleMore(false)
      src.click()
      syncMore()
    }
    menu.appendChild(b)
  })
}
function syncMore() {
  document.querySelectorAll<HTMLElement>('#more .more-tile').forEach((t) => t.setAttribute('aria-pressed', $(t.dataset.for!).getAttribute('aria-pressed') ?? 'false'))
}
function toggleMore(open = $('more').hidden) {
  $('more').hidden = !open
  $('t-more').setAttribute('aria-expanded', String(open))
  $('t-more').setAttribute('aria-pressed', String(open))
  if (open) { syncMore(); toggleThemes(false); toggleLighting(false) }
}
$('t-more').onclick = (e) => { e.stopPropagation(); toggleMore() }
addEventListener('pointerdown', (e) => {
  if (!$('themes').hidden && !(e.target as Element).closest('#themes, #t-theme')) toggleThemes(false)
  if (!$('lighting').hidden && !(e.target as Element).closest('#lighting, #t-light, #more')) toggleLighting(false)
  if (!$('more').hidden && !(e.target as Element).closest('#more, #t-more')) toggleMore(false)
})
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key.toLowerCase()
  if (k === 'g') { view.grid = !view.grid; applyView() }
  else if (k === 'b') { view.glow = !view.glow; applyView() }
  else if (k === 's') { view.spin = !view.spin; applyView() }
  else if (k === 'f') frameModel()
  else if (k === 'r') resetView()
  else if (k === 'arrowright' || k === ']') stepItem(1)
  else if (k === 'arrowleft' || k === '[') stepItem(-1)
  else if (k === 'c') setCatalog($('catalog').dataset.state === 'rail')
  else if (k === 'escape') { parts.select(null); toggleLighting(false); toggleThemes(false); renderScene(false) }
  else if ((k === 'delete' || k === 'backspace') && parts.selected?.kind === 'object' && sceneObjects.length > 1) {
    const e = sceneObjects.find((o) => o.obj === parts.selected!.root)
    if (e) { removeObject(e); renderScene(false) }
  }
  else if (k === 'l') toggleLighting()
  else if (k === 't') setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])
})

// ---- phone remote -------------------------------------------------------------

const abs = (path: string) => new URL(path, location.origin).href
/** The phone's model picker: the whole catalogue, grouped by collection (Local folder files included, see syncPhoneModels). */
const modelOptions = () => CATALOG.map((i) => ({
  value: i.id, label: i.name, group: categoryName(i.category), detail: i.subtitle,
  image: i.icon ? abs(i.icon) : undefined, glyph: i.glyph,
}))
const layout: Layout = {
  v: 1,
  modes: [Mode.tilt, Mode.hold, Mode.point, Mode.track, Mode.gamepad],
  utilities: ['pad', 'motion.aim', 'motion.steer', 'motion.point', 'motion.track', 'touch.trackpad', 'motion.hold', 'motion.tilt', 'camera.hand', 'camera.body'],
  tray: [
    { id: 'model', label: 'Models', type: 'select', icon: 'models', add: true, options: modelOptions() },
    { id: 'light', label: 'Lighting', type: 'select', icon: 'sun', options: LIGHT_PRESETS.map((p) => ({ value: p.id, label: p.name, glyph: '☀' })) },
    { id: 'reset', label: 'Reset', icon: 'reset' },
    { id: 'frame', label: 'Frame', icon: 'frame' },
    { id: 'spin', label: 'Spin', type: 'toggle', icon: 'spin' },
    { id: 'grid', label: 'Grid', type: 'toggle', icon: 'grid' },
    { id: 'glow', label: 'Glow', type: 'toggle', icon: 'glow' },
  ],
}
/** Local folder connected, refreshed or disconnected: send the phone the new model list. */
function syncPhoneModels() {
  const picker = layout.tray.find((c) => c.id === 'model')
  if (picker) picker.options = modelOptions()
  remote?.setLayout(layout)
}
const MODE_LABEL: Partial<Record<ModeId, string>> = { [Mode.tilt]: 'Tilt', [Mode.hold]: '1:1', [Mode.point]: 'Point', [Mode.orbit]: 'Gyro', [Mode.gamepad]: 'Gamepad' }
const emptyPadState: PadState = { flags: 0, seq: 0, t: 0, buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0] }
let remote: Remote | null = null
let controlSpace: ControlSession | null = null
const controlParts = new Map<string, THREE.Object3D | null>()
const controlBounds = new Map<string, { key: string; x: number; y: number; w: number; h: number }>()
const sound = mountSound('viewer', (strong, weak, ms, who) => remote?.rumble(strong, weak, ms, who), document.getElementById('catalog'))
const objectSound = new ObjectSound(sound)
/** The pairing chip: the QR code and the short code, in the bottom-right corner. */
let pairChip: PairingChip | null = null

// ---- shared scene: every connected device is a seat, with its own cursor and hand (CATALOGUE §5) ----

/** One device in the scene: its cursor, its grab and motion state, and the hand that holds its part. */
interface Seat {
  who: Participant
  hand: Hand
  el: HTMLElement
  aim: ScreenPointer
  pointerOn: boolean
  x: number
  y: number
  grabbing: boolean
  wasClutch: boolean
  base: THREE.Quaternion
  lastGrab: number
  /** 3D (mode 6): where the phone and what it moves were when the thumb went down. */
  track: { gen: number; p0: [number, number, number]; q0: [number, number, number, number]; heading: number; pos0: THREE.Vector3; quat0: THREE.Quaternion; last: THREE.Vector3 } | null
  cameraHand: ViewerHandInput
  cameraCursor: HandCursor
  lastHoverObj: THREE.Object3D | null
  padPointing: boolean
  padAB: number
  /** Gamepad contexts: the lead's drives the view and the scene; everyone else's only moves what it holds. */
  gpLead: GamepadContext
  gpOwn: GamepadContext
}
const seats = new Map<string, Seat>()
const pointerTemplate = $('pointer')
/** The lead drives the shared view (the camera, the whole scene) while it holds nothing. */
const isLead = (s: Seat) => !!remote?.participants.find((p) => p.id === s.who.id)?.lead
const anyPointer = () => [...seats.values()].some((s) => s.pointerOn || s.padPointing)
const anyClutch = () => [...seats.values()].some((s) => s.wasClutch)
const rgbOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}` }
const clampX = (x: number) => Math.min(innerWidth - 14, Math.max(14, x))
const clampY = (y: number) => Math.min(innerHeight - 14, Math.max(14, y))

function addSeat(who: Participant): Seat {
  const el = pointerTemplate.cloneNode(true) as HTMLElement
  el.removeAttribute('id')
  el.hidden = true
  el.style.setProperty('--accent', who.color)
  el.style.setProperty('--accent-rgb', rgbOf(who.color))
  const tag = document.createElement('span')
  tag.className = 'pt-name'
  tag.textContent = who.name
  el.appendChild(tag)
  document.body.appendChild(el)
  const s = {
    who, hand: parts.hand(who.id, who.color), el, aim: new ScreenPointer(), pointerOn: false, x: innerWidth / 2, y: innerHeight / 2,
    grabbing: false, wasClutch: false, base: new THREE.Quaternion(), lastGrab: -1, track: null, cameraHand: new ViewerHandInput(), cameraCursor: new HandCursor(el), lastHoverObj: null, padPointing: false, padAB: 0,
  } as Seat
  s.gpLead = leadGamepad(s)
  s.gpOwn = ownGamepad(s)
  seats.set(who.id, s)
  return s
}

function removeSeat(id: string) {
  const s = seats.get(id)
  if (!s) return
  s.el.remove()
  parts.dropHand(id)
  seats.delete(id)
}

function recenterSeat(s: Seat) { s.aim.recenter(); s.x = innerWidth / 2; s.y = innerHeight / 2; s.track = null; s.cameraHand.reset(); controlBounds.delete(s.who.id) }

function setSeatPointer(s: Seat, on: boolean) {
  s.pointerOn = on
  s.el.hidden = !on && !s.padPointing
  s.grabbing = false
  s.cameraHand.reset()
  if (on) recenterSeat(s)
  else if (!s.padPointing) parts.hover(null, null, s.hand)
}

/** Who holds a part, as a device should hear it. */
function holderName(h: Hand | null) {
  if (!h) return 'Someone'
  return h === parts.host ? 'The screen' : seats.get(h.id)?.who.name ?? 'Someone'
}

function heldFeedback(s: Seat, part: Part | null) {
  remote?.feedback({ haptic: 'bump', toast: `${holderName(parts.holderOf(part))} has ${part?.title ?? 'that'}` }, s.who.id)
}

/** A (or a tap): take what's under the cursor, let go on empty space, and for the lead, focus the view there. */
function seatSelect(s: Seat) {
  const r = parts.pickFor(s.hand)
  if (r === 'picked') { renderScene(false); remote?.feedback({ haptic: 'tick' }, s.who.id) }
  else if (r === 'held') heldFeedback(s, s.hand.hovered)
  else if (s.hand.selected) { parts.select(null, s.hand); renderScene(false) }
  else if (isLead(s)) focusAt(s)
}

/** Holding B grabs: what the cursor is on (if nobody else has it), else what the seat already holds. */
function seatGrab(s: Seat, down: boolean) {
  s.grabbing = down
  if (!down) return
  const hov = s.hand.hovered
  if (hov?.movable && !parts.holdsHovered(s.hand) && !parts.select(hov, s.hand)) { s.grabbing = false; heldFeedback(s, hov); return }
  remote?.feedback({ haptic: 'tick' }, s.who.id)
}

/** A grab drags what the seat holds; the lead, holding nothing, turns the view. */
function dragBy(s: Seat, dx: number, dy: number) {
  if (controlSpace?.scope(s.who.id) === 'scene') { if (isLead(s)) void controls.rotate(-dx * 0.006, -dy * 0.006, true) }
  else if (s.hand.selected?.movable) parts.move(dx, dy, s.hand)
  else if (isLead(s)) void controls.rotate(-dx * 0.006, -dy * 0.006, true)
}

function drawCursor(s: Seat, px: number, py: number, vx: number, vy: number, off: boolean) {
  s.el.style.transform = `translate(${px}px, ${py}px)`
  s.el.style.setProperty('--ang', `${Math.atan2(vy - py, vx - px)}rad`)
  s.el.classList.toggle('off', off)
  s.el.classList.toggle('grab', s.grabbing)
  s.el.classList.toggle('on-part', !!s.hand.hovered)
}

async function startRemote() {
  remote = await Remote.create({ appName: 'ob.Pal Viewer', layout, seats: 8 })
  holdForPhone(remote)
  controlSpace = new ControlSession(remote, 'viewer')
  sharedPresence.connect(remote)
  remote.setHostPerson({ name: 'Screen', color: family.accentColor() })
  Object.assign(window, { __obpal: remote, __viewer: { holder, camera, controls, view, seats, parts } })
  // Open while nobody is here; it closes by itself as a phone comes in, and the + in the people chip opens it again.
  // It folds while a panel is where it opens, and on narrow screens the caption makes way for it.
  pairChip = new PairingChip({
    remote, open: true, testLink: true, avoid: '#lighting, #themes, #more, #switcher, #people, #catalog, .presence-controls, .quick-panel, .quick-themes, .obpal-camera',
    onToggle: (open) => { $('chip-invite').setAttribute('aria-pressed', String(open)); $('caption').classList.toggle('pair-open', open) },
  })
  remote.on('connect', () => {
    $('chip').hidden = false
    remote!.setValues({ model: current?.id ?? '', spin: view.spin, grid: view.grid, glow: view.glow, theme: theme.id, accent: family.getAccent(), light: lighting.preset })
  })
  remote.on('disconnect', () => {
    $('chip').hidden = true
    pairChip?.expand()
    togglePeople(false)
  })
  remote.on('join', (p) => {
    addSeat(p)
    renderPeople()
    note(`${p.name} joined`)
    publishScene(true)
  })
  remote.on('leave', (p) => {
    removeSeat(p.id)
    renderPeople()
    note(`${p.name} left`)
    publishScene()
  })
  remote.on('mode', (m, who) => {
    const s = seats.get(who.id)
    if (!s) return
    setSeatPointer(s, m === Mode.point)
    if (m !== Mode.point) parts.hover(null, null, s.hand)
    if (isLead(s)) $('chip-mode').textContent = MODE_LABEL[m] ?? ''
  })
  remote.on('recenter', (who) => { const s = seats.get(who.id); if (s) recenterSeat(s) })
  remote.on('value', ({ id, v, add }) => {
    if (id === 'model') { const item = CATALOG.find((i) => i.id === v); if (item) void selectItem(item, add) }
    else if (id === 'spin' || id === 'grid' || id === 'glow') { view[id] = !!v; applyView() }
    else if (id === 'theme') setTheme(themeById(String(v)))
    // A device's colour is its identity in a shared scene: its accent choice stays on the device.
    else if (id === 'accent' && !remote?.shared) setAccent(String(v))
    else if (id === 'light') setPreset(String(v))
  })
  remote.on('button', ({ id, ev }, who) => {
    const s = seats.get(who.id)
    if (s) seatButton(s, id, ev)
  })
  // A device picked a node from its scene list (null: let go).
  remote.on('claim', ({ node }, who) => {
    const s = seats.get(who.id)
    if (!s) return
    if (node === null) { parts.select(null, s.hand); renderScene(false); return }
    const part = nodeParts.get(node)
    if (!part) { remote?.feedback({ haptic: 'bump', toast: 'That’s no longer in the scene' }, who.id); return }
    if (parts.select(part, s.hand)) { renderScene(false); remote?.feedback({ haptic: 'tick' }, who.id) }
    else heldFeedback(s, part)
  })
  $('chip-disc').onclick = () => remote?.disconnect()
  $('chip-invite').onclick = () => { pairChip?.toggle(); if (pairChip?.expanded) $('people').hidden = true }
  $('chip-who').onclick = () => togglePeople()
  $('invite-new').onclick = async () => {
    await remote?.resetInvite()
    note('New invite link: the old code no longer works')
  }
}

function seatButton(s: Seat, id: string, ev: string) {
  const lead = isLead(s)
  const h = s.hand
  if (id === 'reset') { if (h.selected) parts.resetSelected(h); else if (lead) resetView() }
  else if (id === 'frame') { if (lead) frameModel() }
  else if (id === 'part-release') { parts.select(null, h); renderScene(false) }
  else if (id === 'control.take' && ev === 'tap') { seatSelect(s); if (s.hand.selected) controlSpace?.setScope(s.who.id, 'object') }
  else if (id === 'wii-a' && ev === 'tap' && s.pointerOn) seatSelect(s) // A also reports down and up (for the PC); a tap selects
  else if (id === 'wii-b' && s.pointerOn) seatGrab(s, ev === 'down')
  else if ((id === 'wii-plus' || id === 'wii-minus') && s.pointerOn) {
    const k = id === 'wii-plus' ? 1 : -1
    if (h.selected && !parts.live_(h.selected)) parts.scaleBy(k * 0.25, h)
    else if (lead) void controls.dolly(controls.distance * (k > 0 ? 1 - 1 / 1.25 : 1 - 1.25), true)
  } else if (id === 'pad') {
    // In 3D the thumb rests on the pad as the deadman: a long press there is no letting go.
    if (s.track && ev !== 'tap') return
    if (ev === 'double') { if (h.selected) parts.resetSelected(h); else if (lead) frameModel() }
    else if (ev === 'long') { if (h.selected) { parts.select(null, h); renderScene(false) } else if (lead) resetView() }
    else if (ev === 'tap' && s.pointerOn) seatSelect(s)
  }
}

// ---- the scene's nodes and who holds them, published to every device ----

const nodeParts = new Map<string, Part>()

/** Tell every device what it can claim (after the scene's objects change) and who holds what. */
function publishScene(nodesChanged = false) {
  if (!remote?.shared) return
  if (nodesChanged) {
    nodeParts.clear()
    for (const p of parts.listable()) nodeParts.set(p.object.uuid, p)
  }
  const held: Record<string, string> = {}
  for (const h of parts.holders()) held[h.selected!.object.uuid] = h.id
  const nodes = nodesChanged ? [...nodeParts].map(([id, p]) => ({ id, name: p.title, kind: p.kind, group: parts.groupOf(p) })) : undefined
  remote.setScene({ held, ...(nodes ? { nodes } : {}) })
  renderPeople()
}

// ---- presence: who's in the scene, the invite, and removing someone ----

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '•'

function renderPeople() {
  const list = remote?.participants ?? []
  const dots = $('chip-people')
  dots.replaceChildren(...list.map((p) => {
    const d = document.createElement('span')
    d.className = 'person'
    d.style.setProperty('--c', p.color)
    d.textContent = initials(p.name)
    return d
  }))
  $('chip-text').textContent = list.length === 1 ? list[0].name : `${list.length} people`
  document.body.classList.toggle('multi', list.length > 1)
  const rows = $('people-list')
  rows.replaceChildren(...list.map((p) => {
    const li = document.createElement('li')
    const held = seats.get(p.id)?.hand.selected
    setMarkup(li, html`<span class="person"></span><span class="pp-text"><b></b><small></small></span><button class="chip-x" data-icon="close"></button>`)
    const dot = li.querySelector<HTMLElement>('.person')!
    dot.style.setProperty('--c', p.color)
    dot.textContent = initials(p.name)
    li.querySelector('b')!.textContent = p.name
    li.querySelector('small')!.textContent = [p.lead ? 'Drives the view' : '', held ? `Holding ${held.title}` : ''].filter(Boolean).join(' · ') || 'Free'
    const x = li.querySelector<HTMLButtonElement>('button')!
    setMarkup(x, ICONS.close)
    x.setAttribute('aria-label', `Remove ${p.name}`)
    x.onclick = () => { remote?.disconnect(p.id); note(`Removed ${p.name}`) }
    return li
  }))
}

function togglePeople(on = $('people').hidden) {
  $('people').hidden = !on
  if (on && remote?.status === 'connected') pairChip?.collapse()
}

/**
 * Gamepad mode with the phone's Point utility on (PROTOCOL §6): the seat's Wii cursor, at the absolute angle the phone
 * sends. A selects, holding B grabs, as in Point mode; both then leave the pad, so the pad mapping does not also frame
 * or reset the view. Returns the pad the gamepad mapping should see.
 */
function seatPadPointer(s: Seat, pad: PadState, pt: PointerState | null): PadState {
  if (!pt) {
    if (s.padPointing) { s.padPointing = false; s.grabbing = false; if (!s.pointerOn) { s.el.hidden = true; parts.hover(null, null, s.hand) } }
    return pad
  }
  if (!s.padPointing) { s.padPointing = true; s.padAB = pad.buttons & 3; s.el.hidden = false }
  const { x: vx, y: vy, off } = ScreenPointer.project(pt.yaw, pt.pitch, innerWidth, innerHeight)
  const px = clampX(vx)
  const py = clampY(vy)
  const a = pad.buttons & 1
  const b = pad.buttons & 2
  if (b && !(s.padAB & 2)) seatGrab(s, true)
  if (!b) s.grabbing = false
  if (s.grabbing && (px !== s.x || py !== s.y)) dragBy(s, px - s.x, py - s.y)
  s.x = px
  s.y = py
  if (a && !(s.padAB & 1)) seatSelect(s)
  s.padAB = pad.buttons & 3
  drawCursor(s, px, py, vx, vy, off)
  if (!s.grabbing) parts.hover(off ? null : px, off ? null : py, s.hand)
  return { ...pad, buttons: pad.buttons & ~3 }
}

const raycaster = new THREE.Raycaster()
/** Orbit about the point under a seat's cursor (the lead's). */
function focusAt(s: Seat) {
  const ndc = new THREE.Vector2((s.x / innerWidth) * 2 - 1, -(s.y / innerHeight) * 2 + 1)
  raycaster.setFromCamera(ndc, experience.activeCamera)
  const hit = raycaster.intersectObject(holder, true)[0]
  s.el.classList.remove('pulse')
  void s.el.offsetWidth
  s.el.classList.add('pulse')
  if (hit) {
    void controls.setOrbitPoint(hit.point.x, hit.point.y, hit.point.z)
    remote?.feedback({ haptic: 'tick' }, s.who.id)
  }
}

// ---- gamepad: a phone in gamepad mode (mapping in ./gamepad-input.ts) ----

/** The lead: sticks drive the view and the scene, as with one phone. */
function leadGamepad(s: Seat): GamepadContext {
  return {
    controls, camera, holder, frame: frameModel, step: stepItem,
    // B is "back", as in games: release what it holds first, otherwise reset the view.
    reset: () => { if (s.hand.selected) parts.select(null, s.hand); else resetView() },
    // The right stick turns what it holds, or the whole model.
    turn: (q) => { if (s.hand.selected?.movable) parts.rotateWorld(q, s.hand); else holder.quaternion.premultiply(q) },
    toggle: (k) => { view[k] = !view[k]; applyView() },
    toggleCatalog: () => setCatalog($('catalog').dataset.state === 'rail'),
  }
}

/** Everyone else steers only what they hold: the left stick moves it, the triggers and D-pad scale it, the right stick turns it. */
function ownGamepad(s: Seat): GamepadContext {
  const noop = () => {}
  return {
    controls: {
      rotate: (az: number, polar: number) => { if (s.hand.selected) parts.move(-az * 290, -polar * 410, s.hand) },
      dolly: (d: number) => { if (s.hand.selected && controls.distance > 0) parts.scaleBy(d / controls.distance, s.hand) },
      get distance() { return controls.distance },
    },
    camera, holder, frame: noop, step: noop, toggle: noop, toggleCatalog: noop,
    reset: () => { if (s.hand.selected) { parts.select(null, s.hand); renderScene(false) } },
    turn: (q) => parts.rotateWorld(q, s.hand),
  }
}

/** Apply one seat's frame: what it holds follows its phone; the lead, holding nothing, moves the view and the scene. */
function applySeat(s: Seat, f: Frame, dt: number) {
  const cursor = s.cameraCursor.step(f.connected && !f.body ? f.hand : null)
  if (!f.connected) { s.cameraHand.reset(); s.track = null; return }
  const calibrated = controlSpace?.aim(s.who.id)
  if (calibrated) f = { ...f, tilt: calibrated.tilt }
  experience.motionControl(!!calibrated)
  const lead = isLead(s)
  const h = s.hand
  const sceneScope = controlSpace?.scope(s.who.id) === 'scene'
  const sel = !sceneScope && h.selected?.movable ? h.selected : null
  if (controlParts.get(s.who.id) !== (h.selected?.object ?? null)) {
    controlParts.set(s.who.id, h.selected?.object ?? null)
    controlSpace?.position(s.who.id)
    controlBounds.delete(s.who.id)
  }
  if (sel && (f.clutch || f.touching || (f.mode === Mode.tilt && (f.tilt[0] || f.tilt[1])) || f.aim[0] || f.aim[1] || f.twist || f.zoom)) parts.active(h)
  // 1:1 match: while the gyro is on, what the seat drives copies the phone's rotation since it was turned on.
  const target = sel && !parts.live_(sel) ? sel.object : lead && !sel ? holder : null
  if (f.hand && !f.body) {
    s.track = null; s.wasClutch = false
    if (cursor && !s.grabbing && !(f.hand.gestures & 4)) parts.hover(cursor.x, cursor.y, h)
    const pinch = f.hand.tracked && !!(f.hand.gestures & 1) && !(f.hand.gestures & 2)
    if (pinch && !s.grabbing && h.hovered?.movable) seatGrab(s, true)
    if (!pinch) s.grabbing = false
    const grabbed = h.selected?.movable ? h.selected : null
    const active = s.cameraHand.step(f.hand, {
      controls, camera: experience.activeCamera, target: pinch && s.grabbing ? grabbed?.object ?? null : null, orbit: lead,
      live: grabbed && parts.live_(grabbed) ? { width: innerWidth, height: innerHeight, move: (dx, dy) => parts.move(dx, dy, h) } : undefined,
    })
    if (active && sel) parts.active(h)
    s.wasClutch = active && handGrabs(f.hand)
    experience.motionControl(active)
    return
  }
  s.cameraHand.reset()
  const matching = f.clutch && f.mode === Mode.hold && !!target
  if (matching && target) {
    if (!s.wasClutch || f.grab !== s.lastGrab) { s.base.copy(target.quaternion); s.lastGrab = f.grab }
    experience.activeCamera.getWorldQuaternion(camQ)
    camQi.copy(camQ).invert()
    qRel.set(f.qRel[0], f.qRel[1], f.qRel[2], f.qRel[3])
    const world = tmpQ.copy(camQ).multiply(qRel).multiply(camQi)
    if (target === holder) target.quaternion.copy(world).multiply(s.base)
    else {
      const pw = target.parent!.getWorldQuaternion(new THREE.Quaternion())
      target.quaternion.copy(pw.clone().invert().multiply(world).multiply(pw)).multiply(s.base)
    }
  }
  s.wasClutch = matching
  // 3D (mode 6): while a thumb is on the pad, what the seat drives moves and turns as the phone does, through space.
  const pose = f.pose
  // A live part (a pillar's value) moves as a drag does: raising the phone raises it.
  const liveSel = sel && parts.live_(sel) ? sel : null
  const moved = target ?? liveSel?.object
  if (f.mode === Mode.track && pose?.tracked && f.touching && moved) {
    if (!s.track || s.track.gen !== pose.gen) {
      const pos0 = moved.getWorldPosition(new THREE.Vector3())
      s.track = { gen: pose.gen, p0: [...pose.p], q0: [...pose.q], heading: headingOf(pose.q), pos0, quat0: moved.getWorldQuaternion(new THREE.Quaternion()), last: pos0.clone() }
    }
    const k = s.track
    const m = handMove([pose.p[0] - k.p0[0], pose.p[1] - k.p0[1], pose.p[2] - k.p0[2]], k.heading)
    // A hand's move of a tenth of the viewing distance moves it an eighth of the way across.
    const reach = controls.distance * 1.2
    trFwd.copy(experience.controlFrame.forward)
    trRight.copy(experience.controlFrame.right)
    const world = trV.copy(k.pos0).addScaledVector(trRight, m.right * reach).addScaledVector(WORLD_UP, m.up * reach).addScaledVector(trFwd, m.forward * reach)
    k.p0 = [...pose.p]; k.pos0.copy(world)
    experience.motionControl(true)
    if (liveSel || !target) {
      // Drag it by however far the hand's move goes on the screen. A value snaps to its steps, so the drag builds up
      // from where the value last changed instead of rounding away frame by frame.
      const a = k.last.clone().project(experience.activeCamera)
      const b = world.clone().project(experience.activeCamera)
      if (parts.move(((b.x - a.x) / 2) * innerWidth, ((a.y - b.y) / 2) * innerHeight, h)) k.last.copy(world)
    } else {
      // The same camera frame as 1:1 turn, including the camera's pitch and roll.
      experience.activeCamera.getWorldQuaternion(camQ)
      trQ.set(...poseRelativeInView(k.q0, pose.q))
      trQ.premultiply(camQ).multiply(trQ0.copy(camQ).invert()).multiply(k.quat0)
      const parent = target.parent!
      target.position.copy(parent.worldToLocal(world))
      target.quaternion.copy(parent.getWorldQuaternion(trQ0).invert().multiply(trQ))
    }
  } else s.track = null
  camRight.copy(experience.controlFrame.right)
  // Rate gyro (protocol mode 1): yaw about the world vertical, pitch about the camera's right axis.
  if (f.mode === Mode.orbit && (f.aim[0] || f.aim[1])) {
    const qa = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, f.aim[0] * GAME_GAIN * D2R)
    const qb = new THREE.Quaternion().setFromAxisAngle(camRight, f.aim[1] * GAME_GAIN * D2R)
    if (sel) { parts.rotateWorld(qa, h); parts.rotateWorld(qb, h) }
    else if (lead) { holder.quaternion.premultiply(qa); holder.quaternion.premultiply(qb) }
  }
  // Racing tilt: what it drives keeps turning while the phone is tilted, and stops when it is level again.
  if (f.mode === Mode.tilt && (f.tilt[0] || f.tilt[1])) {
    const qa = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, f.tilt[0] * TILT_YAW_RATE * dt * D2R)
    const qb = new THREE.Quaternion().setFromAxisAngle(camRight, f.tilt[1] * TILT_PITCH_RATE * dt * D2R)
    // A live trade-off pillar: tipping the phone away from you raises its value, towards you lowers it.
    if (sel && parts.live_(sel)) parts.tradeoffOf(sel)!.drive(sel.key!, -f.tilt[1], dt)
    else if (sel) { parts.rotateWorld(qa, h); parts.rotateWorld(qb, h) }
    else if (lead) { holder.quaternion.premultiply(qa); holder.quaternion.premultiply(qb) }
  }
  if (f.mode === Mode.point) {
    // Where the phone points; a phone without motion sensors steers with its trackpad instead.
    let { x: vx, y: vy, dx, dy, off } = s.aim.step(f.aim, sel ? [0, 0] : [f.pad1[0] * 1.2, f.pad1[1] * 1.2], innerWidth, innerHeight)
    if (calibrated) {
      const cameraKey = experience.activeCamera.matrixWorld.elements.filter((_, n) => [2, 6, 10, 12, 13, 14].includes(n)).map(v => Math.round(v * 20)).join(',')
      const key = `${sceneScope}:${sel?.object.uuid ?? 'scene'}:${experience.mode}:${experience.ride}:${experience.look.viewpoint}:${cameraKey}`
      let bounds = controlBounds.get(s.who.id)
      if (!bounds || bounds.key !== key) {
        const box = new THREE.Box3().setFromObject(sel?.object ?? holder), points: THREE.Vector3[] = []
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z).project(experience.activeCamera))
        const xs = points.map(p => (p.x + 1) * innerWidth / 2), ys = points.map(p => (1 - p.y) * innerHeight / 2)
        const valid = !box.isEmpty() && [...xs, ...ys].every(Number.isFinite)
        const x = valid ? clampX(Math.min(...xs)) : innerWidth * 0.1, y = valid ? clampY(Math.min(...ys)) : innerHeight * 0.1
        bounds = { key, x, y, w: valid ? Math.max(80, clampX(Math.max(...xs)) - x) : innerWidth * 0.8, h: valid ? Math.max(80, clampY(Math.max(...ys)) - y) : innerHeight * 0.8 }
        controlBounds.set(s.who.id, bounds)
      }
      vx = bounds.x + (calibrated.aim[0] + 1) * bounds.w / 2
      vy = bounds.y + (1 - calibrated.aim[1]) * bounds.h / 2
      dx = vx - s.x; dy = vy - s.y; off = false
    }
    // Holding B drags what it grabbed: a part (or a live pillar's value), otherwise (the lead) the view.
    if (s.grabbing && (dx || dy)) dragBy(s, dx, dy)
    let px = clampX(vx)
    let py = clampY(vy)
    // Aim assist (display only): when nearly still, the cursor settles onto a nearby node.
    const m = !s.grabbing && !off && Math.hypot(f.aim[0], f.aim[1]) < 0.12 ? parts.magnet(px, py) : null
    if (m) { px += (m.x - px) * 0.5; py += (m.y - py) * 0.5 }
    s.x = px
    s.y = py
    drawCursor(s, px, py, vx, vy, off)
    if (!s.grabbing) parts.hover(off ? null : px, off ? null : py, h)
    if (calibrated) s.el.hidden = !h.hovered && !s.grabbing
    if (sel && !s.grabbing && (f.pad1[0] || f.pad1[1])) parts.move(f.pad1[0] * 1.4, f.pad1[1] * 1.4, h)
    // Like the Wii: a short buzz as the cursor crosses onto something it can pick up.
    const ho = h.hovered?.movable ? h.hovered.object : null
    if (ho && ho !== s.lastHoverObj) remote?.feedback({ haptic: 'tick' }, s.who.id)
    s.lastHoverObj = ho
  } else if (sel && (f.pad1[0] || f.pad1[1])) {
    parts.move(f.pad1[0] * 1.4, f.pad1[1] * 1.4, h)
  } else if (lead && (f.pad1[0] || f.pad1[1])) {
    void controls.rotate(-f.pad1[0] * 0.008, -f.pad1[1] * 0.008, true)
  }
  if (f.pad2[0] || f.pad2[1]) {
    if (sel) parts.move(f.pad2[0], f.pad2[1], h)
    else if (lead) {
      const k = controls.distance * 0.0022
      void controls.truck(-f.pad2[0] * k, -f.pad2[1] * k, true)
    }
  }
  if (f.zoom) { if (sel) parts.scaleBy(f.zoom, h); else if (lead) void controls.dolly(controls.distance * (1 - Math.pow(2, -f.zoom)), true) }
  if (f.twist && sel) parts.twist(f.twist, h)
  else if (f.twist && lead) {
    towardViewer.copy(experience.controlFrame.forward).negate()
    holder.quaternion.premultiply(tmpQ.setFromAxisAngle(towardViewer, -f.twist * D2R))
    if (matching) s.base.premultiply(tmpQ)
  }
}

// ---- frame loop -------------------------------------------------------------

const camQ = new THREE.Quaternion()
const camQi = new THREE.Quaternion()
const qRel = new THREE.Quaternion()
/** Camera tracking: phones without WebXR glow in their colour, and this computer's camera follows them. */
const follower = new GlowFollower()
const glowView = $('glow-view') as HTMLCanvasElement
const glowCtx = glowView.getContext('2d')!
follower.onUnseen = (id) => remote?.feedback({ haptic: 'bump', toast: 'The camera can’t see your glow: turn the screen toward it' }, id)
follower.onCameraOff = () => note('A phone is glowing: turn on “Follow glowing phones with this camera” in People')
$('glow-cam').onclick = async () => {
  if (follower.cam.on) follower.cam.stop()
  else {
    try { await follower.cam.start(); note('Hold glowing phones toward the camera') } catch { note('The camera didn’t start: allow it for this page') }
  }
  $('glow-cam').setAttribute('aria-pressed', String(follower.cam.on))
  glowView.hidden = !follower.cam.on
}
/** 3D following's scratch space. */
const trFwd = new THREE.Vector3()
const trRight = new THREE.Vector3()
const trV = new THREE.Vector3()
const trQ = new THREE.Quaternion()
const trQ0 = new THREE.Quaternion()
const tmpQ = new THREE.Quaternion()
const tmpV = new THREE.Vector3()
const towardViewer = new THREE.Vector3()
const WORLD_UP = new THREE.Vector3(0, 1, 0)
const camRight = new THREE.Vector3()
const GAME_GAIN = 1.6
const TILT_YAW_RATE = 160 // degrees/second at full steer
const TILT_PITCH_RATE = 110
let lastFrame = 0

// Render above screen resolution (supersampling) for crisp edges, and back off automatically if the GPU can't keep 60 fps.
const quality = { max: Math.min(2, Math.max(1.75, devicePixelRatio)), ratio: 0, frames: 0, time: 0, cooldown: 0 }
quality.ratio = quality.max

function resize() {
  const w = innerWidth
  const h = innerHeight
  renderer.setPixelRatio(quality.ratio)
  renderer.setSize(w, h, false)
  composer.setPixelRatio(quality.ratio)
  composer.setSize(w, h)
  applyStageInset()
  watchInset()
}

/**
 * On wide screens the catalogue covers the left of the stage, so the camera centres and frames the scene in the
 * space beside it: the projection's optical centre moves right by half the panel (setViewOffset) and framing
 * uses the free width. The view still renders under the glass panel. Eases as the panel opens and closes.
 */
let stageInset = 0
let insetTarget = 0
let insetUntil = 0
function measureInset() {
  if (innerWidth <= 860) return 0 // the catalogue is a sheet there, closed after each pick
  const r = $('catalog').getBoundingClientRect()
  return r.left < 60 && r.right > 0 ? Math.round(r.right) : 0
}
/** Follow the panel for a moment (its width animates when it opens or collapses). */
function watchInset() { insetUntil = performance.now() + 700 }
function applyStageInset() {
  const w = innerWidth
  const h = innerHeight
  const free = Math.max(1, w - stageInset)
  camera.aspect = free / h
  if (stageInset > 0.5) camera.setViewOffset(free, h, -stageInset, 0, w, h)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
}
function easeInset(now: number, dt: number) {
  if (now < insetUntil) insetTarget = measureInset()
  if (stageInset === insetTarget) return
  stageInset += (insetTarget - stageInset) * (1 - Math.exp(-dt * 12))
  if (Math.abs(insetTarget - stageInset) < 0.5) stageInset = insetTarget
  applyStageInset()
}
addEventListener('resize', resize)
resize()

function adaptQuality(dt: number) {
  if (dt <= 0 || dt > 0.1) return
  quality.frames++
  quality.time += dt
  if (quality.frames < 90) return
  const avg = quality.time / quality.frames
  quality.frames = 0
  quality.time = 0
  if (quality.cooldown-- > 0) return
  const next = avg > 1 / 45 ? quality.ratio - 0.25 : avg < 1 / 57 ? quality.ratio + 0.25 : quality.ratio
  const clamped = Math.min(quality.max, Math.max(1, next))
  if (clamped !== quality.ratio) { quality.ratio = clamped; quality.cooldown = 2; resize() }
}

/**
 * Resting: after a few seconds with nothing moving (no input, the camera still, nothing animating) the stage draws
 * ten times a second instead of every frame, which a phone or tablet showing the stage feels as warmth. Anything that
 * moves brings it straight back.
 */
let lastActive = performance.now()
const markActive = () => { lastActive = performance.now() }
for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const) addEventListener(t, markActive, { passive: true, capture: true })
const REST_AFTER_MS = 3000
const REST_FRAME_MS = 100

function loop(now: number) {
  if (!experience.immersive && !sharedPresence.guest && !sharedPresence.people.size && now - lastActive > REST_AFTER_MS && lastFrame && now - lastFrame < REST_FRAME_MS) return
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0
  lastFrame = now
  const visibleCamera = experience.activeCamera
  partCamera.copy(visibleCamera, false)
  partCamera.position.copy(visibleCamera.getWorldPosition(tmpV))
  partCamera.quaternion.copy(visibleCamera.getWorldQuaternion(tmpQ))
  partCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(1 / visibleCamera.projectionMatrix.elements[5]))
  partCamera.updateMatrixWorld(true)
  if (sharedPresence.guest) {
    controls.update(dt)
    experience.update(dt, now)
    const ear = experience.activeCamera; ear.updateMatrixWorld(); listenFrom(ear.matrixWorld.elements)
    objectSound.update(holder, 'scene', undefined, now); objectSound.prune(now); sound.tick(now)
    if (experience.immersive) renderer.render(scene, experience.camera)
    else composer.render(dt)
    return
  }
  if (remote) {
    // Read every seat's input once; phones glowing for the camera (3D without their own tracking) get a pose from it.
    const frames = new Map<string, Frame>()
    for (const seat of seats.values()) frames.set(seat.who.id, remote.consumeOf(seat.who.id, now))
    for (const [id, pose] of follower.step(now, [...seats.values()].map((s) => ({ id: s.who.id, color: s.who.color, frame: frames.get(s.who.id)! })))) frames.set(id, { ...frames.get(id)!, pose })
    if (follower.cam.on) follower.draw(glowCtx, (id) => seats.get(id)?.who.color ?? '')
    for (const f of frames.values()) {
      if (f.touching || f.clutch || f.aim[0] || f.aim[1] || f.pad1[0] || f.pad1[1] || f.pad2[0] || f.pad2[1] || f.zoom || f.twist || f.tilt[0] || f.tilt[1] || f.pose || f.hand?.tracked) markActive()
    }
    for (const seat of seats.values()) {
      const id = seat.who.id
      const pad = remote.padOf(id)
      if (pad) {
        if (pad.buttons || pad.axes.some((a) => Math.abs(a) > 0.05) || pad.triggers.some((t) => t > 0.05)) markActive()
        const pt = remote.pointerOf(id)
        applyGamepad(seatPadPointer(seat, pad, pt && !(pt.flags & PointerFlag.relative) ? pt : null), dt, isLead(seat) ? seat.gpLead : seat.gpOwn)
      } else if (seat.padPointing) seatPadPointer(seat, { ...emptyPadState, buttons: 0 }, null)
      applySeat(seat, frames.get(id)!, dt)
    }
  }
  if (view.spin && !anyClutch()) holder.rotateOnWorldAxis(WORLD_UP, dt * 0.5)
  // Fluid model entrance: ease each new model up from 86% scale.
  if (pop < 1) {
    pop = Math.min(1, pop + dt / 0.45)
    const e = 1 - Math.pow(1 - pop, 3)
    holder.scale.setScalar(0.86 + 0.14 * e)
  }
  const several = sceneObjects.length > 1
  shadow.visible = !several
  for (const e of sceneObjects) {
    e.mixer?.update(dt)
    e.tradeoff?.update(dt, partCamera)
    e.shadow.visible = several
    if (several) {
      e.wrap.getWorldPosition(tmpV)
      e.shadow.position.set(tmpV.x, GROUND_Y + 0.003, tmpV.z)
      // Tighter than the stage shadow, so neighbours' shadows don't merge into one smudge.
      e.shadow.scale.setScalar((0.75 * e.size.length() * e.wrap.scale.x * holder.scale.x) / OBJECT_SIZE)
    }
    // An added object eases in on its own (the whole stage pops when the scene is replaced).
    if (e.pop < 1 && parts.selected?.root !== e.obj) {
      e.pop = Math.min(1, e.pop + dt / 0.45)
      const k = 0.86 + 0.14 * (1 - Math.pow(1 - e.pop, 3))
      e.wrap.scale.setScalar((OBJECT_SIZE / (e.size.length() || 1)) * k)
    }
  }
  parts.update(dt)
  for (const s of seats.values()) if (s.hand.selected) objectSound.update(s.hand.selected.object, s.who.id, s.who.id, now)
  objectSound.update(holder, 'scene', remote?.participants.find(p => p.lead)?.id, now)
  objectSound.prune(now); sound.tick(now)
  easeInset(now, dt)
  if (controls.update(dt) || view.spin || pop < 1 || stageInset !== insetTarget || sceneObjects.some((e) => e.mixer || e.pop < 1)) markActive()
  experience.update(dt, now)
  const ear = experience.activeCamera; ear.updateMatrixWorld(); listenFrom(ear.matrixWorld.elements)
  if (experience.immersive) renderer.render(scene, experience.camera)
  else { composer.render(dt); adaptQuality(dt) }
}

/** Reopen the last scene: every catalogue object that was in it (local files can't come back by themselves). */
async function restoreScene(fallback: CatalogItem) {
  let ids: string[] = []
  try { ids = JSON.parse(store.get('obpal.view.scene') ?? '[]') } catch { /* old or bad value */ }
  const items = (Array.isArray(ids) ? ids : []).map((id) => CATALOG.find((i) => i.id === id)).filter((i): i is CatalogItem => !!i)
  if (items.length < 2) return selectItem(fallback)
  for (const [i, item] of items.entries()) await selectItem(item, i > 0)
}

// ---- boot -------------------------------------------------------------------

let presenceLoading = ''
const viewerRides = (): Ride[] => sceneObjects.map((e, i) => {
  const seat = (side = 0) => {
    const target = e.wrap.getWorldPosition(new THREE.Vector3()), scale = e.wrap.getWorldScale(new THREE.Vector3())
    const size = e.size.length() * Math.max(scale.x, scale.y, scale.z)
    return looking(target.clone().add(new THREE.Vector3(side, 0.4, 1.3).multiplyScalar(Math.max(0.8, size))), target)
  }
  return { id: `object${i + 1}`, name: e.name, style: 'scene', horizon: true, pose: seat, views: [{ name: 'Object', pose: seat }, { name: 'Side', pose: () => seat(0.8) }] }
})
const sharedPresence = new SharedPresence({
  rides: viewerRides,
  capture: () => ({ models: sceneObjects.map(e => e.item?.id ?? ''), holder: [...holder.position.toArray(), ...holder.quaternion.toArray()], parts: parts.listable().map(p => [...p.object.position.toArray(), ...p.object.quaternion.toArray(), ...p.object.scale.toArray()]) }),
  apply(state) {
    const s = state as unknown as { models: string[]; holder: number[]; parts: number[][] }
    if (!Array.isArray(s?.models) || !Array.isArray(s.parts)) return
    const wanted = s.models.join(',')
    if (sceneObjects.map(e => e.item?.id ?? '').join(',') !== wanted) {
      if (presenceLoading !== wanted) {
        presenceLoading = wanted
        void (async () => { for (const [i, id] of s.models.entries()) { const item = CATALOG.find(c => c.id === id && !c.load); if (item) await selectItem(item, i > 0) } })()
      }
      return
    }
    holder.position.fromArray(s.holder); holder.quaternion.fromArray(s.holder, 3)
    parts.listable().forEach((p, i) => { const a = s.parts[i]; if (a?.length === 10) { p.object.position.fromArray(a); p.object.quaternion.fromArray(a, 3); p.object.scale.fromArray(a, 7) } })
  },
})
scene.add(sharedPresence.group)
if (!sharedPresence.guest) { sharedPresence.world.add('ball', [0.7, 0.18, 0.8], 0.18); sharedPresence.world.add('block', [-0.6, 0.18, 0.8], 0.18) }
const experience = new Experience(renderer, scene, camera, viewerRides, sharedPresence, controls)
experience.addEventListener('camerachange', () => { if (experience.immersive) pairChip?.collapse() })
Object.assign(window, { __activeSceneCamera: () => experience.activeCamera })
// The quick-actions tray: its camera steps from the home view to the model framed and to first person (the viewpoint
// row's own; on a phone, first person comes first), and its reset is the view's; pairing, sound, the surface and
// fullscreen come with the tray.
const inOverview = (show: () => void) => () => { if (experience.immersive) void experience.leave().then(show); else show() }
quickViews([
  { name: 'Home view', show: inOverview(resetView) },
  { name: 'Framed', show: inOverview(frameModel) },
  { name: 'First person', show: () => document.querySelector<HTMLButtonElement>('.presence-controls .presence-enter')?.click(), current: () => experience.mode === 'first-person', phone: true },
])
quickAction({ id: 'open', group: 'page', label: 'Open a model', icon: 'folder', run: () => fileInput.click() })
quickAction({ id: 'reset', group: 'page', label: 'Reset the view', hint: 'The model upright, the camera home', icon: 'reset', run: inOverview(resetView) })
mountQuick()

setTheme(theme, false)
buildMore()
buildLightingUI()
applyLighting()
renderRail()
const saved = CATALOG.find((i) => i.id === store.get('obpal.view.model')) ?? CATALOG.find((i) => i.id === DEFAULT_ITEM)!
activeCat = saved.category
renderTiles()
setCatalog(innerWidth > 1024)
stageInset = insetTarget = measureInset() // start centred beside the panel instead of sliding there
applyStageInset()
applyView()
// Local folder catalogue: offers a remembered folder again (never prompts on load); keeps the Local panel and the phone in sync.
void localFolder.init({ note, changed: (items) => { if (activeCat === LOCAL_CATEGORY) renderTiles(); if (items) syncPhoneModels() } })
void restoreScene(saved)
renderer.setAnimationLoop(loop)
hint('catalog', () => $('catalog'), 'Choose a model, or drop in your own file', { place: 'right', delay: 3800 })
hint('tools', () => $('tools'), 'Grid, glow, spin, frame and reset', { place: 'bottom', delay: 7000 })
if (!sharedPresence.guest) startRemote().catch((e) => {
  console.error(e)
  note('Could not start pairing. Check your connection and reload.')
})

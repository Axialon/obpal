/**
 * The embed demo (/embed/): a plain three.js scene and one <obpal-remote>, written the way any page would write it.
 * The element comes from /embed.js; this file only lists the shapes as nodes and reads each person's input per frame.
 * Scan the code and you take a free shape: drag moves it, two fingers push it back or pull it near, a pinch sizes it,
 * a twist turns it, the gyro turns it 1:1, Point moves it where you aim and 3D moves it with your hand. The first
 * person holding nothing turns the view.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { Frame } from '@obpal/host'
import type { ObpalRemote } from '@obpal/host/element'

const canvas = document.getElementById('stage') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(2, devicePixelRatio))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
const scene = new THREE.Scene()
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80)
const target = new THREE.Vector3(0, 0.75, 0)
/** A tall screen (a phone) stands the shapes closer, staggered, and steps back, so all three fit across it. */
const tall = innerHeight > innerWidth
const view = { yaw: 0, pitch: tall ? 0.3 : 0.2, dist: tall ? 10.5 : 7.4 }

const sun = new THREE.DirectionalLight('#ffffff', 2.2)
sun.position.set(3, 6, 4)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.radius = 6
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 })
scene.add(sun)
const floor = new THREE.Mesh(new THREE.CircleGeometry(9, 96), new THREE.ShadowMaterial({ opacity: 0.35 }))
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)
const grid = new THREE.PolarGridHelper(5.2, 12, 6, 96, '#2a3446', '#1a2130')
;(grid.material as THREE.Material).transparent = true
;(grid.material as THREE.Material).opacity = 0.5
scene.add(grid)

interface Shape { id: string; name: string; obj: THREE.Mesh; halo: THREE.Mesh; home: THREE.Vector3; pos: THREE.Vector3; label: HTMLSpanElement; grab: number; atGrab: THREE.Quaternion | null; hand: { gen: number; p0: THREE.Vector3; at: THREE.Vector3 } | null }

const glossy = (color: string) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.22, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.12 })
const labels = document.getElementById('labels')!
const shapes: Shape[] = [
  { id: 'cube', name: 'Cube', geometry: new RoundedBoxGeometry(1, 1, 1, 6, 0.16), color: '#c6ff34', x: -2 },
  { id: 'knot', name: 'Knot', geometry: new THREE.TorusKnotGeometry(0.42, 0.15, 220, 32), color: '#d2c3f6', x: 0 },
  { id: 'orb', name: 'Orb', geometry: new THREE.IcosahedronGeometry(0.58, 3), color: '#38bdf8', x: 2 },
].map((s) => {
  const obj = new THREE.Mesh(s.geometry, glossy(s.color))
  obj.castShadow = true
  scene.add(obj)
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.022, 12, 120), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 }))
  halo.rotation.x = Math.PI / 2
  halo.visible = false
  scene.add(halo)
  const label = document.createElement('span')
  label.innerHTML = '<i></i><b></b><small></small>'
  label.querySelector('b')!.textContent = s.name
  labels.appendChild(label)
  const home = tall ? new THREE.Vector3(s.x * 0.5, 0.85, s.x ? 0.5 : -0.9) : new THREE.Vector3(s.x, 0.85, 0)
  return { id: s.id, name: s.name, obj, halo, home, pos: home.clone(), label, grab: -1, atGrab: null, hand: null }
})
const shapeOf = (id: string | null) => shapes.find((s) => s.id === id) ?? null

// ---- the element: what phones can take over, and what they do ----

/** The element, once /embed.js has defined it; the scene runs without it until then (or where it can't load). */
let pal: ObpalRemote | null = null
const events: string[] = []
Object.assign(window, { __demo: { shapes, events, view } })

void customElements.whenDefined('obpal-remote').then(() => {
  const el = document.querySelector('obpal-remote')!
  pal = el
  Object.assign(window, { __demo: { pal: el, shapes, events, view } })
  el.layout = { tray: [{ id: 'reset', label: 'Reset', icon: 'reset' }] }
  el.setScene({ nodes: shapes.map((s) => ({ id: s.id, name: s.name, kind: 'object' })) })
  for (const t of ['obpal-connect', 'obpal-disconnect', 'obpal-join', 'obpal-leave', 'obpal-button', 'obpal-mode', 'obpal-claim'] as const) {
    el.addEventListener(t, (e) => events.push(e.type))
  }
  // Whoever joins takes the first free shape (the scene list on their phone picks another).
  el.addEventListener('obpal-join', (e) => {
    const free = shapes.find((s) => !el.holder(s.id))
    if (free) el.setScene({ held: { ...el.held, [free.id]: e.detail.participant.id } })
    people(el)
  })
  el.addEventListener('obpal-leave', () => people(el))
  el.addEventListener('obpal-claim', () => queueMicrotask(() => people(el)))
  el.addEventListener('obpal-button', (e) => {
    const { id, ev, participant } = e.detail
    if (id === 'reset') for (const s of shapes) reset(s)
    // A double tap on the trackpad puts back what you hold.
    if (id === 'pad' && ev === 'double') { const s = shapeOf(el.holding(participant.id)); if (s) reset(s) }
  })
  const note = (status: string, reason = '') => {
    const n = document.getElementById('note')!
    n.hidden = status !== 'unsupported' && status !== 'error'
    n.textContent = status === 'unsupported' ? `No phone can pair in this browser: ${reason}.` : 'The remote could not start here.'
  }
  el.addEventListener('obpal-status', (e) => note(e.detail.status, e.detail.reason))
  note(el.status)
})

function reset(s: Shape) {
  s.pos.copy(s.home)
  s.obj.quaternion.identity()
  s.obj.scale.setScalar(1)
}

function people(pal: ObpalRemote) {
  const list = document.getElementById('people')!
  list.replaceChildren(...pal.participants.map((p) => {
    const li = document.createElement('li')
    li.innerHTML = '<span class="person"></span><span></span><small></small>'
    const dot = li.querySelector<HTMLElement>('.person')!
    dot.style.setProperty('--c', p.color)
    dot.textContent = p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    li.children[1].textContent = p.name
    li.querySelector('small')!.textContent = shapeOf(pal.holding(p.id))?.name ?? (p.lead ? 'the view' : '')
    return li
  }))
}

// ---- input, each frame ----

const DEG = Math.PI / 180
const v = new THREE.Vector3()
const q = new THREE.Quaternion()
const right = new THREE.Vector3()
const up = new THREE.Vector3()
const back = new THREE.Vector3()

/** One person's frame on the shape they hold. */
function drive(s: Shape, f: Frame, dt: number) {
  right.set(1, 0, 0).applyQuaternion(camera.quaternion)
  up.set(0, 1, 0).applyQuaternion(camera.quaternion)
  back.set(0, 0, 1).applyQuaternion(camera.quaternion)
  const k = 0.012
  // Drag across, two fingers in depth, pinch to size, twist to turn.
  s.pos.addScaledVector(right, f.pad1[0] * k).addScaledVector(up, -f.pad1[1] * k).addScaledVector(back, f.pad2[1] * k)
  s.obj.scale.setScalar(THREE.MathUtils.clamp(s.obj.scale.x * 2 ** f.zoom, 0.4, 2.4))
  s.obj.quaternion.premultiply(q.setFromAxisAngle(back, -f.twist * DEG))
  // The gyro, 1:1: while it is on, the shape turns as the phone does (PROTOCOL §4: camera · qRel · camera⁻¹ · at grab).
  if (f.clutch) {
    if (s.grab !== f.grab || !s.atGrab) { s.grab = f.grab; s.atGrab = s.obj.quaternion.clone() }
    q.set(f.qRel[0], f.qRel[1], f.qRel[2], f.qRel[3])
    s.obj.quaternion.copy(camera.quaternion).multiply(q).multiply(camera.quaternion.clone().invert()).multiply(s.atGrab)
  } else s.atGrab = null
  // Tilt spins it.
  s.obj.quaternion.premultiply(q.setFromAxisAngle(up, f.tilt[0] * dt * 3)).premultiply(q.setFromAxisAngle(right, -f.tilt[1] * dt * 3))
  // Point: it goes where you aim (aim is yaw + left, pitch + up, in degrees).
  if (f.mode === 2) s.pos.addScaledVector(right, -f.aim[0] * 0.06).addScaledVector(up, f.aim[1] * 0.06)
  // 3D: with a thumb down, it moves as the hand does (twice as far).
  const pose = f.pose
  if (pose?.touching) {
    if (!s.hand || s.hand.gen !== pose.gen) s.hand = { gen: pose.gen, p0: new THREE.Vector3(...pose.p), at: s.pos.clone() }
    v.set(...pose.p).sub(s.hand.p0).multiplyScalar(2)
    s.pos.copy(s.hand.at).addScaledVector(right, v.x).addScaledVector(up, v.y).addScaledVector(back, v.z)
  } else s.hand = null
  s.pos.set(THREE.MathUtils.clamp(s.pos.x, -4, 4), THREE.MathUtils.clamp(s.pos.y, 0.3, 3.4), THREE.MathUtils.clamp(s.pos.z, -3.5, 2.6))
}

/** The lead holding nothing turns the view: drag to orbit, pinch to come closer. */
function orbit(f: Frame) {
  view.yaw -= f.pad1[0] * 0.006
  view.pitch = THREE.MathUtils.clamp(view.pitch + f.pad1[1] * 0.004, 0.02, 1.1)
  view.dist = THREE.MathUtils.clamp(view.dist / 2 ** f.zoom, 4, 12)
}

function resize() {
  const w = innerWidth
  const h = innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  // Leave room for the panel on a wide screen, and step back on a tall one.
  camera.setViewOffset(w, h, w > 860 ? -Math.min(190, w * 0.12) : 0, h > w ? h * 0.12 : 0, w, h)
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

let last = performance.now()
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const here = pal?.participants ?? []
  for (const p of here) {
    const f = pal!.frame(now, p.id)
    const s = shapeOf(pal!.holding(p.id))
    if (s) drive(s, f, dt)
    else if (p.lead) orbit(f)
  }
  camera.position.set(Math.sin(view.yaw) * Math.cos(view.pitch), Math.sin(view.pitch), Math.cos(view.yaw) * Math.cos(view.pitch)).multiplyScalar(view.dist).add(target)
  camera.lookAt(target)
  const t = now / 1000
  const w = innerWidth
  const h = innerHeight
  shapes.forEach((s, i) => {
    const who = pal?.holder(s.id)
    const p = who ? here.find((x) => x.id === who) : undefined
    // Free shapes breathe; held ones stay exactly where their person puts them.
    s.obj.position.copy(s.pos)
    if (!who) {
      s.obj.position.y += Math.sin(t * 1.3 + i * 2) * 0.05
      s.obj.rotateY(dt * 0.25)
    }
    s.halo.visible = !!p
    if (p) (s.halo.material as THREE.MeshBasicMaterial).color.set(p.color)
    s.halo.position.set(s.pos.x, 0.02, s.pos.z)
    s.halo.scale.setScalar(s.obj.scale.x * (1 + Math.sin(t * 3) * 0.03))
    v.copy(s.pos).setY(s.pos.y - 0.78 * s.obj.scale.x).project(camera)
    s.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, 0)`
    s.label.classList.toggle('held', !!p)
    s.label.style.setProperty('--c', p?.color ?? '')
    s.label.querySelector('small')!.textContent = p ? p.name : ''
  })
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

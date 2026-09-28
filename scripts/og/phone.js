/**
 * The phone on ob.Pal's link preview (./card.html), in the 3D design language (spec/STYLE-3D.md): held sideways as a
 * controller, a polished gunmetal plate with a 45° housing chamfer and satin titanium sides, a machined rim and a
 * recessed Carbon seam round the screen, and along its top edge a flush ceramic service inset and two short Lime slits.
 * Its screen shows the gamepad face lit in Lime. The finishes are the sim kit's (src/sim/kit/surfaces.ts). It draws
 * once, into a canvas twice the card's pixels (so its edges come out smooth), then sets window.__ready.
 * Units are millimetres.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const canvas = document.getElementById('phone')
const W = canvas.clientWidth, H = canvas.clientHeight
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(2)
renderer.setSize(W, H, false)
renderer.setClearColor(0x000000, 0)
renderer.outputColorSpace = THREE.SRGBColorSpace
// Not too bright (the design direction): neutral tone mapping, a little under 1.
renderer.toneMapping = THREE.NeutralToneMapping
renderer.toneMappingExposure = 0.9

const scene = new THREE.Scene()
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.6

// The kit's finishes (src/sim/kit/surfaces.ts).
const gunmetal = new THREE.MeshStandardMaterial({ color: '#3d484f', metalness: 0.9, roughness: 0.24 })
const titanium = new THREE.MeshStandardMaterial({ color: '#8a9499', metalness: 0.94, roughness: 0.31 })
const polished = new THREE.MeshStandardMaterial({ color: '#c2cbcd', metalness: 0.97, roughness: 0.17 })
const ceramic = new THREE.MeshPhysicalMaterial({ color: '#e9e8e0', metalness: 0.12, roughness: 0.26, clearcoat: 0.8, clearcoatRoughness: 0.19 })
const carbon = new THREE.MeshStandardMaterial({ color: '#202729', metalness: 0.32, roughness: 0.48 })
const lime = new THREE.MeshStandardMaterial({ color: '#a4ce35', emissive: '#c6ff34', emissiveIntensity: 1.1, roughness: 0.3 })

/** A plate outline with its corners clipped at 45° (plan corners of 135°: no rounded pebbles), centred. */
function clipped(w, h, c) {
  const s = new THREE.Shape()
  s.moveTo(-w / 2 + c, -h / 2)
  s.lineTo(w / 2 - c, -h / 2); s.lineTo(w / 2, -h / 2 + c); s.lineTo(w / 2, h / 2 - c); s.lineTo(w / 2 - c, h / 2)
  s.lineTo(-w / 2 + c, h / 2); s.lineTo(-w / 2, h / 2 - c); s.lineTo(-w / 2, -h / 2 + c)
  s.closePath()
  return s
}
/** A flat plate of that outline, with its texture coordinates across it (0 to 1). */
function plate(w, h, c, material) {
  const g = new THREE.ShapeGeometry(clipped(w, h, c))
  const p = g.attributes.position, uv = g.attributes.uv
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5)
  return new THREE.Mesh(g, material)
}
/** A ring between two such outlines (the machined rim). */
function rim(w, h, c, inset, material) {
  const s = clipped(w, h, c)
  s.holes.push(clipped(w - 2 * inset, h - 2 * inset, c - inset * 0.41))
  return new THREE.Mesh(new THREE.ShapeGeometry(s), material)
}

// The gamepad face, drawn for the screen: a stick in a Lime ring on the left, four face buttons on the right with A in
// Lime, shoulder and menu marks, over the trackpad's faint dots. Everything else on the glass stays dark.
const SW = 144, SH = 64, SC = 6
function face() {
  const k = 12, c = document.createElement('canvas')
  c.width = SW * k; c.height = SH * k
  const g = c.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = 'rgba(179, 164, 255, 0.16)'
  for (let y = 18; y < c.height; y += 36) for (let x = 18; x < c.width; x += 36) { g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill() }
  const at = (u, v) => [u * c.width, v * c.height]
  const glow = (color, blur) => { g.shadowColor = color; g.shadowBlur = blur }
  // The stick.
  const [sx, sy] = at(0.21, 0.56)
  glow('rgba(198, 255, 52, 0.9)', 36)
  g.strokeStyle = '#c6ff34'; g.lineWidth = 14
  g.beginPath(); g.arc(sx, sy, 150, 0, Math.PI * 2); g.stroke()
  const knob = g.createRadialGradient(sx - 20, sy - 24, 8, sx, sy, 70)
  knob.addColorStop(0, '#f4ffd6'); knob.addColorStop(0.45, '#c6ff34'); knob.addColorStop(1, '#6f9a12')
  g.fillStyle = knob
  g.beginPath(); g.arc(sx + 34, sy - 26, 62, 0, Math.PI * 2); g.fill()
  // The face buttons: Y, X, B outlined, A lit.
  const [bx, by] = at(0.79, 0.53)
  const d = 118, r = 50
  g.lineWidth = 9
  for (const [dx, dy] of [[0, -d], [-d, 0], [d, 0]]) {
    glow('rgba(235, 228, 255, 0.5)', 14)
    g.strokeStyle = 'rgba(235, 228, 255, 0.72)'
    g.beginPath(); g.arc(bx + dx, by + dy, r, 0, Math.PI * 2); g.stroke()
  }
  glow('rgba(198, 255, 52, 0.95)', 40)
  g.fillStyle = '#c6ff34'
  g.beginPath(); g.arc(bx, by + d, r, 0, Math.PI * 2); g.fill()
  // Shoulders and the two menu marks.
  glow('rgba(235, 228, 255, 0.4)', 10)
  g.fillStyle = 'rgba(235, 228, 255, 0.55)'
  const bar = (x, y, w, h) => { g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fill() }
  bar(at(0.07, 0)[0], 44, 250, 22); bar(at(0.93, 0)[0] - 250, 44, 250, 22)
  bar(at(0.46, 0)[0] - 40, 150, 60, 22); bar(at(0.54, 0)[0] - 20, 150, 60, 22)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return t
}

// The body: a clipped plate extruded 7 mm, chamfered 1.4 mm at 45° all round (the housing edge); its front is at FRONT.
const PW = 152, PH = 72, PC = 9, DEPTH = 7, BEVEL = 1.4, FRONT = DEPTH + BEVEL
const parts = new THREE.Group()
parts.add(new THREE.Mesh(
  new THREE.ExtrudeGeometry(clipped(PW, PH, PC), { depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 1, steps: 1 }),
  [gunmetal, titanium],
))
// Round the screen: a machined rim, then the recessed Carbon seam, then the glass with the face on it.
const layer = (mesh, z) => { mesh.position.z = FRONT + z; parts.add(mesh) }
layer(rim(PW - 5, PH - 5, PC - 2, 0.9, polished), 0.02)
layer(plate(PW - 6.8, PH - 6.8, PC - 2.8, carbon), 0.03)
layer(plate(SW, SH, SC, new THREE.MeshPhysicalMaterial({
  color: '#0b1216', metalness: 0.2, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04,
  emissive: '#ffffff', emissiveMap: face(), emissiveIntensity: 1.25,
})), 0.05)
// Along the top edge: a ceramic service inset in its Carbon seam, and two short Lime slits.
const edge = (w, d, material, x, lift) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), material)
  m.position.set(x, PH / 2 + BEVEL + lift, DEPTH / 2)
  parts.add(m)
}
edge(48, DEPTH - 1.2, carbon, -24, 0.02)
edge(46, DEPTH - 2.6, ceramic, -24, 0.06)
edge(8, 1.4, lime, 24, 0.04)
edge(8, 1.4, lime, 36, 0.04)
// Centred on its own middle, then held: tipped back toward you, turned toward the headline, rolled a touch.
parts.position.z = -DEPTH / 2
const phone = new THREE.Group()
phone.add(parts)
phone.rotation.set(0.44, -0.5, 0.16, 'YXZ')
scene.add(phone)

// Light: a cool key from the upper left and the night's ultraviolet from behind on the right. The Lime is the screen's
// own and the slits' (sparse: the glass stays dark around the face).
const key = new THREE.DirectionalLight('#f4f2ff', 2.4)
key.position.set(-220, 320, 420)
const uv = new THREE.DirectionalLight('#5c3ef5', 0.8)
uv.position.set(360, 60, -260)
scene.add(key, uv)

const camera = new THREE.PerspectiveCamera(26, W / H, 10, 3000)
camera.position.set(0, 10, 440)
camera.lookAt(0, 0, 0)
renderer.render(scene, camera)
window.__ready = true

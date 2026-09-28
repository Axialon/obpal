import * as THREE from 'three'
import { darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { batch, metal } from '../kit'
import { PendulumLogic } from './pendulum'
import { block, disc, playFrame, rod, showcase } from './parts'
import { caption, part } from './optics.view'
import type { Stage } from './stage'
import { mats, wear, type DeviceView } from './view'

function lab(scene: THREE.Scene, logic: PendulumLogic) {
  const frame = part(scene, 'pendulum-laboratory')
  frame.add(tiledDeck(5.7, 2.5, .07, .95))
  block(frame, [5.05, 1.7, .065], [0, 1.85, -1], gunmetal)
  for (const x of [-2.6, 2.6]) { rod(frame, [x, 0.08, 0], [x, 3.1, 0], 0.065); block(frame, [0.65, 0.13, 0.9], [x, 0.15, 0], darkTitanium) }
  rod(frame, [-2.6, 3.1, 0], [2.6, 3.1, 0], 0.075); batch(frame)
  const colors = ['#d5ad72', '#88b8c7', '#b3c88a']
  const models = logic.units.map((_, n) => {
    const mount = part(scene, `pendulum-${n + 1}`); mount.position.set((n - 1) * 1.65, 2.9, 0)
    disc(mount, 0.13, 0.16, [0, 0.075, 0], metal)
    const pivot = part(mount, 'swing-pivot'), line = rod(pivot, [0, 0, 0], [0, -1, 0], 0.012)
    const bob = part(pivot, 'adjustable-bob'), sphere = new THREE.Mesh(new THREE.SphereGeometry(0.18, 28, 20), metal); bob.add(sphere)
    const plate = service(.14, .1); plate.position.set(0, .076, .083); mount.add(plate)
    pov(pivot, [0, -.04, .08], [0, -1, 0])
    const light = mats.glow(); disc(bob, 0.07, 0.01, [0, 0.181, 0], light)
    const number = caption(String(n + 1), colors[n], 0.35); number.position.set(0, 0.4, 0); mount.add(number)
    return { pivot, line, bob, light }
  })
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 320
  const ctx = canvas.getContext('2d')!, texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
  const graph = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.5), new THREE.MeshBasicMaterial({ map: texture })); graph.name = 'live-angle-trace'; graph.position.set(0, 1.85, -0.95); scene.add(graph)
  let last = -1
  return { step(t: number, colorsHeld: readonly (string | null)[] = []) {
    models.forEach((m, n) => { const u = logic.units[n]; m.pivot.rotation.z = u.angle; m.line.scale.y = u.length; m.line.position.y = -u.length / 2; m.bob.position.y = -u.length; wear(m.light, colorsHeld[n] ?? null) })
    if (Math.floor(t * 15) === last) return false
    last = Math.floor(t * 15)
    ctx.fillStyle = '#152330'; ctx.fillRect(0, 0, 1024, 320)
    ctx.strokeStyle = '#364957'; ctx.lineWidth = 1
    for (let x = 60; x <= 1000; x += 94) { ctx.beginPath(); ctx.moveTo(x, 50); ctx.lineTo(x, 270); ctx.stroke() }
    for (const y of [60, 165, 270]) { ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(1000, y); ctx.stroke() }
    ctx.fillStyle = '#d7e3df'; ctx.font = '24px system-ui'; ctx.fillText('ANGLE / TIME', 60, 32); ctx.fillText('−10 s', 60, 305); ctx.fillText('now', 950, 305)
    ctx.font = '18px system-ui'; ctx.fillText('+80°', 6, 66); ctx.fillText('0°', 18, 172); ctx.fillText('−80°', 6, 273)
    logic.units.forEach((u, n) => { ctx.strokeStyle = colors[n]; ctx.lineWidth = 3; ctx.beginPath(); u.trace.forEach((a, j) => { const x = 1000 - (u.trace.length - 1 - j) / 299 * 940, y = 165 - a / 1.4 * 105; if (!j) ctx.moveTo(x, y); else ctx.lineTo(x, y) }); ctx.stroke(); ctx.fillStyle = colors[n]; ctx.fillText(`${n + 1}: ${u.length.toFixed(2)} m`, 410 + n * 185, 32) })
    texture.needsUpdate = true; return true
  } }
}
export function createView(stage: Stage, logic: PendulumLogic): DeviceView {
  const m = lab(stage.scene, logic)
  return { framing: playFrame([0, 1.8, 0], 3.1, [0.18, 0.25, 1.15]), overview: playFrame([0, 1.5, 0], 3.6), inspect: () => playFrame([-1.65, 2, 0], 0.8), update: (colors, t) => { if (m.step(t, colors)) stage.view.invalidate() } }
}
export function preview() {
  const l = new PendulumLogic()
  return showcase(scene => { const m = lab(scene, l); return { step(t, dt) { if (!l.units[0].elapsed) l.units.forEach(u => { u.omega = 1.4 }); l.step([], dt); m.step(t) } } }, [0, 1.7, 0], 2.3)
}

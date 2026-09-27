/**
 * The PTZ cameras' look (three.js): a round set with a toy train on its oval and a turning sculpture, each camera on a
 * tripod with its head turning and its lens reaching out as it zooms, and each camera's picture on the screen, framed
 * in its holder's colour, flashing as it takes one.
 */
import * as THREE from 'three'
import { offCentre, PTZ, PtzLogic, TRACK, trainAt, type Cam } from './ptz'
import type { Stage } from './stage'
import type { Theme } from '../../ui/themes'
import { blobShadow, box, mats, plate, previewScene, wear, type DeviceView, type Preview } from './view'

interface CamModel { root: THREE.Group; head: THREE.Group; body: THREE.Group; lens: THREE.Mesh; tally: THREE.MeshStandardMaterial; eye: THREE.PerspectiveCamera }

function buildCam(n: number): CamModel {
  const root = new THREE.Group()
  const dark = mats.dark()
  // A tripod up to the head.
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 1.5, 8), dark)
    const a = (i / 3) * Math.PI * 2
    leg.position.set(Math.cos(a) * 0.22, 0.7, Math.sin(a) * 0.22)
    leg.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3)
    root.add(leg)
  }
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 12), mats.metal())
  column.position.y = 1.28
  root.add(column)
  const head = new THREE.Group()
  head.position.y = 1.45
  root.add(head)
  const yoke = box(0.2, 0.05, 0.12, dark, 0.015)
  head.add(yoke)
  const body = new THREE.Group()
  body.position.y = 0.1
  head.add(body)
  const shell = box(0.18, 0.13, 0.26, mats.body(), 0.03)
  body.add(shell)
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.12, 32), dark)
  lens.rotation.x = Math.PI / 2
  lens.position.z = -0.17
  // The front glass, facing out of the lens's front end (its local −y once the lens lies along z).
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.045, 32), new THREE.MeshPhysicalMaterial({ color: '#27306b', metalness: 0.2, roughness: 0.05, clearcoat: 1 }))
  glass.position.y = -0.061
  glass.rotation.x = Math.PI / 2
  lens.add(glass)
  body.add(lens)
  const tally = mats.glow('#3b1016')
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), tally)
  light.position.set(0.05, 0.075, -0.09)
  body.add(light)
  const num = plate(n + 1, 0.07)
  num.position.set(0.091, 0, 0.02)
  num.rotation.y = Math.PI / 2
  body.add(num)
  root.add(blobShadow(0.32, 0.45))
  // What it sees: a camera at the front of its lens.
  const eye = new THREE.PerspectiveCamera((PTZ.fov * 180) / Math.PI, 16 / 9, 0.05, 40)
  eye.position.set(0, 0, -0.24)
  body.add(eye)
  return { root, head, body, lens, tally, eye }
}

function placeCam(m: CamModel, c: Cam, color: string | null) {
  m.head.rotation.y = c.pan
  m.body.rotation.x = c.tilt
  // The lens reaches out as it zooms in.
  m.lens.scale.set(1, 1 + (c.zoom - 1) * 0.12, 1)
  m.lens.position.z = -0.17 - (c.zoom - 1) * 0.007
  m.eye.fov = (PTZ.fov / c.zoom) * (180 / Math.PI)
  m.eye.updateProjectionMatrix()
  wear(m.tally, color, 0.3, 2.6)
}

/** The toy train: an engine and two wagons, each placed along the track a little behind the last. */
function buildTrain() {
  const colors = ['#c6ff34', '#b3a4ff', '#38bdf8']
  const cars = colors.map((c, i) => {
    const g = new THREE.Group()
    const paint = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.2, roughness: 0.35, clearcoat: 0.8 })
    const bodyBox = box(0.16, 0.12, 0.32, i ? paint : mats.body(), 0.03)
    bodyBox.position.y = 0.1
    g.add(bodyBox)
    if (i === 0) {
      const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.2, 24), paint)
      boiler.rotation.x = Math.PI / 2
      boiler.position.set(0, 0.2, -0.05)
      const cab = box(0.15, 0.1, 0.1, mats.dark(), 0.02)
      cab.position.set(0, 0.22, 0.1)
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.07, 12), mats.dark())
      stack.position.set(0, 0.28, -0.11)
      g.add(boiler, cab, stack)
    }
    for (const z of [-0.1, 0.1]) {
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.19, 16), mats.dark())
      axle.rotation.z = Math.PI / 2
      axle.position.set(0, 0.035, z)
      g.add(axle)
    }
    g.add(blobShadow(0.2, 0.4))
    return g
  })
  const place = (t: number) => cars.forEach((g, i) => {
    const p = trainAt(t - i * 0.95)
    const q = trainAt(t - i * 0.95 + 0.05)
    g.position.set(p[0], 0, p[2])
    g.rotation.y = Math.atan2(-(q[0] - p[0]), -(q[2] - p[2]))
  })
  return { cars, place }
}

/** The set: a round floor, the track's rails and sleepers, a turning sculpture and a few blocks. */
function buildSet() {
  const g = new THREE.Group()
  const floorMat = new THREE.MeshStandardMaterial({ color: '#262c37', roughness: 0.9 })
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.04, 96), floorMat)
  floor.position.y = -0.02
  g.add(floor)
  const rail = mats.metal()
  for (const k of [-0.07, 0.07]) {
    const curve = new THREE.EllipseCurve(0, 0, TRACK.rx + k, TRACK.rz + k, 0, Math.PI * 2, false, 0)
    const pts = curve.getPoints(160).map((p) => new THREE.Vector3(TRACK.x + p.x, 0.012, TRACK.z + p.y))
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 200, 0.01, 6, true), rail)
    g.add(tube)
  }
  const sleeperMat = new THREE.MeshStandardMaterial({ color: '#3a4250', roughness: 0.8 })
  const sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.012, 0.045), sleeperMat, 64)
  const m4 = new THREE.Matrix4()
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2
    const x = TRACK.x + Math.cos(a) * TRACK.rx, z = TRACK.z + Math.sin(a) * TRACK.rz
    const along = Math.atan2(-(Math.cos(a) * TRACK.rz), -(-Math.sin(a) * TRACK.rx))
    sleepers.setMatrixAt(i, m4.compose(new THREE.Vector3(x, 0.004, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, along + Math.PI / 2, 0)), new THREE.Vector3(1, 1, 1)))
  }
  g.add(sleepers)
  const sculpture = new THREE.Group()
  sculpture.position.set(TRACK.x, 0, TRACK.z)
  const pearl = new THREE.MeshPhysicalMaterial({ color: '#e6e1ff', metalness: 0.25, roughness: 0.3, clearcoat: 0.8 })
  for (let i = 0; i < 9; i++) {
    const b = box(0.34 - i * 0.02, 0.1, 0.34 - i * 0.02, pearl, 0.03)
    b.position.y = 0.06 + i * 0.105
    b.rotation.y = i * 0.18
    sculpture.add(b)
  }
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.09, 32, 20), new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#c6ff34', emissiveIntensity: 1.4 }))
  top.position.y = 1.08
  sculpture.add(top)
  g.add(sculpture)
  for (const [x, z, c] of [[-1.2, 1.2, '#fb7185'], [1.4, 1.1, '#fcd34d'], [0.9, -2.1, '#6ee7b7']] as const) {
    const b = box(0.24, 0.24, 0.24, new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }), 0.04)
    b.position.set(x, 0.12, z)
    g.add(b)
  }
  return { group: g, sculpture, floor: floorMat }
}

/**
 * The pictures' frames on the screen, and where each goes: down the right on a wide screen (ending above the pairing
 * chip in the corner: its offset, its 44px and a gap), side by side on a narrow one.
 */
function insetRects(count: number) {
  const W = innerWidth
  if (W <= 860) {
    const w = Math.floor((W - 24 - (count - 1) * 8) / count)
    return Array.from({ length: count }, (_, i) => ({ x: 12 + i * (w + 8), y: 70, w, h: Math.round((w * 9) / 16) }))
  }
  const fits = (((innerHeight - 88 - 76 - (count - 1) * 14) / count) * 16) / 9
  const w = Math.round(Math.max(160, Math.min(420, Math.max(240, W * 0.24), fits)))
  const h = Math.round((w * 9) / 16)
  return Array.from({ length: count }, (_, i) => ({ x: W - 20 - w, y: 88 + i * (h + 14), w, h }))
}

export function createView(stage: Stage, logic: PtzLogic): DeviceView {
  const set = buildSet()
  stage.scene.add(set.group)
  const train = buildTrain()
  stage.scene.add(...train.cars)
  const models = logic.cams.map((c, n) => {
    const m = buildCam(n)
    m.root.position.set(c.at[0], 0, c.at[2])
    m.head.position.y = c.at[1]
    stage.scene.add(m.root)
    return m
  })
  // The pictures' frames: a label, the zoom, and a flash.
  const layer = document.createElement('div')
  layer.className = 'ptz-insets'
  document.body.appendChild(layer)
  const frames = logic.cams.map((_, n) => {
    const el = document.createElement('div')
    el.className = 'ptz-inset'
    el.innerHTML = '<span class="ptz-rec"></span><b></b><i></i><span class="ptz-flash"></span>'
    el.querySelector('b')!.textContent = `Cam ${n + 1}`
    layer.appendChild(el)
    return el
  })
  const setTheme = (t: Theme) => set.floor.color.set(t.light ? '#d9dee6' : '#262c37')
  setTheme(stage.theme)
  let rects = insetRects(logic.cams.length)
  addEventListener('resize', () => { rects = insetRects(logic.cams.length) })
  const size = new THREE.Vector2()
  const clear = new THREE.Color()
  return {
    framing: { target: [0.75, 0.45, -0.35], wide: [0.75, 4.6, 7.2], tall: [0, 6, 7.5], radius: 2.9, min: 2.5, max: 16 },
    update(colors, t) {
      set.sculpture.rotation.y = t * 0.25
      train.place(logic.time)
      logic.cams.forEach((c, n) => {
        placeCam(models[n], c, colors[n])
        const f = frames[n]
        const r = rects[n]
        f.style.transform = `translate(${r.x}px, ${r.y}px)`
        f.style.width = `${r.w}px`
        f.style.height = `${r.h}px`
        f.style.setProperty('--c', colors[n] ?? 'rgb(255 255 255 / 0.35)')
        f.querySelector('i')!.textContent = `${c.zoom.toFixed(1)}×`
        f.classList.toggle('held', !!colors[n])
        f.classList.toggle('lock', offCentre(c, logic.train) < 0.35)
        f.classList.toggle('flash', c.flash > 0)
      })
    },
    afterRender() {
      const r = stage.renderer
      // The drawing buffer's pixels per CSS pixel (the stage draws at the density the device affords).
      r.getSize(size)
      const k = size.x / stage.view.width
      r.getClearColor(clear)
      const alpha = r.getClearAlpha()
      r.setScissorTest(true)
      logic.cams.forEach((_, n) => {
        const rect = rects[n]
        const [x, w, h] = [Math.round(rect.x * k), Math.round(rect.w * k), Math.round(rect.h * k)]
        const y = size.y - Math.round(rect.y * k) - h
        r.setViewport(x, y, w, h)
        r.setScissor(x, y, w, h)
        r.setClearColor(stage.theme.light ? '#dfe5ee' : '#0b0d12', 1)
        r.clear()
        models[n].eye.aspect = rect.w / rect.h
        models[n].eye.updateProjectionMatrix()
        r.render(stage.scene, models[n].eye)
      })
      r.setScissorTest(false)
      r.setViewport(0, 0, size.x, size.y)
      r.setClearColor(clear, alpha)
    },
    setTheme,
  }
}

/** The card: a camera turning to follow the train round its oval. */
export function preview(): Preview {
  const scene = previewScene()
  const set = buildSet()
  set.floor.color.set('#241d4a')
  scene.add(set.group)
  const train = buildTrain()
  scene.add(...train.cars)
  const logic = new PtzLogic(1)
  const m = buildCam(0)
  const c = logic.cams[0]
  m.root.position.set(c.at[0], 0, c.at[2])
  scene.add(m.root)
  const camera = new THREE.PerspectiveCamera(38, 16 / 10, 0.05, 40)
  camera.position.set(0.9, 3.2, 5)
  camera.lookAt(0, 0.5, -0.7)
  return {
    scene, camera,
    step(t, dt) {
      logic.time = t
      train.place(t)
      // The camera follows the train, a moment behind.
      const p = logic.train
      const [pan, tilt] = [Math.atan2(-(p[0] - c.at[0]), -(p[2] - c.at[2])), Math.atan2(p[1] + 0.1 - c.at[1], Math.hypot(p[0] - c.at[0], p[2] - c.at[2]))]
      c.goal = [pan, tilt]
      c.zoom = 2 + Math.sin(t * 0.5)
      c.pan += (c.goal[0] - c.pan) * Math.min(1, dt * 3)
      c.tilt += (c.goal[1] - c.tilt) * Math.min(1, dt * 3)
      placeCam(m, c, '#c6ff34')
      set.sculpture.rotation.y = t * 0.25
    },
  }
}

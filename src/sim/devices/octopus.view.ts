/**
 * The octopus's look (three.js): Cove, an original design. A satin obsidian mantle with panel seams, a lime seam and a
 * smoked-glass sensor belt over a lime core, on a soft collar; eight graphite arms swept along the logic's continuum
 * frames, their cups instanced on the oral side, and a web between the arms near the root. All procedural: no meshes
 * or textures are downloaded. Only the ball casts a shadow map; soft blob shadows sit under the body and the ball.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { plastic } from '../kit'
import { pov, tiledDeck } from '../kit/precision'
import { contactPart, contactSurface } from '../contact'
import { BALL_RADIUS, OCTOPUS_LIMITS, OctopusLogic } from './octopus'
import { ArmSweep, CupSweep, WebSweep } from './octopus-sweep'
import { OCTOPUS_PROFILE, profileYaw, type Octopus } from './octopus-types'
import { playFrame, showcase } from './parts'
import type { Stage } from './stage'
import { restInput } from './types'
import { blobShadow, type DeviceView } from './view'

/** Mantle proportions: 0.38 m along its axis, 0.30 m across, leaning back on the collar (design values). */
const MANTLE = { length: 0.38, radius: 0.15, lean: -0.42 }
const LIME = '#c6ff34'

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The Cove finishes: satin, low-gloss obsidian; graphite elastomer; pale metal cup rims over dark bowls. */
function finishes() {
  return {
    mantle: new THREE.MeshPhysicalMaterial({ color: '#15191c', metalness: 0.4, roughness: 0.34, clearcoat: 0.4, clearcoatRoughness: 0.32 }),
    seam: new THREE.MeshStandardMaterial({ color: '#07090a', metalness: 0.2, roughness: 0.6 }),
    belt: new THREE.MeshPhysicalMaterial({ color: '#0d1a1d', metalness: 0.3, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12, transparent: true, opacity: 0.82 }),
    core: new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: LIME, emissiveIntensity: 1.8, roughness: 0.3 }),
    signal: new THREE.MeshStandardMaterial({ color: '#a4ce35', emissive: LIME, emissiveIntensity: 0.7, roughness: 0.3 }),
    skin: new THREE.MeshStandardMaterial({ color: '#1d2125', metalness: 0.02, roughness: 0.66, envMapIntensity: 0.3 }),
    arms: rim(new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, metalness: 0.02, roughness: 0.58, envMapIntensity: 0.28 }), '#9fb2be', 0.14),
    web: new THREE.MeshStandardMaterial({ color: '#1a1e21', metalness: 0.02, roughness: 0.7, envMapIntensity: 0.28, side: THREE.DoubleSide }),
    cups: new THREE.MeshStandardMaterial({ color: '#c3cbd1', metalness: 0.7, roughness: 0.3, vertexColors: true }),
  }
}

/**
 * A soft rim light: the surface brightens where it turns away from the camera, so dark arms separate from a dark floor.
 * Added as emission in the shader; it costs no light or draw.
 */
function rim<T extends THREE.MeshStandardMaterial>(material: T, color: string, strength: number): T {
  const tint = new THREE.Color(color).multiplyScalar(strength)
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimTint = { value: tint }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimTint;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rimTint * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);')
  }
  material.customProgramCacheKey = () => `octopus-rim-${color}-${strength}`
  return material
}

/** A point on the mantle's egg, in its own frame: t from 0 at the base to π at the crown, phi round from the front. */
function eggPoint(t: number, phi: number, lift = 0, out = new THREE.Vector3()) {
  const r = MANTLE.radius * Math.sin(t) * (1 - 0.13 * Math.cos(t)) + lift
  return out.set(Math.sin(phi) * r, (MANTLE.length / 2) * (1 - Math.cos(t)) + lift * -Math.cos(t), Math.cos(phi) * r)
}

/** Seams as thin tubes just proud of the shell: meridian panel lines and one band below the belt. */
function seams(curves: [number, number][][], radius: number) {
  const geometries = curves.map((points) => {
    const path = new THREE.CatmullRomCurve3(points.map(([t, phi]) => eggPoint(t, phi, 0.0015)))
    return new THREE.TubeGeometry(path, Math.max(8, points.length * 6), radius, 5, false)
  })
  const merged = mergeGeometries(geometries)!
  geometries.forEach((g) => g.dispose())
  return merged
}

const span = (from: number, to: number, phi: number | ((t: number) => number), n = 10): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => { const t = from + ((to - from) * i) / n; return [t, typeof phi === 'number' ? phi : phi(t)] })

function mantle(m: ReturnType<typeof finishes>) {
  const group = new THREE.Group()
  group.name = 'mantle'
  const profile = Array.from({ length: 33 }, (_, i) => {
    const p = eggPoint((i / 32) * Math.PI, 0)
    return new THREE.Vector2(Math.max(1e-4, p.z), p.y)
  })
  const shell = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), m.mantle)
  shell.name = 'mantle-shell'
  group.add(shell)
  // Panel lines: overlapping plates meet along curved meridians; a band closes them above the belt.
  const panel = seams([
    span(1.15, 3.05, (t) => 0.75 + 0.25 * (t - 1.15)), span(1.15, 3.05, (t) => -0.75 - 0.25 * (t - 1.15)),
    span(0.55, 2.95, (t) => 2.1 - 0.15 * (t - 0.55)), span(0.55, 2.95, (t) => -2.1 + 0.15 * (t - 0.55)),
    Array.from({ length: 25 }, (_, i): [number, number] => [1.13, -1.45 + (2.9 * i) / 24]),
  ], 0.0022)
  group.add(new THREE.Mesh(panel, m.seam))
  // One lime signal on the seam that crosses the crown.
  const signal = new THREE.Mesh(seams([span(1.45, 3.1, (t) => 0.28 - 0.1 * (t - 1.45), 16)], 0.0026), m.signal)
  signal.name = 'mantle-signal'
  group.add(signal)
  // The smoked-glass sensor belt across the front, the lime core showing through it.
  const belt = new THREE.BufferGeometry(), rows = 6, cols = 28, positions: number[] = [], index: number[] = []
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
    const t = 0.78 + (0.3 * i) / rows, phi = -1.75 + (3.5 * j) / cols, edge = Math.min(i, rows - i) / rows
    positions.push(...eggPoint(t, phi, 0.006 + 0.004 * Math.sin(Math.PI * edge)).toArray())
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const a = i * (cols + 1) + j
    index.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1)
  }
  belt.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  belt.setIndex(index)
  belt.computeVertexNormals()
  const glass = new THREE.Mesh(belt, m.belt)
  glass.name = 'sensor-belt'
  glass.renderOrder = 2
  group.add(glass)
  const eyes = mergeGeometries([-0.36, 0.36].map((phi) => new THREE.SphereGeometry(0.013, 12, 8).translate(...eggPoint(0.93, phi, 0.002).toArray())))!
  const core = new THREE.Mesh(eyes, m.core)
  core.name = 'glass-core'
  group.add(core)
  return group
}

/** The collar: a soft flare from the mantle's base out to the arm roots, closing under the body round the mouth. */
function collar(m: ReturnType<typeof finishes>) {
  const points = [[0.001, -0.06], [0.07, -0.058], [0.13, -0.045], [0.175, -0.02], [0.185, 0.008], [0.165, 0.04], [0.13, 0.06], [0.11, 0.075]]
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 40), m.skin)
  mesh.name = 'collar'
  return mesh
}

function robot(logic: OctopusLogic) {
  const m = finishes()
  const root = new THREE.Group(), body = new THREE.Group(), lean = new THREE.Group()
  root.name = 'octopus-1'
  body.name = 'body'
  lean.name = 'mantle-lean'
  root.add(body)
  body.add(lean)
  const shell = mantle(m)
  shell.rotation.x = MANTLE.lean
  shell.position.y = 0.02
  lean.add(shell)
  body.add(collar(m))
  const arms = new ArmSweep(OCTOPUS_PROFILE), cups = new CupSweep(OCTOPUS_PROFILE, m.cups, arms), web = new WebSweep(OCTOPUS_PROFILE)
  const skin = new THREE.Mesh(arms.geometry, m.arms)
  skin.name = 'arms'
  skin.frustumCulled = false
  contactPart(skin, 'arms', { mode: 'free' })
  const membrane = new THREE.Mesh(web.geometry, m.web)
  membrane.name = 'web'
  membrane.frustumCulled = false
  cups.mesh.name = 'cups'
  // The soft parts are swept in world coordinates from the rods; they hang from the scene, not the body.
  const soft = new THREE.Group()
  soft.name = 'octopus-soft'
  soft.add(skin, membrane, cups.mesh)
  // The ride camera: at the front of the belt, looking where the octopus faces (the profile's +z).
  pov(body, [0, 0.16, 0.2], [0, 0, 1])
  const shadow = blobShadow(0.62, 0.42)
  root.add(shadow)
  let leanPitch = 0, leanRoll = 0
  const step = (u: Octopus, t: number, dt: number, color: string | null) => {
    root.position.set(u.x, 0, u.z)
    body.position.y = u.y
    body.rotation.y = profileYaw(u.h)
    shadow.position.set(0, 0.003, 0)
    ;(shadow.material as THREE.MeshBasicMaterial).opacity = 0.42 * Math.exp(-Math.max(0, u.y - 0.2) * 4)
    // The mantle lags the travel a little and squeezes with the jet cycle; it breathes at rest unless motion is reduced.
    const k = 1 - Math.exp(-Math.max(0, dt) * 5)
    leanPitch += (-0.35 * u.v - leanPitch) * k
    leanRoll += (0.25 * u.turn - leanRoll) * k
    lean.rotation.set(leanPitch, 0, leanRoll)
    const breath = reduced() || u.stopped ? 0 : 0.012 * Math.sin(t * 1.3)
    const squeeze = Math.cbrt(Math.max(0.3, u.mantle))
    shell.scale.set(squeeze * (1 + breath), 1 / Math.sqrt(squeeze) - breath * 0.5, squeeze * (1 + breath))
    arms.update(u)
    cups.update(u, arms)
    web.update(arms)
    // The lime seam brightens as a pulse squeezes the mantle.
    m.signal.emissiveIntensity = u.stopped ? 0.25 : 0.7 + 4 * Math.max(0, 1 - u.mantle)
    m.core.emissive.set(color ?? LIME)
    m.core.emissiveIntensity = u.stopped ? 0.4 : color ? 2.2 : 1.6
  }
  return { root, soft, step }
}

function studio(scene: THREE.Scene, logic: OctopusLogic) {
  const floor = new THREE.Group()
  floor.name = 'studio-floor'
  scene.add(floor)
  const deck = tiledDeck(OCTOPUS_LIMITS.x * 2 + 1.4, OCTOPUS_LIMITS.z * 2 + 1.4, 0, 1)
  // A Carbon floor for this studio: its own tile finish, darker than the shared deck's, so the lime ring and the
  // graphite arms read against it. The shared material itself is left alone.
  deck.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshStandardMaterial)) return
    const finish = mesh.material = mesh.material.clone()
    finish.color.set('#15191c')
    finish.metalness = 0.25
    finish.roughness = 0.46
    finish.envMapIntensity = 0.35
  })
  floor.add(deck)
  const u = logic.units[0]
  const den = new THREE.Group()
  den.name = 'den'
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.31, 48), new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0.85 }))
  const pad = new THREE.Mesh(new THREE.CircleGeometry(0.27, 48), new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0.08, depthWrite: false }))
  ring.rotation.x = pad.rotation.x = -Math.PI / 2
  ring.position.y = 0.004
  pad.position.y = 0.003
  den.add(ring, pad)
  den.position.set(u.den[0], 0, u.den[1])
  scene.add(den)
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 32, 20), plastic('#ead16b'))
  // The one rigid part resting on the floor casts the stage's shadow, as every supported part does; the soft body
  // re-poses each frame and keeps to its blob shadow.
  ball.castShadow = true
  ball.name = 'ball'
  // Resting, it touches the floor; held or falling (a new ball drops in), it is free.
  contactPart(ball, 'ball', { mode: () => (u.ball.held || u.ball.y > BALL_RADIUS + 0.003 ? 'free' : 'touch') })
  const ballShadow = blobShadow(0.09, 0.5)
  scene.add(ball, ballShadow)
  contactSurface(floor)
  const model = robot(logic)
  scene.add(model.root, model.soft)
  return {
    step(t: number, dt: number, color: string | null = null) {
      model.step(u, t, dt, color)
      ball.position.set(u.ball.x, u.ball.y, u.ball.z)
      ballShadow.position.set(u.ball.x, 0.003, u.ball.z)
      ;(ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.5 * Math.exp(-Math.max(0, u.ball.y - BALL_RADIUS) * 6)
      den.position.set(u.den[0], 0, u.den[1])
    },
  }
}

export function createView(stage: Stage, logic: OctopusLogic): DeviceView {
  const world = studio(stage.scene, logic), u = logic.units[0]
  const at = (): [number, number, number] => [u.x, 0.22, u.z]
  world.step(0, 0)
  return {
    // Radius covers the arms' spread, so a narrow screen backs off to keep them in; the offset keeps a close desktop view.
    framing: playFrame(at(), 1.0, [0.68, 0.56, -0.94]),
    overview: playFrame([0, 0, 0], OCTOPUS_LIMITS.x + 0.4),
    inspect: () => playFrame(at(), 0.6, [0.8, 0.62, -1.2]),
    follow: () => new THREE.Vector3(...at()),
    update(colors, t, dt) {
      world.step(t, dt, colors[0] ?? null)
      stage.view.invalidate()
    },
  }
}

/** The catalogue card: the octopus crawling a slow circle by itself. */
export function preview() {
  const logic = new OctopusLogic(), u = logic.units[0], input = restInput()
  input.pad = { axes: [0.5, -0.45, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  const card = showcase((scene) => {
    const world = studio(scene, logic)
    return {
      step(t, dt) {
        logic.step([input], dt)
        world.step(t, dt)
      },
    }
  }, [u.x, 0.22, u.z], 0.9)
  card.camera.position.set(u.x + 1.4, 1.35, u.z - 1.9)
  card.camera.lookAt(u.x, 0.2, u.z)
  return card
}

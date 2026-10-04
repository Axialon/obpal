/**
 * The octopus's look (three.js): Cove, an original design. A satin obsidian mantle with panel seams, a lime seam and a
 * smoked-glass sensor belt over a lime core, on a soft collar; eight graphite arms swept along the logic's continuum
 * frames, their cups instanced on the oral side, and a web between the arms near the root. All procedural: no meshes
 * or textures are downloaded. Only the ball casts a shadow map; soft blob shadows sit under the body and the ball.
 * The arms' skin shades by shader terms alone (chromatophores, a pulse's lime band, a rim light), and the mantle's
 * breath is one rhythm with the jet cycle's pulse, so the look adds no draws.
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

/** The soft rim light's colour: a cool steel that lifts every silhouette off the dark floor. */
const RIM = '#9ec3d6'

/**
 * The Cove palette (judged against the owner's cove.png): glossy obsidian mantle with a lime seam and eyes; arms from
 * obsidian at the root through graphite to a cool slate tip, their oral side pale pearl; pale pewter cup rims over
 * dark bowls; all on a near-black, softly glossy Carbon floor. Each surface reflects the room at its own strength.
 */
function finishes(environment: THREE.Texture | null) {
  const m = {
    mantle: rim(new THREE.MeshPhysicalMaterial({ color: '#0d1013', metalness: 0.35, roughness: 0.24, clearcoat: 0.8, clearcoatRoughness: 0.16 }), 0.3),
    seam: new THREE.MeshStandardMaterial({ color: '#050607', metalness: 0.2, roughness: 0.6 }),
    belt: new THREE.MeshPhysicalMaterial({ color: '#0d1a1d', metalness: 0.3, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12, transparent: true, opacity: 0.82 }),
    core: new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: LIME, emissiveIntensity: 1.8, roughness: 0.3 }),
    signal: new THREE.MeshStandardMaterial({ color: '#a4ce35', emissive: LIME, emissiveIntensity: 0.7, roughness: 0.3 }),
    skin: rim(new THREE.MeshStandardMaterial({ color: '#121518', metalness: 0.08, roughness: 0.5 }), 0.22),
    arms: skinMaterial(),
    web: rim(new THREE.MeshStandardMaterial({ color: '#14181b', metalness: 0.04, roughness: 0.55, side: THREE.DoubleSide }), 0.16),
    cups: rim(new THREE.MeshStandardMaterial({ color: '#e2e8eb', metalness: 0.5, roughness: 0.3, vertexColors: true }), 0.2),
  }
  // The stage's room light: a material with no map of its own takes the scene's strength, so each finish gets its own.
  if (environment) for (const [material, strength] of [[m.mantle, 1], [m.belt, 1], [m.skin, 0.4], [m.arms.material, 0.45], [m.web, 0.35], [m.cups, 0.7]] as const) {
    material.envMap = environment
    material.envMapIntensity = strength
  }
  return m
}

/** The rim term: brighter where the surface turns away from the camera. GLSL, after the emissive map. */
const RIM_TERM = 'totalEmissiveRadiance += rimTint * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);'

/**
 * A soft rim light: the surface brightens where it turns away from the camera, so dark parts separate from a dark floor.
 * Added as emission in the shader; it costs no light or draw.
 */
function rim<T extends THREE.MeshStandardMaterial>(material: T, strength: number): T {
  const tint = new THREE.Color(RIM).multiplyScalar(strength)
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimTint = { value: tint }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimTint;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${RIM_TERM}`)
  }
  material.customProgramCacheKey = () => `octopus-rim-${strength}`
  return material
}

/**
 * The arms' skin: the swept vertex colours (octopus-sweep.ts) with three cheap shader terms and no extra draw.
 *   - Chromatophores: small pigment cells on the dorsal side in the skin's own coordinates, so they ride with the arm,
 *     slowly opening and closing, a little wider on each breath.
 *   - A pulse sends a band of lime iridescence from the root to the tip (`wave` is its place along the arm, 0…1).
 *   - The rim light.
 * The uniforms are shared objects, so the view sets them each frame without recompiling.
 */
function skinMaterial() {
  const uniforms = {
    skinTime: { value: 0 }, skinBreath: { value: 0 }, skinWave: { value: -1 }, skinGlow: { value: 0 },
    rimTint: { value: new THREE.Color(RIM).multiplyScalar(0.34) }, skinShimmer: { value: new THREE.Color(LIME).multiplyScalar(0.42) },
  }
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, metalness: 0.06, roughness: 0.46 })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 skin;\nvarying vec4 vSkin;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkin = skin;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float skinTime, skinBreath, skinWave, skinGlow;
uniform vec3 rimTint, skinShimmer;
varying vec4 vSkin;
float skinHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float skinNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(skinHash(i), skinHash(i + vec2(1.0, 0.0)), f.x), mix(skinHash(i + vec2(0.0, 1.0)), skinHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float dorsal = smoothstep(-0.2, 0.8, vSkin.z);
vec2 cell = vec2(vSkin.x * 60.0, vSkin.y * 6.0 + vSkin.w * 37.0);
float cells = 0.62 * skinNoise(cell + vec2(0.0, skinTime * 0.3)) + 0.38 * skinNoise(cell * 2.6 + vec2(skinTime * 0.2, 3.1));
float pigment = smoothstep(0.54 - 0.05 * skinBreath, 0.86, cells) * dorsal;
diffuseColor.rgb *= 1.0 - 0.45 * pigment;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float band = skinGlow * exp(-pow((vSkin.x - skinWave) / 0.07, 2.0));
totalEmissiveRadiance += skinShimmer * band * (0.3 + 0.7 * dorsal) * (1.0 - 0.5 * pigment);
${RIM_TERM}`)
  }
  material.customProgramCacheKey = () => 'octopus-skin'
  return { material, uniforms }
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

/** Seconds per breath at rest; crawling quickens it by up to half. A design value, not a measured rate. */
const BREATH = { period: 3.4, depth: 0.014 }

function robot(environment: THREE.Texture | null) {
  const m = finishes(environment), skinUniforms = m.arms.uniforms
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
  const skin = new THREE.Mesh(arms.geometry, m.arms.material)
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
  // The breath, the skin's own clock and the pulse's wave along the arms.
  let phase = 0, breathing = 1, wave = -1, lastMantle = 1
  const step = (u: Octopus, t: number, dt: number, color: string | null) => {
    root.position.set(u.x, 0, u.z)
    body.position.y = u.y
    body.rotation.y = profileYaw(u.h)
    shadow.position.set(0, 0.003, 0)
    ;(shadow.material as THREE.MeshBasicMaterial).opacity = 0.42 * Math.exp(-Math.max(0, u.y - 0.2) * 4)
    // The mantle lags the travel a little and squeezes with the jet cycle.
    const span = Math.max(0, dt), k = 1 - Math.exp(-span * 5)
    leanPitch += (-0.35 * u.v - leanPitch) * k
    leanRoll += (0.25 * u.turn - leanRoll) * k
    lean.rotation.set(leanPitch, 0, leanRoll)
    // Breathing and pulsing are one rhythm: a pulse's squeeze takes the breath over, the breath fades as the mantle
    // contracts, and the next breath starts from the refill. Stopped or with reduced motion, the mantle keeps still.
    const still = reduced() || u.stopped, jetting = u.mantle < 0.995
    if (jetting && lastMantle >= 0.995 && !still) wave = -0.12
    lastMantle = u.mantle
    if (jetting) { phase = 0; breathing += (0 - breathing) * (1 - Math.exp(-span * 10)) }
    else if (!still) {
      breathing += (1 - breathing) * (1 - Math.exp(-span * 1.2))
      phase += span * ((2 * Math.PI) / BREATH.period) * (1 + 0.5 * Math.min(1, Math.abs(u.v) / OCTOPUS_LIMITS.speed))
    }
    const inhale = still ? 0 : breathing * Math.sin(phase), breath = BREATH.depth * inhale
    const squeeze = Math.cbrt(Math.max(0.3, u.mantle))
    shell.scale.set(squeeze * (1 + breath), 1 / Math.sqrt(squeeze) - breath * 0.5, squeeze * (1 + breath))
    arms.update(u)
    cups.update(u, arms)
    web.update(arms)
    // The skin: chromatophores drift on their own clock (held still when stopped) and open a little on each breath; a
    // pulse's lime band runs from root to tip in about seven tenths of a second, fading as it reaches the tip.
    if (!still) skinUniforms.skinTime.value += span
    skinUniforms.skinBreath.value = inhale
    if (wave > -1) wave = still || wave > 1.3 ? -1 : wave + span * 1.6
    skinUniforms.skinWave.value = wave
    skinUniforms.skinGlow.value = wave > -1 ? Math.min(1, Math.max(0, 1.3 - wave)) : 0
    // The lime seam brightens as a pulse squeezes the mantle and glows a little with each breath.
    m.signal.emissiveIntensity = u.stopped ? 0.25 : 0.8 + 0.25 * inhale + 4 * Math.max(0, 1 - u.mantle)
    m.core.emissive.set(color ?? LIME)
    m.core.emissiveIntensity = u.stopped ? 0.4 : (color ? 2.2 : 1.6) + 0.2 * inhale
  }
  return { root, soft, step }
}

function studio(scene: THREE.Scene, logic: OctopusLogic) {
  const floor = new THREE.Group()
  floor.name = 'studio-floor'
  scene.add(floor)
  const deck = tiledDeck(OCTOPUS_LIMITS.x * 2 + 1.4, OCTOPUS_LIMITS.z * 2 + 1.4, 0, 1)
  // A Carbon floor for this studio: its own near-black, softly glossy tile finish, so the slate arms, the pearl
  // undersides and the lime ring read against it. It reflects the room at a quarter of the stage's strength (which a
  // material without its own map would otherwise take). The shared material itself is left alone.
  deck.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshStandardMaterial)) return
    const finish = mesh.material = mesh.material.clone()
    finish.color.set('#0a0c0e')
    finish.metalness = 0.3
    finish.roughness = 0.32
    if (scene.environment) finish.envMap = scene.environment
    finish.envMapIntensity = 0.24
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
  const model = robot(scene.environment)
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

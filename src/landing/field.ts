/**
 * The hero's bounce field, drawn: the headline's letters as 3D blocks standing on the floor, seen from overhead at a
 * tilt, and glass marbles that bounce on them (./bounce.ts does the physics). A marble is clear glass with a soft
 * light inside: bright at its rim, a highlight where the key light catches it, and a caustic where it focuses light on
 * the surface below. Its glow spreads across a floor of dots (they rise and brighten near it: a depth field) and
 * passes through the letters, which light up from within as it nears; every bounce sends a ring of light out
 * through both. A letter a marble lands on turns lime and stays so; light them all and the headline celebrates.
 * Loaded on demand (it brings three.js), and it draws only when asked to (the hero calls render() while anything moves).
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color, DirectionalLight, ExtrudeGeometry, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Plane, Points, Raycaster, Scene, ShaderMaterial,
  SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, Vector2, Vector3, Vector4, WebGLRenderer, type Material,
} from 'three'
import { newOrb, step, surfaceAt, type Footprint, type Orb } from './bounce'
import { BEVEL, LETTER_H, layoutLetters } from './letters'

/** A marble's size, in em. */
export const ORB_R = 0.2
/** The hop while a marble is being played with. */
const HOP = 0.8
/** The camera: its field of view, and how steeply it looks down (degrees above the horizon). */
const FOV = 30
const ELEVATION = 56
const MAX_ORBS = 5
/** Rings of light a bounce sends out: how many at once, how fast they spread (em/s) and fade (per s). */
const MAX_RIPPLES = 8
const RIPPLE_SPEED = 2.4
const RIPPLE_FADE = 1.9

const LAVENDER = new Color('#b3a4ff')
const UV = new Color('#5c3ef5')
const INK = new Color('#f1edff')
const LIME = new Color('#c6ff34')

export interface FieldOrb {
  id: string
  orb: Orb
  color: Color
  /** How lit it is, 0…1 (a resting marble glows softly). */
  life: number
  push: [number, number] | null
  marble: Mesh
  /** A faint halo, so the marble's light reads at any size. */
  halo: Sprite
  shadow: Mesh
  caustic: Mesh
  pool: Mesh
}

interface Letter {
  ch: string
  word: number
  fp: Footprint
  mesh: Mesh
  cap: MeshStandardMaterial
  /** 0 dark … 1 fully lit; `kept` is what it settles back to once hit. */
  lit: number
  kept: number
  /** Its dip when landed on (a damped spring). */
  dip: number
  dipV: number
}

export interface Field {
  readonly canvas: HTMLCanvasElement
  /** Lay the headline out as the page wraps it (lines of text), fitted into `box` (px, within the canvas). */
  layout(lines: string[], W: number, H: number, box: { x: number; y: number; w: number; h: number }): void
  /** The floor point under a screen point (canvas px), clamped to the field. */
  floorAt(sx: number, sy: number): { x: number; z: number }
  /** A world point on screen (canvas px). */
  project(x: number, y: number, z: number): { x: number; y: number }
  /** The letters in reading order, with where to land on each and which word each is in. */
  letters(): { ch: string; spot: [number, number]; word: number }[]
  /** A marble, created on first use, in a colour. */
  orb(id: string, color: string): FieldOrb
  removeOrb(id: string): void
  orbs(): FieldOrb[]
  /** Advance everything by dt; returns whether anything still moves. */
  step(dt: number): boolean
  render(): void
  /** Called with a letter's index when a marble lands on it. */
  onLand: ((letter: number, orbId: string) => void) | null
}

const radial = (stops: [number, string][], size = 128) => {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [at, col] of stops) grad.addColorStop(at, col)
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}

/** The glow of every marble and every ring of light at a point: shared by the dots and the letters. */
const GLOW_GLSL = `
  uniform vec3 uOrbs[${MAX_ORBS}];
  uniform vec3 uColors[${MAX_ORBS}];
  uniform vec4 uRipples[${MAX_RIPPLES}];
  uniform vec3 uRippleColors[${MAX_RIPPLES}];
  uniform float uTime;
  vec3 glowAt(vec3 p, float reach) {
    vec3 g = vec3(0.0);
    for (int i = 0; i < ${MAX_ORBS}; i++) {
      vec3 o = uOrbs[i];
      if (o.y < -50.0) continue;
      float d = distance(p, o);
      g += uColors[i] * exp(-d * d * reach);
    }
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.0) continue;
      float age = uTime - r.z;
      if (age < 0.0 || age > 2.2) continue;
      float d = distance(p.xz, r.xy);
      float ring = exp(-pow((d - age * ${RIPPLE_SPEED.toFixed(2)}) / 0.2, 2.0)) * exp(-age * ${RIPPLE_FADE.toFixed(2)}) * r.w;
      g += uRippleColors[i] * ring;
    }
    return g;
  }`

export function createField(canvas: HTMLCanvasElement, opts: { coarse: boolean }): Field {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: !opts.coarse, powerPreference: 'low-power', premultipliedAlpha: true })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = SRGBColorSpace
  const scene = new Scene()
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 200)
  scene.add(new HemisphereLight(LAVENDER, new Color('#1c1244'), 1.35))
  const keyDir = new Vector3(-3, 8, 5).normalize()
  const key = new DirectionalLight(0xffffff, 1.5)
  key.position.copy(keyDir).multiplyScalar(10)
  scene.add(key)

  // Shared by the dots, the letters and the marbles: where the marbles are, and the rings of light.
  const glow = {
    uOrbs: { value: Array.from({ length: MAX_ORBS }, () => new Vector3(0, -99, 0)) },
    uColors: { value: Array.from({ length: MAX_ORBS }, () => new Color(LIME)) },
    uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new Vector4(0, 0, -99, 0)) },
    uRippleColors: { value: Array.from({ length: MAX_RIPPLES }, () => new Color(LIME)) },
    uTime: { value: 0 },
  }
  let rippleNext = 0

  /** A letter material whose glow comes from the marbles and the rings: light passing through it. */
  const glowing = <M extends Material>(m: M, strength: number, reach: number): M => {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, glow)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\n${GLOW_GLSL}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += glowAt(vWorld, ${reach.toFixed(2)}) * ${strength.toFixed(2)};`)
    }
    m.customProgramCacheKey = () => `glow-${strength}-${reach}`
    return m
  }
  const capBase = { color: INK, roughness: 0.34, metalness: 0.02, emissive: LIME, emissiveIntensity: 0 }
  const sideMat = glowing(new MeshStandardMaterial({ color: UV.clone().multiplyScalar(0.8), roughness: 0.5, metalness: 0.1 }), 0.55, 3.2)
  const letterGroup = new Group()
  scene.add(letterGroup)
  let letters: Letter[] = []
  let footprints: Footprint[] = []
  let bounds: [number, number, number, number] = [-10, -10, 10, 10]
  let W = 1, H = 1
  let celebrateAt = -1
  let clock = 0

  // ---- the depth field: a floor of dots that rise and glow near a marble, and ring with its bounces ----
  const dotUniforms = {
    ...glow,
    uSize: { value: 3 },
    uDist: { value: 10 },
    uHaze: { value: new Color(LAVENDER) },
    uFar: { value: new Vector2(0, 1) },
  }
  const dots = new Points(new BufferGeometry(), new ShaderMaterial({
    uniforms: dotUniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: `
      ${GLOW_GLSL}
      uniform float uSize;
      uniform float uDist;
      uniform vec2 uFar;
      varying vec3 vColor;
      varying float vGlow;
      varying float vFade;
      void main() {
        vec3 p = position;
        vec3 g = glowAt(p, 1.3);
        float k = min(max(g.r, max(g.g, g.b)), 1.0);
        p.y += k * 0.08;
        vGlow = k;
        vColor = k > 0.0 ? g / max(k, 1e-3) : vec3(0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * (1.0 + vGlow * 1.5) * (uDist / -mv.z);
        // Far dots fade into the night (the depth).
        vFade = clamp((uFar.y - p.z) / max(uFar.y - uFar.x, 1e-3), 0.0, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uHaze;
      varying vec3 vColor;
      varying float vGlow;
      varying float vFade;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = dot(c, c);
        if (r > 0.25) discard;
        float soft = smoothstep(0.25, 0.0, r);
        vec3 col = mix(uHaze, vColor, vGlow);
        float a = soft * (0.09 + 0.8 * vGlow) * (1.0 - 0.75 * vFade);
        gl_FragColor = vec4(col * a, a);
      }`,
  }))
  scene.add(dots)

  // ---- marbles ----
  const orbMap = new Map<string, FieldOrb>()
  const shadowTex = radial([[0, 'rgba(8,4,24,0.8)'], [1, 'rgba(8,4,24,0)']])
  const causticTex = radial([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']])
  const poolTex = radial([[0, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']])
  const haloTex = radial([[0, 'rgba(255,255,255,0.9)'], [0.25, 'rgba(255,255,255,0.28)'], [1, 'rgba(255,255,255,0)']])
  const marbleGeo = new SphereGeometry(ORB_R, 40, 28)

  /** Clear glass with a light inside: see-through in the middle, bright at the rim, a sharp highlight from the key light. */
  const marbleMaterial = (tint: Color) => new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTint: { value: tint }, uLife: { value: 0 }, uKey: { value: keyDir } },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 uTint;
      uniform float uLife;
      uniform vec3 uKey;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec3 n = normalize(vN), v = normalize(vV);
        float ndv = clamp(dot(n, v), 0.0, 1.0);
        float rim = pow(1.0 - ndv, 2.4);
        vec3 r = reflect(-v, n);
        float spec = pow(max(dot(r, uKey), 0.0), 120.0) * 1.6 + pow(max(dot(r, normalize(vec3(0.6, 0.35, 0.7))), 0.0), 24.0) * 0.18;
        // The light inside: a soft core, brighter while the marble is in play.
        float core = pow(ndv, 2.2) * (0.16 + 0.34 * uLife);
        // Light that enters on the key side comes out focused on the far side: a soft crescent inside the glass,
        // opposite the highlight, the way a real marble shows it.
        float crescent = pow(clamp(dot(n, -uKey) * 0.5 + 0.5, 0.0, 1.0), 5.0) * smoothstep(0.08, 0.55, ndv) * (0.55 + 0.45 * uLife);
        // Refraction's darker band just inside the rim, where glass bends the scene away.
        float band = smoothstep(0.18, 0.42, ndv) * (1.0 - smoothstep(0.42, 0.75, ndv)) * 0.1;
        vec3 col = uTint * (core + crescent * 0.9) + mix(vec3(0.9, 0.88, 1.0), uTint, 0.3) * rim * 0.95 + vec3(1.0) * spec;
        float a = clamp(0.09 + core * 0.55 + crescent * 0.55 + rim * 0.8 + spec - band, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
      }`,
  })

  function makeOrb(id: string, color: string): FieldOrb {
    const c = new Color(color)
    const marble = new Mesh(marbleGeo, marbleMaterial(c))
    marble.renderOrder = 3
    const flat = (tex: CanvasTexture, size: number, add: boolean) => {
      const m = new Mesh(new CircleGeometry(size, 32), new MeshBasicMaterial({ map: tex, color: add ? c : 0xffffff, transparent: true, depthWrite: false, blending: add ? AdditiveBlending : undefined }))
      m.rotation.x = -Math.PI / 2
      m.renderOrder = 2
      scene.add(m)
      return m
    }
    const shadow = flat(shadowTex, ORB_R * 1.5, false)
    const pool = flat(poolTex, ORB_R * 8, true)
    const caustic = flat(causticTex, ORB_R * 0.9, true)
    const halo = new Sprite(new SpriteMaterial({ map: haloTex, color: c, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.2 }))
    halo.scale.setScalar(ORB_R * 4.2)
    halo.renderOrder = 1
    scene.add(marble, halo)
    const start = letters.length ? letters[letters.length - 1].fp.spot : [0, 0]
    const orb = newOrb(start[0], start[1], ORB_R, surfaceAt(footprints, start[0], start[1]).h)
    const fo: FieldOrb = { id, orb, color: c, life: 0, push: null, marble, halo, shadow, caustic, pool }
    orbMap.set(id, fo)
    return fo
  }

  function ripple(x: number, z: number, strength: number, color: Color) {
    const i = rippleNext++ % MAX_RIPPLES
    glow.uRipples.value[i].set(x, z, clock, strength)
    glow.uRippleColors.value[i].copy(color)
  }

  // ---- letters ----
  function buildLetters(lines: string[]) {
    for (const l of letters) { l.mesh.geometry.dispose(); l.cap.dispose() }
    letterGroup.clear()
    letters = []
    footprints = []
    // Laid out as the page wraps the headline (./letters.ts); each letter extruded from its glyph's shapes.
    for (const l of layoutLetters(lines)) {
      const geo = new ExtrudeGeometry(l.shapes, { depth: LETTER_H - BEVEL, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: 0.008, bevelSegments: 1, curveSegments: opts.coarse ? 4 : 6 })
      // Glyph up is away from the viewer (-z); the letter stands up out of the floor (+y), its bevel just below it.
      geo.rotateX(-Math.PI / 2)
      geo.translate(l.x, BEVEL, l.zBase)
      const cap = glowing(new MeshStandardMaterial(capBase), 0.7, 2.6)
      const mesh = new Mesh(geo, [cap, sideMat])
      letterGroup.add(mesh)
      footprints.push(l.fp)
      letters.push({ ch: l.ch, word: l.word, fp: l.fp, mesh, cap, lit: 0, kept: 0, dip: 0, dipV: 0 })
    }
  }

  // ---- the camera, fitted so the letters fill the headline's place on the page ----
  const ray = new Raycaster()
  const floor = new Plane(new Vector3(0, 1, 0), 0)
  let lastLines = ''

  function fit(box: { x: number; y: number; w: number; h: number }) {
    const el = (ELEVATION * Math.PI) / 180
    const lb = footprints.reduce((b, f) => [Math.min(b[0], f.box[0]), Math.min(b[1], f.box[1]), Math.max(b[2], f.box[2]), Math.max(b[3], f.box[3])], [Infinity, Infinity, -Infinity, -Infinity])
    const cx = (lb[0] + lb[2]) / 2, cz = (lb[1] + lb[3]) / 2
    camera.aspect = W / H
    camera.clearViewOffset()
    // Distance so the block's width fills the box's width (at the block's centre), then the view is shifted so the
    // block's centre lands on the box's centre.
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180)
    const visW = ((lb[2] - lb[0]) * W) / Math.max(40, box.w)
    const dist = visW / (2 * tanV * camera.aspect)
    camera.position.set(cx, Math.sin(el) * dist, cz + Math.cos(el) * dist)
    camera.lookAt(cx, 0, cz)
    camera.setViewOffset(W, H, W / 2 - (box.x + box.w / 2), H / 2 - (box.y + box.h / 2), W, H)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    // The field is what the camera sees of the floor.
    const pts = [[0, 0], [W, 0], [0, H], [W, H]].map(([sx, sy]) => rawFloorAt(sx, sy))
    bounds = [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.z)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.z))]
    // The dots cover the field (a little wider apart on a phone).
    const gap = opts.coarse ? 0.26 : 0.2
    const verts: number[] = []
    for (let x = Math.floor(bounds[0] / gap) * gap; x <= bounds[2]; x += gap) {
      for (let z = Math.floor(bounds[1] / gap) * gap; z <= bounds[3]; z += gap) verts.push(x, 0.002, z)
    }
    dots.geometry.dispose()
    dots.geometry = new BufferGeometry()
    dots.geometry.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3))
    dotUniforms.uFar.value.set(bounds[1], bounds[3])
    dotUniforms.uSize.value = 2.2 * Math.min(2, renderer.getPixelRatio())
    dotUniforms.uDist.value = dist
  }

  function rawFloorAt(sx: number, sy: number) {
    ray.setFromCamera(new Vector2((sx / W) * 2 - 1, -(sy / H) * 2 + 1), camera)
    const hit = new Vector3()
    return ray.ray.intersectPlane(floor, hit) ? { x: hit.x, z: hit.z } : { x: 0, z: 0 }
  }

  const field: Field = {
    canvas,
    onLand: null,
    layout(lines, w, h, box) {
      W = Math.max(1, w); H = Math.max(1, h)
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, opts.coarse ? 1.5 : 2))
      renderer.setSize(W, H, false)
      const k = lines.join('\n')
      if (k !== lastLines) {
        buildLetters(lines)
        lastLines = k
        // Marbles stay where they were, on whatever is under them now.
        for (const o of orbMap.values()) o.orb.resting = false
      }
      fit(box)
    },
    floorAt(sx, sy) {
      const p = rawFloorAt(sx, sy)
      return { x: Math.max(bounds[0] + ORB_R, Math.min(bounds[2] - ORB_R, p.x)), z: Math.max(bounds[1] + ORB_R, Math.min(bounds[3] - ORB_R, p.z)) }
    },
    project(x, y, z) {
      const v = new Vector3(x, y, z).project(camera)
      return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H }
    },
    letters: () => letters.map((l) => ({ ch: l.ch, spot: l.fp.spot, word: l.word })),
    orb: (id, color) => orbMap.get(id) ?? makeOrb(id, color),
    removeOrb(id) {
      const o = orbMap.get(id)
      if (!o) return
      scene.remove(o.marble, o.halo, o.shadow, o.caustic, o.pool)
      ;(o.marble.material as ShaderMaterial).dispose()
      o.halo.material.dispose()
      for (const m of [o.shadow, o.caustic, o.pool]) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose() }
      orbMap.delete(id)
    },
    orbs: () => [...orbMap.values()],
    step(dt) {
      clock += dt
      glow.uTime.value = clock
      let busy = false
      for (const o of orbMap.values()) {
        const vy = o.orb.vy
        // Real time whatever the frame rate: a long frame (a slow phone, a busy page) is caught up in 60 Hz steps.
        const r = { landed: null as number | null, bumped: null as number | null, moving: false }
        for (let left = Math.min(dt, 0.12); left > 1e-6; left -= 1 / 60) {
          const q = step(o.orb, footprints, Math.min(left, 1 / 60), { hop: HOP, bounds, push: o.push ?? undefined })
          if (q.landed !== null) r.landed = q.landed
          if (q.bumped !== null) r.bumped = q.bumped
          r.moving = q.moving
        }
        if (r.landed !== null) {
          // Every bounce sends a ring of light out through the dots and the letters, stronger the harder it lands.
          const impact = Math.min(1, Math.abs(vy) / 5)
          if (impact > 0.12) ripple(o.orb.x, o.orb.z, 0.25 + 0.75 * impact, o.color)
        }
        if (r.landed !== null && r.landed >= 0) {
          const l = letters[r.landed]
          l.dipV -= 0.9
          l.lit = 1
          l.kept = 0.42
          field.onLand?.(r.landed, o.id)
          if (celebrateAt < 0 && letters.every((x) => x.kept > 0)) celebrateAt = clock
        }
        const goal = o.orb.active || o.push ? 1 : 0.45
        o.life += (goal - o.life) * (1 - Math.exp(-dt * 3))
        busy = busy || r.moving || Math.abs(goal - o.life) > 0.01
      }
      // Rings still spreading keep the page drawing.
      for (const r of glow.uRipples.value) if (r.w > 0 && clock - r.z < 2.2) busy = true
      // Every letter lit: a wave runs through the headline, then it goes dark again for another round.
      if (celebrateAt >= 0) {
        const t = clock - celebrateAt
        letters.forEach((l, i) => {
          const w = t - i * 0.05
          if (w > 0 && w < 0.06) { l.dipV -= 0.8; l.lit = 1; if (i % 3 === 0) ripple(l.fp.spot[0], l.fp.spot[1], 0.6, LIME) }
        })
        if (t > 2.6) { for (const l of letters) l.kept = 0; celebrateAt = -1 }
        busy = true
      }
      for (const l of letters) {
        // The dip springs back; the light settles to what the letter keeps.
        l.dipV += (-l.dip * 220 - l.dipV * 18) * dt
        l.dip += l.dipV * dt
        l.lit += (l.kept - l.lit) * (1 - Math.exp(-dt * 2.2))
        l.mesh.position.y = Math.max(-LETTER_H * 0.45, l.dip * 0.05)
        l.cap.emissiveIntensity = l.lit * 0.7
        l.cap.color.copy(INK).lerp(LIME, l.lit * 0.3)
        if (Math.abs(l.dip) > 1e-4 || Math.abs(l.dipV) > 1e-3 || Math.abs(l.lit - l.kept) > 0.004) busy = true
      }
      return busy
    },
    render() {
      let i = 0
      for (const o of orbMap.values()) {
        const b = o.orb
        o.marble.position.set(b.x, b.y, b.z)
        ;(o.marble.material as ShaderMaterial).uniforms.uLife.value = o.life
        o.halo.position.set(b.x, b.y, b.z)
        o.halo.material.opacity = 0.1 + 0.18 * o.life
        // On whatever is under the marble: its shadow (smaller and fainter the higher it is), the caustic its glass
        // focuses there (tight and bright when low, spreading as it rises), and the soft pool of its light.
        const s = surfaceAt(footprints, b.x, b.z)
        const hgt = Math.max(0, b.y - b.r - s.h)
        o.shadow.position.set(b.x + 0.02, s.h + 0.004, b.z + 0.03)
        o.shadow.scale.setScalar(1 + hgt * 0.8)
        ;(o.shadow.material as MeshBasicMaterial).opacity = Math.max(0.08, 0.55 - hgt * 0.7)
        o.caustic.position.set(b.x - 0.02, s.h + 0.005, b.z - 0.02)
        o.caustic.scale.setScalar(1 + hgt * 2.2)
        ;(o.caustic.material as MeshBasicMaterial).opacity = (0.35 + 0.35 * o.life) / (1 + hgt * 3)
        o.pool.position.set(b.x, s.h + 0.003, b.z)
        o.pool.scale.setScalar(0.8 + hgt * 0.6)
        ;(o.pool.material as MeshBasicMaterial).opacity = (0.05 + 0.1 * o.life) / (1 + hgt)
        if (i < MAX_ORBS) { glow.uOrbs.value[i].set(b.x, b.y, b.z); glow.uColors.value[i].copy(o.color).multiplyScalar(0.35 + 0.65 * o.life) }
        i++
      }
      for (; i < MAX_ORBS; i++) glow.uOrbs.value[i].set(0, -99, 0)
      renderer.render(scene, camera)
    },
  }
  return field
}

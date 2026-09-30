/**
 * The hero's bounce field, drawn: the headline's letters as 3D blocks standing on the floor, seen from overhead at a
 * tilt, and glass marbles that roll and bounce on them (./world.ts and ./bounce.ts move them; this draws them where
 * they are between their last two steps, and answers what they strike). The page's raised things (its buttons and the
 * like) are drawn by the page, under this canvas: here they only hide what stands behind them. A marble is clear
 * glass: what's behind it shows through upside down and drawn in, the way a ball of glass bends it; a twist of colour
 * inside turns as it rolls; it's bright at its rim, catches the key light, and focuses a caustic on the surface below.
 * It looks a little bigger the higher it rises (it's nearer), while its shadow stays on the ground. Its glow spreads
 * across a floor of dots, which part around it as it passes and brighten in its light (a depth field), and passes
 * through the letters, which light up from within as it nears; every bounce sends a ring of light out through both. A
 * letter a marble lands on turns lime and stays so; light them all and the headline celebrates.
 *
 * Edges stay clean at any size: the canvas's pixels are exactly the screen's (or, on a GPU with room, twice as many,
 * which the browser averages down), the letters are multisampled, the marble's outline and rim are worked out per
 * pixel from the true sphere (not its mesh), and the picture of the scene inside it is filtered as the glass shrinks
 * it (mipmaps), so it never sparkles. How finely it draws is a step of ./governor.ts's ladder, set by the hero.
 * Loaded on demand (it brings three.js), and it draws only when asked to (the hero calls render() while anything moves).
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color, DirectionalLight, DoubleSide, ExtrudeGeometry, Group,
  HemisphereLight, LinearFilter, LinearMipmapLinearFilter, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PMREMGenerator, Points, Quaternion, Scene, ShaderMaterial, Shape, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, Vector2,
  Vector3, Vector4, WebGLRenderer, WebGLRenderTarget, type Material, type Texture,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { surfaceAt, type Footprint, type Orb } from './bounce'
import { glassScale, type GpuSample, type Step } from './governor'
import { BEVEL, LETTER_H } from './letters'
import { createWorld, DEPTH, foreseeable, HIT_MIN, keyOf, ORB_R, PAD_H, WALL_MIN, type HitKind, type PadRect, type WorldMarble } from './world'

export { ORB_R }
export type { HitKind, PadRect }
const MAX_ORBS = 5
/** Rings of light a bounce sends out: how many at once, how fast they spread (em/s) and fade (per s). */
const MAX_RIPPLES = 8
const RIPPLE_SPEED = 2.4
const RIPPLE_FADE = 1.9
/** Hits this fast (em/s) are the hardest there is (slower than ./world.ts HIT_MIN, silent). */
const HIT_MAX = 7
/** Knocks too soft to hear are noted for ?debug=audio from this fast (em/s), at most this often per marble (s). */
const NOTE_FROM = 0.12
const NOTE_GAP = 0.3
/**
 * A knock felt in 3D: a letter rocks (rad/s at the hardest: about 3°), a marble squashes and rings (per s: about 7% at
 * the hardest), and a very hard one jolts the view (from this hard, up to this many px).
 */
const ROCK = 2.4
const SQUASH = 5
const JOLT_FROM = 0.7
const JOLT_PX = 1.6
/** The rounded edge a letter's top has (em). */
const EDGE = 0.016
/** At most this many raised things (the buttons, the hint, the sound control, the steps' icons) keep the dots off them. */
const MAX_PADS = 8

const LAVENDER = new Color('#b3a4ff')

/**
 * A marble hit something (the edge of the screen: a wall): what (a button: which), how hard (0…1, and its speed into
 * it, em/s), where, and when: how long before the moment drawn now it happened (s; below 0, it's drawn next frame, or
 * it's foreseen). `key` names the marble and what it struck, the same for a knock foreseen and the knock itself.
 */
export interface Hit { orb: string; other?: string; kind: HitKind; pad?: number; strength: number; speed: number; x: number; y: number; z: number; ago: number; key: string }

export interface FieldOrb {
  id: string
  orb: Orb
  /** Its place in the world: where it's drawn (m.shown), and what it's standing on. */
  m: WorldMarble
  color: Color
  /** How lit it is, 0…1 (a resting marble glows softly). */
  life: number
  /** Someone is playing with it: it glows brighter. */
  live: boolean
  push: [number, number] | null
  marble: Mesh
  /** A faint halo, so the marble's light reads at any size. */
  halo: Sprite
  shadow: Mesh
  caustic: Mesh
  pool: Mesh
  /** How it has turned as it rolled (the twist inside shows it), and how fast it turns (rad/s, as an axis). */
  spin: Quaternion
  omega: Vector3
  /** When a knock too soft to hear was last noted for ?debug=audio. */
  quietAt: number
  /** A knock rings through it: it squashes along `axis` (the way it was struck) and back, a few times, quickly. */
  squash: Wobble
  axis: Vector3
}

/** A decaying spring: its value and its speed (the letters' tilt, a marble's squash, the view's shake). */
interface Wobble { x: number; v: number }

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
  /** It rocks when struck, about its foot (radians, about x and z): springs, a fifth of a second. */
  rx: Wobble
  rz: Wobble
}

/** A spring's step: stiffness as a frequency (Hz) and damping ratio. */
function spring(w: Wobble, dt: number, hz: number, zeta: number) {
  const k = 2 * Math.PI * hz
  // In small steps: it's stiff.
  for (let left = dt; left > 1e-6; left -= 1 / 240) {
    const h = Math.min(left, 1 / 240)
    w.v += (-k * k * w.x - 2 * zeta * k * w.v) * h
    w.x += w.v * h
  }
}
const settled = (w: Wobble) => Math.abs(w.x) < 1e-4 && Math.abs(w.v) < 1e-3

export interface Gfx {
  /** The canvas's size in CSS pixels, its drawing buffer's, and drawing-buffer pixels per CSS pixel. */
  css: [number, number]
  buffer: [number, number]
  pr: number
  /** The canvas in device pixels as the browser reported them (null: not reported, or not matching its CSS size). */
  device: [number, number] | null
  /** Multisamples on the canvas, and the picture of the scene the glass bends (size, mipmapped), 0 wide when off. */
  samples: number
  behind: [number, number]
  glass: number
  /** The last GPU time measured (ms), null where the browser can't time it. */
  gpuMs: number | null
}

export interface Field {
  readonly canvas: HTMLCanvasElement
  /** Lay the headline out as the page wraps it (lines of text), fitted into `box` (px, within the canvas). */
  layout(lines: string[], W: number, H: number, box: { x: number; y: number; w: number; h: number }): void
  /** The floor point under a screen point (canvas px), clamped to the field. */
  floorAt(sx: number, sy: number): { x: number; z: number }
  /** What's under a screen point: a letter's top where it's over one (that letter), else the floor (-1). */
  pointAt(sx: number, sy: number): { x: number; z: number; letter: number }
  /**
   * Where a hop aimed at a screen point should land: on the letter under it, or right by it (in its counter, or
   * nearer its side than a marble is wide), at that letter's landing spot; else on the floor there.
   */
  spotAt(sx: number, sy: number): { x: number; z: number }
  /** A world point on screen (canvas px). */
  project(x: number, y: number, z: number): { x: number; y: number }
  /** The letters in reading order, with where to land on each and which word each is in. */
  letters(): { ch: string; spot: [number, number]; word: number }[]
  /** Each letter's counters: the deepest point of each (for tests). */
  counters(): { letter: number; x: number; z: number; a: number }[]
  /** The gaps between two letters narrower than `width` (em): where each is narrowest (for tests). */
  gaps(width: number): { a: number; b: number; x: number; z: number; w: number }[]
  /** The point `h` em above the floor under a canvas point. */
  planeAt(sx: number, sy: number, h: number): { x: number; z: number }
  /** The opening's route: a letter from the middle of each word, then the full stop. */
  tour(): { x: number; z: number }[]
  /** Which letter is at a floor point (-1: none). */
  under(x: number, z: number): number
  /** What's under a floor point: a letter (its index), a button (PAD_ID + its index) or the floor (-1), and its top. */
  surface(x: number, z: number): { id: number; h: number }
  /**
   * The page's buttons in the hero (canvas px), as low steps the marbles roll up onto and off: the marbles draw above
   * them (the canvas is over the page there) and the dots stay under them. Call when they move.
   */
  pads(rects: PadRect[]): void
  /**
   * What of the canvas the marbles may use, top to bottom (canvas px; its sides are the canvas's): what's on screen
   * when the page is at its top, below the bar over it. Each marble's outline, as drawn, stays within it.
   */
  play(top: number, bottom: number): void
  /** A marble's outline as drawn, on the canvas (px): its leftmost, rightmost, topmost and bottommost points. */
  outline(id: string): { left: number; right: number; top: number; bottom: number } | null
  /**
   * Each raised thing's side as it's seen (canvas px, in the order they were given; null: not there): from the middle
   * of its top's near edge down to the floor. Its block is drawn with it: as tall as its step looks from here, leaning
   * the way perspective leans it.
   */
  padSides(): ({ dx: number; dy: number } | null)[]
  /** How tall the raised things stand (em: ./world.ts PAD_H). */
  readonly padHeight: number
  /** The marbles' own clock (s): how far their fixed steps have taken them (./world.ts). */
  clock(): number
  /** Toss a marble up at `vy` (em/s): now if it's on something, else as soon as it touches down. */
  toss(o: FieldOrb, vy: number): void
  /** A marble, created on first use, in a colour. */
  orb(id: string, color: string): FieldOrb
  /** A marble takes another colour (its glass, glow, halo and light). */
  recolor(id: string, color: string): void
  /** The headline is text even when drawn in 3D: its ink and accent follow the page's surface. */
  palette(ink: string, accent: string, side: string): void
  removeOrb(id: string): void
  orbs(): FieldOrb[]
  /** Advance everything by dt; returns whether anything still moves. */
  step(dt: number): boolean
  /** The knocks that will be heard within `horizon` s if nothing changes what moves the marbles (./world.ts foresee()). */
  foresee(horizon: number): Hit[]
  render(): void
  /** How finely to draw (a step of ./governor.ts's ladder); `level` tags the GPU times measured at it. */
  quality(step: Step, level: number): void
  /** The canvas's exact size in device pixels, where the browser tells it (so the native step matches them 1:1). */
  pixels(w: number, h: number): void
  /** The GPU's time for a frame drawn earlier, when one has come back since the last call (browsers that can time it). */
  gpu(): GpuSample | null
  /** What it's drawing with, for the ?debug=gfx readout and tests. */
  gfx(): Gfx
  /** Called with a letter's index when a marble lands on it. */
  onLand: ((letter: number, orbId: string) => void) | null
  /** A marble hit something hard enough to hear. */
  onHit: ((h: Hit) => void) | null
  /** A knock too soft (or too soon after the last) to sound, and why: for ?debug=audio. */
  onQuiet: ((q: { orb: string; kind: HitKind; speed: number; why: string }) => void) | null
}

const radial = (stops: [number, string][], size = 256) => {
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
  float ringAt(vec2 p, vec4 r) {
    if (r.w <= 0.0) return 0.0;
    float age = uTime - r.z;
    if (age < 0.0 || age > 2.2) return 0.0;
    float d = distance(p, r.xy);
    return exp(-pow((d - age * ${RIPPLE_SPEED.toFixed(2)}) / 0.2, 2.0)) * exp(-age * ${RIPPLE_FADE.toFixed(2)}) * r.w;
  }
  vec3 glowAt(vec3 p, float reach) {
    vec3 g = vec3(0.0);
    for (int i = 0; i < ${MAX_ORBS}; i++) {
      vec3 o = uOrbs[i];
      if (o.y < -50.0) continue;
      float d = distance(p, o);
      g += uColors[i] * exp(-d * d * reach);
    }
    for (int i = 0; i < ${MAX_RIPPLES}; i++) g += uRippleColors[i] * ringAt(p.xz, uRipples[i]);
    return g;
  }`

export function createField(canvas: HTMLCanvasElement, opts: { coarse: boolean; still?: boolean }): Field {
  const UV = new Color('#5c3ef5'), INK = new Color('#f1edff'), LIME = new Color('#c6ff34')
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = SRGBColorSpace
  const scene = new Scene()
  // The marbles' world (./world.ts): its camera is the one drawn with.
  const world = createWorld()
  const camera = world.camera
  scene.add(new HemisphereLight(LAVENDER, new Color('#1c1244'), 1.35))
  const keyDir = new Vector3(-3, 8, 5).normalize()
  const key = new DirectionalLight(0xffffff, 1.5)
  key.position.copy(keyDir).multiplyScalar(10)
  scene.add(key)
  // A soft studio to reflect: the letters' edges and sides catch it, the way lacquered type does.
  const pmrem = new PMREMGenerator(renderer)
  const env: Texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()
  let quality: Step = { pr: Math.min(devicePixelRatio || 1, 2), glass: 2 }
  let qualityLevel = 0
  /** The canvas in device pixels, exactly, where the browser says (else worked out from its CSS size). */
  let device: [number, number] | null = null
  let exact: [number, number] | null = null
  /**
   * What's behind the marbles (the letters and the dots), for their glass to bend. The glass shows it shrunk three to
   * ten times, so it's drawn at half the screen's pixels or less, and mipmapped: each pixel of the marble shows the
   * average of what it covers, not one sample of it (which sparkles as the marble moves).
   */
  const behind = new WebGLRenderTarget(1, 1, { generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter })
  const buf = new Vector2(1, 1)
  // The GPU's time per frame, where the browser can measure it (Chrome, Edge): the governor's best guide.
  const gl = renderer.getContext() as WebGL2RenderingContext
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  const timing: { q: WebGLQuery; level: number }[] = []
  let gpuLast: GpuSample | null = null
  let gpuFresh = false
  let samples = 0
  const behindView = new Vector2(1, 1)
  /** No buttons (the picture the glass bends is the scene alone). */
  const noPads = Array.from({ length: MAX_PADS }, () => new Vector4(0, 0, 0, 0))

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
  const capBase = { color: INK, roughness: 0.34, metalness: 0.02, emissive: LIME, emissiveIntensity: 0, envMap: env, envMapIntensity: 0.28 }
  const sideMat = glowing(new MeshStandardMaterial({ color: UV.clone().multiplyScalar(0.8), roughness: 0.42, metalness: 0.1, envMap: env, envMapIntensity: 0.45 }), 0.55, 3.2)
  const letterGroup = new Group()
  scene.add(letterGroup)
  let letters: Letter[] = []
  // The raised things are drawn by the page (their tops, their sides), under the canvas. Here each is a block that draws
  // nothing but hides what's behind it (a marble rolled up to its far side, the dots and the light on the floor there),
  // so the page's block shows in front of it, as it stands in front of it.
  const padGroup = new Group()
  scene.add(padGroup)
  const hides = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide })
  /** The raised things' boxes (canvas px), which the dots keep off. */
  let padRects: PadRect[] = []
  let W = 1, H = 1
  let celebrateAt = -1
  let clock = 0

  // ---- the depth field: a floor of dots that part around a marble, glow in its light, and ring with its bounces ----
  const dotUniforms = {
    ...glow,
    uSize: { value: 3 },
    uDist: { value: 10 },
    uHaze: { value: new Color(LAVENDER) },
    uFar: { value: new Vector2(0, 1) },
    uView: { value: buf },
    // The buttons over the dots (drawing-buffer px from the bottom left: x0, y0, x1, y1, and their corners' radius).
    uPads: { value: Array.from({ length: MAX_PADS }, () => new Vector4(0, 0, 0, 0)) },
    uPadR: { value: new Array<number>(MAX_PADS).fill(0) },
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
      // A marble low over the dots parts them, like a finger drawn through sand, and presses them down a little; a
      // ring of light lifts them as it passes (a wave).
      vec3 wake(vec3 p) {
        vec3 d = vec3(0.0);
        for (int i = 0; i < ${MAX_ORBS}; i++) {
          vec3 o = uOrbs[i];
          if (o.y < -50.0) continue;
          vec2 v = p.xz - o.xz;
          float r2 = dot(v, v) + 1e-4;
          float k = exp(-r2 * 9.0) * exp(-max(o.y - ${ORB_R.toFixed(2)}, 0.0) * 3.5);
          d.xz += v * inversesqrt(r2) * k * 0.09;
          d.y -= k * 0.025;
        }
        for (int i = 0; i < ${MAX_RIPPLES}; i++) d.y += ringAt(p.xz, uRipples[i]) * 0.07;
        return d;
      }
      void main() {
        vec3 p = position;
        vec3 g = glowAt(p, 1.3);
        float k = min(max(g.r, max(g.g, g.b)), 1.0);
        p += wake(position);
        p.y += k * 0.05;
        vGlow = k;
        vColor = k > 0.0 ? g / max(k, 1e-3) : vec3(0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * (1.0 + vGlow * 1.2) * (uDist / -mv.z);
        // Far dots fade into the night (the depth).
        vFade = clamp((uFar.y - p.z) / max(uFar.y - uFar.x, 1e-3), 0.0, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uHaze;
      uniform vec2 uView;
      uniform vec4 uPads[${MAX_PADS}];
      uniform float uPadR[${MAX_PADS}];
      varying vec3 vColor;
      varying float vGlow;
      varying float vFade;
      // 0 under a button, 1 clear of them (the floor's dots are under the page's buttons, as they're under the page).
      float clear(vec2 p) {
        float m = 1.0;
        for (int i = 0; i < ${MAX_PADS}; i++) {
          vec4 b = uPads[i];
          if (b.z <= b.x) continue;
          vec2 q = abs(p - (b.xy + b.zw) * 0.5) - (b.zw - b.xy) * 0.5 + uPadR[i];
          float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uPadR[i];
          m = min(m, clamp(d + 0.5, 0.0, 1.0));
        }
        return m;
      }
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = dot(c, c);
        if (r > 0.25) discard;
        float soft = smoothstep(0.25, 0.06, r);
        // At rest the matrix is faint, and fades out toward the hero's edges; a marble's light shows anywhere.
        vec2 sp = gl_FragCoord.xy / uView;
        float field = 1.0 - smoothstep(0.25, 0.8, length((sp - vec2(0.5, 0.55)) / vec2(0.75, 0.65)));
        vec3 col = mix(uHaze, vColor, vGlow);
        float a = soft * (0.2 * field + 0.8 * vGlow) * (1.0 - 0.6 * vFade) * clear(gl_FragCoord.xy);
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
  const marbleGeo = new SphereGeometry(ORB_R, 48, 32)

  /**
   * Clear glass. Behind it, the scene seen through a ball lens: upside down and drawn in from all around, less of it at
   * the rim where the glass mostly reflects. Inside, a thin twisted ribbon of colour, found by following the bent ray
   * through the ball: it turns as the marble rolls. On it, the key light's highlight and the sky's sheen.
   * The mesh only covers the marble (a little larger than it): each pixel finds the true sphere along its view ray, so
   * the outline is shaded by how much of the pixel it covers, and the rim, whose brightness changes within a pixel at
   * the very edge, is averaged across the pixel rather than sampled at its middle. No stairs or sparkle at any size.
   */
  const marbleMaterial = (tint: Color) => new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    uniforms: {
      uTint: { value: tint }, uLife: { value: 0 }, uKey: { value: keyDir },
      uScene: { value: behind.texture }, uRefract: { value: 1 }, uView: { value: buf }, uSteps: { value: 12 },
      uCenter: { value: new Vector2() }, uRad: { value: 1 }, uC: { value: new Vector3() }, uR: { value: ORB_R }, uSpin: { value: new Matrix3() },
      uAxis: { value: new Vector3(0, 1, 0) }, uSquash: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 uTint;
      uniform float uLife;
      uniform vec3 uKey;
      uniform sampler2D uScene;
      uniform float uRefract;
      uniform vec2 uView;
      uniform int uSteps;
      uniform vec2 uCenter;
      uniform float uRad;
      uniform vec3 uC;
      uniform float uR;
      uniform mat3 uSpin;
      uniform vec3 uAxis;
      uniform float uSquash;
      varying vec3 vWorld;
      // Into the space where the marble, squashed along uAxis by a knock, is a sphere of radius uR again.
      vec3 unsquash(vec3 v) {
        float a = dot(v, uAxis);
        return (v - a * uAxis) / (1.0 + 0.5 * uSquash) + uAxis * (a / (1.0 - uSquash));
      }
      float vanes(vec3 q) {
        float l = length(q);
        float r = length(q.xz);
        if (l > 0.84) return 0.0;
        float a = atan(q.z, q.x) - q.y * 1.7;
        float blade = pow(abs(cos(a)), 26.0);
        return blade * smoothstep(0.84, 0.45, l) * smoothstep(0.0, 0.1, r);
      }
      // The rim's reflection where the view passes q from the centre: faint face-on, all of it at the very edge.
      float fresnel(float q) {
        float ndv = sqrt(max(1.0 - q * q / (uR * uR), 0.0));
        return 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
      }
      void main() {
        // The sphere along this pixel's view ray: how near the ray passes its centre, and one pixel in the same units.
        // (Worked out where the squashed marble is round again: the same, unsquashed.)
        vec3 rd0 = normalize(vWorld - cameraPosition);
        vec3 O = unsquash(cameraPosition - uC);
        vec3 D = unsquash(rd0);
        float dd = dot(D, D);
        float along = -dot(O, D) / dd;
        float q = length(O + D * along);
        float px = max(length(vec2(dFdx(q), dFdy(q))), 1e-6);
        float cover = clamp((uR - q) / px + 0.5, 0.0, 1.0);
        float qi = min(q, uR);
        vec3 hit = cameraPosition + rd0 * (along - sqrt(uR * uR - qi * qi) / sqrt(dd));
        vec3 n = normalize(unsquash(unsquash(hit - uC)));
        vec3 v = -rd0;
        float ndv = clamp(dot(n, v), 0.0, 1.0);
        float fres = 0.0;
        float taps = 0.0;
        for (int k = 0; k < 4; k++) {
          float qk = q + px * (float(k) - 1.5) * 0.25;
          if (qk <= uR) { fres += fresnel(qk); taps += 1.0; }
        }
        fres = taps > 0.0 ? fres / taps : 1.0;
        vec2 d = (gl_FragCoord.xy - uCenter) / uRad;
        d /= max(1.0, length(d));
        vec2 s = uCenter - d * uRad * (3.0 + 2.2 * dot(d, d));
        vec4 back = uRefract > 0.5 ? texture2D(uScene, clamp(s / uView, 0.0, 1.0)) : vec4(0.0);
        vec3 rd = refract(rd0, n, 1.0 / 1.5);
        float chord = max(0.0, -2.0 * dot(hit - uC, rd));
        float dens = 0.0;
        float steps = float(uSteps);
        for (int i = 1; i <= 12; i++) {
          if (i > uSteps) break;
          vec3 p = hit + rd * chord * (float(i) / (steps + 1.0));
          dens += vanes(uSpin * (unsquash(p - uC) / uR));
        }
        dens = clamp(dens / (steps * 0.25), 0.0, 1.0);
        vec3 r = reflect(-v, n);
        float spec = pow(max(dot(r, uKey), 0.0), 70.0) * 1.8;
        float sheen = smoothstep(0.5, 1.0, dot(r, normalize(vec3(-0.25, 1.0, 0.3)))) * 0.22;
        float core = pow(ndv, 3.0) * (0.03 + 0.12 * uLife);
        float see = 1.0 - fres;
        vec3 vane = uTint * dens * (0.4 + 0.45 * uLife);
        // Glass takes a little of the colour out of what it shows, and cools it.
        vec3 seen = mix(vec3(dot(back.rgb, vec3(0.3, 0.55, 0.15))), back.rgb, 0.7) * vec3(0.86, 0.9, 1.0);
        vec3 col = seen * see * 0.85 + vane + uTint * core + mix(vec3(0.92, 0.9, 1.0), uTint, 0.25) * (fres * 0.85 + sheen) + vec3(spec);
        float a = clamp(back.a * see * 0.8 + dens * 0.4 + core + fres * 0.85 + sheen + spec + 0.04, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
        // Coverage after the colour's encoding, so an edge pixel half covered is half as bright on screen.
        gl_FragColor *= cover;
      }`,
  })

  function makeOrb(id: string, color: string): FieldOrb {
    const c = new Color(color)
    const marble = new Mesh(marbleGeo, marbleMaterial(c))
    marble.renderOrder = 3
    const flat = (tex: CanvasTexture, size: number, add: boolean) => {
      const m = new Mesh(new CircleGeometry(size, 40), new MeshBasicMaterial({ map: tex, color: add ? c : 0xffffff, transparent: true, depthWrite: false, ...(add ? { blending: AdditiveBlending } : {}) }))
      m.rotation.x = -Math.PI / 2
      m.renderOrder = 2
      scene.add(m)
      return m
    }
    const shadow = flat(shadowTex, ORB_R * 1.5, false)
    const pool = flat(poolTex, ORB_R * 8, true)
    const caustic = flat(causticTex, ORB_R * 0.9, true)
    const halo = new Sprite(new SpriteMaterial({ map: haloTex, color: c, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.2 }))
    halo.renderOrder = 1
    scene.add(marble, halo)
    const m = world.marble(id)
    const fo: FieldOrb = { id, orb: m.orb, m, color: c, life: 0, live: false, push: null, marble, halo, shadow, caustic, pool, spin: new Quaternion(), omega: new Vector3(), quietAt: -1, squash: { x: 0, v: 0 }, axis: new Vector3(0, 1, 0) }
    orbMap.set(id, fo)
    return fo
  }

  function ripple(x: number, z: number, strength: number, color: Color) {
    const i = rippleNext++ % MAX_RIPPLES
    glow.uRipples.value[i].set(x, z, clock, strength)
    glow.uRippleColors.value[i].copy(color)
  }

  // ---- knocks felt in 3D (none where the visitor asks for less motion: then it's the sound alone) ----
  /** The view's jolt (canvas px), springing back. */
  const shake = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 } }
  /** A letter struck: it rocks, the side toward (dx, dz) from its foot going down, as hard as `s` (0…1). */
  function rock(l: Letter, dx: number, dz: number, s: number) {
    const d = Math.hypot(dx, dz)
    if (opts.still || s <= 0 || d < 1e-6) return
    l.rx.v += (ROCK * s * dz) / d
    l.rz.v -= (ROCK * s * dx) / d
  }
  /** A marble struck along (ax, ay, az): it squashes that way, and rings. */
  function knock(o: FieldOrb, ax: number, ay: number, az: number, s: number) {
    if (opts.still || s <= 0 || Math.hypot(ax, ay, az) < 1e-6) return
    // A new knock the other way round wins over what's left of the last.
    if (Math.abs(o.squash.x) < 0.02) o.axis.set(ax, ay, az).normalize()
    o.squash.v += SQUASH * s
  }
  /** A very hard knock jolts the view, the way the marble was going (canvas px: dx right, dy down). */
  function jolt(dx: number, dy: number, s: number) {
    const d = Math.hypot(dx, dy)
    if (opts.still || s < JOLT_FROM || d < 1e-6) return
    const k = ((s - JOLT_FROM) / (1 - JOLT_FROM)) * JOLT_PX * 2 * Math.PI * 9
    shake.x.v += (k * dx) / d
    shake.y.v += (k * dy) / d
  }
  /** A knock too soft (or too soon) to sound: noted for ?debug=audio, now and then. */
  function hush(o: FieldOrb, kind: HitKind, speed: number, why: string) {
    if (speed < NOTE_FROM || clock - o.quietAt < NOTE_GAP) return
    o.quietAt = clock
    field.onQuiet?.({ orb: o.id, kind, speed, why })
  }
  /** Which way on screen a wall is (left, right, top, bottom). */
  const WALL_WAY: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]]

  // ---- letters ----
  function buildLetters() {
    for (const l of letters) { l.mesh.geometry.dispose(); l.cap.dispose() }
    letterGroup.clear()
    letters = []
    // Laid out as the page wraps the headline (./letters.ts, by the world); each letter extruded from its glyph's
    // shapes, its top's rounded edge set inside the outline (so narrow gaps, like the eye of an e, never close up).
    for (const l of world.laid) {
      const geo = new ExtrudeGeometry(l.shapes, {
        depth: LETTER_H - BEVEL, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: EDGE, bevelOffset: -EDGE, bevelSegments: 2,
        curveSegments: opts.coarse ? 9 : 14,
      })
      // Glyph up is away from the viewer (-z); the letter stands up out of the floor (+y), its bevel just below it. It
      // stands on its own foot (the middle of its footprint), which it rocks about when struck.
      const b = l.fp.box, cx = (b[0] + b[2]) / 2, cz = (b[1] + b[3]) / 2
      geo.rotateX(-Math.PI / 2)
      geo.translate(l.x - cx, BEVEL, l.zBase - cz)
      const cap = glowing(new MeshStandardMaterial(capBase), 0.7, 2.6)
      const mesh = new Mesh(geo, [cap, sideMat])
      mesh.position.set(cx, 0, cz)
      letterGroup.add(mesh)
      letters.push({ ch: l.ch, word: l.word, fp: l.fp, mesh, cap, lit: 0, kept: 0, dip: 0, dipV: 0, rx: { x: 0, v: 0 }, rz: { x: 0, v: 0 } })
    }
  }

  // ---- the raised things, as blocks that hide what's behind them ----
  function buildPadBlocks() {
    for (const m of padGroup.children) (m as Mesh).geometry.dispose()
    padGroup.clear()
    for (const fp of world.pads) {
      const ring = fp.rings[0]
      const shape = new Shape()
      shape.moveTo(ring[0], -ring[1])
      for (let k = 2; k < ring.length; k += 2) shape.lineTo(ring[k], -ring[k + 1])
      // Its footprint, from the floor up to its top (the shape's y is the floor's -z, as the letters' glyphs are).
      const geo = new ExtrudeGeometry(shape, { depth: PAD_H, bevelEnabled: false, curveSegments: 1 })
      geo.rotateX(-Math.PI / 2)
      padGroup.add(new Mesh(geo, hides))
    }
  }

  // ---- the dots, where the camera sees the floor; and the raised things they keep off ----

  /** The dots cover what the camera sees of the floor (a little wider apart on a phone), sized for the buffer. */
  function fitDots() {
    const bounds = world.bounds
    const gap = opts.coarse ? 0.26 : 0.2
    const verts: number[] = []
    for (let x = Math.floor(bounds[0] / gap) * gap; x <= bounds[2]; x += gap) {
      for (let z = Math.floor(bounds[1] / gap) * gap; z <= bounds[3]; z += gap) verts.push(x, 0.002, z)
    }
    dots.geometry.dispose()
    dots.geometry = new BufferGeometry()
    dots.geometry.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3))
    dotUniforms.uFar.value.set(bounds[1], bounds[3])
    dotUniforms.uSize.value = 2.6 * (buf.x / W)
    dotUniforms.uDist.value = world.view.dist
    padsForDots()
  }

  /** The dots keep off the raised things: their boxes in drawing-buffer pixels, from the bottom left. */
  function padsForDots() {
    const kx = buf.x / W, ky = buf.y / H
    dotUniforms.uPads.value.forEach((v, i) => {
      const b = padRects[i]
      if (b && b.w > 0) v.set(b.x * kx, buf.y - (b.y + b.h) * ky, (b.x + b.w) * kx, buf.y - b.y * ky)
      else v.set(0, 0, 0, 0)
      dotUniforms.uPadR.value[i] = b ? Math.min(b.r, b.w / 2, b.h / 2) * kx : 0
    })
  }

  function size() {
    // The drawing buffer at the step's density, counted from the screen's own pixels so that at its density it
    // matches them exactly: a buffer even half a pixel off is stretched by the browser, softening every edge.
    const dpr = devicePixelRatio || 1
    // The browser's own count where it agrees with the CSS size (an emulated screen reports CSS pixels there).
    exact = device && Math.abs(device[0] - W * dpr) < 1.5 && Math.abs(device[1] - H * dpr) < 1.5 ? device : null
    const [dw, dh] = exact ?? [Math.round(W * dpr), Math.round(H * dpr)]
    const k = quality.pr / dpr
    const bw = Math.max(1, Math.round(dw * k)), bh = Math.max(1, Math.round(dh * k))
    // setSize clears even an unchanged canvas; the renderer keeps its default pixel ratio of one.
    if (canvas.width !== bw || canvas.height !== bh) renderer.setSize(bw, bh, false)
    renderer.getDrawingBufferSize(buf)
    const g = glassScale(quality, dpr)
    behind.setSize(Math.max(1, Math.round(W * g)), Math.max(1, Math.round(H * g)))
  }

  const strength = (v: number) => Math.min(1, Math.max(0, (v - HIT_MIN) / (HIT_MAX - HIT_MIN)))
  const tmpV = new Vector3()
  const tmpQ = new Quaternion()
  const m4 = new Matrix4()
  const right = new Vector3()
  const pc = new Vector3()
  const pe = new Vector3()

  const field: Field = {
    canvas,
    onLand: null,
    onHit: null,
    onQuiet: null,
    layout(lines, w, h, box) {
      W = Math.max(1, w); H = Math.max(1, h)
      size()
      if (world.layout(lines, W, H, box)) buildLetters()
      fitDots()
      buildPadBlocks()
    },
    floorAt: (sx, sy) => world.floorAt(sx, sy),
    pointAt: (sx, sy) => world.pointAt(sx, sy),
    spotAt: (sx, sy) => world.spotAt(sx, sy),
    project: (x, y, z) => world.project(x, y, z),
    letters: () => world.letters(),
    counters: () => world.counters(),
    gaps: (w) => world.gaps(w),
    planeAt: (sx, sy, h) => world.planeAt(sx, sy, h),
    tour: () => world.tour(),
    under: (x, z) => surfaceAt(world.footprints, x, z).id,
    surface: (x, z) => world.surface(x, z),
    pads(rects) {
      if (!world.setPads(rects)) return
      padRects = rects.map((r) => ({ ...r }))
      padsForDots()
      buildPadBlocks()
    },
    play: (top, bottom) => world.play(top, bottom),
    padHeight: PAD_H,
    clock: () => world.clock,
    padSides() {
      return padRects.map((b) => {
        if (!(b.w > 0)) return null
        const p = world.planeAt(b.x + b.w / 2, b.y + b.h, PAD_H)
        const top = world.project(p.x, PAD_H, p.z), foot = world.project(p.x, 0, p.z)
        return { dx: foot.x - top.x, dy: Math.max(0, foot.y - top.y) }
      })
    },
    outline(id) {
      const o = orbMap.get(id)
      if (!o) return null
      // Points all over the sphere as drawn (a little bigger the higher it is), onto the canvas: their extremes.
      const [bx, by, bz] = o.m.shown
      const rho = ORB_R * (1 + DEPTH * Math.max(0, by - ORB_R))
      const out = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
      for (let i = 0; i < 48; i++) {
        const lat = -Math.PI / 2 + (Math.PI * (i + 0.5)) / 48
        for (let j = 0; j < 96; j++) {
          const lon = (2 * Math.PI * j) / 96
          const p = world.project(bx + rho * Math.cos(lat) * Math.cos(lon), by + rho * Math.sin(lat), bz + rho * Math.cos(lat) * Math.sin(lon))
          out.left = Math.min(out.left, p.x); out.right = Math.max(out.right, p.x)
          out.top = Math.min(out.top, p.y); out.bottom = Math.max(out.bottom, p.y)
        }
      }
      return out
    },
    toss: (o, vy) => world.toss(o.m, vy),
    orb: (id, color) => orbMap.get(id) ?? makeOrb(id, color),
    recolor(id, color) {
      const o = orbMap.get(id)
      if (!o) return
      // The glass's tint is this same colour object; the rest carry copies.
      o.color.set(color)
      o.halo.material.color.set(color)
      for (const m of [o.pool, o.caustic]) (m.material as MeshBasicMaterial).color.set(color)
    },
    palette(ink, accent, side) {
      INK.set(ink)
      LIME.set(accent)
      sideMat.color.set(side).multiplyScalar(0.8)
      for (const l of letters) { l.cap.color.copy(INK); l.cap.emissive.copy(LIME) }
    },
    removeOrb(id) {
      const o = orbMap.get(id)
      if (!o) return
      scene.remove(o.marble, o.halo, o.shadow, o.caustic, o.pool)
      ;(o.marble.material as ShaderMaterial).dispose()
      o.halo.material.dispose()
      for (const m of [o.shadow, o.caustic, o.pool]) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose() }
      orbMap.delete(id)
      world.remove(id)
    },
    orbs: () => [...orbMap.values()],
    quality(q, lv) {
      qualityLevel = lv
      if (q.pr === quality.pr && q.glass === quality.glass) return
      quality = q
      size()
      fitDots()
    },
    pixels(w, h) {
      if (device && device[0] === w && device[1] === h) return
      device = [w, h]
      size()
      fitDots()
    },
    gpu() {
      pollTiming()
      if (!gpuFresh) return null
      gpuFresh = false
      return gpuLast
    },
    gfx: () => ({
      css: [W, H], buffer: [buf.x, buf.y], pr: Math.round((buf.x / W) * 1000) / 1000, device: exact, samples,
      behind: quality.glass ? [behind.width, behind.height] : [0, 0], glass: quality.glass, gpuMs: gpuLast?.ms ?? null,
    }),
    step(dt) {
      clock += dt
      glow.uTime.value = clock
      const all = [...orbMap.values()]
      for (const o of all) o.m.push = o.push
      // The marbles move on in the world's steps; what they struck, each at its moment, answered here.
      const moved = world.step(dt)
      let busy = moved.moving
      const shownAt = world.shownAt()
      const hits: Hit[] = []
      for (const h of moved.hits) {
        const o = orbMap.get(h.orb)
        if (!o) continue
        const s = strength(h.speed)
        const at = { x: h.x, y: h.y, z: h.z, ago: shownAt - h.t, key: keyOf(h) }
        if (h.kind === 'wall') {
          // A knock against the edge of the screen: a glass tap, as hard as it came in, a ring of light from where it
          // struck, and a squash along the edge's way.
          if (h.speed > WALL_MIN) {
            hits.push({ orb: o.id, kind: 'wall', strength: s, speed: h.speed, ...at })
            ripple(h.x + h.nx * ORB_R, h.z + h.nz * ORB_R, 0.2 + 0.55 * s, o.color)
            knock(o, h.nx, 0, h.nz, s)
            jolt(WALL_WAY[h.wall ?? 0][0], WALL_WAY[h.wall ?? 0][1], s)
          } else hush(o, 'wall', h.speed, `under ${WALL_MIN} em/s`)
          continue
        }
        if (h.kind === 'marble') {
          // Marbles knock into each other (glass on glass): both ring, both squash along the line between them.
          const other = h.other ? orbMap.get(h.other) : undefined
          if (!other || h.speed <= HIT_MIN * 0.6) continue
          hits.push({ orb: o.id, other: other.id, kind: 'marble', strength: s, speed: h.speed, ...at })
          ripple(h.x, h.z, 0.2 + 0.5 * s, o.color.clone().lerp(other.color, 0.5))
          knock(o, h.nx, h.ny, h.nz, s)
          knock(other, h.nx, h.ny, h.nz, s)
          continue
        }
        const l = h.letter !== undefined ? letters[h.letter] : undefined
        if (h.landed && !h.soft) {
          // Every bounce sends a ring of light out through the dots and the letters, stronger the harder it lands; the
          // marble squashes a little as it lands, and a very hard landing jolts the view.
          const impact = Math.min(1, h.speed / 5)
          if (impact > 0.12) ripple(h.x, h.z, 0.25 + 0.75 * impact, o.color)
          knock(o, 0, 1, 0, s)
          jolt(0, 1, s)
          if (l) {
            l.dipV -= 0.9
            l.lit = 1
            l.kept = 0.42
            // It rocks toward the side that took it.
            rock(l, h.x - l.mesh.position.x, h.z - l.mesh.position.z, s)
            field.onLand?.(h.letter!, o.id)
            if (celebrateAt < 0 && letters.every((x) => x.kept > 0)) celebrateAt = clock
          }
        } else if (l) {
          // A knock on a letter's side: it flashes, but only a landing keeps it lit; it rocks away from the marble.
          l.lit = Math.max(l.lit, 0.35 + 0.65 * s)
          l.dipV -= 0.25 * s
          rock(l, l.mesh.position.x - h.x - h.nx * ORB_R, l.mesh.position.z - h.z - h.nz * ORB_R, 0.8 * s)
          knock(o, h.nx, 0, h.nz, s)
        }
        // Arriving on a button without a landing to hear (rolled up onto it, or set down softly): it takes the
        // marble's weight with a soft tap.
        if (h.soft) hits.push({ orb: o.id, kind: 'button', pad: h.pad, strength: 0.12 + 0.3 * strength(h.speed * 2), speed: h.speed, ...at })
        else if (h.speed > HIT_MIN) hits.push({ orb: o.id, kind: h.kind, ...(h.pad !== undefined ? { pad: h.pad } : {}), strength: s, speed: h.speed, ...at })
        else hush(o, h.kind, h.speed, `under ${HIT_MIN} em/s`)
      }
      for (const o of all) {
        const b = o.orb
        // It rolls on whatever it's on (turning with its speed); in the air it keeps turning as it was.
        const onSurface = b.y - b.r - world.surface(b.x, b.z).h < 0.01
        if (onSurface) o.omega.set(b.vz, 0, -b.vx).divideScalar(b.r)
        else o.omega.multiplyScalar(Math.exp(-dt * 0.4))
        const w = o.omega.length()
        if (w > 1e-3) { o.spin.premultiply(tmpQ.setFromAxisAngle(tmpV.copy(o.omega).divideScalar(w), w * Math.min(dt, 0.12))); o.spin.normalize() }
        const goal = o.live || o.push ? 1 : 0.45
        o.life += (goal - o.life) * (1 - Math.exp(-dt * 3))
        busy = busy || Math.abs(goal - o.life) > 0.01
        // A knock's squash rings out: a few quick swings, gone in a fifth of a second.
        spring(o.squash, dt, 12, 0.18)
        o.squash.x = Math.max(-0.1, Math.min(0.1, o.squash.x))
        if (!settled(o.squash)) busy = true
      }
      spring(shake.x, dt, 9, 0.35)
      spring(shake.y, dt, 9, 0.35)
      if (!settled(shake.x) || !settled(shake.y)) busy = true
      for (const h of hits) field.onHit?.(h)
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
        // A knock rocks it about its foot, a few swings in a fifth of a second.
        spring(l.rx, dt, 7, 0.32)
        spring(l.rz, dt, 7, 0.32)
        l.mesh.rotation.set(Math.max(-0.08, Math.min(0.08, l.rx.x)), 0, Math.max(-0.08, Math.min(0.08, l.rz.x)))
        l.cap.emissiveIntensity = l.lit * 0.7
        l.cap.color.copy(INK).lerp(LIME, l.lit * 0.3)
        if (Math.abs(l.dip) > 1e-4 || Math.abs(l.dipV) > 1e-3 || Math.abs(l.lit - l.kept) > 0.004 || !settled(l.rx) || !settled(l.rz)) busy = true
      }
      return busy
    },
    foresee(horizon) {
      const shownAt = world.shownAt()
      const out: Hit[] = []
      for (const h of world.foresee(horizon)) {
        const o = orbMap.get(h.orb)
        // Those step() will surely hear.
        if (!o || !foreseeable(h) || (h.kind === 'marble' && !(h.other && orbMap.has(h.other)))) continue
        out.push({ orb: o.id, kind: h.kind, ...(h.other ? { other: h.other } : {}), ...(h.pad !== undefined ? { pad: h.pad } : {}), strength: strength(h.speed), speed: h.speed, x: h.x, y: h.y, z: h.z, ago: shownAt - h.t, key: keyOf(h) })
      }
      return out
    },
    render() {
      let i = 0
      const refract = quality.glass > 0
      // A hard knock's jolt: the whole view, drawn a pixel or two over (the page itself stays put).
      const jolted = !settled(shake.x) || !settled(shake.y)
      if (jolted) {
        camera.setViewOffset(W, H, world.view.x - shake.x.x, world.view.y - shake.y.x, W, H)
        camera.updateProjectionMatrix()
      }
      right.setFromMatrixColumn(camera.matrixWorld, 0)
      for (const o of orbMap.values()) {
        // Where it is as drawn: between its last two steps, as far as the frame is.
        const [bx, by, bz] = o.m.shown
        const b = { x: bx, y: by, z: bz, r: o.orb.r }
        // Nearer the eye the higher it is: a little bigger (the physics keeps its true size).
        const scale = 1 + DEPTH * Math.max(0, b.y - b.r)
        const u = (o.marble.material as ShaderMaterial).uniforms
        u.uLife.value = o.life
        u.uRefract.value = refract ? 1 : 0
        u.uSteps.value = quality.glass === 2 ? 12 : 6
        u.uC.value.set(b.x, b.y, b.z)
        u.uR.value = ORB_R * scale
        u.uSquash.value = o.squash.x
        ;(u.uAxis.value as Vector3).copy(o.axis)
        ;(u.uSpin.value as Matrix3).setFromMatrix4(m4.makeRotationFromQuaternion(tmpQ.copy(o.spin).invert()))
        // Its centre and size on screen (drawing-buffer pixels, from the bottom), where its glass bends what's behind.
        pc.set(b.x, b.y, b.z).project(camera)
        pe.set(b.x, b.y, b.z).addScaledVector(right, ORB_R * scale).project(camera)
        ;(u.uCenter.value as Vector2).set(((pc.x + 1) / 2) * buf.x, ((pc.y + 1) / 2) * buf.y)
        const rad = Math.max(1, Math.hypot(((pe.x - pc.x) / 2) * buf.x, ((pe.y - pc.y) / 2) * buf.y))
        u.uRad.value = rad
        // The mesh reaches a couple of pixels past the glass, for its shaded edge (and past a squash's bulge).
        o.marble.position.set(b.x, b.y, b.z)
        o.marble.scale.setScalar(scale * (1 + 2.5 / rad + Math.abs(o.squash.x)))
        o.halo.position.set(b.x, b.y, b.z)
        o.halo.scale.setScalar(ORB_R * 4.2 * scale)
        o.halo.material.opacity = 0.05 + 0.12 * o.life
        // On whatever is under the marble: its shadow (bigger and fainter the higher it is), the caustic its glass
        // focuses there (tight and bright when low, spreading as it rises), and the soft pool of its light.
        const s = world.surface(b.x, b.z)
        const hgt = Math.max(0, b.y - b.r - s.h)
        // Both fall away from the key light (behind and to the right of the marble, as seen), the caustic inside the shadow.
        o.shadow.position.set(b.x + 0.05 + hgt * 0.3, s.h + 0.004, b.z - 0.08 - hgt * 0.5)
        o.shadow.scale.setScalar(1 + hgt * 0.8)
        ;(o.shadow.material as MeshBasicMaterial).opacity = Math.max(0.08, 0.55 - hgt * 0.7)
        o.caustic.position.set(b.x + 0.07 + hgt * 0.3, s.h + 0.005, b.z - 0.12 - hgt * 0.5)
        o.caustic.scale.setScalar(1 + hgt * 2.2)
        ;(o.caustic.material as MeshBasicMaterial).opacity = (0.25 + 0.3 * o.life) / (1 + hgt * 3)
        o.pool.position.set(b.x, s.h + 0.003, b.z)
        o.pool.scale.setScalar(0.8 + hgt * 0.6)
        ;(o.pool.material as MeshBasicMaterial).opacity = (0.035 + 0.08 * o.life) / (1 + hgt)
        if (i < MAX_ORBS) { glow.uOrbs.value[i].set(b.x, b.y, b.z); glow.uColors.value[i].copy(o.color).multiplyScalar(0.35 + 0.65 * o.life) }
        i++
      }
      for (; i < MAX_ORBS; i++) glow.uOrbs.value[i].set(0, -99, 0)
      pollTiming()
      const q = timer && timing.length < 4 ? gl.createQuery() : null
      if (q) gl.beginQuery(timer!.TIME_ELAPSED_EXT, q)
      // What's behind the marbles, for their glass: the scene without them (its dots sized for its pixels).
      if (refract && orbMap.size) {
        const hide = (on: boolean) => { for (const o of orbMap.values()) for (const m of [o.marble, o.halo, o.shadow, o.caustic, o.pool]) m.visible = on }
        hide(false)
        const dotSize = dotUniforms.uSize.value, padBoxes = dotUniforms.uPads.value
        dotUniforms.uSize.value = dotSize * (behind.width / buf.x)
        dotUniforms.uView.value = behindView.set(behind.width, behind.height)
        dotUniforms.uPads.value = noPads
        renderer.setRenderTarget(behind)
        renderer.clear()
        renderer.render(scene, camera)
        renderer.setRenderTarget(null)
        dotUniforms.uSize.value = dotSize
        dotUniforms.uView.value = buf
        dotUniforms.uPads.value = padBoxes
        hide(true)
      }
      renderer.render(scene, camera)
      if (q) { gl.endQuery(timer!.TIME_ELAPSED_EXT); timing.push({ q, level: qualityLevel }) }
      if (!samples) samples = gl.getParameter(gl.SAMPLES) as number
      if (jolted) {
        camera.setViewOffset(W, H, world.view.x, world.view.y, W, H)
        camera.updateProjectionMatrix()
      }
    },
  }

  /** Collect the GPU times that have come back (a frame or two late), unless the GPU was interrupted meanwhile. */
  function pollTiming() {
    if (!timer) return
    while (timing.length) {
      const t = timing[0]
      if (!gl.getQueryParameter(t.q, gl.QUERY_RESULT_AVAILABLE)) break
      const ns = gl.getQueryParameter(t.q, gl.QUERY_RESULT) as number
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) { gpuLast = { ms: ns / 1e6, level: t.level }; gpuFresh = true }
      gl.deleteQuery(t.q)
      timing.shift()
    }
  }
  return field
}

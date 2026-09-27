/**
 * The home page's use cases, as small live scenes. Each plays a short story of its own (a pick and place, a rally,
 * a shared build) and hands over to your pointer or finger the moment you touch it, the way ob.Pal hands a scene to a
 * phone. SVG with gradients only: no filters, and nothing draws unless main.ts asks for a frame (on screen, lately
 * looked at), so a phone stays cool.
 */
import { aim, BLOCK, FINGER, follow, HOLD, JOINT_R, LINK_W, PADS, PLATE, pose, RIM, story, TABLE, type Arm } from './arm'

const NS = 'http://www.w3.org/2000/svg'
type Attrs = Record<string, string | number>
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  parent?.appendChild(e)
  return e
}
const set = (e: Element, attrs: Attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? v.toFixed(2) : v) }
const ease = (cur: number, to: number, dt: number, rate = 9) => cur + (to - cur) * (1 - Math.exp(-dt * rate))
const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c) }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export const W = 400
export const H = 260

// The site palette (styles/site.css): lime light, lavender haze, ultraviolet depth, and everyone else's colours.
const LIME = '#c6ff34'
const CORE = '#f4ffd6'
const HAZE = '#b3a4ff'
const UV = '#5c3ef5'
const INK = '#f5f2ff'
const DIM = '#968fbd'
const DEEP = '#120d2b'
const SKY = '#38bdf8'
const ROSE = '#fb7185'
const AMBER = '#fcd34d'

export interface Point { x: number; y: number }
export interface Scene {
  svg: SVGSVGElement
  /**
   * Advance by `dt` seconds. With a pointer (`p`, viewBox units) the scene follows it; with none it plays its own
   * story at time `t`. Returns whether anything still moves.
   */
  step(dt: number, p: Point | null, t: number): boolean
  /** A tap or click at `p`. */
  press?(p: Point): void
}

let seq = 0
/** A scene's frame: the stage light, and the gradients its parts share. */
function frame(label: string) {
  const id = `sc${++seq}`
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, class: 'scene-svg' })
  const defs = el('defs', {}, svg)
  const grad = (name: string, kind: 'linearGradient' | 'radialGradient', stops: [number, string, number][], attrs: Attrs = {}) => {
    const gr = el(kind, { id: `${id}-${name}`, ...attrs }, defs)
    for (const [o, c, a] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, gr)
  }
  // A soft pool of light with no edges, so the scene melts into whatever card it sits in.
  grad('stage', 'radialGradient', [[0, UV, 0.22], [0.55, UV, 0.07], [1, UV, 0]], { cx: 0.5, cy: 0.42, r: 0.72 })
  grad('floor', 'radialGradient', [[0, LIME, 0.2], [0.5, LIME, 0.06], [1, LIME, 0]])
  grad('glow', 'radialGradient', [[0, LIME, 0.42], [0.4, LIME, 0.1], [1, LIME, 0]])
  grad('haze', 'radialGradient', [[0, HAZE, 0.3], [1, HAZE, 0]])
  grad('glass', 'linearGradient', [[0, '#34297a', 1], [1, '#130e2e', 1]], { x1: 0, y1: 0, x2: 1, y2: 1 })
  grad('screen', 'linearGradient', [[0, '#1e1750', 1], [1, '#0a0719', 1]], { x1: 0, y1: 0, x2: 0, y2: 1 })
  grad('metal', 'linearGradient', [[0, '#e9e4ff', 1], [1, '#8d84c2', 1]], { x1: 0, y1: 0, x2: 1, y2: 1 })
  el('rect', { width: W, height: H, fill: `url(#${id}-stage)` }, svg)
  return { svg, u: (name: string) => `url(#${id}-${name})` }
}

/** The phone in each scene: a glass body, a lit screen (with what it shows), a speaker slit and a glint. */
function phone(parent: Element, u: (n: string) => string, s = 1) {
  const g = el('g', {}, parent)
  const body = el('g', { transform: `scale(${s})` }, g)
  el('rect', { x: -15, y: -29, width: 30, height: 58, rx: 7.5, fill: u('glass'), stroke: HAZE, 'stroke-opacity': 0.55, 'stroke-width': 1.1 }, body)
  el('rect', { x: -12.4, y: -25.6, width: 24.8, height: 51.2, rx: 5, fill: u('screen') }, body)
  el('line', { x1: -3.5, y1: -23, x2: 3.5, y2: -23, stroke: HAZE, 'stroke-opacity': 0.55, 'stroke-width': 1.3, 'stroke-linecap': 'round' }, body)
  const screen = el('g', {}, body)
  el('path', { d: 'M-10.5 -4 L-2 -24', stroke: '#fff', 'stroke-opacity': 0.1, 'stroke-width': 3.2, 'stroke-linecap': 'round' }, body)
  return { g, screen }
}

/** A mouse pointer, in a colour. */
const CURSOR = 'M0 0 L0 17 L4.6 12.6 L8.4 20.2 L11.4 18.8 L7.7 11.3 L13.8 11.3 Z'
function cursor(parent: Element, color: string) {
  const g = el('g', {}, parent)
  el('path', { d: CURSOR, fill: color, stroke: DEEP, 'stroke-width': 1.3, 'stroke-linejoin': 'round' }, g)
  return g
}

// ---- Turn: the model turns as the phone does, one to one ----

type V3 = [number, number, number]
const BOX_FACES: [number[], V3][] = [
  [[0, 1, 3, 2], [-1, 0, 0]], [[4, 6, 7, 5], [1, 0, 0]], [[0, 4, 5, 1], [0, -1, 0]],
  [[2, 3, 7, 6], [0, 1, 0]], [[0, 2, 6, 4], [0, 0, -1]], [[1, 5, 7, 3], [0, 0, 1]],
]
const LIGHT: V3 = (() => { const v: V3 = [-0.45, -0.75, -0.5]; const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l] })()

/** Draw a box (half-sizes sx, sy, sz, `k` px per unit) turned by yaw then pitch; `paint` colours each face it shows. */
function drawBox(polys: SVGPolygonElement[], sx: number, sy: number, sz: number, k: number, yaw: number, pitch: number, paint: (face: number, light: number) => Attrs) {
  const cy = Math.cos(yaw), sy_ = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
  const rot = (x: number, y: number, z: number): V3 => {
    const x1 = x * cy + z * sy_, z1 = -x * sy_ + z * cy
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp]
  }
  const V = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => rot(x * sx, y * sy, z * sz))))
  const P = V.map(([x, y, z]) => { const f = k / (1 + z * 0.16); return [x * f, y * f, z] as V3 })
  const shown = BOX_FACES.map(([idx, n], i) => {
    const r = rot(...n)
    return { i, idx, z: idx.reduce((s, v) => s + P[v][2], 0) / 4, facing: r[2] < -0.02, light: Math.max(0, r[0] * LIGHT[0] + r[1] * LIGHT[1] + r[2] * LIGHT[2]) }
  }).filter((f) => f.facing).sort((a, b) => b.z - a.z)
  polys.forEach((p, j) => {
    const f = shown[j]
    if (!f) { p.setAttribute('points', ''); return }
    p.setAttribute('points', f.idx.map((v) => `${P[v][0].toFixed(1)},${P[v][1].toFixed(1)}`).join(' '))
    set(p, paint(f.i, f.light))
  })
}
const shade = (dark: [number, number, number], lit: [number, number, number], t: number) =>
  `rgb(${dark.map((d, i) => Math.round(d + (lit[i] - d) * t)).join(' ')})`

export function turnScene(): Scene {
  const { svg, u } = frame('A phone and a model that turn together, one to one')
  el('ellipse', { cx: 268, cy: 222, rx: 104, ry: 15, fill: u('floor') }, svg)
  el('ellipse', { cx: 92, cy: 222, rx: 46, ry: 9, fill: u('floor') }, svg)
  const LINK = [[122, 96], [158, 58], [196, 58], [222, 86]]
  el('path', { d: 'M122 96 C 158 58, 196 58, 222 86', fill: 'none', stroke: HAZE, 'stroke-opacity': 0.4, 'stroke-width': 1.3, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round' }, svg)
  const pulse = el('circle', { r: 2.8, fill: LIME }, svg)
  const ph = el('g', { transform: 'translate(92 132)' }, svg)
  const phoneFaces = Array.from({ length: 3 }, () => el('polygon', { 'stroke-linejoin': 'round', 'stroke-width': 1.1 }, ph))
  const model = el('g', { transform: 'translate(268 130)' }, svg)
  el('circle', { r: 88, fill: u('glow'), opacity: 0.55 }, model)
  const faces = Array.from({ length: 3 }, () => el('polygon', { 'stroke-linejoin': 'round', 'stroke-width': 1.6 }, model))
  let yaw = 0.7, pitch = 0.42, pt = 0
  return {
    svg,
    step(dt, p, t) {
      const ty = p ? ((p.x - W / 2) / (W / 2)) * 1.4 + 0.6 : 0.6 + 0.95 * Math.sin(t * 0.52) + 0.25 * Math.sin(t * 1.37)
      const tp = p ? ((p.y - H / 2) / (H / 2)) * 0.9 + 0.42 : 0.42 + 0.26 * Math.sin(t * 0.77 + 1)
      yaw = ease(yaw, ty, dt, p ? 8 : 5)
      pitch = ease(pitch, tp, dt, p ? 8 : 5)
      // The phone: a slab, screen lit in lime. The model: the ob.Pal box, obsidian with lime edges.
      drawBox(phoneFaces, 0.5, 1, 0.08, 34, yaw, pitch, (f, l) => f === 4
        ? { fill: shade([14, 11, 36], [40, 58, 22], 0.35 + 0.65 * l), stroke: LIME, 'stroke-opacity': 0.7 }
        : { fill: shade([30, 23, 72], [88, 74, 170], l), stroke: HAZE, 'stroke-opacity': 0.55 })
      drawBox(faces, 1, 1, 1, 50, yaw, pitch, (f, l) => f === 2
        ? { fill: shade([40, 58, 14], [176, 232, 48], 0.35 + 0.65 * l), stroke: CORE, 'stroke-opacity': 0.8 }
        : { fill: shade([20, 15, 48], [104, 88, 214], l), stroke: '#ffffff', 'stroke-opacity': 0.28 })
      pt = (pt + dt * 0.55) % 1
      // A pulse runs along the link, phone to model.
      const b = [(1 - pt) ** 3, 3 * (1 - pt) ** 2 * pt, 3 * (1 - pt) * pt ** 2, pt ** 3]
      set(pulse, { cx: b.reduce((s, w, i) => s + w * LINK[i][0], 0), cy: b.reduce((s, w, i) => s + w * LINK[i][1], 0), opacity: Math.sin(pt * Math.PI) })
      return true
    },
  }
}

// ---- Point: a Wii-style cursor, where the phone points ----

export function pointScene(): Scene {
  const { svg, u } = frame('A cursor that goes where the phone points, popping targets')
  el('rect', { x: 118, y: 24, width: 262, height: 176, rx: 16, fill: DEEP, 'fill-opacity': 0.55, stroke: HAZE, 'stroke-opacity': 0.28, 'stroke-width': 1.3 }, svg)
  el('ellipse', { cx: 249, cy: 200, rx: 120, ry: 12, fill: u('haze'), opacity: 0.5 }, svg)
  const targets = [0, 1, 2].map((i) => {
    const g = el('g', {}, svg)
    const halo = el('circle', { r: 20, fill: u('haze'), opacity: 0.6 }, g)
    const disc = el('circle', { r: 11, fill: 'none', stroke: [SKY, ROSE, AMBER][i], 'stroke-width': 2.4 }, g)
    const pip = el('circle', { r: 3.4, fill: [SKY, ROSE, AMBER][i] }, g)
    return { g, halo, disc, pip, x: 0, y: 0, pop: 0, n: i }
  })
  const spots = [[176, 70], [322, 62], [252, 150], [180, 158], [336, 150], [250, 66]]
  const place = (tg: (typeof targets)[number]) => { const [x, y] = spots[tg.n % spots.length]; tg.x = x; tg.y = y; tg.pop = 0; set(tg.g, { transform: `translate(${x} ${y})`, opacity: 1 }) }
  targets.forEach(place)
  const beam = el('line', { stroke: LIME, 'stroke-opacity': 0.35, 'stroke-width': 1.2, 'stroke-dasharray': '3 6', 'stroke-linecap': 'round' }, svg)
  const trail = Array.from({ length: 9 }, (_, i) => el('circle', { r: 5.2 - i * 0.5, fill: LIME, opacity: (0.42 - i * 0.045).toFixed(2) }, svg))
  const burst = el('circle', { r: 0, fill: 'none', stroke: LIME, 'stroke-width': 2, opacity: 0 }, svg)
  const ring = el('circle', { r: 13, fill: 'none', stroke: LIME, 'stroke-width': 2, opacity: 0.7 }, svg)
  const dot = el('circle', { r: 5.5, fill: CORE }, svg)
  const { g: ph, screen } = phone(svg, u)
  el('circle', { r: 6, fill: 'none', stroke: LIME, 'stroke-width': 1.6 }, screen)
  el('circle', { r: 1.8, fill: LIME }, screen)
  let x = 250, y = 110, bursting = 1, aim = 0, hold = 0
  const past: Point[] = []
  const hit = (px: number, py: number) => {
    set(burst, { cx: px, cy: py })
    bursting = 0
    const tg = targets.find((tt) => tt.pop === 0 && Math.hypot(tt.x - px, tt.y - py) < 18)
    if (tg) tg.pop = 0.001
  }
  return {
    svg,
    press(p) { hit(clamp(p.x, 128, 370), clamp(p.y, 34, 190)) },
    step(dt, p) {
      let tx: number, ty: number
      if (p) { tx = clamp(p.x, 128, 370); ty = clamp(p.y, 34, 190) }
      else {
        // Glide to the next target, settle, click, and on to the next.
        const tg = targets[aim % 3]
        tx = tg.x; ty = tg.y
        if (Math.hypot(tx - x, ty - y) < 3 && tg.pop === 0) { hold += dt; if (hold > 0.28) { hit(x, y); hold = 0; aim++ } }
      }
      x = ease(x, tx, dt, p ? 16 : 4.5)
      y = ease(y, ty, dt, p ? 16 : 4.5)
      past.unshift({ x, y })
      past.length = Math.min(past.length, 10)
      trail.forEach((c, i) => { const q = past[Math.min(i + 1, past.length - 1)]; set(c, { cx: q.x, cy: q.y }) })
      set(ring, { cx: x, cy: y }); set(dot, { cx: x, cy: y })
      const px = 60, py = 206
      set(ph, { transform: `translate(${px} ${py}) rotate(${(Math.atan2(y - py, x - px) * 180) / Math.PI + 90})` })
      set(beam, { x1: px, y1: py, x2: x, y2: y })
      if (bursting < 1) { bursting = Math.min(1, bursting + dt * 2.6); set(burst, { r: 6 + bursting * 26, opacity: 1 - bursting }) }
      for (const tg of targets) {
        if (tg.pop > 0) {
          tg.pop += dt * 2.4
          set(tg.g, { transform: `translate(${tg.x} ${tg.y}) scale(${1 + tg.pop * 0.9})`, opacity: Math.max(0, 1 - tg.pop) })
          if (tg.pop >= 1) { tg.n += 3; place(tg) }
        } else set(tg.halo, { r: 18 + Math.sin(performance.now() / 400 + tg.n) * 2 })
      }
      return true
    },
  }
}

// ---- Move: a robot arm picks and places, following the phone's hand ----

export function armScene(): Scene {
  const { svg, u } = frame('A robot arm that picks and places, following a phone moved through the air')
  el('ellipse', { cx: 210, cy: TABLE, rx: 170, ry: 14, fill: u('floor') }, svg)
  el('line', { x1: 24, y1: TABLE, x2: 376, y2: TABLE, stroke: HAZE, 'stroke-opacity': 0.22, 'stroke-width': 1.2 }, svg)
  // Two pads the block goes between.
  for (const pd of PADS) el('rect', { x: pd.x - 24, y: TABLE - 5, width: 48, height: 5, rx: 2.5, fill: HAZE, 'fill-opacity': 0.22 }, svg)
  const handPath = el('path', { fill: 'none', stroke: LIME, 'stroke-opacity': 0.3, 'stroke-width': 1.2, 'stroke-dasharray': '1.5 4.5', 'stroke-linecap': 'round' }, svg)
  const block = el('rect', { width: BLOCK, height: BLOCK, rx: 4, fill: LIME, stroke: DEEP, 'stroke-width': 1 }, svg)
  // The turntable on the table, with a mark on its rim where the arm faces: it crosses the middle as the base turns.
  el('rect', { x: PLATE.x, y: PLATE.y, width: PLATE.w, height: PLATE.h, rx: 5, fill: u('glass'), stroke: HAZE, 'stroke-opacity': 0.4 }, svg)
  const mark = el('line', { y1: PLATE.y + 5, y2: PLATE.y + 9, stroke: LIME, 'stroke-opacity': 0.8, 'stroke-width': 2, 'stroke-linecap': 'round' }, svg)
  const upper = el('line', { stroke: u('metal'), 'stroke-width': LINK_W[0], 'stroke-linecap': 'round' }, svg)
  const fore = el('line', { stroke: u('metal'), 'stroke-width': LINK_W[1], 'stroke-linecap': 'round' }, svg)
  const joints = JOINT_R.map((r) => el('circle', { r, fill: DEEP, stroke: LIME, 'stroke-width': RIM }, svg))
  const f1 = el('line', { stroke: '#e9e4ff', 'stroke-width': FINGER.w, 'stroke-linecap': 'round' }, svg)
  const f2 = el('line', { stroke: '#e9e4ff', 'stroke-width': FINGER.w, 'stroke-linecap': 'round' }, svg)
  const { g: ph, screen } = phone(svg, u, 0.9)
  el('path', { d: 'M-5 4 L-5 -4 Q-5 -7 -2 -7 L2 -7 Q5 -7 5 -4 L5 6', fill: 'none', stroke: LIME, 'stroke-width': 1.6, 'stroke-linecap': 'round' }, screen)
  // It plays a pick and place by itself (./arm.ts), or reaches for your pointer; either way, its elbow up and every
  // part above the table, turning its base to reach the other side.
  let arm: Arm = story(0).arm, grip = 0, held = false, wantGrip = 0, lean = 0
  let lastX = pose(arm).wrist.x
  let bxy = { x: PADS[0].x, y: TABLE - BLOCK / 2 }
  const hand: Point[] = []
  return {
    svg,
    press() { wantGrip = wantGrip ? 0 : 1 },
    step(dt, p, t) {
      let to: Arm, tg: number
      if (p) { to = aim(p, arm.turn); tg = wantGrip } else { ({ arm: to, grip: tg } = story(t)); wantGrip = 0 }
      arm = follow(arm, to, dt)
      grip = ease(grip, tg, dt, 14)
      const { shoulder: s, elbow: e, wrist: w, facing } = pose(arm)
      set(upper, { x1: s.x, y1: s.y, x2: e.x, y2: e.y })
      set(fore, { x1: e.x, y1: e.y, x2: w.x, y2: w.y })
      set(joints[0], { cx: s.x, cy: s.y }); set(joints[1], { cx: e.x, cy: e.y }); set(joints[2], { cx: w.x, cy: w.y })
      set(mark, { x1: s.x + facing * (PLATE.w / 2 - 7), x2: s.x + facing * (PLATE.w / 2 - 7) })
      // The gripper hangs straight down, its fingers closing on the block (or all the way, on nothing); edge on as the
      // base turns.
      const near = Math.abs(w.x - bxy.x) < 14 && Math.abs(w.y + HOLD - bxy.y) < 16
      const gap = Math.max(held || near ? BLOCK / 2 + FINGER.w / 2 : 3, 17 - grip * 14) * Math.abs(facing)
      set(f1, { x1: w.x - gap, y1: w.y + FINGER.from, x2: w.x - gap, y2: w.y + FINGER.to })
      set(f2, { x1: w.x + gap, y1: w.y + FINGER.from, x2: w.x + gap, y2: w.y + FINGER.to })
      if (!held && grip > 0.8 && near) held = true
      if (held && grip < 0.4) held = false
      if (held) bxy = { x: w.x, y: w.y + HOLD }
      else bxy.y = Math.min(TABLE - BLOCK / 2, bxy.y + dt * 260)
      set(block, { x: bxy.x - BLOCK / 2, y: bxy.y - BLOCK / 2 })
      // The phone, up in the air, making the same moves at a smaller scale and leaning the way it goes: the arm
      // follows the hand.
      const hx = 64 + (w.x - s.x) * 0.3, hy = 74 + (w.y - 150) * 0.3
      lean = ease(lean, clamp(((w.x - lastX) / Math.max(dt, 1e-3)) * 0.06, -16, 16), dt, 6)
      lastX = w.x
      hand.unshift({ x: hx, y: hy + 30 })
      hand.length = Math.min(hand.length, 36)
      set(ph, { transform: `translate(${hx} ${hy}) rotate(${lean})` })
      handPath.setAttribute('d', hand.length > 1 ? `M${hand.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' L')}` : '')
      return true
    },
  }
}

// ---- Play: four phones, four players ----

export function playScene(): Scene {
  const { svg, u } = frame('Four players, each on their own phone, in a rally')
  const L = 70, R = 330, T = 34, B = 226
  el('rect', { x: L, y: T, width: R - L, height: B - T, rx: 22, fill: DEEP, 'fill-opacity': 0.5, stroke: HAZE, 'stroke-opacity': 0.26, 'stroke-width': 1.4 }, svg)
  el('circle', { cx: W / 2, cy: H / 2, r: 30, fill: 'none', stroke: HAZE, 'stroke-opacity': 0.16, 'stroke-width': 1.2 }, svg)
  el('ellipse', { cx: W / 2, cy: H / 2, rx: 120, ry: 80, fill: u('haze'), opacity: 0.25 }, svg)
  const colors = [LIME, SKY, ROSE, AMBER]
  // Each player guards a side: bottom (you), top, left, right. Playing, yours goes anywhere on the field.
  const home = [{ x: W / 2, y: B - 22 }, { x: W / 2, y: T + 22 }, { x: L + 22, y: H / 2 }, { x: R - 22, y: H / 2 }]
  const pucks = colors.map((c, i) => ({ ...home[i], vx: 0, vy: 0, rot: 0, c: el('circle', { r: 12, fill: c, stroke: DEEP, 'stroke-width': 1.5 }, svg), i }))
  const phones = colors.map((c, i) => {
    const { g, screen } = phone(svg, u, 0.5)
    el('circle', { r: 6, fill: c, opacity: 0.9 }, screen)
    const at = [[W / 2 + 150, H - 28], [W / 2 - 150, 30], [30, H / 2 + 72], [W - 30, H / 2 - 72]][i]
    return { g, x: at[0], y: at[1] }
  })
  const glow = el('circle', { r: 16, fill: u('glow') }, svg)
  const ball = el('circle', { r: 6.5, fill: CORE }, svg)
  let x = W / 2, y = H / 2, vx = 120, vy = 85
  return {
    svg,
    step(dt, p) {
      x += vx * dt; y += vy * dt
      if (x < L + 8) { x = L + 8; vx = Math.abs(vx) } else if (x > R - 8) { x = R - 8; vx = -Math.abs(vx) }
      if (y < T + 8) { y = T + 8; vy = Math.abs(vy) } else if (y > B - 8) { y = B - 8; vy = -Math.abs(vy) }
      for (const pk of pucks) {
        // Guard your side: follow the ball along it, lean in when it's close. Your own puck, played, goes where you
        // point, anywhere on the field.
        let gx: number, gy: number
        if (pk.i === 0 && p) { gx = clamp(p.x, L + 14, R - 14); gy = clamp(p.y, T + 14, B - 14) }
        else if (pk.i < 2) { gx = clamp(x, L + 30, R - 30); gy = home[pk.i].y + (Math.abs(y - home[pk.i].y) < 70 ? (y - home[pk.i].y) * 0.4 : 0) }
        else { gy = clamp(y, T + 30, B - 30); gx = home[pk.i].x + (Math.abs(x - home[pk.i].x) < 70 ? (x - home[pk.i].x) * 0.4 : 0) }
        const ox = pk.x, oy = pk.y
        pk.x = ease(pk.x, gx, dt, pk.i === 0 && p ? 14 : 5)
        pk.y = ease(pk.y, gy, dt, pk.i === 0 && p ? 14 : 5)
        // Pucks don't pass through each other: yours, going anywhere, nudges the others aside.
        for (const o of pucks) {
          if (o === pk) continue
          const dx = pk.x - o.x, dy = pk.y - o.y, d = Math.hypot(dx, dy)
          if (d >= 24 || d < 1e-6) continue
          const push = (24 - d) / 2
          pk.x = clamp(pk.x + (dx / d) * push, L + 14, R - 14); pk.y = clamp(pk.y + (dy / d) * push, T + 14, B - 14)
          o.x = clamp(o.x - (dx / d) * push, L + 14, R - 14); o.y = clamp(o.y - (dy / d) * push, T + 14, B - 14)
        }
        pk.vx = (pk.x - ox) / Math.max(dt, 1e-3); pk.vy = (pk.y - oy) / Math.max(dt, 1e-3)
        const dx = x - pk.x, dy = y - pk.y, d = Math.hypot(dx, dy)
        if (d < 18.5 && d > 0) {
          // Bounce off the puck, taking some of its speed.
          const nx = dx / d, ny = dy / d
          const dot = vx * nx + vy * ny
          if (dot < 0) { vx -= 2 * dot * nx; vy -= 2 * dot * ny }
          vx += pk.vx * 0.25; vy += pk.vy * 0.25
          x = pk.x + nx * 18.6; y = pk.y + ny * 18.6
        }
        set(pk.c, { cx: pk.x, cy: pk.y })
        const ph = phones[pk.i]
        // Each phone leans with its puck, smoothly: a player's hand, not every bump.
        pk.rot = ease(pk.rot, clamp(pk.vx * 0.05, -24, 24), dt, 4)
        set(ph.g, { transform: `translate(${ph.x} ${ph.y}) rotate(${pk.rot})` })
      }
      // Keep the rally lively but never wild.
      const sp = Math.hypot(vx, vy) || 1, want = clamp(sp, 130, 230)
      vx *= want / sp; vy *= want / sp
      set(ball, { cx: x, cy: y }); set(glow, { cx: x, cy: y })
      return true
    },
  }
}

// ---- Together: one invite, and everyone holds a different part ----

export function togetherScene(): Scene {
  const { svg, u } = frame('Four people, each moving a different part of one model')
  el('ellipse', { cx: W / 2, cy: 136, rx: 150, ry: 96, fill: u('haze'), opacity: 0.3 }, svg)
  const rest = [[200, 68], [284, 110], [270, 196], [130, 196], [116, 110], [200, 138]]
  const nodes = rest.map(([x, y]) => ({ x, y, rx: x, ry: y, by: -1 }))
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [5, 0], [5, 1], [5, 2], [5, 3], [5, 4]]
  const lines = edges.map(() => el('line', { stroke: HAZE, 'stroke-opacity': 0.35, 'stroke-width': 1.6 }, svg))
  const halos = nodes.map(() => el('circle', { r: 22, fill: u('glow'), opacity: 0 }, svg))
  const discs = nodes.map(() => el('circle', { r: 11, fill: DEEP, stroke: HAZE, 'stroke-opacity': 0.6, 'stroke-width': 2 }, svg))
  // Three people already in, each holding a part; you're the lime one.
  const people = [{ c: SKY, name: 'Ana', node: 1 }, { c: ROSE, name: 'Kai', node: 3 }, { c: AMBER, name: 'Mo', node: 4 }].map((pp, i) => {
    const g = cursor(svg, pp.c)
    const tag = el('g', {}, g)
    el('rect', { x: 14, y: 16, width: pp.name.length * 7 + 12, height: 17, rx: 8.5, fill: pp.c }, tag)
    const tx = el('text', { x: 20, y: 28.5, fill: DEEP, style: 'font: 700 10.5px var(--font, sans-serif)' }, tag)
    tx.textContent = pp.name
    nodes[pp.node].by = i
    return { ...pp, g, i }
  })
  const colorOf = (by: number) => (by === 3 ? LIME : people[by]?.c ?? HAZE)
  const me = cursor(svg, LIME)
  let mx = 330, my = 60, mine = -1
  const free = () => nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.by < 0 || n.by === 3)
  return {
    svg,
    step(dt, p, t) {
      // Everyone else moves their part in a slow loop of their own.
      people.forEach((pp, k) => {
        const n = nodes[pp.node]
        n.x = ease(n.x, n.rx + Math.sin(t * (0.8 + k * 0.23) + k * 2) * 16, dt, 4)
        n.y = ease(n.y, n.ry + Math.cos(t * (0.9 + k * 0.17) + k) * 12, dt, 4)
        set(pp.g, { transform: `translate(${n.x + 4} ${n.y + 4})` })
      })
      // You: follow the pointer, or wander from free part to free part, taking each for a turn.
      let tx: number, ty: number
      if (p) { tx = p.x; ty = p.y }
      else {
        const f = free()
        const target = f[Math.floor(t / 3.2) % f.length]
        const n = target.n
        const k = (t % 3.2) / 3.2
        tx = n.rx + (k > 0.3 && k < 0.85 ? Math.sin(k * 9) * 18 : 0)
        ty = n.ry + (k > 0.3 && k < 0.85 ? Math.cos(k * 7) * 14 : 0)
      }
      mx = ease(mx, tx, dt, p ? 14 : 5); my = ease(my, ty, dt, p ? 14 : 5)
      // Take the free part you're on; let it go (it springs home) when you move off.
      const over = nodes.findIndex((n, i) => (n.by < 0 || n.by === 3) && Math.hypot(n.x - mx, n.y - my) < (i === mine ? 30 : 16))
      if (over !== mine) { if (mine >= 0) nodes[mine].by = -1; mine = over; if (mine >= 0) nodes[mine].by = 3 }
      nodes.forEach((n, i) => {
        if (i === mine) { n.x = ease(n.x, mx, dt, 16); n.y = ease(n.y, my, dt, 16) }
        else if (n.by < 0) { n.x = ease(n.x, n.rx, dt, 5); n.y = ease(n.y, n.ry, dt, 5) }
        const c = n.by >= 0 ? colorOf(n.by) : HAZE
        set(discs[i], { cx: n.x, cy: n.y, stroke: c, 'stroke-opacity': n.by >= 0 ? 1 : 0.55, fill: n.by >= 0 ? c : DEEP, 'fill-opacity': n.by >= 0 ? 0.28 : 1 })
        set(halos[i], { cx: n.x, cy: n.y, opacity: i === mine ? 0.9 : 0 })
      })
      edges.forEach(([a, b], i) => set(lines[i], { x1: nodes[a].x, y1: nodes[a].y, x2: nodes[b].x, y2: nodes[b].y }))
      set(me, { transform: `translate(${mx - 1} ${my - 1})` })
      return true
    },
  }
}

// ---- Your computer: the phone is a trackpad and keys ----

export function desktopScene(): Scene {
  const { svg, u } = frame('A phone used as a trackpad and keys for a computer')
  // The computer: a screen with a window and a little game in it.
  el('rect', { x: 150, y: 28, width: 226, height: 148, rx: 12, fill: DEEP, 'fill-opacity': 0.7, stroke: HAZE, 'stroke-opacity': 0.3, 'stroke-width': 1.3 }, svg)
  el('path', { d: 'M226 176 L300 176 L310 196 L216 196 Z', fill: u('glass'), stroke: HAZE, 'stroke-opacity': 0.25 }, svg)
  el('ellipse', { cx: 263, cy: 204, rx: 110, ry: 9, fill: u('floor') }, svg)
  const win = el('g', {}, svg)
  el('rect', { x: 168, y: 44, width: 190, height: 116, rx: 9, fill: '#1a1440', stroke: HAZE, 'stroke-opacity': 0.25 }, win)
  for (const [i, c] of [ROSE, AMBER, LIME].entries()) el('circle', { cx: 180 + i * 10, cy: 54, r: 3, fill: c, opacity: 0.8 }, win)
  el('line', { x1: 180, y1: 140, x2: 346, y2: 140, stroke: HAZE, 'stroke-opacity': 0.3, 'stroke-width': 1.5 }, win)
  const hero = el('rect', { width: 14, height: 14, rx: 3.5, fill: LIME }, win)
  const btn = el('rect', { x: 300, y: 66, width: 44, height: 18, rx: 9, fill: HAZE, 'fill-opacity': 0.18, stroke: HAZE, 'stroke-opacity': 0.4 }, win)
  const ripple = el('circle', { r: 0, fill: 'none', stroke: LIME, 'stroke-width': 1.6, opacity: 0 }, svg)
  const mouse = cursor(svg, INK)
  // The phone: a trackpad above, W A S D below.
  const { g: ph, screen } = phone(svg, u, 2)
  set(ph, { transform: 'translate(78 130)' })
  el('rect', { x: -10, y: -21, width: 20, height: 22, rx: 3, fill: HAZE, 'fill-opacity': 0.07, stroke: HAZE, 'stroke-opacity': 0.25, 'stroke-width': 0.5 }, screen)
  const finger = el('circle', { r: 2.4, fill: LIME }, screen)
  const fingerHalo = el('circle', { r: 4.2, fill: LIME, opacity: 0.25 }, screen)
  const keys: Record<string, SVGRectElement> = {}
  for (const [k, x, y] of [['W', 0, 7], ['A', -6.5, 14.5], ['S', 0, 14.5], ['D', 6.5, 14.5]] as const) {
    keys[k] = el('rect', { x: x - 2.9, y: y - 2.9, width: 5.8, height: 5.8, rx: 1.4, fill: HAZE, 'fill-opacity': 0.12, stroke: HAZE, 'stroke-opacity': 0.4, 'stroke-width': 0.4 }, screen)
    const tx = el('text', { x, y: y + 1.5, fill: DIM, 'text-anchor': 'middle', style: 'font: 700 3.8px var(--font, sans-serif)' }, screen)
    tx.textContent = k
  }
  let cx = 250, cy = 100, hx = 190, rip = 1, click = 0
  return {
    svg,
    press() { rip = 0; set(ripple, { cx, cy }) },
    step(dt, p, t) {
      let tx: number, ty: number, dir = ''
      if (p) { tx = clamp(p.x, 170, 356); ty = clamp(p.y, 46, 158) }
      else {
        // A little session: glide to the button and click it, then play with the keys.
        const k = t % 8
        if (k < 3) { const s = smooth(k / 2.2); tx = 210 + (322 - 210) * s; ty = 120 + (75 - 120) * s }
        else { tx = 322; ty = 75 }
        if (k > 2.6 && k - dt <= 2.6) { rip = 0; set(ripple, { cx: 322, cy: 75 }); click = 1 }
        if (k > 3.5 && k < 7.5) dir = Math.sin((k - 3.5) * 1.6) > 0 ? 'D' : 'A'
      }
      const ox = cx, oy = cy
      cx = ease(cx, tx, dt, p ? 16 : 6); cy = ease(cy, ty, dt, p ? 16 : 6)
      set(mouse, { transform: `translate(${cx} ${cy})` })
      // The finger on the trackpad moves as the pointer does.
      const fx = ((cx - 170) / 186) * 16 - 8, fy = ((cy - 46) / 112) * 17 - 19
      set(finger, { cx: fx, cy: fy }); set(fingerHalo, { cx: fx, cy: fy })
      if (p && !dir) { const vx = cx - ox, vy = cy - oy; if (Math.abs(vx) > 0.6 || Math.abs(vy) > 0.6) dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'D' : 'A') : (vy > 0 ? 'S' : 'W') }
      for (const [k, r] of Object.entries(keys)) set(r, { 'fill-opacity': k === dir ? 0.9 : 0.12, fill: k === dir ? LIME : HAZE })
      if (dir === 'D') hx = Math.min(338, hx + dt * 60)
      if (dir === 'A') hx = Math.max(182, hx - dt * 60)
      set(hero, { x: hx - 7, y: 126 })
      if (rip < 1) { rip = Math.min(1, rip + dt * 2.2); set(ripple, { r: 4 + rip * 20, opacity: 1 - rip }) }
      click = Math.max(0, click - dt * 1.5)
      set(btn, { 'fill-opacity': 0.18 + click * 0.6, fill: click > 0.05 ? LIME : HAZE })
      return true
    },
  }
}

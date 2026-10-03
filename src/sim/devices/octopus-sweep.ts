/**
 * The octopus's soft parts as geometry swept along its arm rods (three.js): every arm as one tapered tube through a
 * Catmull-Rom curve of the rod's particles, the cups as one instanced mesh and the proximal web between neighbouring
 * arms. The oral side is carried along each arm by parallel transport from its root, so it never flips. A segment's
 * section narrows as it elongates and thickens as it shortens (constant volume). Each frame re-poses the same
 * buffers in world coordinates; nothing is allocated per frame.
 */
import * as THREE from 'three'
import { type ContinuumProfile } from '../continuum/profile'
import { ROD_SEGMENTS, surfaceRadius } from '../continuum/rod'
import { ARM_POINTS, OCTOPUS_ARMS, OCTOPUS_CUPS, armRoot, pointAt, type Octopus } from './octopus-types'

/** Rings along each arm, points around each ring, and the rounded tip's extra rings. */
const RINGS = 48, AROUND = 16, CAP = 3
/** Where the first ring starts, as a fraction: just inside the collar so the root never shows an open end. */
const ROOT = -0.04

/**
 * The arm's cross-section: a slightly square superellipse, flatter on the oral (cup) side, with two low dorsal ridges
 * for the tendon sheaths. Unit radius; offsets and 2D normals per point around the ring, +y dorsal.
 */
function section() {
  const offsets: [number, number][] = [], normals: [number, number][] = []
  const at = (theta: number): [number, number] => {
    const c = Math.cos(theta), s = Math.sin(theta), p = 2.4
    let x = Math.sign(c) * Math.abs(c) ** (2 / p), y = Math.sign(s) * Math.abs(s) ** (2 / p)
    if (y < 0) y *= 0.8
    const ridge = 1 + 0.06 * (Math.exp(-(((theta - Math.PI / 2 - 0.66) / 0.13) ** 2)) + Math.exp(-(((theta - Math.PI / 2 + 0.66) / 0.13) ** 2)))
    return [x * ridge, y * ridge]
  }
  for (let i = 0; i < AROUND; i++) {
    const theta = (i / AROUND) * Math.PI * 2, [x, y] = at(theta), [x0, y0] = at(theta - 1e-3), [x1, y1] = at(theta + 1e-3)
    const tx = x1 - x0, ty = y1 - y0, length = Math.hypot(tx, ty) || 1
    offsets.push([x, y])
    normals.push([ty / length, -tx / length])
  }
  return { offsets, normals }
}

/** Ring positions along the arm, denser toward the tip where it curls tightest. */
const fractions = Array.from({ length: RINGS }, (_, k) => ROOT + (1 - ROOT) * (1 - (1 - k / (RINGS - 1)) ** 1.25))

/** The Cove skin: graphite above, darkest at the root and lifting toward the tip, with a paler oral side round the cups. */
const SKIN = { root: '#1b1f23', tip: '#353b40', oral: '#626b72' }

const catmull = (a: number, b: number, c: number, d: number, t: number) =>
  0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t)

export class ArmSweep {
  readonly geometry = new THREE.BufferGeometry()
  /** Per arm and ring: centre, tangent, oral-side normal (as +y dorsal in the ring frame), radius. */
  readonly centres: Float32Array
  readonly tangents: Float32Array
  readonly dorsals: Float32Array
  readonly radii: Float32Array
  private readonly cross = section()
  private readonly positions: Float32Array
  private readonly normals: Float32Array
  private readonly perArm: number
  private readonly root = new THREE.Vector3()
  private readonly out = new THREE.Vector3()
  private readonly up = new THREE.Vector3()
  private readonly t = new THREE.Vector3()
  private readonly n = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly v = new THREE.Vector3()

  constructor(readonly profile: ContinuumProfile) {
    const rings = RINGS + CAP
    this.perArm = rings * AROUND + 1
    const count = this.perArm * profile.arms.length
    this.positions = new Float32Array(count * 3)
    this.normals = new Float32Array(count * 3)
    this.centres = new Float32Array(profile.arms.length * RINGS * 3)
    this.tangents = new Float32Array(profile.arms.length * RINGS * 3)
    this.dorsals = new Float32Array(profile.arms.length * RINGS * 3)
    this.radii = new Float32Array(profile.arms.length * RINGS)
    const index: number[] = []
    for (let a = 0; a < profile.arms.length; a++) {
      const base = a * this.perArm
      for (let r = 0; r < rings - 1; r++) for (let i = 0; i < AROUND; i++) {
        // Counter-clockwise seen from outside: round the ring first, then along the arm.
        const j = (i + 1) % AROUND, p = base + r * AROUND
        index.push(p + i, p + j, p + AROUND + i, p + j, p + AROUND + j, p + AROUND + i)
      }
      const apex = base + rings * AROUND, last = base + (rings - 1) * AROUND
      for (let i = 0; i < AROUND; i++) index.push(last + i, last + ((i + 1) % AROUND), apex)
    }
    this.geometry.setIndex(index)
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage))
    const colors = new Float32Array(count * 3), root = new THREE.Color(SKIN.root), tip = new THREE.Color(SKIN.tip), oral = new THREE.Color(SKIN.oral), c = new THREE.Color()
    for (let a = 0; a < profile.arms.length; a++) for (let r = 0; r <= rings; r++) for (let i = 0; i < (r === rings ? 1 : AROUND); i++) {
      const f = Math.max(0, fractions[Math.min(r, RINGS - 1)]), underside = r === rings ? 0 : Math.max(0, -this.cross.normals[i][1])
      c.copy(root).lerp(tip, f ** 0.8).lerp(oral, 0.75 * underside ** 1.5)
      c.toArray(colors, (a * this.perArm + r * AROUND + i) * 3)
    }
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  }

  /** Re-pose every arm from the state's rod particles (world coordinates). */
  update(u: Pick<Octopus, 'arms' | 'x' | 'y' | 'z' | 'h'>) {
    const P = u.arms
    for (let a = 0; a < this.profile.arms.length; a++) {
      const arm = this.profile.arms[a], rest = arm.sections.reduce((s, x) => s + x.length, 0) / ROD_SEGMENTS
      armRoot(u, a, this.root, this.out, this.up)
      const coord = (i: number, axis: number) => {
        if (i < 0) return P[pointAt(a, 0) + axis] - (this.out.getComponent(axis) * rest) * -i
        if (i > ROD_SEGMENTS) return 2 * P[pointAt(a, ROD_SEGMENTS) + axis] - P[pointAt(a, ROD_SEGMENTS - 1) + axis]
        return P[pointAt(a, i) + axis]
      }
      // Ring centres along the curve; frames by parallel transport from the root's dorsal axis.
      this.n.copy(this.up)
      for (let r = 0; r < RINGS; r++) {
        const x = fractions[r] * ROD_SEGMENTS, i = Math.floor(x), local = x - i, k = (a * RINGS + r) * 3
        for (let axis = 0; axis < 3; axis++)
          this.centres[k + axis] = catmull(coord(i - 1, axis), coord(i, axis), coord(i + 1, axis), coord(i + 2, axis), local)
        const span = Math.hypot(coord(Math.min(i + 1, ROD_SEGMENTS), 0) - coord(i, 0), coord(Math.min(i + 1, ROD_SEGMENTS), 1) - coord(i, 1), coord(Math.min(i + 1, ROD_SEGMENTS), 2) - coord(i, 2))
        this.radii[a * RINGS + r] = surfaceRadius(arm, Math.max(0, fractions[r]), i < ROD_SEGMENTS && i >= 0 ? span / rest : 1)
      }
      for (let r = 0; r < RINGS; r++) {
        const k = (a * RINGS + r) * 3, prev = Math.max(0, r - 1) * 3 + a * RINGS * 3, next = Math.min(RINGS - 1, r + 1) * 3 + a * RINGS * 3
        this.t.set(this.centres[next] - this.centres[prev], this.centres[next + 1] - this.centres[prev + 1], this.centres[next + 2] - this.centres[prev + 2]).normalize()
        this.n.addScaledVector(this.t, -this.t.dot(this.n))
        if (this.n.lengthSq() < 1e-10) this.n.set(0, 1, 0).addScaledVector(this.t, -this.t.y)
        this.n.normalize()
        this.t.toArray(this.tangents, k)
        this.n.toArray(this.dorsals, k)
      }
      const base = a * this.perArm, last = (a * RINGS + RINGS - 1) * 3, tipRadius = surfaceRadius(arm, 1)
      for (let r = 0; r < RINGS + CAP; r++) {
        const ring = Math.min(r, RINGS - 1), k = (a * RINGS + ring) * 3
        let radius = this.radii[a * RINGS + ring], extend = 0, slope = 0
        if (r >= RINGS) {
          const c = (r - RINGS + 1) / (CAP + 1)
          extend = tipRadius * c * 1.1
          radius = tipRadius * Math.sqrt(Math.max(0, 1 - c * c))
          slope = -c * 2
        } else if (ring > 0) slope = (this.radii[a * RINGS + ring] - this.radii[a * RINGS + ring - 1]) / (rest * ROD_SEGMENTS / RINGS)
        this.t.fromArray(this.tangents, k)
        this.n.fromArray(this.dorsals, k)
        // Across is dorsal × tangent, so (across, dorsal, tangent) is right-handed and the faces point outward.
        this.b.crossVectors(this.n, this.t)
        const cx = this.centres[k] + this.t.x * extend, cy = this.centres[k + 1] + this.t.y * extend, cz = this.centres[k + 2] + this.t.z * extend
        for (let i = 0; i < AROUND; i++) {
          // The ring frame: +x across (binormal), +y dorsal.
          const [ox, oy] = this.cross.offsets[i], [nx, ny] = this.cross.normals[i], v = (base + r * AROUND + i) * 3
          this.positions[v] = cx + (this.b.x * ox + this.n.x * oy) * radius
          this.positions[v + 1] = cy + (this.b.y * ox + this.n.y * oy) * radius
          this.positions[v + 2] = cz + (this.b.z * ox + this.n.z * oy) * radius
          this.v.copy(this.b).multiplyScalar(nx).addScaledVector(this.n, ny).addScaledVector(this.t, -slope).normalize()
          this.normals[v] = this.v.x; this.normals[v + 1] = this.v.y; this.normals[v + 2] = this.v.z
        }
      }
      const v = (base + (RINGS + CAP) * AROUND) * 3
      this.t.fromArray(this.tangents, last)
      this.positions[v] = this.centres[last] + this.t.x * tipRadius * 1.1
      this.positions[v + 1] = this.centres[last + 1] + this.t.y * tipRadius * 1.1
      this.positions[v + 2] = this.centres[last + 2] + this.t.z * tipRadius * 1.1
      this.normals[v] = this.t.x; this.normals[v + 1] = this.t.y; this.normals[v + 2] = this.t.z
    }
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.normal.needsUpdate = true
  }

  /** The ring nearest a fraction along an arm, for cups and the web. */
  ring(fraction: number) {
    let best = 0
    for (let r = 1; r < RINGS; r++) if (Math.abs(fractions[r] - fraction) < Math.abs(fractions[best] - fraction)) best = r
    return best
  }
}

/** A cup: a raised rim and a dark, shallow bowl, unit radius, its axis +y. Vertex colours separate rim from bowl. */
function cupGeometry() {
  const profile = [[0, -0.05], [0.5, 0], [0.76, 0.24], [0.96, 0.3], [1.04, 0.16], [0.95, -0.1], [0.7, -0.16]]
  const geometry = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 10)
  const p = geometry.attributes.position, colors = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getZ(i)), rim = r > 0.7 ? 1 : 0.12
    colors.set([rim, rim, rim], i * 3)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** All cups of one octopus as instances on the arms' oral side; sealed cups flatten and darken. */
export class CupSweep {
  readonly mesh: THREE.InstancedMesh
  private readonly rings: number[][]
  private readonly matrix = new THREE.Matrix4()
  private readonly basis = new THREE.Matrix4()
  private readonly orientation = new THREE.Quaternion()
  private readonly tilt = new THREE.Quaternion()
  private readonly offset = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()
  private readonly color = new THREE.Color()
  private readonly t = new THREE.Vector3()
  private readonly n = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly down = new THREE.Vector3()
  private readonly offsetAxis = new THREE.Vector3()

  constructor(readonly profile: ContinuumProfile, material: THREE.Material, sweep: ArmSweep) {
    const count = profile.arms.length * OCTOPUS_CUPS
    this.mesh = new THREE.InstancedMesh(cupGeometry(), material, count)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3)
    this.mesh.frustumCulled = false
    this.rings = profile.arms.map((arm) => arm.cups.map((cup) => sweep.ring(cup.fraction)))
  }

  update(u: Pick<Octopus, 'cups'>, sweep: ArmSweep) {
    let n = 0
    for (let a = 0; a < OCTOPUS_ARMS; a++) {
      const arm = this.profile.arms[a]
      for (let c = 0; c < OCTOPUS_CUPS; c++) {
        const cup = arm.cups[c], seal = u.cups[a * OCTOPUS_CUPS + c] ?? 0, ring = this.rings[a][c], k = (a * sweep.radii.length / OCTOPUS_ARMS + ring) * 3
        const radius = sweep.radii[k / 3]
        this.t.fromArray(sweep.tangents, k)
        this.n.fromArray(sweep.dorsals, k)
        this.b.crossVectors(this.n, this.t)
        // Two rows either side of the oral midline, each cup's axis pointing out of the oral side, leaning outward.
        this.offset.fromArray(sweep.centres, k).addScaledVector(this.b, cup.row * radius * 0.42).addScaledVector(this.n, -radius * 0.82)
        this.down.copy(this.n).negate()
        // (down × tangent, down, tangent) is a right-handed basis with the cup's axis out of the oral side.
        this.basis.makeBasis(this.offsetAxis.crossVectors(this.down, this.t), this.down, this.t)
        this.orientation.setFromRotationMatrix(this.basis)
        this.tilt.setFromAxisAngle(this.t.set(0, 0, 1), -cup.row * 0.38)
        this.orientation.multiply(this.tilt)
        const size = cup.radius * (1 + 0.12 * seal)
        this.scale.set(size, size * (1 - 0.45 * seal), size)
        this.matrix.compose(this.offset, this.orientation, this.scale)
        this.mesh.setMatrixAt(n, this.matrix)
        this.color.setScalar(1 - 0.35 * seal)
        this.mesh.setColorAt(n, this.color)
        n++
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

/** Across each gap between neighbouring arms, and how far along the arms the web reaches at its edges and middle. */
const ACROSS = 7, ALONG = 6, WEB_EDGE = 0.2, WEB_MIDDLE = 0.08

/** The soft proximal web between neighbouring arms: a membrane hung between their flanks, sagging toward the mouth. */
export class WebSweep {
  readonly geometry = new THREE.BufferGeometry()
  private readonly pairs: [number, number][]
  private readonly positions: Float32Array
  private readonly p = new THREE.Vector3()
  private readonly q = new THREE.Vector3()
  private readonly side = new THREE.Vector3()

  constructor(readonly profile: ContinuumProfile) {
    const ring = profile.arms.map((arm, i) => ({ i, angle: Math.atan2(arm.position.x, arm.position.z) })).sort((x, y) => x.angle - y.angle)
    this.pairs = ring.map((arm, k) => [arm.i, ring[(k + 1) % ring.length].i])
    const per = ACROSS * ALONG
    this.positions = new Float32Array(this.pairs.length * per * 3)
    const index: number[] = []
    for (let w = 0; w < this.pairs.length; w++) for (let s = 0; s < ALONG - 1; s++) for (let t = 0; t < ACROSS - 1; t++) {
      const v = w * per + s * ACROSS + t
      index.push(v, v + 1, v + ACROSS, v + 1, v + ACROSS + 1, v + ACROSS)
    }
    this.geometry.setIndex(index)
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  }

  update(sweep: ArmSweep) {
    const per = ACROSS * ALONG, rings = sweep.radii.length / OCTOPUS_ARMS
    this.pairs.forEach(([left, right], w) => {
      for (let t = 0; t < ACROSS; t++) {
        const across = t / (ACROSS - 1), reach = WEB_EDGE + (WEB_MIDDLE - WEB_EDGE) * Math.sin(Math.PI * across)
        for (let s = 0; s < ALONG; s++) {
          const ring = sweep.ring((s / (ALONG - 1)) * reach)
          const a = (left * rings + ring) * 3, b = (right * rings + ring) * 3
          this.p.fromArray(sweep.centres, a)
          this.q.fromArray(sweep.centres, b)
          this.side.subVectors(this.q, this.p)
          const gap = this.side.length() || 1
          this.side.multiplyScalar(1 / gap)
          this.p.addScaledVector(this.side, sweep.radii[a / 3] * 0.85)
          this.q.addScaledVector(this.side, -sweep.radii[b / 3] * 0.85)
          this.p.lerp(this.q, across)
          this.p.y -= 0.025 * Math.sin(Math.PI * across) * (1 - s / (ALONG - 1))
          const v = (w * per + s * ACROSS + t) * 3
          this.positions[v] = this.p.x; this.positions[v + 1] = this.p.y; this.positions[v + 2] = this.p.z
        }
      }
    })
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.computeVertexNormals()
  }
}

export { ARM_POINTS }

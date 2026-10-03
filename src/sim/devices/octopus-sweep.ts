/**
 * The octopus's soft parts as geometry swept along the continuum model's own frames (three.js): every arm as one
 * tapered tube, the cups as one instanced mesh and the proximal web between neighbouring arms. Each frame re-poses the
 * same buffers from the section shapes; nothing is allocated per frame. Surfaces follow the exact PCC frames, so what
 * is drawn is what the logic placed, with no interpolated hinge poses.
 */
import * as THREE from 'three'
import { ArmKinematics, frame } from '../continuum/kinematics'
import { straight, type ContinuumProfile, type Shape } from '../continuum/profile'
import { surfaceRadius } from '../continuum/solve'
import { armShapes, OCTOPUS_ARMS, OCTOPUS_CUPS, type Octopus } from './octopus-types'

/** Rings along each arm, points around each ring, and the rounded tip's extra rings. */
const RINGS = 44, AROUND = 16, CAP = 3
/** Where the first ring starts, as a fraction: just inside the collar so the root never shows an open end. */
const ROOT = -0.04

/**
 * The arm's cross-section: a slightly square superellipse, flatter on the oral (cup) side, with two low dorsal ridges
 * for the tendon sheaths. Unit radius; offsets and 2D normals per point around the ring.
 */
function section() {
  const offsets: [number, number][] = [], normals: [number, number][] = []
  const at = (theta: number): [number, number] => {
    const c = Math.cos(theta), s = Math.sin(theta), p = 2.4
    let x = Math.sign(c) * Math.abs(c) ** (2 / p), y = Math.sign(s) * Math.abs(s) ** (2 / p)
    if (y < 0) y *= 0.8
    // Two sheaths, 38 degrees either side of the dorsal line.
    const ridge = 1 + 0.06 * (Math.exp(-(((theta - Math.PI / 2 - 0.66) / 0.13) ** 2)) + Math.exp(-(((theta - Math.PI / 2 + 0.66) / 0.13) ** 2)))
    x *= ridge
    y *= ridge
    return [x, y]
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

export class ArmSweep {
  readonly geometry = new THREE.BufferGeometry()
  readonly kinematics: ArmKinematics[]
  private readonly shapes: Shape[][]
  private readonly cross = section()
  private readonly positions: Float32Array
  private readonly normals: Float32Array
  private readonly at = frame()
  private readonly tangent = new THREE.Vector3()
  private readonly x = new THREE.Vector3()
  private readonly y = new THREE.Vector3()
  private readonly n = new THREE.Vector3()
  private readonly perArm: number

  constructor(readonly profile: ContinuumProfile) {
    this.kinematics = profile.arms.map((arm) => new ArmKinematics(arm, 3))
    this.shapes = profile.arms.map((arm) => arm.sections.map(straight))
    const rings = RINGS + CAP
    this.perArm = rings * AROUND + 1
    const count = this.perArm * profile.arms.length
    this.positions = new Float32Array(count * 3)
    this.normals = new Float32Array(count * 3)
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
    // Colours are fixed per vertex: along the arm from root to tip, and round each ring from back to oral side.
    const colors = new Float32Array(count * 3), root = new THREE.Color(SKIN.root), tip = new THREE.Color(SKIN.tip), oral = new THREE.Color(SKIN.oral), c = new THREE.Color()
    for (let a = 0; a < profile.arms.length; a++) for (let r = 0; r <= rings; r++) for (let i = 0; i < (r === rings ? 1 : AROUND); i++) {
      const f = Math.max(0, fractions[Math.min(r, RINGS - 1)]), underside = r === rings ? 0 : Math.max(0, -this.cross.normals[i][1])
      c.copy(root).lerp(tip, f ** 0.8).lerp(oral, 0.75 * underside ** 1.5)
      c.toArray(colors, (a * this.perArm + r * AROUND + i) * 3)
    }
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    // A generous fixed bound: arms never leave a 1.4 m sphere about the collar, so culling needs no per-frame update.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.4)
  }

  /** Re-pose every arm from the state's shapes, in the body (profile) frame. */
  update(u: Pick<Octopus, 'shapes'>) {
    for (let a = 0; a < this.profile.arms.length; a++) {
      const arm = this.profile.arms[a], kin = this.kinematics[a], shapes = armShapes(u, a, this.shapes[a])
      kin.update(shapes)
      const base = a * this.perArm
      for (let r = 0; r < RINGS + CAP; r++) {
        let f = fractions[Math.min(r, RINGS - 1)], radius: number, slope: number, extend = 0
        if (r >= RINGS) {
          // The tip: a short rounded cap beyond the last section, along its tangent.
          const k = (r - RINGS + 1) / (CAP + 1)
          f = 1
          extend = surfaceRadius(arm, 1) * k * 1.1
          radius = surfaceRadius(arm, 1) * Math.sqrt(Math.max(0, 1 - k * k))
          slope = -k * 2
        } else {
          const section = shapes[Math.min(arm.sections.length - 1, Math.max(0, Math.floor(f * arm.sections.length)))]
          radius = surfaceRadius(arm, Math.max(0, f), section.strain)
          slope = (surfaceRadius(arm, 1) - surfaceRadius(arm, 0)) / 0.88
        }
        kin.at(Math.max(0, f), this.at)
        const q = this.at.orientation
        this.tangent.set(0, 0, 1).applyQuaternion(q)
        this.x.set(1, 0, 0).applyQuaternion(q)
        this.y.set(0, 1, 0).applyQuaternion(q)
        const centre = this.at.position
        const along = f < 0 ? f * 0.88 : extend
        for (let i = 0; i < AROUND; i++) {
          const [ox, oy] = this.cross.offsets[i], [nx, ny] = this.cross.normals[i], v = (base + r * AROUND + i) * 3
          this.positions[v] = centre.x + this.tangent.x * along + (this.x.x * ox + this.y.x * oy) * radius
          this.positions[v + 1] = centre.y + this.tangent.y * along + (this.x.y * ox + this.y.y * oy) * radius
          this.positions[v + 2] = centre.z + this.tangent.z * along + (this.x.z * ox + this.y.z * oy) * radius
          this.n.copy(this.x).multiplyScalar(nx).addScaledVector(this.y, ny).addScaledVector(this.tangent, -slope).normalize()
          this.normals[v] = this.n.x
          this.normals[v + 1] = this.n.y
          this.normals[v + 2] = this.n.z
        }
      }
      // The apex closes the cap.
      kin.at(1, this.at)
      this.tangent.set(0, 0, 1).applyQuaternion(this.at.orientation)
      const v = (base + (RINGS + CAP) * AROUND) * 3, reach = surfaceRadius(arm, 1) * 1.1
      this.positions[v] = this.at.position.x + this.tangent.x * reach
      this.positions[v + 1] = this.at.position.y + this.tangent.y * reach
      this.positions[v + 2] = this.at.position.z + this.tangent.z * reach
      this.normals[v] = this.tangent.x
      this.normals[v + 1] = this.tangent.y
      this.normals[v + 2] = this.tangent.z
    }
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.normal.needsUpdate = true
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
  private readonly matrix = new THREE.Matrix4()
  private readonly at = frame()
  private readonly offset = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()
  private readonly turn = new THREE.Quaternion()
  private readonly tilt = new THREE.Quaternion()
  private readonly color = new THREE.Color()
  private readonly axis = new THREE.Vector3(0, 0, 1)

  constructor(readonly profile: ContinuumProfile, material: THREE.Material) {
    const count = profile.arms.length * OCTOPUS_CUPS
    this.mesh = new THREE.InstancedMesh(cupGeometry(), material, count)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3)
    this.mesh.frustumCulled = false
    // Turn the cup's +y axis to face the arm's oral side (local -y).
    this.turn.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
  }

  update(u: Pick<Octopus, 'cups'>, kinematics: readonly ArmKinematics[]) {
    let n = 0
    for (let a = 0; a < OCTOPUS_ARMS; a++) {
      const arm = this.profile.arms[a], kin = kinematics[a]
      for (let c = 0; c < OCTOPUS_CUPS; c++) {
        const cup = arm.cups[c], seal = u.cups[a * OCTOPUS_CUPS + c] ?? 0, radius = surfaceRadius(arm, cup.fraction)
        kin.at(cup.fraction, this.at)
        // Two rows either side of the oral midline, leaning outward a little.
        const across = cup.row * radius * 0.42
        this.offset.set(across, -radius * 0.82, 0).applyQuaternion(this.at.orientation).add(this.at.position)
        this.tilt.setFromAxisAngle(this.axis, cup.row * 0.38)
        this.at.orientation.multiply(this.tilt).multiply(this.turn)
        const size = cup.radius * (1 + 0.12 * seal)
        this.scale.set(size, size * (1 - 0.45 * seal), size)
        this.matrix.compose(this.offset, this.at.orientation, this.scale)
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

/** Across each gap between neighbouring arms, and how far up the arms the web reaches at its edges and middle. */
const ACROSS = 7, ALONG = 6, WEB_EDGE = 0.2, WEB_MIDDLE = 0.08

/** The soft proximal web between neighbouring arms: a membrane hung between their surfaces, sagging toward the mouth. */
export class WebSweep {
  readonly geometry = new THREE.BufferGeometry()
  private readonly pairs: [number, number][]
  private readonly positions: Float32Array
  private readonly a = frame()
  private readonly b = frame()
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
      // Both faces: the web is seen from above and below.
      index.push(v, v + 1, v + ACROSS, v + 1, v + ACROSS + 1, v + ACROSS)
    }
    this.geometry.setIndex(index)
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1)
  }

  update(kinematics: readonly ArmKinematics[]) {
    const per = ACROSS * ALONG
    this.pairs.forEach(([left, right], w) => {
      for (let t = 0; t < ACROSS; t++) {
        const across = t / (ACROSS - 1), reach = WEB_EDGE + (WEB_MIDDLE - WEB_EDGE) * Math.sin(Math.PI * across)
        for (let s = 0; s < ALONG; s++) {
          const f = (s / (ALONG - 1)) * reach
          kinematics[left].at(f, this.a)
          kinematics[right].at(f, this.b)
          // Attach to each arm's facing flank rather than its centreline.
          this.side.subVectors(this.b.position, this.a.position)
          const gap = this.side.length() || 1
          this.side.multiplyScalar(1 / gap)
          const ra = surfaceRadius(this.profile.arms[left], f) * 0.85, rb = surfaceRadius(this.profile.arms[right], f) * 0.85
          this.p.copy(this.a.position).addScaledVector(this.side, ra)
          this.q.copy(this.b.position).addScaledVector(this.side, -rb)
          this.p.lerp(this.q, across)
          this.p.y -= 0.025 * Math.sin(Math.PI * across) * (1 - s / (ALONG - 1))
          const v = (w * per + s * ACROSS + t) * 3
          this.positions[v] = this.p.x
          this.positions[v + 1] = this.p.y
          this.positions[v + 2] = this.p.z
        }
      }
    })
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.computeVertexNormals()
  }
}

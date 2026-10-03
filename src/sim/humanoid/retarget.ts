/** BODY to named joints. No camera data survives reset or enters calibration storage. */
import { Euler, Quaternion, Vector3 } from 'three'
import type { BodyFrame } from '@obpal/host'
import { applyRanges, freshCalibration, type Calibration } from './calibration'
import { bodyFrame, forward, mirrorPoints, mirrorScores, solveLimb, v } from './ik'
import { bounded, clamp, mirrorAngles, neutral, rad, type Angles, type Chain, type RigProfile } from './profile'
export interface Retargeted {
  q: Angles
  raw: Angles
  valid: Set<string>
  tracked: boolean
  calibrating: boolean
  generation: number
  residual: number
  limited: boolean
  /**
   * The pelvis turn since calibration, about the calibrated vertical: positive turns the robot to its own left,
   * mirrored with the preview. It is continuous across the camera's half-turn seam, bounded by HEADING_LIMIT, held
   * and eased to zero exactly like a lost joint, and never integrated, so it cannot accumulate a turn.
   */
  heading: number
}
/** The furthest a body turn moves the robot's root heading either way. */
export const HEADING_LIMIT = rad(60)
/** A standing spine further than this from the camera's up is a lean or a tilted camera too large to calibrate. */
const VERTICAL_LIMIT = rad(25)
/**
 * Landmark noise bends a straight limb by a degree or two in an arbitrary plane. The observed bend plane is trusted
 * only as the person visibly bends the elbow or knee; below that the limb keeps its untwisted rest plane.
 */
const BEND_TRUST: readonly [number, number] = [rad(15), rad(40)]
/** Within about 20° of pointing straight ahead or behind, a limb's direction no longer tells its roll. */
const LOCK: readonly [number, number] = [0.12, 0.35]
const UP = new Vector3(0, 1, 0),
  DOWN = new Vector3(0, -1, 0)
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const wrap = (n: number) => Math.atan2(Math.sin(n), Math.cos(n))
const smooth = (n: number, [lo, hi]: readonly [number, number]) => {
  const t = clamp((n - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}
/**
 * A limb's roll, pitch and yaw joints (Z, X, Y) for one solved rotation. Euler extraction returns |pitch| ≤ 90°,
 * which wraps an overhead reach or high kick into a sideways fling, and at 90° (pointing straight ahead) roll and yaw
 * both turn the limb about its own length, so landmark noise splits them arbitrarily. Roll and pitch come from the
 * limb's direction instead, roll holds its previous value as that direction loses it, and yaw takes the remaining
 * twist. Of the two branches, (roll, pitch, yaw) and (roll + π, π − pitch, yaw + π), keep the one inside the joint
 * limits, then the one nearer the previous sample.
 */
export function limbAngles(
  profile: RigProfile,
  chain: Chain,
  rotation: Quaternion,
  previous?: readonly number[],
): [number, number, number] {
  const d = DOWN.clone().applyQuaternion(rotation),
    across = Math.hypot(d.x, d.y),
    pitch = Math.asin(clamp(-d.z, -1, 1))
  const limits = chain.joints.slice(0, 3).map((id) => profile.joints.find((j) => j.id === id)!.limits)
  const option = (flip: boolean): [number, number, number] => {
    const seen = wrap(Math.atan2(d.x, -d.y) + (flip ? Math.PI : 0)),
      before = previous ? previous[0] * chain.side : 0
    const z = before + wrap(seen - before) * smooth(across, LOCK),
      x = flip ? wrap(Math.PI - pitch) : pitch
    const twist = new Quaternion()
      .setFromAxisAngle(new Vector3(1, 0, 0), x)
      .premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), z))
      .invert()
      .multiply(rotation)
    return [wrap(z) * chain.side, x, wrap(2 * Math.atan2(twist.y, twist.w))]
  }
  const cost = (a: readonly number[]) =>
    a.reduce((sum, n, i) => sum + 10 * Math.max(0, limits[i][0] - n, n - limits[i][1]) + (previous ? Math.abs(wrap(n - previous[i])) : 0), 0)
  const [plain, flipped] = [option(false), option(true)]
  return cost(flipped) < cost(plain) ? flipped : plain
}
/**
 * The bend plane for a two-link solve, in the parent frame. The rest plane is swung, without twist, from hanging
 * down to the limb's current direction; the observed elbow or knee replaces it only as the limb visibly bends.
 */
export function limbPole(chain: Chain, upper: Vector3, target: Vector3, bend: number) {
  const along = target.lengthSq() > 1e-10 ? target.clone().normalize() : DOWN.clone()
  const rest = new Vector3(0, 0, chain.bend).applyQuaternion(new Quaternion().setFromUnitVectors(DOWN, along))
  const seen = upper.clone().addScaledVector(along, -upper.dot(along))
  const trust = seen.lengthSq() > 1e-8 ? smooth(bend, BEND_TRUST) : 0
  return rest.multiplyScalar(1 - trust).addScaledVector(trust ? seen.normalize() : seen, trust)
}
export class Retargeter {
  mirror = true
  data: Calibration
  private gen = -1
  private started = -1
  private sampled = -1
  private samples = new Map<string, number[]>()
  private limbs = new Map<string, [number, number, number]>()
  private held: Angles
  private seen: Record<string, number> = {}
  /** Calibrated standing vertical and forward, both from the first second of tracking on this feed. */
  private vertical = UP.clone()
  private front: Vector3 | null = null
  private settled = false
  private spines = new Vector3()
  private fronts = new Vector3()
  /** Unwrapped calibrated heading, its bounded output, and when the pelvis was last seen. */
  private turn = 0
  private heading = 0
  private headingSeen = -Infinity
  constructor(readonly profile: RigProfile) {
    this.data = freshCalibration(profile)
    this.held = neutral(profile)
  }
  /** A new tracking generation of the same feed: limbs and proportions restart; the camera's calibration stays. */
  private restart() {
    this.started = -1
    this.sampled = -1
    this.samples.clear()
    this.limbs.clear()
    this.seen = {}
    this.held = neutral(this.profile)
  }
  /** A new feed, owner or mirror: forget the camera too. */
  reset() {
    this.restart()
    this.gen = -1
    this.vertical.copy(UP)
    this.front = null
    this.settled = false
    this.spines.set(0, 0, 0)
    this.fronts.set(0, 0, 0)
    this.turn = 0
    this.heading = 0
    this.headingSeen = -Infinity
  }
  setMirror(mirror: boolean) {
    if (mirror !== this.mirror) {
      this.mirror = mirror
      this.reset()
    }
  }
  step(body: BodyFrame | null, now: number): Retargeted {
    const raw = neutral(this.profile),
      valid = new Set<string>()
    let residual = 0,
      limited = false
    const result = (tracked = false, calibrating = false): Retargeted => ({
      q: { ...this.held },
      raw,
      valid,
      tracked,
      calibrating,
      generation: this.gen,
      residual,
      limited,
      heading: this.heading,
    })
    const lost = () => {
      for (const j of this.profile.joints) if (now - (this.seen[j.id] ?? -Infinity) >= 250) this.held[j.id] *= 0.85
      if (now - this.headingSeen >= 250) this.heading *= 0.85
      this.started = -1
      return result()
    }
    if (!body?.tracked || now - body.receivedAt >= 250) return lost()
    if (body.gen !== this.gen) {
      // The camera has not moved: a person regained after a gap keeps its vertical and forward, so a stream hiccup
      // cannot re-zero a turned person's heading.
      this.restart()
      this.gen = body.gen
    }
    const points = this.mirror ? mirrorPoints(body.landmarks) : body.landmarks
    const confidence = body.visibility.map((n, i) => Math.min(n, body.presence[i]))
    const scores = this.mirror ? mirrorScores(confidence) : confidence
    const good = (ids: readonly number[]) => ids.every((i) => scores[i] >= 0.5 && points[i]?.every(Number.isFinite))
    const f = this.profile.frame
    if (f && !good([...f.hips, ...f.shoulders])) return lost()
    const hip = f ? v(points[f.hips[0]]).add(v(points[f.hips[1]])).multiplyScalar(0.5) : new Vector3()
    const shoulder = f
      ? v(points[f.shoulders[0]]).add(v(points[f.shoulders[1]])).multiplyScalar(0.5)
      : new Vector3(0, 1, 0)
    const right = f ? v(points[f.hips[1]]).sub(v(points[f.hips[0]])) : new Vector3(1, 0, 0)
    const newSample = body.receivedAt !== this.sampled
    if (this.started < 0) this.started = now
    // The camera is rarely level: a propped phone leans every standing person. The first second of tracking on a feed
    // measures the standing spine as the vertical, and the pelvis facing as forward. Later leans are relative to them.
    if (f && !this.settled && newSample) {
      const spine = shoulder.clone().sub(hip)
      if (spine.lengthSq() > 1e-4) this.spines.add(spine.normalize())
      const facing = new Vector3().crossVectors(UP, right)
      if (facing.lengthSq() > 1e-6) this.fronts.add(facing.normalize())
      const vertical = this.spines.clone().normalize()
      this.vertical.copy(this.spines.lengthSq() > 0 && vertical.angleTo(UP) <= VERTICAL_LIMIT ? vertical : UP)
      const front = this.fronts.clone().addScaledVector(this.vertical, -this.fronts.dot(this.vertical))
      this.front = front.lengthSq() > 1e-8 ? front.normalize() : this.front
      this.settled = now - this.started >= 1000
    }
    const pelvis = f ? bodyFrame(right, this.vertical) : new Quaternion()
    const torso = f
      ? bodyFrame(v(points[f.shoulders[1]]).sub(v(points[f.shoulders[0]])), shoulder.clone().sub(hip))
      : new Quaternion()
    if (!pelvis || !torso) return lost()
    const rel = pelvis.clone().invert().multiply(torso),
      e = new Euler().setFromQuaternion(rel, 'YXZ')
    if (f)
      [e.y, e.x, e.z].forEach((n, i) => {
        raw[f.spine[i]] = n
        valid.add(f.spine[i])
      })
    if (f && this.front) {
      // Signed and continuous: the nearer branch of each new sample, so facing the camera (a half turn in camera
      // axes) cannot wrap. Only the output is bounded; the unwrapped value follows the person back.
      const facing = new Vector3().crossVectors(this.vertical, right).normalize()
      const sample = Math.atan2(new Vector3().crossVectors(this.front, facing).dot(this.vertical), this.front.dot(facing))
      this.turn += wrap(sample - this.turn)
      this.heading = clamp(this.turn, -HEADING_LIMIT, HEADING_LIMIT)
      this.headingSeen = body.receivedAt
    }
    for (const c of this.profile.chains) {
      if (!good(c.points)) continue
      const [a, b, d] = c.points.map((i) => v(points[i]))
      const upper = b.clone().sub(a),
        lower = d.clone().sub(b)
      const parent = c.group === 'legs' ? pelvis : torso,
        inv = parent.clone().invert()
      const lengths = [upper.length(), lower.length()]
      if (lengths.some((n) => n < 0.08 || n > 1)) continue
      const sourceChain = this.mirror
        ? (this.profile.chains.find((other) => other.group === c.group && other.side === -c.side) ?? c)
        : c
      for (let i = 0; i < 2; i++) {
        const key = `${sourceChain.id}.${i ? 'lower' : 'upper'}`
        if (newSample && now - this.started <= 1200 && !this.data.lengths[key]) {
          const samples = this.samples.get(key) ?? []
          samples.push(lengths[i])
          this.samples.set(key, samples)
        }
        if (now - this.started >= 1000 && !this.data.lengths[key]) {
          const samples = this.samples.get(key)
          if (samples && samples.length >= 10) this.data.lengths[key] = median(samples)
        }
      }
      const user = [
        this.data.lengths[`${sourceChain.id}.upper`] ?? lengths[0],
        this.data.lengths[`${sourceChain.id}.lower`] ?? lengths[1],
      ]
      // Segment-wise scale preserves articulation when the user and robot have different proportions.
      const target = upper
        .clone()
        .multiplyScalar(c.lengths[0] / user[0])
        .add(lower.clone().multiplyScalar(c.lengths[1] / user[1]))
        .applyQuaternion(inv)
      const ik = solveLimb(target, limbPole(c, upper.clone().applyQuaternion(inv), target, upper.angleTo(lower)), ...c.lengths, c.bend)
      residual = Math.max(residual, ik.residual)
      const angles = limbAngles(this.profile, c, ik.rotation, this.limbs.get(c.id))
      this.limbs.set(c.id, angles)
      ;[...angles, ik.flex].forEach((n, i) => {
        raw[c.joints[i]] = n
        valid.add(c.joints[i])
      })
      if (good(c.tips)) {
        const lowerQ = ik.rotation
          .clone()
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(c.bend, 0, 0), ik.flex))
        const direction =
          c.group === 'legs'
            ? v(points[c.tips[1]]).sub(v(points[c.tips[0]]))
            : v(points[c.tips[0]]).add(v(points[c.tips[1]])).multiplyScalar(0.5).sub(d)
        direction.applyQuaternion(inv).applyQuaternion(lowerQ.clone().invert()).normalize()
        if (c.group === 'legs') {
          raw[c.distal[0]] = Math.atan2(direction.y, -direction.z)
          raw[c.distal[1]] = Math.atan2(direction.x, Math.hypot(direction.y, direction.z))
        } else {
          const span = v(points[c.tips[1]])
            .sub(v(points[c.tips[0]]))
            .applyQuaternion(inv)
            .applyQuaternion(lowerQ.clone().invert())
          raw[c.distal[0]] = Math.atan2(span.z, Math.abs(span.x)) * c.side
          raw[c.distal[1]] = Math.atan2(-direction.z, -direction.y)
          raw[c.distal[2]] = Math.atan2(direction.x, Math.hypot(direction.y, direction.z))
        }
        c.distal.forEach((id) => valid.add(id))
      }
    }
    if (f && good([...f.ears, f.nose])) {
      const middle = v(points[f.ears[0]]).add(v(points[f.ears[1]])).multiplyScalar(0.5)
      const look = v(points[f.nose]).sub(middle).applyQuaternion(torso.clone().invert())
      raw[f.head[0]] = Math.atan2(-look.x, -look.z)
      raw[f.head[1]] = Math.atan2(look.y, Math.hypot(look.x, look.z))
      f.head.forEach((id) => valid.add(id))
    }
    // Saved ranges always describe the anatomical user, independent of the preview/mirror preference.
    const observed = this.mirror ? mirrorAngles(this.profile, raw) : raw
    const mapped = applyRanges(this.profile, observed, this.data)
    const q = bounded(this.profile, this.mirror ? mirrorAngles(this.profile, mapped) : mapped)
    limited =
      residual > 0.01 ||
      this.profile.joints.some(
        (j) =>
          valid.has(j.id) &&
          !this.data.ranges[this.profile.mirror?.[j.id]?.joint ?? j.id] &&
          (raw[j.id] < j.limits[0] - 0.02 || raw[j.id] > j.limits[1] + 0.02),
      )
    for (const j of this.profile.joints) {
      if (valid.has(j.id)) {
        this.held[j.id] = q[j.id]
        this.seen[j.id] = body.receivedAt
      } else if (now - (this.seen[j.id] ?? -Infinity) >= 250) this.held[j.id] *= 0.85
    }
    this.sampled = body.receivedAt
    return {
      ...result(true, now - this.started < 1000),
      raw: observed,
      valid: this.mirror ? new Set([...valid].map((id) => this.profile.mirror?.[id]?.joint ?? id)) : valid,
    }
  }
}

/** Visual support only: contacts constrain named legs, never authorise real robot motion. */
export class FootBalance {
  private feet = new Map<string, { p: Vector3; anchor: Vector3; age: number; contact: boolean }>()
  reset() {
    this.feet.clear()
  }
  step(profile: RigProfile, source: Angles, dt: number, moving = false) {
    const q = { ...source },
      fk = forward(profile, q),
      root = new Vector3(),
      landed: string[] = []
    const legs = profile.chains.filter((c) => c.group === 'legs')
    if (!legs.length) return { q, root, landed, contacts: [] as string[] }
    const lowest = Math.min(...legs.map((c) => fk.get(c.end)!.p.y - 0.08))
    root.y = clamp(-lowest, -Math.max(0, fk.get(profile.root)!.p.y - 0.12), 0.4)
    const support: Vector3[] = []
    for (const c of legs) {
      const p = fk.get(c.end)!.p.clone().add(root)
      p.y -= 0.08
      let foot = this.feet.get(c.id)
      if (!foot) {
        foot = { p: p.clone(), anchor: p.clone(), age: 0, contact: false }
        this.feet.set(c.id, foot)
      }
      const speed = p.distanceTo(foot.p) / Math.max(0.001, dt)
      if (moving || p.y > 0.04 || speed > 0.2) {
        foot.contact = false
        foot.age = 0
      }
      if (!moving && p.y < 0.02 && speed < 0.1) {
        foot.age += dt
        if (!foot.contact && foot.age >= 0.08) {
          foot.contact = true
          foot.anchor.copy(p)
          landed.push(c.id)
        }
      }
      if (foot.contact) support.push(foot.anchor)
      foot.p.copy(p)
    }
    if (support.length) {
      const margin = support.length === 1 ? 0 : 0.02
      const minX = Math.min(...support.map((p) => p.x)) - 0.08 + margin,
        maxX = Math.max(...support.map((p) => p.x)) + 0.08 - margin
      const minZ = Math.min(...support.map((p) => p.z)) - 0.14 + margin,
        maxZ = Math.max(...support.map((p) => p.z)) + 0.1 - margin
      const com = fk.get(profile.frame?.spine[2] ?? profile.root)!.p
      root.x = clamp(com.x, minX, maxX) - com.x
      root.z = clamp(com.z, minZ, maxZ) - com.z
      for (const c of legs) {
        const foot = this.feet.get(c.id)!
        if (!foot.contact) continue
        const hip = fk.get(c.joints[0])!.p.clone().add(root)
        const target = foot.anchor
          .clone()
          .add(new Vector3(0, 0.08, 0))
          .sub(hip)
        // A straight leg's knee lies on the hip–ankle line, so its position alone is no bend plane: share BODY's rule.
        const knee = fk.get(c.joints[3])!.p.clone().add(root).sub(hip)
        const ik = solveLimb(target, limbPole(c, knee, target, q[c.joints[3]]), ...c.lengths, c.bend)
        const angles = limbAngles(profile, c, ik.rotation, [q[c.joints[0]], q[c.joints[1]], q[c.joints[2]]])
        ;[...angles, ik.flex].forEach((n, i) => (q[c.joints[i]] = n))
      }
    }
    return {
      q: bounded(profile, q),
      root,
      landed,
      contacts: [...this.feet].filter(([, f]) => f.contact).map(([id]) => id),
    }
  }
}

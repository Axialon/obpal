/** Cairn I practice stepping. World support anchors constrain the rendered pose, not the physical rig. */
import { Vector3 } from 'three'
import { bounded, clamp, type Angles, type RigProfile } from './profile'
import { forward, solveLimb, v } from './ik'
import { limbAngles } from './retarget'

const UP = new Vector3(0, 1, 0)
const PERIOD = 0.44
const smooth = (t: number) => t * t * t * (10 + t * (-15 + 6 * t))
const signedAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
interface Foot {
  stance: boolean
  phase: number
  cycle: number
  at: Vector3
  from: Vector3
  to: Vector3
  yaw: number
  fromYaw: number
  toYaw: number
  fromPhase: number
}
export class CairnVisualGait {
  readonly feet: Record<string, Foot> = {}
  active = false
  private moving = false
  private translating = false
  private rendered = new Map<string, { at: Vector3; yaw: number }>()
  constructor(readonly profile: RigProfile) {}
  reset() {
    for (const side of Object.keys(this.feet)) delete this.feet[side]
    this.rendered.clear()
    this.active = false
    this.moving = false
    this.translating = false
  }
  /** A source switch starts from the last visible feet, without retaining an input or a running stride. */
  seed(side: string, at: Vector3, yaw: number) {
    if (!Object.keys(this.feet).length) this.rendered.set(side, { at: at.clone().setY(0), yaw })
  }
  /** Root movement remains the native control's. A stopped input finishes its existing swing without another step. */
  advance(dt: number, position: Vector3, yaw: number, enabled: boolean, before: Vector3, beforeYaw: number) {
    if (!enabled) { this.reset(); return }
    this.active = true
    const velocity = position.clone().sub(before).divideScalar(dt || 1)
    const turn = signedAngle(yaw - beforeYaw) / (dt || 1)
    const translating = velocity.length() > .001
    const moving = translating || Math.abs(turn) > .001
    const released = this.moving && !moving || this.translating && !translating
    this.moving = moving
    this.translating = translating
    const rate = clamp(Math.max(velocity.length() / .85, Math.abs(turn) / 1.5), .25, Math.SQRT2)
    for (const chain of this.profile.chains.filter(c => c.group === 'legs')) {
      const side = chain.side < 0 ? 'left' : 'right', hip = this.profile.joints.find(j => j.id === chain.joints[0])!
      // Native translation rotates with heading. Predict that arc, rather than a straight tangent which
      // can make an otherwise reachable turning landing appear unreachable late in its swing.
      const predictedHip = (seconds: number) => {
        const angle = turn * seconds, along = Math.abs(turn) > 1e-8 ? Math.sin(angle) / turn : seconds
        const across = Math.abs(turn) > 1e-8 ? (1 - Math.cos(angle)) / turn : 0
        return v(hip.offset).setY(0).applyAxisAngle(UP, yaw + angle).add(position)
          .add(new Vector3(velocity.x * along + velocity.z * across, 0, velocity.z * along - velocity.x * across))
      }
      let foot = this.feet[side]
      if (!foot) {
        const seen = this.rendered.get(side), at = seen?.at ?? v(hip.offset).setY(0).applyAxisAngle(UP, beforeYaw).add(before)
        const facing = seen?.yaw ?? beforeYaw
        foot = this.feet[side] = { stance: true, phase: chain.side < 0 ? 0 : .5, cycle: 0, at: at.clone(), from: at.clone(), to: at.clone(), yaw: facing, fromYaw: facing, toYaw: facing, fromPhase: .5 }
      }
      if (moving || !foot.stance) foot.phase += dt * rate / PERIOD
      if (foot.phase >= 1) {
        foot.phase %= 1
        foot.cycle++
        foot.stance = true
        foot.at.copy(foot.to)
        foot.yaw = foot.toYaw
      }
      if (foot.stance && foot.phase >= .5 && moving) {
        foot.stance = false
        foot.from.copy(foot.at)
        foot.fromYaw = foot.yaw
        foot.fromPhase = .5
        // Commit this swing's landing at lift-off. Release/reversal changes the next step, not this material path.
        const remaining = (1 - foot.phase) * PERIOD / rate
        // Land near the hip at touchdown. A forward stance lead survives release and can exceed reach when
        // backward movement resumes; the endpoint envelope below supplies only the lead actually needed.
        foot.to.copy(predictedHip(remaining))
        foot.toYaw = foot.fromYaw + signedAngle(yaw + turn * remaining - foot.fromYaw)
      }
      if (!foot.stance) {
        const u = clamp((foot.phase - .5) * 2, 0, 1)
        const remaining = (1 - foot.phase) * PERIOD / rate, support = PERIOD / (2 * rate)
        const skin = this.profile.skins.find(s => s.joint === chain.end && s.finish === 'trim')!
        const drop = .855 + skin.offset[1] - skin.size[1] / 2
        const reach = Math.sqrt(Math.max(0, (chain.lengths[0] + chain.lengths[1] - .002) ** 2 - drop ** 2))
        const landingHip = predictedHip(remaining), endHip = predictedHip(remaining + support)
        const yawJoint = this.profile.joints.find(j => j.id === chain.joints[2])!
        // Leave room for the roll/pitch decomposition too. A position can be reachable while its frozen
        // sole heading hits the named hip-yaw limit during support and rotates the planted material points.
        const yawReach = Math.min(...yawJoint.limits.map(Math.abs)) - .05
        const positionUnreachable = [landingHip, endHip].some(p => foot.to.distanceTo(p) > reach)
        // Endpoint equality can differ by a binary remainder; do not restart an unchanged plan for it.
        const yawUnreachable = [remaining, remaining + support].some(seconds => Math.abs(signedAngle(foot.toYaw - yaw - turn * seconds)) > yawReach + 1e-9)
        if (released || positionUnreachable || yawUnreachable) {
          // A reversal can make the old landing unreachable. Rebase at the current point/orientation; never snap it.
          foot.from.copy(foot.at).setY(0)
          foot.fromYaw = foot.yaw
          foot.fromPhase = foot.phase
          // Choose a nearby landing inside both endpoint envelopes. Predict the turning hip too; using only its
          // current offset can reject every subsequent frame, repeatedly freezing progress until touchdown.
          // A stopped step lands beneath the stationary hip so a later backward stance remains reachable.
          // Translation ending into a turn keeps the nearest current point, rather than a compressed new stride.
          if (released || positionUnreachable) foot.to.copy(released && !moving ? landingHip : foot.at).setY(0)
          for (let i = 0; i < 4; i++) for (const centre of [landingHip, endHip]) {
            const delta = foot.to.clone().sub(centre), distance = delta.length(), radius = Math.max(0, reach - .005)
            if (distance > radius) foot.to.copy(centre).addScaledVector(delta, radius / distance)
          }
          // Keep the nearest heading valid at both support endpoints. A late reversal needs only the
          // missing limit margin, not a new midpoint heading compressed into the last few swing frames.
          const landingYaw = yaw + turn * remaining, sweep = turn * support
          const relative = clamp(signedAngle(foot.toYaw - landingYaw), Math.max(-yawReach, sweep - yawReach), Math.min(yawReach, sweep + yawReach))
          foot.toYaw = foot.fromYaw + signedAngle(landingYaw + relative - foot.fromYaw)
        }
        const progress = clamp((foot.phase - foot.fromPhase) / (1 - foot.fromPhase), 0, 1)
        foot.at.lerpVectors(foot.from, foot.to, smooth(progress))
        foot.at.y = .035 * Math.sin(Math.PI * u) ** 2
        foot.yaw = foot.fromYaw + (foot.toYaw - foot.fromYaw) * smooth(progress)
      }
    }
  }
  /** Apply the support constraint after elasticity too: target angles alone cannot prevent visible sole drift. */
  pose(source: Angles, position: Vector3, yaw: number, floor: number) {
    const q = { ...source }, rootHeight = this.profile.joints.find(j => j.id === this.profile.root)!.offset[1]
    const offset = new Vector3(0, .855 - rootHeight, 0)
    for (const chain of this.profile.chains.filter(c => c.group === 'legs')) {
      const foot = this.feet[chain.side < 0 ? 'left' : 'right']
      if (!foot) continue
      const skin = this.profile.skins.find(s => s.joint === chain.end && s.finish === 'trim')!
      const sole = skin.offset[1] - skin.size[1] / 2
      const hip = forward(this.profile, q).get(chain.joints[0])!.p
      const target = foot.at.clone().sub(position).applyAxisAngle(UP, -yaw)
      target.y = floor + .0005 - sole + (foot.stance ? 0 : foot.at.y) - offset.y
      target.sub(hip)
      const pole = new Vector3(0, 0, -1).applyAxisAngle(UP, foot.yaw - yaw)
      const ik = solveLimb(target, pole, ...chain.lengths, chain.bend)
      const angles = limbAngles(this.profile, chain, ik.rotation)
      ;[...angles, ik.flex].forEach((n, i) => q[chain.joints[i]] = n)
      chain.distal.forEach(id => q[id] = 0)
      const safe = bounded(this.profile, q), lower = forward(this.profile, safe).get(chain.end)!.q
      // Two ankle axes align the sole's normal with world up. Existing bounds still win.
      const up = UP.clone().applyQuaternion(lower.clone().invert())
      q[chain.distal[0]] = Math.atan2(up.z, up.y)
      q[chain.distal[1]] = -Math.asin(clamp(up.x, -1, 1))
    }
    const pose = bounded(this.profile, q), fk = forward(this.profile, pose)
    // The authored sole height agrees with the named trim. Its enclosing corners are conservative at tilted edges.
    let lowest = Infinity
    for (const chain of this.profile.chains.filter(c => c.group === 'legs')) {
      const skin = this.profile.skins.find(s => s.joint === chain.end && s.finish === 'trim')!, foot = fk.get(chain.end)!
      for (const x of [-1, 1]) for (const z of [-1, 1]) {
        const p = new Vector3(skin.offset[0] + x * skin.size[0] / 2, skin.offset[1] - skin.size[1] / 2, skin.offset[2] + z * skin.size[2] / 2)
          .applyQuaternion(foot.q).add(foot.p).add(offset)
        lowest = Math.min(lowest, p.y)
      }
    }
    offset.y += Math.max(0, floor + .0005 - lowest)
    return { q: pose, offset }
  }
}

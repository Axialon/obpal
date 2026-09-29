/** Conservative envelopes for the simulated driver lane, independent of practice controls. */
import { Vector3 } from 'three'
import { forward, v } from './ik'
import { clamp, neutral, type Angles } from './profile'
import { profileKey, upperJoints, type DriverProfile } from './driver-profile'
import { TIMING, type DriverReading } from './drivers'

export interface Motion {
  positions: Angles
  velocities: Angles
}
export interface TargetInput {
  kind: 'jog' | 'body'
  token: string
  positions: Angles
  at: number
  valid: boolean
  preset: boolean
}
export interface Check {
  id: string
  label: string
  ok: boolean
  reason: string
}

export function profileProblem(p: DriverProfile): string {
  if (p.units !== 'radians' || p.feedback !== 'measured') return 'Measured radians are required'
  if (!['measured-hold', 'controlled-damp'].includes(p.stop)) return 'A driver-specific hold is required'
  if (!p.joints.length || !upperJoints(p).length) return 'The profile has no commandable joints'
  for (const key of ['id', 'wire', 'index'] as const)
    if (new Set(p.joints.map((j) => j[key])).size !== p.joints.length) return 'The joint map contains duplicates'
  for (const j of p.joints) {
    const rig = p.rig.joints.find((r) => r.id === j.id)
    if (
      !rig ||
      !j.wire ||
      !Number.isInteger(j.index) ||
      j.index < 0 ||
      ![1, -1].includes(j.sign) ||
      ![j.zero, ...j.limits, j.speed, j.acceleration].every(Number.isFinite) ||
      j.limits[0] > j.limits[1] ||
      j.limits[0] < rig.limits[0] ||
      j.limits[1] > rig.limits[1] ||
      j.speed <= 0 ||
      j.speed > 0.5 ||
      j.acceleration <= 0 ||
      j.acceleration > 1 ||
      !['upper', 'legs'].includes(j.group) ||
      (j.id.includes('.leg.') && j.group !== 'legs')
    )
      return `Invalid joint profile: ${j.id}`
  }
  return ''
}
/** Every mapped measured joint matters to the collision model, including passive legs. */
export function feedbackProblem(p: DriverProfile, read: DriverReading | null, now: number): string {
  if (!read) return 'Waiting for measured joints'
  if (read.profileKey !== profileKey(p)) return 'The reported joint map does not match the verified profile'
  if (!Number.isFinite(read.at) || read.at > now + 1 || now - read.at > TIMING.feedback)
    return 'Guardian status is stale'
  if (!read.guardian || !read.robotWatchdog || !read.exclusive)
    return 'Guardian, robot watchdog and exclusive ownership are required'
  if (read.fault || read.mode === 'fault') return read.fault || 'Controller fault'
  for (const j of p.joints) {
    const measured = read.joints[j.id]
    if (!measured || measured.position === null) return `${j.id} is unreported`
    if (!Number.isFinite(measured.position) || measured.position < j.limits[0] || measured.position > j.limits[1])
      return `${j.id} is outside its measured limits`
    if (!Number.isFinite(measured.at) || measured.at > now + 1 || now - measured.at > TIMING.feedback)
      return `${j.id} is stale`
  }
  return ''
}
export function measuredPose(p: DriverProfile, read: DriverReading | null, previous = neutral(p.rig)): Angles {
  const q = { ...previous }
  for (const j of p.joints) {
    const n = read?.joints[j.id]?.position
    if (typeof n === 'number' && Number.isFinite(n) && n >= j.limits[0] && n <= j.limits[1]) q[j.id] = n
  }
  return q
}

/** Closest distance between finite segments, including points and parallel segments. */
export function segmentDistance(a: Vector3, b: Vector3, c: Vector3, d: Vector3) {
  const u = b.clone().sub(a),
    w = d.clone().sub(c),
    r = a.clone().sub(c)
  const aa = u.dot(u),
    bb = u.dot(w),
    cc = w.dot(w),
    dd = u.dot(r),
    ee = w.dot(r)
  let s = 0,
    t = 0
  if (aa < 1e-12 && cc < 1e-12) return r.length()
  if (aa < 1e-12) t = clamp(ee / cc, 0, 1)
  else if (cc < 1e-12) s = clamp(-dd / aa, 0, 1)
  else {
    const divisor = aa * cc - bb * bb
    s = divisor > 1e-12 ? clamp((bb * ee - cc * dd) / divisor, 0, 1) : 0
    t = (bb * s + ee) / cc
    if (t < 0) {
      t = 0
      s = clamp(-dd / aa, 0, 1)
    } else if (t > 1) {
      t = 1
      s = clamp((bb - dd) / aa, 0, 1)
    }
  }
  return r.addScaledVector(u, s).addScaledVector(w, -t).length()
}
interface Capsule {
  id: string
  chain: string
  a: Vector3
  b: Vector3
  radius: number
}
/** Test geometry uses named chain frames. A physical profile needs commissioned collision geometry. */
export function collisionProblem(p: DriverProfile, q: Angles): string {
  const fk = forward(p.rig, q),
    capsules: Capsule[] = []
  for (const chain of p.rig.chains) {
    const points = [chain.joints[0], chain.joints[3], chain.end].map((id) => fk.get(id)!.p)
    for (let i = 0; i < 2; i++)
      capsules.push({
        id: `${chain.id}.${i}`,
        chain: chain.id,
        a: points[i].clone().lerp(points[i + 1], 0.12),
        b: points[i].clone().lerp(points[i + 1], 0.92),
        radius: chain.group === 'arms' ? 0.055 : 0.065,
      })
  }
  if (p.rig.frame) {
    const spine = fk.get(p.rig.frame.spine[2])!,
      head = fk.get(p.rig.frame.head[1])!
    capsules.push({
      id: 'torso',
      chain: 'body',
      a: spine.p.clone().add(v([0, 0.02, 0]).applyQuaternion(spine.q)),
      b: head.p.clone().add(v([0, -0.11, 0]).applyQuaternion(head.q)),
      radius: 0.14,
    })
    capsules.push({
      id: 'head',
      chain: 'body',
      a: head.p.clone(),
      b: head.p.clone().add(v([0, 0.16, 0]).applyQuaternion(head.q)),
      radius: 0.1,
    })
  }
  for (let i = 0; i < capsules.length; i++)
    for (let k = i + 1; k < capsules.length; k++) {
      const a = capsules[i],
        b = capsules[k]
      if (a.chain === b.chain) continue
      if (segmentDistance(a.a, a.b, b.a, b.b) < a.radius + b.radius + 0.008) return `${a.id} approaches ${b.id}`
    }
  return ''
}
/** Check the short path too, not only the endpoint; the profile caps keep each step small. */
export function sweptCollision(p: DriverProfile, a: Angles, b: Angles) {
  for (let step = 0; step <= 4; step++) {
    const q = Object.fromEntries(
      p.rig.joints.map((j) => [j.id, (a[j.id] ?? 0) + (((b[j.id] ?? 0) - (a[j.id] ?? 0)) * step) / 4]),
    )
    const why = collisionProblem(p, q)
    if (why) return why
  }
  return ''
}
export function targetProblem(p: DriverProfile, input: TargetInput, now: number) {
  if (!input.valid) return 'The selected input is not tracked'
  if (input.preset) return 'Move presets and sparring cannot drive this lane'
  if (!Number.isFinite(input.at) || input.at > now + 1 || now - input.at > TIMING.capture)
    return 'The selected input is stale'
  if (upperJoints(p).some((j) => !Number.isFinite(input.positions[j.id]))) return 'A requested joint is not finite'
  return ''
}
/** Rate-limited integration with braking distance to both hard limits. */
export function limitMotion(p: DriverProfile, previous: Motion, desired: Angles, dt: number): Motion | null {
  if (!(dt > 0 && dt <= 0.05)) return null
  const positions = { ...previous.positions },
    velocities: Angles = {}
  for (const j of upperJoints(p)) {
    const position = previous.positions[j.id],
      speed = previous.velocities[j.id] ?? 0
    if (![position, speed, desired[j.id]].every(Number.isFinite)) return null
    const acceleration = Math.min(1, j.acceleration),
      cap = Math.min(0.5, j.speed),
      step = acceleration * dt
    const brake = (distance: number) =>
      Math.max(0, Math.sqrt(step * step + 2 * acceleration * Math.max(0, distance)) - step)
    const lo = Math.max(-cap, speed - step, -brake(position - j.limits[0]))
    const hi = Math.min(cap, speed + step, brake(j.limits[1] - position))
    if (lo > hi + 1e-9) return null
    const aim = clamp(desired[j.id], ...j.limits)
    const velocity = clamp((aim - position) * 4, lo, hi)
    positions[j.id] = position + velocity * dt
    velocities[j.id] = velocity
    if (positions[j.id] < j.limits[0] - 1e-9 || positions[j.id] > j.limits[1] + 1e-9) return null
  }
  return { positions, velocities }
}

export function checklist(
  p: DriverProfile,
  read: DriverReading | null,
  now: number,
  input: TargetInput,
  twin: Angles,
  confirmations: { mapping: boolean; workspace: boolean },
  holdVerified: boolean,
  freshDeadman: boolean,
): Check[] {
  const profile = profileProblem(p),
    feedback = feedbackProblem(p, read, now),
    source = targetProblem(p, input, now)
  const collision = feedback ? '' : collisionProblem(p, measuredPose(p, read))
  const aligned =
    !!read && upperJoints(p).every((j) => Math.abs(twin[j.id] - (read.joints[j.id]?.position ?? Infinity)) <= 0.03)
  const stable = !!read && Number.isFinite(read.stableSince) && now - read.stableSince >= TIMING.stable
  return [
    {
      id: 'profile',
      label: 'Joint map',
      ok: !profile && confirmations.mapping,
      reason: profile || 'Verify the selected joint map',
    },
    { id: 'feedback', label: 'Measured joints', ok: !feedback, reason: feedback },
    {
      id: 'controller',
      label: 'Guardian & hold',
      ok: stable && holdVerified,
      reason: !holdVerified ? 'A fresh hold acknowledgement is required' : 'Controller mode must be stable for 200 ms',
    },
    {
      id: 'twin',
      label: 'Twin aligned',
      ok: aligned && !collision,
      reason: collision || 'The measured twin is not aligned',
    },
    { id: 'input', label: 'Input fresh', ok: !source, reason: source },
    {
      id: 'workspace',
      label: 'Workspace clear',
      ok: confirmations.workspace,
      reason: 'Confirm a clear workspace and reachable emergency stop',
    },
    { id: 'deadman', label: 'Deadman held', ok: freshDeadman, reason: 'Release, then hold the deadman to arm' },
  ]
}

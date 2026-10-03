/**
 * Synthetic BODY traces through the real capture path. A person on the robot's proportions stands facing the camera
 * (a half turn from the robot's own frame), in MediaPipe world axes; BodySignal filters it exactly as a phone does and
 * encodeBody makes the 276-byte wire packet. Replay runs the host's BodyInput, retargeting, control, foot support and
 * tendons, the same kinematic path the practice arena renders.
 */
import { Quaternion, Vector3 } from 'three'
import { encodeBody, type Vec3 } from '@obpal/core'
import { BodyInput } from '@obpal/host'
import { BodySignal, type BodyResult } from '../src/controller/body-signal'
import { forward, mirrorPoints } from '../src/sim/humanoid/ik'
import { FootBalance, Retargeter, type Retargeted } from '../src/sim/humanoid/retarget'
import { ActorControl, restIntent } from '../src/sim/humanoid/controls'
import { Tendons } from '../src/sim/humanoid/tendons'
import { KEEL, neutral, rad, type Angles, type RigProfile } from '../src/sim/humanoid/profile'

export interface Person {
  /** Joint angles of the person, in the robot's own convention. */
  q: Angles
  /** Radians the person has turned to their own left from facing the camera. */
  heading: number
}
export interface Camera {
  /** Radians the camera is pitched up (a phone propped on a table). */
  pitch?: number
  /** A horizontally mirrored picture: the model then reports a mirrored person, sides relabelled. */
  mirrored?: boolean
  /** Uniform landmark noise in metres; depth noise is usually several times larger. */
  jitter?: number
  depth?: number
}
/** Deterministic noise, so a trace is the same on every machine. */
export function noise(seed = 7) {
  return (scale: number) => {
    seed = (seed * 16807) % 2147483647
    return ((seed / 2147483647) * 2 - 1) * scale
  }
}
/** One model result for a person, or null when nobody is in view. */
export function personResult(person: Person, camera: Camera = {}, random = noise(), profile: RigProfile = KEEL): BodyResult {
  const fk = forward(profile, person.q),
    hip = fk.get(profile.root)!.p
  const points: Vec3[] = Array.from({ length: 33 }, () => [0, 0, 0])
  const at = (id: string, offset = new Vector3()) => offset.applyQuaternion(fk.get(id)!.q).add(fk.get(id)!.p).sub(hip)
  const set = (i: number, p: Vector3) => (points[i] = p.toArray() as Vec3)
  for (const c of profile.chains) {
    set(c.points[0], at(c.joints[0]))
    set(c.points[1], at(c.joints[3]))
    set(c.points[2], at(c.end))
    if (c.group === 'arms') {
      set(c.tips[0], at(c.end, new Vector3(-0.025, -0.1, 0)))
      set(c.tips[1], at(c.end, new Vector3(0.025, -0.1, 0)))
    } else {
      set(c.tips[0], at(c.end, new Vector3(0, -0.05, 0.09)))
      set(c.tips[1], at(c.end, new Vector3(0, -0.05, -0.18)))
    }
  }
  set(0, at('head.pitch', new Vector3(0, 0.08, -0.12)))
  set(7, at('head.pitch', new Vector3(-0.08, 0.08, 0)))
  set(8, at('head.pitch', new Vector3(0.08, 0.08, 0)))
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI + person.heading),
    tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), camera.pitch ?? 0)
  let seen = points.map((p): Vec3 => {
    const s = new Vector3(...p).applyQuaternion(turn).applyQuaternion(tilt)
    return [s.x + random(camera.jitter ?? 0), s.y + random(camera.jitter ?? 0), s.z + random(camera.depth ?? camera.jitter ?? 0)]
  })
  if (camera.mirrored) seen = mirrorPoints(seen)
  // BODY's camera axes are MediaPipe's world axes with y and z reversed.
  const world = seen.map(([x, y, z]) => ({ x, y: -y, z: -z, visibility: 0.95 }))
  return { worldLandmarks: [world], landmarks: [world.map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }))] }
}
export interface Packet {
  /** Host acceptance time, milliseconds. */
  at: number
  packet: ArrayBuffer
}
/** The phone's capture filter and wire encoding, frame by frame at 30 Hz. Absent results send nothing. */
export function capture(scene: (ms: number) => BodyResult | null, ms: number, fps = 30): Packet[] {
  const signal = new BodySignal(),
    out: Packet[] = []
  let seq = 0,
    gen = 0
  for (let i = 0; i * (1000 / fps) < ms; i++) {
    const at = 100 + i * (1000 / fps),
      result = scene(at - 100)
    if (!result) continue
    const sample = signal.sample(result, at)
    if (!sample) continue
    if (sample.acquired) gen = (gen + 1) & 255
    out.push({ at, packet: encodeBody({ ...sample.body, t: Math.round(at * 1000) >>> 0, seq: (seq = (seq + 1) & 65535), gen }) })
  }
  return out
}
export interface Rendered {
  at: number
  retargeted: Retargeted
  /** The rendered pose after control, foot support and tendons. */
  pose: Angles
  /** The rendered root heading (classical yaw plus BODY's bounded turn). */
  facing: number
  /** The rendered torso's heading in the arena. */
  torso: number
}
/** Render a recorded trace at 30 Hz on the host, including the gaps between packets. */
export function replay(packets: readonly Packet[], options: { mirror?: boolean; ms?: number; profile?: RigProfile } = {}): Rendered[] {
  const profile = options.profile ?? KEEL,
    input = new BodyInput(),
    retarget = new Retargeter(profile),
    control = new ActorControl(profile),
    balance = new FootBalance(),
    tendons = new Tendons(profile),
    out: Rendered[] = []
  retarget.setMirror(options.mirror ?? true)
  const end = options.ms ?? (packets.at(-1)?.at ?? 0) + 100
  let next = 0
  for (let at = 100; at <= end; at += 1000 / 30) {
    while (next < packets.length && packets[next].at <= at + 1e-6) input.receive(packets[next].packet, packets[next++].at)
    const body = input.read(at),
      retargeted = retarget.step(body, at)
    const q = control.step(1 / 30, restIntent(), body ? retargeted.q : null, retargeted.heading)
    const support = balance.step(profile, q, 1 / 30, control.moving),
      pose = { ...tendons.step(support.q, { left: 0, right: 0 }, 1 / 30) }
    const chest = new Vector3(0, 0, -1).applyQuaternion(forward(profile, pose).get(profile.frame!.spine[2])!.q)
    out.push({ at, retargeted, pose, facing: control.facing, torso: control.facing + Math.atan2(-chest.x, -chest.z) })
  }
  return out
}
export const standing = (): Angles => ({
  ...neutral(KEEL),
  'left.arm.roll': rad(30),
  'right.arm.roll': rad(30),
  'left.arm.elbow': rad(20),
  'right.arm.elbow': rad(20),
})
/**
 * The recorded scene: stand facing the camera for calibration, turn left to side-on and hold, continue to a half turn,
 * return to face the camera and hold. Centimetre noise across the picture, three centimetres in depth.
 */
export function turnScene() {
  const random = noise(11)
  return (ms: number) => {
    const t = ms / 1000,
      degrees = t < 1.2 ? 0 : t < 2.2 ? 90 * (t - 1.2) : t < 3 ? 90 : t < 3.9 ? 90 + 100 * (t - 3) : t < 4.4 ? 180 : t < 6.2 ? 180 - 100 * (t - 4.4) : 0
    return personResult({ q: standing(), heading: rad(degrees) }, { jitter: 0.008, depth: 0.03 }, random)
  }
}
export const TURN_MS = 7400
const encode = (packet: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(packet)))
const decode = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer as ArrayBuffer
export interface Recording {
  note: string
  fps: number
  frames: { at: number; body: string }[]
}
/** tests/fixtures/body-turn-trace.json is JSON.stringify(record(capture(turnScene(), TURN_MS), RECORDING_NOTE)). */
export const RECORDING_NOTE =
  'Synthetic, not a person: tests/humanoid-body-trace.ts turnScene() through BodySignal and encodeBody (BODY v1, 30 Hz). Host acceptance ms and base64 packets.'
export const record = (packets: readonly Packet[], note = RECORDING_NOTE): Recording => ({
  note,
  fps: 30,
  frames: packets.map((p) => ({ at: Math.round(p.at * 1000) / 1000, body: encode(p.packet) })),
})
export const playback = (recording: Recording): Packet[] => recording.frames.map((f) => ({ at: f.at, packet: decode(f.body) }))

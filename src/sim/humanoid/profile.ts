/** Named articulated profiles. The tree and two-link chains are independent of a body shape. */
import type { Vec3 } from '@obpal/core'

export type Angles = Record<string, number>
export interface Joint {
  id: string
  parent: string | null
  offset: Vec3
  axis: Vec3
  limits: readonly [number, number]
}
export interface Chain {
  id: string
  group: string
  parent: string
  points: readonly [number, number, number]
  joints: readonly [string, string, string, string]
  lengths: readonly [number, number]
  side: number
  bend: number
  end: string
  distal: readonly string[]
  tips: readonly [number, number]
}
export interface RigProfile {
  id: string
  root: string
  joints: readonly Joint[]
  chains: readonly Chain[]
  height: number
  calibrationId?: string
  model?: 'cairn-i' | 'cairn-ii' | 'rill-i' | 'rill-ii' | 'hush-i' | 'hush-ii'
  /**
   * Visual-only face signature: the eye line and the face-glass ellipsoid the
   * lights lie on, [centre y, centre z, radius x, radius y, radius z] in the
   * 1.8 m authoring frame (humanoid-forms.json carries the same values).
   */
  face?: { horizon: boolean; centre: number; surface: readonly [number, number, number, number, number] }
  /** Original sim-only tendon envelopes; driver reference profiles omit these. */
  compliance?: {
    stiffness: number
    damping: number
    wristTravel: number
    ankleTravel: number
    fingers: readonly [number, number, number]
  }
  skins: readonly {
    joint: string
    size: Vec3
    offset: Vec3
    finish: 'shell' | 'trim' | 'glass' | 'accent' | 'metal'
    axle?: boolean
  }[]
  mirror?: Readonly<Record<string, { joint: string; sign: number }>>
  frame?: {
    hips: readonly [number, number]
    shoulders: readonly [number, number]
    spine: readonly [string, string, string]
    head: readonly [string, string]
    ears: readonly [number, number]
    nose: number
  }
}
export const rad = (n: number) => (n * Math.PI) / 180
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const joints: Joint[] = []
function joint(id: string, parent: string | null, offset: Vec3, axis: Vec3, lo: number, hi: number) {
  joints.push({ id, parent, offset, axis, limits: [rad(lo), rad(hi)] })
  return id
}
joint('pelvis', null, [0, 0.92, 0], [0, 1, 0], 0, 0)
joint('spine.yaw', 'pelvis', [0, 0.12, 0], [0, 1, 0], -35, 35)
joint('spine.pitch', 'spine.yaw', [0, 0, 0], [1, 0, 0], -20, 30)
joint('spine.roll', 'spine.pitch', [0, 0, 0], [0, 0, 1], -20, 20)
joint('head.yaw', 'spine.roll', [0, 0.47, 0], [0, 1, 0], -60, 60)
joint('head.pitch', 'head.yaw', [0, 0, 0], [1, 0, 0], -35, 45)
const chains: Chain[] = []
for (const [side, s, i] of [
  ['left', -1, 0],
  ['right', 1, 1],
] as const) {
  const a = `${side}.arm`,
    l = `${side}.leg`
  joint(`${a}.roll`, 'spine.roll', [s * 0.26, 0.36, 0], [0, 0, s], -15, 110)
  joint(`${a}.pitch`, `${a}.roll`, [0, 0, 0], [1, 0, 0], -80, 140)
  joint(`${a}.yaw`, `${a}.pitch`, [0, 0, 0], [0, 1, 0], -70, 70)
  joint(`${a}.elbow`, `${a}.yaw`, [0, -0.29, 0], [1, 0, 0], 0, 140)
  joint(`${a}.wrist.roll`, `${a}.elbow`, [0, -0.26, 0], [0, 1, 0], -90, 90)
  joint(`${a}.wrist.pitch`, `${a}.wrist.roll`, [0, 0, 0], [1, 0, 0], -45, 45)
  joint(`${a}.wrist.yaw`, `${a}.wrist.pitch`, [0, 0, 0], [0, 0, 1], -35, 35)
  joint(`${l}.roll`, 'pelvis', [s * 0.15, 0, 0], [0, 0, s], -25, 45)
  joint(`${l}.pitch`, `${l}.roll`, [0, 0, 0], [1, 0, 0], -35, 100)
  joint(`${l}.yaw`, `${l}.pitch`, [0, 0, 0], [0, 1, 0], -35, 35)
  joint(`${l}.knee`, `${l}.yaw`, [0, -0.43, 0], [-1, 0, 0], 0, 130)
  joint(`${l}.ankle.pitch`, `${l}.knee`, [0, -0.41, 0], [1, 0, 0], -35, 25)
  joint(`${l}.ankle.roll`, `${l}.ankle.pitch`, [0, 0, 0], [0, 0, 1], -20, 20)
  chains.push({
    id: a,
    group: 'arms',
    parent: 'spine.roll',
    points: [11 + i, 13 + i, 15 + i],
    joints: [`${a}.roll`, `${a}.pitch`, `${a}.yaw`, `${a}.elbow`],
    lengths: [0.29, 0.26],
    side: s,
    bend: 1,
    end: `${a}.wrist.yaw`,
    distal: [`${a}.wrist.roll`, `${a}.wrist.pitch`, `${a}.wrist.yaw`],
    tips: [19 + i, 17 + i],
  })
  chains.push({
    id: l,
    group: 'legs',
    parent: 'pelvis',
    points: [23 + i, 25 + i, 27 + i],
    joints: [`${l}.roll`, `${l}.pitch`, `${l}.yaw`, `${l}.knee`],
    lengths: [0.43, 0.41],
    side: s,
    bend: -1,
    end: `${l}.ankle.roll`,
    distal: [`${l}.ankle.pitch`, `${l}.ankle.roll`],
    tips: [29 + i, 31 + i],
  })
}
const skins: RigProfile['skins'][number][] = [
  { joint: 'pelvis', size: [0.32, 0.17, 0.21], offset: [0, 0, 0], finish: 'shell' },
  { joint: 'spine.yaw', size: [0.14, 0.14, 0.13], offset: [0, 0.01, 0], finish: 'metal' },
  { joint: 'spine.roll', size: [0.43, 0.31, 0.22], offset: [0, 0.2, 0], finish: 'shell' },
  { joint: 'spine.roll', size: [0.1, 0.23, 0.025], offset: [0, 0.22, -0.125], finish: 'glass' },
  { joint: 'spine.roll', size: [0.018, 0.21, 0.028], offset: [0, 0.22, -0.145], finish: 'accent' },
  { joint: 'head.pitch', size: [0.2, 0.19, 0.2], offset: [0, 0.08, 0], finish: 'shell' },
  { joint: 'head.yaw', size: [0.08, 0.1, 0.08], offset: [0, -0.035, 0], finish: 'metal' },
  { joint: 'head.pitch', size: [0.17, 0.028, 0.022], offset: [0, 0.1, -0.112], finish: 'accent' },
]
for (const c of chains) {
  const arm = c.group === 'arms'
  skins.push(
    {
      joint: c.joints[2],
      size: [arm ? 0.12 : 0.16, c.lengths[0] - 0.07, arm ? 0.14 : 0.18],
      offset: [0, -c.lengths[0] / 2, 0],
      finish: 'shell',
    },
    {
      joint: c.joints[3],
      size: [arm ? 0.14 : 0.13, c.lengths[1] - 0.07, arm ? 0.15 : 0.16],
      offset: [0, -c.lengths[1] / 2, 0],
      finish: 'shell',
    },
    {
      joint: c.end,
      size: [arm ? 0.15 : 0.18, arm ? 0.14 : 0.11, arm ? 0.15 : 0.32],
      offset: [0, arm ? -0.05 : -0.025, arm ? 0 : -0.055],
      finish: 'trim',
    },
    { joint: c.joints[3], size: [arm ? 0.066 : 0.085, 0.15, 0], offset: [0, 0, 0], finish: 'metal', axle: true },
  )
}
const mirror = Object.fromEntries(
  joints.map((j) => [
    j.id,
    {
      joint: j.id.startsWith('left.')
        ? j.id.replace('left.', 'right.')
        : j.id.startsWith('right.')
          ? j.id.replace('right.', 'left.')
          : j.id,
      sign: j.axis[0] || j.id.endsWith('.arm.roll') || j.id.endsWith('.leg.roll') ? 1 : -1,
    },
  ]),
)
export const HUMANOID = {
  id: 'humanoid-v1',
  root: 'pelvis',
  height: 1.8,
  joints,
  chains,
  skins,
  mirror,
  frame: {
    hips: [23, 24],
    shoulders: [11, 12],
    spine: ['spine.yaw', 'spine.pitch', 'spine.roll'],
    head: ['head.yaw', 'head.pitch'],
    ears: [7, 8],
    nose: 0,
  },
} satisfies RigProfile
export const KEEL: RigProfile = {
  ...HUMANOID,
  id: 'keel-v1',
  calibrationId: HUMANOID.id,
  compliance: { stiffness: 196, damping: 24, wristTravel: 1.3, ankleTravel: 1.45, fingers: [0.72, 1.05, 0.8] },
}
const scale = 1.65 / 1.8
export const MORROW: RigProfile = {
  ...HUMANOID,
  id: 'morrow-v1',
  calibrationId: HUMANOID.id,
  height: 1.65,
  compliance: { stiffness: 256, damping: 29, wristTravel: 1.25, ankleTravel: 1.4, fingers: [0.68, 1, 0.76] },
  joints: joints.map((j) => ({
    ...j,
    offset: j.offset.map((n, axis) =>
      axis === 0 && j.id.endsWith('.arm.roll')
        ? Math.sign(n) * 0.21
        : axis === 0 && j.id.endsWith('.leg.roll')
          ? Math.sign(n) * 0.18
          : n * scale,
    ) as Vec3,
    limits: [j.limits[0], j.id.endsWith('.elbow') ? rad(130) : j.id.endsWith('.arm.pitch') ? rad(130) : j.limits[1]],
  })),
  chains: chains.map((c) => ({ ...c, lengths: [c.lengths[0] * scale, c.lengths[1] * scale] })),
  skins: skins.map((s) => ({
    ...s,
    size: s.size.map((n) => n * scale) as Vec3,
    offset: s.offset.map((n) => n * scale) as Vec3,
  })),
}
/** Face glass and eye line per soft direction, unscaled; see assets/blender/humanoid-forms.json. */
export const SOFT_FACES = {
  cairn: { eyes: 0.165, surface: [0.16, -0.018, 0.068, 0.102, 0.082] },
  rill: { eyes: 0.176, surface: [0.176, -0.006, 0.083, 0.06, 0.094] },
  hush: { eyes: 0.172, surface: [0.172, -0.045, 0.062, 0.045, 0.052] },
} as const
/** Original soft-cover forms share the calibration and tendon contract, with their own proportions. */
function softProfile(name: 'cairn' | 'rill' | 'hush', form: 'i' | 'ii'): RigProfile {
  const scale = form === 'i' ? 1.73 / 1.8 : 1
  return {
    ...HUMANOID,
    id: `${name}-${form}-v1`,
    model: `${name}-${form}`,
    calibrationId: HUMANOID.id,
    height: 1.8 * scale,
    face: { horizon: name === 'rill', centre: SOFT_FACES[name].eyes * scale, surface: SOFT_FACES[name].surface },
    compliance: { stiffness: 225, damping: 27, wristTravel: 1.3, ankleTravel: 1.45, fingers: [0.70, 1.02, 0.78] },
    joints: joints.map((joint) => ({
      ...joint,
      offset: joint.offset.map((n, axis) =>
        axis === 0 && joint.id.endsWith('.arm.roll')
          ? Math.sign(n) * (form === 'i' ? 0.225 : 0.26) * scale
          : axis === 0 && joint.id.endsWith('.leg.roll')
            ? Math.sign(n) * (form === 'i' ? 0.18 : 0.15) * scale
            : n * scale,
      ) as Vec3,
    })),
    chains: chains.map((chain) => ({ ...chain, lengths: [chain.lengths[0] * scale, chain.lengths[1] * scale] })),
    skins: skins.map((skin) => ({ ...skin, size: skin.size.map((n) => n * scale) as Vec3, offset: skin.offset.map((n) => n * scale) as Vec3 })),
  }
}
export const SOFT_PROFILES = {
  cairn: [softProfile('cairn', 'i'), softProfile('cairn', 'ii')],
  rill: [softProfile('rill', 'i'), softProfile('rill', 'ii')],
  hush: [softProfile('hush', 'i'), softProfile('hush', 'ii')],
} as const
export const ROBOTS = [
  { id: 'keel', name: 'Keel', forms: [KEEL] },
  { id: 'morrow', name: 'Morrow', forms: [MORROW] },
] as const
const SOFT_ROBOTS = [
  { id: 'cairn', name: 'Cairn', forms: SOFT_PROFILES.cairn },
  { id: 'rill', name: 'Rill', forms: SOFT_PROFILES.rill },
  { id: 'hush', name: 'Hush', forms: SOFT_PROFILES.hush },
] as const
export const robotRoster = (preview = false) => preview ? [...ROBOTS, ...SOFT_ROBOTS] : ROBOTS
export const mirrorAngles = (p: RigProfile, q: Angles): Angles =>
  Object.fromEntries(
    p.joints.map((j) => {
      const m = p.mirror?.[j.id]
      return [j.id, m ? (q[m.joint] ?? 0) * m.sign : (q[j.id] ?? 0)]
    }),
  )
export const neutral = (p: RigProfile): Angles => Object.fromEntries(p.joints.map((j) => [j.id, 0]))
export function bounded(p: RigProfile, q: Angles): Angles {
  return Object.fromEntries(p.joints.map((j) => [j.id, clamp(Number.isFinite(q[j.id]) ? q[j.id] : 0, ...j.limits)]))
}

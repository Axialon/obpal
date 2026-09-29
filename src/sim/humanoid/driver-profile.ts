/** Explicit wire maps for the simulated reference, G1 arm7 and H1 arm4 bridges.
 * Limits are conservative test envelopes, not vendor commissioning data. */
import { HUMANOID, rad, type RigProfile } from './profile'

export type DriverKind = 'ros' | 'g1' | 'h1'
export interface DriverJoint {
  id: string
  wire: string
  index: number
  sign: 1 | -1
  zero: number
  group: 'upper' | 'legs'
  limits: [number, number]
  speed: number
  acceleration: number
}
export interface DriverProfile {
  id: string
  kind: DriverKind
  label: string
  revision: string
  units: 'radians'
  feedback: 'measured'
  simulated: boolean
  stop: 'measured-hold' | 'controlled-damp'
  joints: DriverJoint[]
  rig: RigProfile
  legs: { capable: boolean; commissioning: string | null }
}

// Indices describe the cited SDK examples, not every firmware or model variant.
const g1 = [
  'left.leg.pitch',
  'left.leg.roll',
  'left.leg.yaw',
  'left.leg.knee',
  'left.leg.ankle.pitch',
  'left.leg.ankle.roll',
  'right.leg.pitch',
  'right.leg.roll',
  'right.leg.yaw',
  'right.leg.knee',
  'right.leg.ankle.pitch',
  'right.leg.ankle.roll',
  'spine.yaw',
  'spine.roll',
  'spine.pitch',
  'left.arm.pitch',
  'left.arm.roll',
  'left.arm.yaw',
  'left.arm.elbow',
  'left.arm.wrist.roll',
  'left.arm.wrist.pitch',
  'left.arm.wrist.yaw',
  'right.arm.pitch',
  'right.arm.roll',
  'right.arm.yaw',
  'right.arm.elbow',
  'right.arm.wrist.roll',
  'right.arm.wrist.pitch',
  'right.arm.wrist.yaw',
]
const h1 = [
  'right.leg.roll',
  'right.leg.pitch',
  'right.leg.knee',
  'left.leg.roll',
  'left.leg.pitch',
  'left.leg.knee',
  'spine.yaw',
  'left.leg.yaw',
  'right.leg.yaw',
  '',
  'left.leg.ankle.pitch',
  'right.leg.ankle.pitch',
  'right.arm.pitch',
  'right.arm.roll',
  'right.arm.yaw',
  'right.arm.elbow',
  'left.arm.pitch',
  'left.arm.roll',
  'left.arm.yaw',
  'left.arm.elbow',
]
export function fakeProfile(kind: DriverKind): DriverProfile {
  const map = kind === 'g1' ? g1 : kind === 'h1' ? h1 : HUMANOID.joints.filter((j) => j.parent).map((j) => j.id)
  return {
    id: `obpal-${kind}-test-v1`,
    kind,
    label: kind === 'ros' ? 'ROS 2 reference' : kind === 'g1' ? 'Unitree G1 · arm7' : 'Unitree H1 · arm4',
    revision: 'simulation-1',
    units: 'radians',
    feedback: 'measured',
    simulated: true,
    stop: kind === 'h1' ? 'controlled-damp' : 'measured-hold',
    rig: HUMANOID,
    legs: { capable: false, commissioning: null },
    joints: map.flatMap((id, index) => {
      if (!id) return []
      const joint = HUMANOID.joints.find((j) => j.id === id)!
      return [
        {
          id,
          index,
          wire: kind === 'ros' ? id.replaceAll('.', '_') : `${kind}_motor_${index}`,
          // The simulator's lateral axes are outward-positive; wire axes are signed.
          sign: id.endsWith('.roll') && id.startsWith('left.') ? (-1 as const) : (1 as const),
          zero: 0,
          group: id.includes('.leg.') ? ('legs' as const) : ('upper' as const),
          limits: id.startsWith('spine.')
            ? ([-rad(15), rad(15)] as [number, number])
            : ([...joint.limits] as [number, number]),
          speed: kind === 'h1' ? 0.3 : kind === 'g1' ? 0.35 : 0.5,
          acceleration: kind === 'h1' ? 0.6 : kind === 'g1' ? 0.7 : 1,
        },
      ]
    }),
  }
}
/** Exact identity includes the map and envelopes; a copied label cannot verify a swapped mapping. */
export const profileKey = (p: DriverProfile) =>
  JSON.stringify({
    id: p.id,
    revision: p.revision,
    units: p.units,
    feedback: p.feedback,
    stop: p.stop,
    joints: p.joints,
    legs: p.legs,
    rig: p.rig,
  })
export const upperJoints = (p: DriverProfile) => p.joints.filter((j) => j.group === 'upper')
export const toWire = (j: DriverJoint, value: number) => j.zero + j.sign * value
export const fromWire = (j: DriverJoint, value: number) => (value - j.zero) / j.sign

/** There is no commissioning authority or leg-enable implementation in this release. */
export function legRefusal(p: DriverProfile) {
  if (!p.legs.capable) return 'Legs locked: this driver has no commissioned leg capability.'
  if (!p.legs.commissioning) return 'Legs locked: commissioning evidence is required.'
  return 'Legs locked: commissioning evidence cannot be verified by this build.'
}

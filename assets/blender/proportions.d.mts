import type * as THREE from 'three'
import type { RigProfile } from '../../src/sim/humanoid/profile'

export function partPoints(scene: THREE.Object3D, pivots: Set<string>): Map<string, THREE.Vector3[]>
export function measure(scene: THREE.Object3D, profile: RigProfile): Record<
  'height' | 'headHeight' | 'headsTall' | 'headBreadth' | 'headDepthRatio' | 'shoulderSpan' | 'upperArmWidth' | 'hipBreadth' | 'waistBreadth' | 'waistToHip',
  number
>
export function shoe(scene: THREE.Object3D, profile: RigProfile): {
  box: { min: number[]; max: number[] }
  min: number[]
  max: number[]
  lengthCoverage: number
  toeSpring: number
}

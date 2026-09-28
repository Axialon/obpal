/** A phone's reach fitted to a particular arm, before its IK and collision limits. */
import { unit, type Reach } from '../../control-space'
import { planar } from '../vr/intent'
export function armWorkspace(aim: Reach, yaw: Reach, reach: Reach, frameYaw?: number): { yaw: number; reach: number; x: number; z: number } {
  if (frameYaw !== undefined) {
    const centre = armWorkspace([0, 0], yaw, reach)
    const [dx, dz] = planar({ yaw: frameYaw, heading: 0, immersive: false }, unit(aim[0]) * reach[1] * 0.6, -unit(aim[1]) * (reach[1] - reach[0]) / 2)
    const x = centre.x + dx, z = centre.z + dz
    const angle = Math.max(yaw[0], Math.min(yaw[1], Math.atan2(z, -x) * 180 / Math.PI))
    const radius = Math.max(reach[0], Math.min(reach[1], Math.hypot(x, z)))
    return { yaw: angle, reach: radius, x: -Math.cos(angle * Math.PI / 180) * radius, z: Math.sin(angle * Math.PI / 180) * radius }
  }
  const angle = yaw[0] + (unit(aim[0]) + 1) * (yaw[1] - yaw[0]) / 2
  const radius = reach[0] + (unit(aim[1]) + 1) * (reach[1] - reach[0]) / 2
  return { yaw: angle, reach: radius, x: -Math.cos(angle * Math.PI / 180) * radius, z: Math.sin(angle * Math.PI / 180) * radius }
}
export function armHeight(y: number, height: Reach) { return height[0] + (unit(y) + 1) * (height[1] - height[0]) / 2 }

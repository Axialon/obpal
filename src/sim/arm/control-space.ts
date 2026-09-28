/** A phone's reach fitted to a particular arm, before its IK and collision limits. */
import { unit, type Reach } from '../../control-space'
export function armWorkspace(aim: Reach, yaw: Reach, reach: Reach) {
  const angle = yaw[0] + (unit(aim[0]) + 1) * (yaw[1] - yaw[0]) / 2
  const radius = reach[0] + (unit(aim[1]) + 1) * (reach[1] - reach[0]) / 2
  return { yaw: angle, reach: radius, x: -Math.cos(angle * Math.PI / 180) * radius, z: Math.sin(angle * Math.PI / 180) * radius }
}
export function armHeight(y: number, height: Reach) { return height[0] + (unit(y) + 1) * (height[1] - height[0]) / 2 }

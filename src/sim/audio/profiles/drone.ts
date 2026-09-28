/** Drone sound follows its logic, independent of the rendered model. */
import type { DroneLogic } from '../../devices/drone'
import { profile, sample } from '../profile'

export default profile<DroneLogic>({
  id: 'drone', space: 'sky', materials: ['plastic', 'metal'], texture: 'rotor', pitch: 1.3, distance: 4, action: 'launch',
}, (logic, n, out) => {
  const u = logic.drones[n]
  sample(out, u.x, u.y, u.z, u.rotor, 0.28 + Math.abs(u.vy) / 5 + Math.hypot(u.pitch, u.roll) * 0.6, 0, 0, u.pitch, u.roll)
})


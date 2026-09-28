/** Football sound follows its logic, independent of the rendered model. */
import type { FootballLogic } from '../../devices/football'
import { profile, sample } from '../profile'

export default profile<FootballLogic>({
  id: 'football', space: 'room', materials: ['plastic', 'wood'], texture: 'servo', pitch: 0.65, distance: 2, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, (n % 2 ? 1 : -1) * 0.7, 0.9, (n - 1.5) * 0.5, 0, 0, 0, 0, u.x, u.angle)
})


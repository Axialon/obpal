/** Plane sound follows its logic, independent of the rendered model. */
import type { PlaneLogic } from '../../devices/plane'
import { profile, sample } from '../profile'

export default profile<PlaneLogic>({
  id: 'plane', space: 'sky', materials: ['wood', 'rubber'], texture: 'engine', pitch: 1.2, distance: 6, action: 'launch',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, u.y, u.z, u.powered ? 0.2 + u.throttle * 0.8 : 0, u.throttle, u.y < 0.3 ? u.v / 8 : 0, 0, u.pitch, u.bank)
})


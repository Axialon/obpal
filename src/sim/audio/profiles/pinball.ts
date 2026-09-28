/** Pinball sound follows its logic, independent of the rendered model. */
import type { PinballLogic } from '../../devices/pinball'
import { profile, sample } from '../profile'

export default profile<PinballLogic>({
  id: 'pinball', space: 'hall', materials: ['metal', 'rubber'], texture: 'roll', pitch: 1.3, distance: 2, action: 'launch',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, (n - 0.5) * 1.9 + u.x, 1.02, u.z, 0, 0, u.active ? Math.hypot(u.vx, u.vz) / 7 : 0, 0, u.left * 0.1, u.right * 0.1)
})


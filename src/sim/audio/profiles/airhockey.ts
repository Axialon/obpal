/** Airhockey sound follows its logic, independent of the rendered model. */
import type { AirhockeyLogic } from '../../devices/airhockey'
import { profile, sample } from '../profile'

export default profile<AirhockeyLogic>({
  id: 'airhockey', space: 'hall', materials: ['plastic', 'wood'], texture: 'scrape', pitch: 0.9, distance: 2, action: 'launch',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 0.9, u.z, 0, 0, Math.hypot(u.vx, u.vz) / 6)
})


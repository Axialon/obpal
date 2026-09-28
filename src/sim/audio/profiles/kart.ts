/** Kart sound follows its logic, independent of the rendered model. */
import type { KartLogic } from '../../devices/kart'
import { profile, sample } from '../profile'

export default profile<KartLogic>({
  id: 'kart', space: 'yard', materials: ['rubber', 'metal'], texture: 'engine', pitch: 1, distance: 5, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 0.35, u.z, u.v / 8, u.drift ? 1 : Math.abs(u.v) / 8, u.drift ? Math.abs(u.v) / 8 : 0)
})


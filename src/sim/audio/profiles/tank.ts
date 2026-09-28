/** Tank sound follows its logic, independent of the rendered model. */
import type { TankLogic } from '../../devices/tank'
import { profile, sample } from '../profile'

export default profile<TankLogic>({
  id: 'tank', space: 'yard', materials: ['metal', 'metal'], texture: 'engine', pitch: 0.65, distance: 4, action: 'fire',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 0.7, u.z, u.v / 3, u.v / 3, u.v / 3, 0, u.turret, u.elevation)
})


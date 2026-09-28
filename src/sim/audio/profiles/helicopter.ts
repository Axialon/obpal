/** Helicopter sound follows its logic, independent of the rendered model. */
import type { HelicopterLogic } from '../../devices/helicopter'
import { profile, sample } from '../profile'

export default profile<HelicopterLogic>({
  id: 'helicopter', space: 'sky', materials: ['metal', 'rubber'], texture: 'rotor', pitch: 0.65, distance: 5, action: 'launch',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, u.y, u.z, u.rotor, 0.35 + u.collective * 0.3, 0, 0, u.pitch, u.roll)
})


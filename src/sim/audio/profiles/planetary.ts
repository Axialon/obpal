/** Planetary sound follows its logic, independent of the rendered model. */
import type { PlanetaryLogic } from '../../devices/planetary'
import { profile, sample } from '../profile'

export default profile<PlanetaryLogic>({
  id: 'planetary', space: 'sky', materials: ['metal', 'tile'], texture: 'motor', pitch: 0.65, distance: 5, action: 'grab',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, u.y + 0.5, u.z, u.v / 3, u.sampling ? 0.9 : 0.2, u.v / 3, 0, u.swing, u.boom, u.mastPan, u.mastTilt)
})


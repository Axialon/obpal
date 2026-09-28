/** Telescope sound follows its logic, independent of the rendered model. */
import type { TelescopeLogic } from '../../devices/telescope'
import { profile, sample } from '../profile'

export default profile<TelescopeLogic>({
  id: 'telescope', space: 'sky', materials: ['metal', 'plastic'], texture: 'servo', pitch: 0.6, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, n * 3, 1.7, 0, 0, 0, 0, 0, u.pan, u.elevation)
})


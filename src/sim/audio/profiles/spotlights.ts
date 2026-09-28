/** Spotlights sound follows its logic, independent of the rendered model. */
import type { SpotlightsLogic } from '../../devices/spotlights'
import { profile, sample } from '../profile'

export default profile<SpotlightsLogic>({
  id: 'spotlights', space: 'hall', materials: ['metal', 'plastic'], texture: 'servo', pitch: 0.8, distance: 4, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, 3, u.z, 0, 0, 0, 0, u.pan, u.tilt)
})


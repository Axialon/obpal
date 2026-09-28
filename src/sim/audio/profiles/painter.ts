/** Painter sound follows its logic, independent of the rendered model. */
import type { PainterLogic } from '../../devices/painter'
import { profile, sample } from '../profile'

export default profile<PainterLogic>({
  id: 'painter', space: 'room', materials: ['plastic', 'glass'], texture: 'scrape', pitch: 0.7, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, u.x, u.y, u.z, 0, 0, 0, 0, u.x, u.y, u.z)
})


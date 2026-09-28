/** Slider sound follows its logic, independent of the rendered model. */
import type { SliderLogic } from '../../devices/slider'
import { profile, sample } from '../profile'

export default profile<SliderLogic>({
  id: 'slider', space: 'room', materials: ['metal', 'plastic'], texture: 'servo', pitch: 0.9, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  sample(out, n * 5 + u.x, 1.2, 0, 0, 0, 0, 0, u.x, u.pan, u.tilt)
})

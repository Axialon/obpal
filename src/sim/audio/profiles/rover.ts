/** Rover sound follows its logic, independent of the rendered model. */
import type { RoverLogic } from '../../devices/rover'
import { profile, sample } from '../profile'

export default profile<RoverLogic>({
  id: 'rover', space: 'yard', materials: ['rubber', 'tile'], texture: 'motor', pitch: 1, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.rovers[n]
  // Motor and tyre grain share one buffer and panner on each small chassis.
  sample(out, u.x, 0.3, u.z, u.v / 4, Number(!u.braking))
})

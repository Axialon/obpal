/** Marblerun sound follows its logic, independent of the rendered model. */
import { marblePitch, marblePosition, type MarblerunLogic } from '../../devices/marblerun'
import { profile, sample } from '../profile'
import { glassDragParameters } from '../materials'

export default profile<MarblerunLogic>({
  id: 'marblerun', space: 'room', materials: ['glass', 'glass'], texture: 'roll', pitch: 1, distance: 3, action: 'tick',
}, (logic, n, out) => {
  const u = logic.units[n]
  const at = marblePosition(n, u, u.tiltX, u.tiltZ)
  sample(out, ...at)
}, (logic, n, emit) => {
  const u = logic.units[n]
  for (const m of [u, ...u.marbles]) {
    const at = marblePosition(n, m, u.tiltX, u.tiltZ), speed = Math.hypot(m.vx, m.vz), source = `marblerun${n}:marble${m.id}`
    const drag = glassDragParameters(m.slip, m.normalForce / (m.mass * 9.81))
    emit({ kind: 'sustain', source, at, strength: Math.min(1, speed / 1.5), glass: 'roll', pitch: 0.8 + Math.min(1, speed) * 0.35, velocity: [m.vx, 0, m.vz] })
    emit({ kind: 'sustain', source, at, strength: drag.strength, glass: 'drag', pitch: drag.rate * marblePitch(m), velocity: [m.vx, 0, m.vz] })
  }
})


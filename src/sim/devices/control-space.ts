/** Translate calibrated reach into each device's physical space, without consulting the camera. */
import { Mode } from '@obpal/core'
import { CONTROL_SPACES, nearest, sceneCells, unit, type Reach, type ControlScope } from '../../control-space'
import type { DeviceInput } from './types'
import { CLAW, CABINETS } from './claw'
import { ROVER } from './rover'

export const sceneSelects = (id: string) => !['airhockey', 'football', 'pinball', 'slotcars'].includes(id)
export function deviceTarget(id: string, scope: ControlScope, seat: number, aim: Reach, count: number) {
  return scope === 'scene' && sceneSelects(id) ? nearest(sceneCells(count).map(([x, y], n) => ({ x, y, n })), aim).n : seat
}

/** Ground targets use the same bounds as the device's collision and travel limits. */
export function controlSpot(id: string, aim: Reach, n: number): [number, number] | null {
  const [x, y] = aim.map(unit)
  switch (id) {
    case 'claw': return [CABINETS[n][0] + x * (CLAW.half - 0.04), CABINETS[n][1] - y * (CLAW.half - 0.04)]
    case 'rover': return [x * (ROVER.yard[0] - ROVER.radius), -y * (ROVER.yard[1] - ROVER.radius)]
    case 'vacuum': return [x * 4.4, -y * 3.4]
    case 'spotlights': return [x * 5, 1.5 - y * 2.5]
    case 'sorting': return [(n ? 2 : -2) + x * 0.9, 0]
    case 'airhockey': return [x * 0.86, (n ? -1 : 1) * (0.8 - y * 0.66)]
    default: return null
  }
}

/** Legacy clients keep their original path; physical sticks retain their own response. */
export function mapDeviceSpace(id: string, input: DeviceInput, n: number): DeviceInput {
  const space = input.space, profile = CONTROL_SPACES[id]
  if (!space || !profile || input.quiet || input.pad || input.mode === Mode.track) return input
  const mapped = { ...input }
  if (profile.kind === 'drive' || profile.kind === 'tilt') {
    if (!input.point && id !== 'tank') { mapped.mode = Mode.tilt; mapped.hold = null; mapped.tilt = [...space.tilt] }
  }
  if (input.point || profile.kind === 'point') {
    mapped.point = { x: input.point?.x ?? 0, y: input.point?.y ?? 0, yaw: space.aim[0] * profile.reach[0], pitch: space.aim[1] * profile.reach[1], off: false }
    mapped.spot = controlSpot(id, space.aim, n)
  }
  return mapped
}

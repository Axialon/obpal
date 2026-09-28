/** Fit calibrated reach to device bounds, then orient its spatial intent through the active view. */
import { Mode } from '@obpal/core'
import { CONTROL_SPACES, nearest, sceneCells, unit, type Reach, type ControlScope } from '../../control-space'
import type { DeviceInput } from './types'
import { CLAW, CABINETS } from './claw'
import { ROVER } from './rover'
import { planar, rail, type InputFrame } from '../vr/intent'

export const sceneSelects = (id: string) => !['airhockey', 'football', 'pinball', 'slotcars'].includes(id)
export function deviceTarget(id: string, scope: ControlScope, seat: number, aim: Reach, count: number) {
  return scope === 'scene' && sceneSelects(id) ? nearest(sceneCells(count).map(([x, y], n) => ({ x, y, n })), aim).n : seat
}

/** Ground targets use the same bounds as the device's collision and travel limits. */
export function controlSpot(id: string, aim: Reach, n: number, frame?: InputFrame): [number, number] | null {
  const [x, y] = aim.map(unit)
  let bounds: [number, number, number, number]
  switch (id) {
    case 'claw': bounds = [CABINETS[n][0], CABINETS[n][1], CLAW.half - 0.04, CLAW.half - 0.04]; break
    case 'rover': bounds = [0, 0, ROVER.yard[0] - ROVER.radius, ROVER.yard[1] - ROVER.radius]; break
    case 'vacuum': bounds = [0, 0, 4.4, 3.4]; break
    case 'spotlights': bounds = [0, 1.5, 5, 2.5]; break
    case 'sorting': return [(n ? 2 : -2) + x * 0.9 * rail(frame), 0]
    case 'airhockey':
      if (!frame) return [x * 0.86, (n ? -1 : 1) * (0.8 - y * 0.66)]
      bounds = [0, (n ? -1 : 1) * 0.8, 0.86, 0.66]; break
    default: return null
  }
  const [cx, cz, width, depth] = bounds, [dx, dz] = planar(frame, x * width, -y * depth)
  return [cx + Math.max(-width, Math.min(width, dx)), cz + Math.max(-depth, Math.min(depth, dz))]
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
    mapped.spot = controlSpot(id, space.aim, n, input.controlFrame)
  }
  return mapped
}

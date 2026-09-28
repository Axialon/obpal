import { Euler, Object3D, Quaternion, Vector3 } from 'three'
import type { DeviceLogic } from '../devices/types'
import { roverGround } from '../devices/rover'
import { jibTip } from '../devices/jib'

export interface Ride { id: string; name: string; pose(): { p: Vector3; q: Quaternion }; horizon?: boolean }
const flip = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)
/** Anchors use +Z forward; cameras and XR reference spaces use -Z forward. */
export function anchorPose(anchor: Object3D) {
  anchor.updateWorldMatrix(true, false)
  return { p: anchor.getWorldPosition(new Vector3()), q: anchor.getWorldQuaternion(new Quaternion()).multiply(flip) }
}

type State = Record<string, number>
const fields: Record<string, string> = { drone: 'drones', rover: 'rovers', maze: 'boards', ptz: 'cams', lamp: 'lamps', claw: 'claws' }
/** Ride height and forward offset in metres, matching each device's logic coordinate frame. */
export const DEVICE_RIGS: Record<string, [number, number]> = {
  drone: [0.1, -0.23], rover: [0.48, -0.16], kart: [0.88, 0.12], submarine: [0.18, -0.9], helicopter: [0.58, -0.88],
  boat: [0.35, -0.25], plane: [0.25, -0.25], tank: [0.62, -0.3], forklift: [0.85, -0.1], dog: [0.93, -0.4],
  vacuum: [0.22, -0.22], planetary: [1.25, -0.4], slotcars: [0.16, -0.1], excavator: [1.05, -0.5],
  ptz: [1.9, -0.15], gimbal: [1.37, -0.48], slider: [1.05, -0.15], jib: [0, -0.15], telescope: [1.7, -0.8],
  lamp: [0.75, 0], spotlights: [3.65, 0], smarthome: [1.5, 0], studio: [1.25, 1], painter: [0, 0.15],
  maze: [0.55, 0.6], claw: [1.4, 0], sorting: [1.2, 0.8], airhockey: [1.1, 2.8], football: [1.2, 1.7],
  pinball: [1.3, 1.9], marblerun: [1.4, 2], pendulum: [1.4, 1.5], trebuchet: [1.4, 0.5],
}
export function deviceState(logic: DeviceLogic, n: number): State {
  const record = logic as unknown as Record<string, State[]>
  return record[fields[logic.spec.id] ?? 'units']?.[n] ?? {}
}

export function fallbackPose(logic: DeviceLogic, n: number, at?: Vector3) {
  const id = logic.spec.id, u = deviceState(logic, n), [height, forward] = DEVICE_RIGS[id]
  const p = at?.clone() ?? new Vector3(u.x ?? (n - (logic.spec.units - 1) / 2) * 1.5, u.y ?? 0, u.z ?? 0)
  if (!at) {
    if (id === 'rover') p.y = roverGround(p.x, p.z)
    if (id === 'slider' || id === 'trebuchet') p.x += n * 5
    if (id === 'spotlights') p.set((n - 1.5) * 2, 0, -1.5)
    if (id === 'jib') p.set(n ? 2.2 : -2.2, 0, 1)
    if (id === 'jib') { const tip = jibTip(u.swing, u.boom); p.add(new Vector3(tip.x, tip.y, tip.z)) }
    if (id === 'telescope') p.x = n * 3
    if (id === 'pendulum') p.x = (n - 1) * 1.65
    if (id === 'marblerun') p.x = n * 3.8
    if (id === 'sorting') p.x = n ? 2 : -2
    if (id === 'claw') { p.x += n ? 1 : -1; p.y = u.y - 1.4 + 0.03 }
    if (id === 'maze') p.set(n % 2 ? 0.98 : -0.98, 0, n < 2 ? -0.94 : 1)
    if (id === 'pinball') p.x = n ? 2.7 : -2.7
    if (id === 'ptz') { const c = u as unknown as { at: number[] }; if (c.at) p.set(c.at[0], 0, c.at[2]) }
  }
  const q = new Quaternion().setFromEuler(new Euler(u.pitch ?? u.tilt ?? u.elevation ?? 0, u.h ?? u.yaw ?? u.pan ?? 0, u.roll && ['drone', 'helicopter', 'plane', 'gimbal'].includes(id) ? u.roll : 0, 'YXZ'))
  if (id === 'jib') q.setFromEuler(new Euler(u.tilt, u.swing + u.pan + (n ? 0.825 : -0.825), 0, 'YXZ'))
  if (id === 'gimbal') { const r = u as unknown as { q: [number, number, number, number] }; q.set(...r.q) }
  p.add(new Vector3(0, height, forward).applyQuaternion(q))
  return { p, q }
}

/** Resolve anchors lazily: optional model upgrades can replace the tree after loading. */
export function deviceRides(logic: DeviceLogic, scene: Object3D, anchor?: (n: number) => Vector3): Ride[] {
  return Array.from({ length: logic.spec.units }, (_, n) => ({
    id: `${logic.spec.id}${n + 1}`, name: logic.spec.unitNames?.[n] ?? `${logic.spec.unit} ${n + 1}`,
    horizon: ['drone', 'helicopter', 'plane', 'submarine', 'boat'].includes(logic.spec.id),
    pose() {
      const anchors: Object3D[] = []
      scene.traverse(o => { if (o.name === 'pov') anchors.push(o) })
      return anchors[n] ? anchorPose(anchors[n]) : fallbackPose(logic, n, anchor?.(n))
    },
  }))
}

export function armRide(id: string, name: string, root: Object3D, grasp: Object3D): Ride {
  return { id, name, pose: () => {
    const pov = root.getObjectByName('pov')
    if (pov) return anchorPose(pov)
    grasp.updateWorldMatrix(true, false)
    // The grasp frame's local +Y leaves the wrist between the fingers.
    const q = grasp.getWorldQuaternion(new Quaternion()).multiply(new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0)))
    return { p: grasp.localToWorld(new Vector3(0, 0.08, 0.08)), q }
  } }
}

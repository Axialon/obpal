import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three'
import type { DeviceLogic } from '../devices/types'
import { roverGround } from '../devices/rover'
import { jibTip } from '../devices/jib'
import { upright, type CameraPose } from './steady'

export type ViewStyle = 'body' | 'flyer' | 'operator' | 'lens' | 'table' | 'studio' | 'scene'
export interface Viewpoint { name: string; pose(): CameraPose; level?: boolean; follows?: boolean }
export interface Ride { id: string; name: string; pose(): CameraPose; horizon?: boolean; style?: ViewStyle; views?: Viewpoint[]; moving?(): boolean }
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
  drone: [0.16, -0.42], rover: [0.58, -0.5], kart: [0.88, -0.32], submarine: [0.18, -1.34], helicopter: [0.68, -1.2],
  boat: [0.68, -0.8], plane: [0.55, -0.95], tank: [1.2, -1.15], forklift: [1.58, -0.55], dog: [0.98, -0.96],
  vacuum: [0.26, -0.46], planetary: [1.4, -0.6], slotcars: [0.24, -0.26], excavator: [1.85, 0.7],
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
  // Height is world up, not a vector tilted about the body's origin.
  p.y += height
  p.add(new Vector3(0, 0, forward).applyQuaternion(q))
  return { p, q }
}

const bodies = new Set(['rover', 'boat', 'tank', 'kart', 'submarine', 'planetary', 'vacuum', 'forklift', 'slotcars', 'dog'])
const flyers = new Set(['drone', 'helicopter', 'plane'])
const operators = new Set(['claw', 'excavator', 'sorting', 'jib', 'painter'])
const lenses = new Set(['ptz', 'gimbal', 'telescope', 'slider', 'spotlights'])
export const deviceStyle = (id: string): ViewStyle => bodies.has(id) ? 'body' : flyers.has(id) ? 'flyer' : operators.has(id) ? 'operator' : lenses.has(id) ? 'lens' : id === 'studio' ? 'studio' : ['lamp', 'smarthome'].includes(id) ? 'scene' : 'table'

export function looking(p: Vector3, target: Vector3): CameraPose {
  return { p, q: new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(p, target, new Vector3(0, 1, 0))) }
}

/** The body frame deliberately excludes suspension, head animation, turret and mast pan. */
export function bodyPose(logic: DeviceLogic, n: number): CameraPose {
  const u = deviceState(logic, n), id = logic.spec.id, [height, forward] = DEVICE_RIGS[id]
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), u.h ?? u.yaw ?? 0)
  const p = new Vector3(u.x ?? 0, (id === 'rover' ? roverGround(u.x, u.z) : u.y ?? 0) + height, u.z ?? 0)
  return { p: p.add(new Vector3(0, 0, forward).applyQuaternion(q)), q }
}

const studioSeats = [[-0.8, -1.5], [-3.2, -0.2], [1.8, -1.7], [-3.1, 1.85], [-0.45, 2.05], [2.55, 1.65], [3.7, -0.15], [-3.55, -2.3]]
/** A fixed seat shows the workspace instead of riding a ball, mallet, ram, bulb or swinging counterweight. */
function seatPose(logic: DeviceLogic, n: number): CameraPose {
  const u = deviceState(logic, n), id = logic.spec.id
  let at = [0, 0.7, 0], offset = [0, 1.3, 2.5]
  if (id === 'maze') { at = [n % 2 ? 0.98 : -0.98, 0.16, n < 2 ? -0.94 : 1]; offset = [0, 1.25, 1.65] }
  if (id === 'airhockey') { at = [0, 0.85, 0]; offset = [0, 1.2, n ? -3.15 : 3.15] }
  if (id === 'football') { at = [0, 0.95, 0]; offset = [0, 1.15, n % 2 ? -2.8 : 2.8] }
  if (id === 'pinball') { at = [(n - 0.5) * 1.9, 0.96, -0.1]; offset = [0, 1.25, 2.6] }
  if (id === 'marblerun') { at = [n * 3.8, 0.85, 0]; offset = [0, 1.8, 2.4] }
  if (id === 'pendulum') { at = [(n - 1) * 1.65, 1.3, 0]; offset = [0, 0.25, 3.2] }
  if (id === 'trebuchet') { at = [n * 5, 1, -3]; offset = [1.3, 1.1, 5.2] }
  if (id === 'claw') { at = [n ? 1 : -1, 0.65, 0]; offset = [0, 1.1, 1.85] }
  if (id === 'sorting') { at = [n ? 2.1 : -2.1, 1, 0.3]; offset = [0, 1.05, 2.65] }
  if (id === 'excavator') { at = [u.x, 1, u.z]; offset = [-4, 3.4, 4] }
  if (id === 'jib') { at = [n ? 2.2 : -2.2, 1.4, -1]; offset = [0.9, 0.7, 3] }
  if (id === 'painter') { at = [0, 1.5, 0]; offset = [0, 0.15, 4] }
  if (id === 'lamp') { at = [[-1.05, 1.4, -1.3], [1.6, 0.9, -1.5], [0.25, 1.2, -0.35], [1.05, 1.5, -2.2]][n]; offset = [0, 0.2, 1.65] }
  if (id === 'smarthome') { at = [[-1.65, 1.8, -2.05], [0.1, 2.5, 0.15], [0.95, 1.5, -2.08], [2.6, 1.65, -2.08]][n]; offset = [0, -0.15, 2] }
  if (id === 'studio') { const [x, z] = studioSeats[n]; at = [x, 0.85, z]; offset = [0, 0.8, n === 0 ? 1.65 : 1.5] }
  const target = new Vector3(...at)
  return looking(target.clone().add(new Vector3(...offset)), target)
}

const anchorCache = new WeakMap<Object3D, Object3D[]>()
/** Skin upgrades preserve the named nodes. Until the models arrive, use their logic poses. */
export function deviceRides(logic: DeviceLogic, scene: Object3D, anchor?: (n: number) => Vector3): Ride[] {
  let anchors = anchorCache.get(scene)
  if (!anchors || anchors.length < logic.spec.units) {
    anchors = []; scene.traverse(o => { if (o.name === 'pov') anchors!.push(o) }); anchorCache.set(scene, anchors)
  }
  const id = logic.spec.id, style = deviceStyle(id)
  return Array.from({ length: logic.spec.units }, (_, n) => {
    const lens = () => {
      const p = anchors[n] ? anchorPose(anchors[n]) : fallbackPose(logic, n, anchor?.(n))
      p.p.add(new Vector3(0, 0, -0.09).applyQuaternion(p.q))
      return p
    }
    const body = () => bodyPose(logic, n), seat = () => seatPose(logic, n)
    let views: Viewpoint[]
    if (style === 'body' || style === 'flyer') {
      views = [{ name: style === 'flyer' ? 'FPV' : 'Cockpit', pose: body, level: true, follows: true }, { name: 'Chase', follows: true, pose: () => {
        const p = body(); return looking(p.p.clone().add(new Vector3(0, 1.15, 2.25).applyQuaternion(p.q)), p.p.clone().add(new Vector3(0, 0, -1).applyQuaternion(p.q)))
      } }]
      if (id === 'tank') views.push({ name: 'Turret', pose: () => {
        const u = deviceState(logic, n), q = new Quaternion().setFromEuler(new Euler(u.elevation, u.h + u.turret, 0, 'YXZ'))
        return { p: new Vector3(u.x, 0.94, u.z).add(new Vector3(0, 0, -1.4).applyQuaternion(q)), q }
      } })
    } else if (style === 'lens') views = [{ name: 'Lens', pose: lens }, { name: 'Operator', pose: () => { const p = lens(); return looking(p.p.clone().add(new Vector3(0.7, 0.6, 1.4)), p.p) } }]
    else if (style === 'operator') views = [{ name: 'Operator', pose: seat }, { name: id === 'jib' ? 'Lens' : 'Tool', pose: lens }]
    else views = [{ name: style === 'studio' ? 'Player' : 'Seat', pose: seat }, { name: 'Wide', pose: () => { const p = seat(); p.p.add(new Vector3(0, 0.5, 0.9).applyQuaternion(upright(p.q, true))); return p } }]
    return { id: `${id}${n + 1}`, name: logic.spec.unitNames?.[n] ?? `${logic.spec.unit} ${n + 1}`, style, horizon: true, views, pose: views[0].pose,
      moving: () => { const u = deviceState(logic, n); return Math.abs(u.v ?? 0) + Math.hypot(u.vx ?? 0, u.vy ?? 0, u.vz ?? 0) + Math.abs(u.turn ?? 0) > 0.08 },
    }
  })
}

export function armRide(id: string, name: string, root: Object3D, grasp: Object3D, reach = 1.2, height = 1.45): Ride {
  const seat = () => {
    root.updateWorldMatrix(true, false)
    return looking(root.localToWorld(new Vector3(reach * 0.6, height + 0.2, reach * 0.8)), root.localToWorld(new Vector3(-reach * 0.55, height * 0.28, 0)))
  }
  const wrist = () => {
    grasp.updateWorldMatrix(true, false)
    // Stand back along the approach, with lateral clearance for the wrist housing.
    const q = grasp.getWorldQuaternion(new Quaternion()).multiply(new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0)))
    const p = grasp.localToWorld(new Vector3(0, -Math.max(0.24, reach * 0.24), Math.max(0.12, reach * 0.12)))
    return { p, q: upright(q) }
  }
  return { id, name, style: 'operator', horizon: true, pose: seat, views: [{ name: 'Operator', pose: seat }, { name: 'Wrist', pose: wrist }] }
}

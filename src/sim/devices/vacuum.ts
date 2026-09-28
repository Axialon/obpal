/** A cleaning robot with furniture collisions, finite dust and a route back to its dock. */
import { Controller } from '@obpal/core'
import { action, blocked, drive, Machine, timestep } from './common'
import { clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const VACUUM_SPEC: DeviceSpec = {
  id: 'vacuum',
  name: 'Robot vacuum',
  unit: 'Vacuum',
  units: 1,
  kind: 'Home',
  blurb: 'Clean the dust between the furniture, then send the robot back to charge.',
  teaches: 'Point at a destination, or drive with a thumb',
  controllers: [Controller.wii, Controller.trackpad],
  how: {
    'face.wii': 'Point and hold B to drive · A switches cleaning · ⌂ docks',
    'face.trackpad': 'Drag or tilt to drive · tap switches cleaning · Home docks',
  },
  tray: [{ id: 'clean', label: 'Clean', type: 'button', icon: 'sun' }],
  buttons: { 'media:playpause': 'tray:clean', 'key:KeyC': 'tray:clean' },
}
export const FURNITURE = [
  { x: 1.7, z: -2.3, w: 3.3, d: 1.2 },
  { x: 0.7, z: 0, w: 1.6, d: 1 },
  { x: -2.8, z: -1.8, w: 1.3, d: 1.3 },
  { x: 3.5, z: 1.7, w: 1, d: 1.3 },
]
export const DOCK = [-4, 3] as const
const clear = (x: number, z: number) => Math.abs(x) <= 4.5 && Math.abs(z) <= 3.5 && !blocked(x, z, 0.38, FURNITURE)
/** A small grid search around the furniture, used only when Home is pressed. */
export function dockRoute(x: number, z: number): [number, number][] {
  const points = Array.from(
    { length: 19 * 15 },
    (_, i) => [((i % 19) - 9) * 0.5, (Math.floor(i / 19) - 7) * 0.5] as [number, number],
  )
  const start = points.reduce(
    (best, p, i) =>
      clear(...p) && Math.hypot(p[0] - x, p[1] - z) < Math.hypot(points[best][0] - x, points[best][1] - z) ? i : best,
    0,
  )
  const goal = points.findIndex((p) => p[0] === DOCK[0] && p[1] === DOCK[1]),
    queue = [start],
    from = new Map<number, number>([[start, -1]])
  for (let at = 0; at < queue.length; at++) {
    const k = queue[at]
    if (k === goal) break
    for (const d of [-19, 19, -1, 1]) {
      const j = k + d
      if (
        !points[j] ||
        from.has(j) ||
        !clear(...points[j]) ||
        Math.hypot(points[j][0] - points[k][0], points[j][1] - points[k][1]) > 0.51
      )
        continue
      from.set(j, k)
      queue.push(j)
    }
  }
  if (!from.has(goal)) return []
  const route: [number, number][] = []
  for (let k = goal; k !== -1; k = from.get(k)!) route.unshift(points[k])
  return route
}
export class VacuumLogic extends Machine {
  readonly spec = VACUUM_SPEC
  units = [{ x: -2, z: 1.5, h: 0, v: 0, clean: true, collected: 0, docking: false, docked: false }]
  dust = Array.from({ length: 120 }, (_, n) => ({
    x: ((n * 37) % 89) / 10 - 4.4,
    z: ((n * 53) % 67) / 10 - 3.3,
    cleaned: false,
  })).filter((p) => clear(p.x, p.z))
  private drag = new DragStick()
  private route: [number, number][] = []
  home() {
    this.route = dockRoute(this.units[0].x, this.units[0].z)
    this.units[0].docking = true
    this.units[0].v = 0
    this.drag = new DragStick()
  }
  readout() {
    const u = this.units[0]
    return u.docked ? 'Docked · charging' : u.docking ? 'Returning to dock' : `${u.collected}/${this.dust.length} clean`
  }
  reset() {
    this.dust.forEach((d) => (d.cleaned = false))
    this.units[0].collected = 0
  }
  readonly resetLabel = 'Scatter dust'
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta),
      i = inputs[0] ?? null,
      u = this.units[0]
    if (i?.recentred) this.home()
    if (action(i, 'clean')) u.clean = !u.clean
    const [steer, throttle] = drive(i, this.drag)
    let target: [number, number] | undefined = u.docking ? this.route[0] : undefined
    if (!u.docking && i?.point && i.spot && i.held.has('wii-b'))
      target = [clamp(i.spot[0], -4.5, 4.5), clamp(i.spot[1], -3.5, 3.5)]
    if (target) {
      const dx = target[0] - u.x,
        dz = target[1] - u.z,
        dist = Math.hypot(dx, dz)
      u.h = wrapPi(u.h + clamp(wrapPi(Math.atan2(-dx, -dz) - u.h), -dt * 4, dt * 4))
      u.v = Math.min(0.9, dist * 3) * Math.max(0, Math.cos(wrapPi(Math.atan2(-dx, -dz) - u.h)))
      if (dist < 0.08 && u.docking) this.route.shift()
    } else {
      u.h = wrapPi(u.h - steer * dt * 2)
      u.v = throttle * 0.9
    }
    const nx = clamp(u.x - Math.sin(u.h) * u.v * dt, -4.5, 4.5),
      nz = clamp(u.z - Math.cos(u.h) * u.v * dt, -3.5, 3.5)
    if ((!clear(nx, u.z) || !clear(u.x, nz)) && Math.abs(u.v) > 0.2) this.events.push({ unit: 0, kind: 'bump', audio: { speed: Math.abs(u.v) } })
    if (clear(nx, u.z)) u.x = nx
    else u.v = 0
    if (clear(u.x, nz)) u.z = nz
    else u.v = 0
    if (u.docking && !this.route.length) {
      u.docking = false
      u.docked = true
      u.x = DOCK[0]
      u.z = DOCK[1]
      u.v = 0
      this.events.push({ unit: 0, kind: 'score', text: 'Docked and charging' })
    }
    if (Math.abs(u.v) > 0.01) u.docked = false
    if (u.clean && !u.docked)
      for (const d of this.dust)
        if (!d.cleaned && Math.hypot(d.x - u.x, d.z - u.z) < 0.43) {
          d.cleaned = true
          u.collected++
        }
  }
}

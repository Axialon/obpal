/** A tracked toy with an independently aimed turret and soft, gravity-driven practice balls. */
import { Controller } from '@obpal/core'
import { action, drive, Machine, timestep } from './common'
import { axis, clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'
export const TANK_SPEC: DeviceSpec = {
  id: 'tank',
  name: 'Tank',
  unit: 'Tank',
  units: 2,
  kind: 'Vehicle',
  blurb: 'Turn the turret with gyro Aim and knock down targets with soft practice balls.',
  teaches: 'The right stick and gyro Aim steer a separate turret',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left stick drives · gyro Aim / right stick turns turret · A fires',
    'face.trackpad': 'Drag drives · two fingers turn the turret · tap fires',
  },
  tray: [{ id: 'fire', label: 'Fire', type: 'button', icon: 'point' }],
  buttons: { 'media:playpause': 'tray:fire', 'key:Space': 'tray:fire' },
}
export const TARGETS = [
  [-5, -6],
  [0, -6],
  [5, -6],
  [-6, -1],
  [6, -1],
] as const
export interface Ball {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  life: number
  owner: number
}
export class TankLogic extends Machine {
  readonly spec = TANK_SPEC
  units = [0, 1].map((n) => ({
    x: n ? 2 : -2,
    z: 2,
    h: 0,
    v: 0,
    turret: 0,
    elevation: 0.08,
    shots: 0,
    score: 0,
    cooldown: 0,
  }))
  targets = TARGETS.map(([x, z]) => ({ x, z, up: true }))
  balls: Ball[] = []
  private drags = this.units.map(() => new DragStick())
  home(n: number) {
    Object.assign(this.units[n], { x: n ? 2 : -2, z: 2, h: 0, v: 0, turret: 0, elevation: 0.08, cooldown: 0 })
    this.drags[n] = new DragStick()
  }
  reset() {
    this.targets.forEach((t) => (t.up = true))
    this.balls = []
    this.units.forEach((u) => (u.score = 0))
  }
  readonly resetLabel = 'Targets up'
  readout(n: number) {
    const u = this.units[n]
    return `${u.score} targets · ${Math.round(u.turret * 57.3)}°`
  }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const i = inputs[n] ?? null,
        [steer, throttle] = drive(i, this.drags[n])
      u.v += (throttle * 1.7 - u.v) * Math.min(1, dt * 5)
      u.h = wrapPi(u.h - steer * dt * 1.5)
      u.x = clamp(u.x - Math.sin(u.h) * u.v * dt, -8, 8)
      u.z = clamp(u.z - Math.cos(u.h) * u.v * dt, -7, 7)
      if (i) {
        if (i.space && (!i.pad || i.space.pointer)) {
          const [x, y] = i.space.aim
          u.turret = -x * Math.PI; u.elevation = 0.08 + y * (y >= 0 ? 0.52 : 0.16)
        } else {
          u.turret = wrapPi(u.turret - (i.pad ? axis(i.pad.axes[2]) * dt * 1.8 : i.pan[0] * 0.012))
          u.elevation = clamp(u.elevation - (i.pad ? axis(i.pad.axes[3]) * dt : i.pan[1] * 0.006), -0.08, 0.6)
        }
      }
      u.cooldown = Math.max(0, u.cooldown - dt)
      if (action(i, 'fire') && !u.cooldown) {
        const h = u.h + u.turret
        this.balls.push({
          x: u.x - Math.sin(h) * 1.3,
          y: 0.94 + Math.sin(u.elevation),
          z: u.z - Math.cos(h) * 1.3,
          vx: -Math.sin(h) * 8 * Math.cos(u.elevation),
          vz: -Math.cos(h) * 8 * Math.cos(u.elevation),
          vy: 0.8 + Math.sin(u.elevation) * 8,
          life: 4,
          owner: n,
        })
        u.shots++
        u.cooldown = 0.35
        this.events.push({ unit: n, kind: 'tick' })
        if (this.balls.length > 24) this.balls.shift()
      }
    })
    for (const b of this.balls) {
      b.life -= dt
      b.vy -= 3 * dt
      b.x += b.vx * dt
      b.z += b.vz * dt
      b.y += b.vy * dt
      if (b.y < 0.1) {
        b.y = 0.1
        b.vy = Math.abs(b.vy) * 0.35
        b.vx *= 0.7
        b.vz *= 0.7
      }
      for (const t of this.targets)
        if (t.up && Math.hypot(b.x - t.x, b.y - 0.9, b.z - t.z) < 0.65) {
          t.up = false
          b.life = 0
          this.units[b.owner].score++
          this.events.push({ unit: b.owner, kind: 'score', text: 'Soft target down' })
        }
    }
    this.balls = this.balls.filter((b) => b.life > 0 && Math.abs(b.x) < 10 && Math.abs(b.z) < 9)
  }
}

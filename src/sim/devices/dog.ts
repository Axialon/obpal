/** A four-legged robot with a diagonal trot and a ball to find in a fenced yard. */
import { Controller, PadButton } from '@obpal/core'
import { drive, Machine, timestep } from './common'
import { approach, clamp, DragStick, wrapPi } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const DOG_SPEC: DeviceSpec = {
  id: 'dog',
  name: 'Robot dog',
  unit: 'Dog',
  units: 2,
  kind: 'Robot',
  blurb: 'Trot around the yard, chase your ball and sit for a well-earned rest.',
  teaches: 'A stick or phone tilt coordinates four articulated legs',
  controllers: [Controller.gamepad, Controller.trackpad],
  how: {
    'face.gamepad': 'Left stick turns and trots · A sits · B stands · reach your ball to score',
    'face.trackpad': 'Drag or tilt to turn and trot · Sit / Stand in the tray · chase your ball',
  },
  tray: [
    { id: 'sit', label: 'Sit', type: 'button', icon: 'minus' },
    { id: 'stand', label: 'Stand', type: 'button', icon: 'plus' },
  ],
  buttons: { 'media:playpause': 'tray:sit', 'key:Space': 'tray:sit', 'key:KeyS': 'tray:stand' },
}

export const DOG_YARD = { x: 6, z: 5 }
const BALL_ROUTE = [[0, -2.4], [2.2, -1], [-1, 0.8], [1.6, 2.4], [-1.8, -2]] as const
export const dogHome = (n: number) => ({ x: n ? 2.2 : -2.2, z: 2.2 })

export interface Dog {
  x: number
  z: number
  h: number
  v: number
  turn: number
  sitting: boolean
  /** Smoothed pose, 0 standing and 1 sitting; gait is the diagonal pair's phase. */
  sit: number
  gait: number
  stride: number
  legs: { hip: number; knee: number }[]
  ball: { x: number; z: number }
  score: number
  actions: number
}

function ballAt(n: number, score: number) {
  const [x, z] = BALL_ROUTE[score % BALL_ROUTE.length]
  return { x: dogHome(n).x + x * 0.7, z }
}

export class DogLogic extends Machine {
  readonly spec = DOG_SPEC
  units: Dog[] = [0, 1].map((n) => ({
    ...dogHome(n), h: 0, v: 0, turn: 0, sitting: false, sit: 0, gait: 0, stride: 0,
    legs: Array.from({ length: 4 }, () => ({ hip: -0.22, knee: 0.44 })),
    ball: ballAt(n, 0), score: 0, actions: 0,
  }))
  private drags = this.units.map(() => new DragStick())
  private parked = this.units.map(() => false)

  home(n: number) {
    const u = this.units[n]
    Object.assign(u, { ...dogHome(n), h: 0, v: 0, turn: 0, sitting: false, sit: 0, gait: 0, stride: 0 })
    u.legs.forEach((leg) => Object.assign(leg, { hip: -0.22, knee: 0.44 }))
    this.drags[n] = new DragStick()
    this.parked[n] = true
  }

  readout(n: number) {
    const u = this.units[n]
    return `${u.sitting ? 'Sitting' : Math.abs(u.v) > 0.05 ? 'Trotting' : 'Standing'} · ${u.score} balls`
  }

  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const input = inputs[n] ?? null
      // These are distinct commands: a generic primary action must never invoke both.
      const sit = input?.presses.includes('sit') || !!(input && input.padPressed & (1 << PadButton.A))
      const stand = input?.presses.includes('stand') || !!(input && input.padPressed & (1 << PadButton.B))
      if (sit || stand) {
        u.sitting = !stand
        u.actions++
        this.events.push({ unit: n, kind: 'tick', text: stand ? 'Standing' : 'Sitting' })
      }
      let live = input && !input.quiet ? input : null
      if (this.parked[n]) {
        const moving = live && (live.touching || Math.hypot(...live.tilt) > 0.08 || live.pad && [...live.pad.axes, ...live.pad.triggers].some(v => Math.abs(v) > 0.08))
        if (!moving) this.parked[n] = false
        live = null
      }
      const [steer, power] = drive(u.sitting ? null : live, this.drags[n])
      if (!live || u.sitting) { u.v = 0; u.turn = 0 }
      else {
        u.v = approach(u.v, power * 2 || 0, 5, dt)
        u.turn = approach(u.turn, -steer * 2 || 0, 7, dt)
      }
      u.h = wrapPi(u.h + u.turn * dt)
      const x = u.x - Math.sin(u.h) * u.v * dt,
        z = u.z - Math.cos(u.h) * u.v * dt
      u.x = clamp(x, -DOG_YARD.x, DOG_YARD.x)
      u.z = clamp(z, -DOG_YARD.z, DOG_YARD.z)
      if (x !== u.x || z !== u.z) u.v = 0
      u.sit = approach(u.sit, u.sitting ? 1 : 0, 3, dt)
      u.stride = approach(u.stride, Math.min(1, Math.abs(u.v) / 1.4 + Math.abs(u.turn) * 0.2), 5, dt)
      if (u.stride > 0.001) u.gait = (u.gait + dt * (5 + Math.abs(u.v) * 5)) % (Math.PI * 2)
      u.legs.forEach((leg, k) => {
        // Front-left and rear-right move together, opposite the other diagonal.
        const phase = u.gait + (k === 0 || k === 3 ? 0 : Math.PI),
          swing = Math.sin(phase) * u.stride * (1 - u.sit)
        leg.hip = -0.22 + swing * 0.5 + u.sit * (k < 2 ? -0.15 : -1.05)
        leg.knee = 0.44 + Math.max(0, -swing) * 0.55 + u.sit * (k < 2 ? 0.25 : 1.35)
      })
      if (live && !u.sitting && Math.hypot(u.x - u.ball.x, u.z - u.ball.z) < 0.62) {
        u.score++
        u.ball = ballAt(n, u.score)
        this.events.push({ unit: n, kind: 'score', text: `Ball found · ${u.score} so far` })
      }
    })
  }
}

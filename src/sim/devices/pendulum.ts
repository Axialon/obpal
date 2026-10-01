/** Bounded nonlinear pendulums with independent settings and a ten-second angle history. */
import { Controller, Mode } from '@obpal/core'
import { rail } from '../vr/intent'
import { FixedWorld } from '../physics/world'
import { PendulumAdapter } from '../physics/pendulum'
import { Machine, action, timestep } from './common'
import { axis, clamp, slopeOf } from './input'
import type { DeviceInput, DeviceSpec } from './types'

export const PENDULUM_SPEC: DeviceSpec = {
  category: 'space-science',
  id: 'pendulum', name: 'Pendulum lab', unit: 'Pendulum', units: 3, kind: 'Science',
  blurb: 'Change length and damping, flick your phone to push a pendulum and compare its live trace.',
  teaches: 'A quick change in phone tilt gives a push; slower touch gestures adjust the experiment',
  controllers: [Controller.trackpad, Controller.gamepad],
  how: {
    'face.trackpad': 'Drag across: length; up: damping · flick Gyro Tilt or tap to push',
    'face.gamepad': 'Left stick up / down changes length, left / right changes damping · A pushes',
  },
  tray: [{ id: 'push', label: 'Push', type: 'button', icon: 'tap' }],
  buttons: { 'key:Space': 'tray:push', 'media:playpause': 'tray:push' },
}
export class PendulumLogic extends Machine {
  readonly spec = PENDULUM_SPEC
  readonly units = [0, 1, 2].map(n => ({ length: 1.2 + n * 0.25, damping: 0.08, angle: 0, omega: 0, actions: 0, trace: [] as number[], elapsed: 0 }))
  private lastTilt: (number | null)[] = [null, null, null]
  private cooldown = [0, 0, 0]
  private clocks = [0, 0, 0]
  private readonly adapter = new PendulumAdapter(this.units, dt => {
    this.units.forEach((u, n) => {
      u.elapsed += dt; this.clocks[n] += dt
      if (this.clocks[n] + 1e-10 >= 1 / 30) {
        this.clocks[n] = Math.max(0, this.clocks[n] - 1 / 30)
        u.trace.push(u.angle); if (u.trace.length > 300) u.trace.shift()
      }
    })
  })
  private readonly world = new FixedWorld(this.adapter, { maxBodies: 3 })
  private simulated = this.adapter.capture()
  renderState() {
    // A shared guest receives presentation state without stepping the host's clock. Preserve that path.
    const live = this.adapter.capture()
    return live.some((u, n) => u.angle !== this.simulated[n]?.angle || u.length !== this.simulated[n]?.length) ? live : this.world.render()
  }
  physicsDiagnostics() { return this.world.diagnostics() }
  home(n: number) { Object.assign(this.units[n], { length: 1.2 + n * 0.25, damping: 0.08, angle: 0, omega: 0, trace: [], elapsed: 0 }); this.lastTilt[n] = null; this.cooldown[n] = this.clocks[n] = 0; this.adapter.wake(n); this.world.snap(); this.simulated = this.adapter.capture() }
  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const raw = inputs[n], i = raw && !raw.quiet ? raw : null, oldLength = u.length
      this.cooldown[n] = Math.max(0, this.cooldown[n] - dt)
      if (i) {
        u.length = clamp(u.length + (i.pad ? -axis(i.pad.axes[1]) * dt * 0.7 : (Number.isFinite(i.drag[0]) ? i.drag[0] : 0) * 0.004), 0.55, 2.2)
        u.damping = clamp(u.damping + (i.pad ? axis(i.pad.axes[0]) * dt * 0.5 : -(Number.isFinite(i.drag[1]) ? i.drag[1] : 0) * 0.003), 0, 1.2)
      }
      u.omega *= (oldLength / u.length) ** 2
      let impulse = raw?.presses.includes('push') || action(i, 'push') ? 1.6 : 0
      if (raw?.positioned) this.lastTilt[n] = null
      const value = i?.hold ? slopeOf(i.hold)[0] : i?.mode === Mode.tilt ? i.tilt[0] : null
      const tilt = value !== null && Number.isFinite(value) ? value : null
      if (tilt !== null && this.lastTilt[n] !== null && dt > 0 && !this.cooldown[n]) {
        const change = tilt - this.lastTilt[n]!
        if (Math.abs(change) > 0.12 && Math.abs(change) / dt > 3) impulse = Math.sign(change) * Math.min(2.8, Math.abs(change) * 4) * rail(i?.controlFrame)
      }
      this.lastTilt[n] = tilt
      if (impulse && !this.cooldown[n]) { u.omega += impulse; u.actions++; this.cooldown[n] = 0.3; this.events.push({ unit: n, kind: 'tick', text: 'Pendulum pushed' }) }
      u.omega = clamp(u.omega, -5, 5)
    })
    this.world.advance(delta)
    this.simulated = this.adapter.capture()
  }
  readout(n: number) { const u = this.units[n]; return `${u.length.toFixed(2)} m · damping ${u.damping.toFixed(2)} · ${(u.angle * 180 / Math.PI).toFixed(0)}°` }
}

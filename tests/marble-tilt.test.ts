import { afterEach, it, expect, vi } from 'vitest'
import { Mode } from '@obpal/core'
import { MarblePhone } from '../src/sim/devices/marblerun.phone'
import { MarblerunLogic } from '../src/sim/devices/marblerun'
import { restInput } from '../src/sim/devices/types'
import { stick } from '../src/sim/devices/input'

afterEach(() => vi.unstubAllGlobals())
function phone(permission?: () => Promise<string>, supported = true) {
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { hidden: false })
  if (supported) Object.assign(window, { DeviceOrientationEvent: permission ? { requestPermission: permission } : Event })
  vi.stubGlobal('window', window); vi.stubGlobal('document', document)
  vi.stubGlobal('screen', { orientation: Object.assign(new EventTarget(), { angle: 0 }) })
  const phone = new MarblePhone()
  const orient = (gamma: number, beta = 60) => window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha: 0, beta, gamma }))
  return { phone, orient, document }
}

it('calibrates the first sensor sample, deadzones small tilts and recentres without a jump', () => {
  const { phone: p, orient } = phone()
  orient(0); expect(p.state).toBe('Tilt active'); expect(p.read().tilt).toEqual([0, 0])
  orient(2); expect(p.read().tilt).toEqual([0, 0])
  orient(30); expect(Math.abs(p.read().tilt[0])).toBeGreaterThan(.2)
  p.recenter(); expect(p.read()).toMatchObject({ tilt: [0, 0], recentred: true })
  expect(p.read().recentred).toBe(false)
  p.stop()
})

it('requests permission only from enable and preserves touch when denied or unsupported', async () => {
  const request = vi.fn(async () => 'denied'), { phone: p, orient } = phone(request)
  expect(request).not.toHaveBeenCalled(); expect(p.state).toBe('Enable tilt')
  await p.enable(); orient(30); p.move(20, -10); p.press('run')
  expect(p.state).toBe('Motion denied · drag')
  expect(p.read()).toMatchObject({ tilt: [0, 0], drag: [20, -10], presses: ['run'] })
  p.stop()
  const { phone: unsupported } = phone(undefined, false)
  expect(unsupported.state).toBe('No motion sensor · drag')
  unsupported.move(7, 3); expect(unsupported.read().drag).toEqual([7, 3]); unsupported.stop()
})

it('ignores invalid and hidden samples and reacquires a neutral after a screen turn', () => {
  const { phone: p, orient, document } = phone()
  orient(NaN); expect(p.state).not.toBe('Tilt active')
  orient(0); orient(30)
  Object.assign(screen.orientation, { angle: 90 })
  screen.orientation.dispatchEvent(new Event('change'))
  orient(30); expect(p.read().tilt).toEqual([0, 0])
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); orient(-30)
  expect(p.read().tilt).toEqual([0, 0])
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); orient(-30)
  expect(p.read().tilt).toEqual([0, 0]); p.stop()
})

it('uses the standard radial deadzone and frame-rate independent smoothing in build and run', () => {
  const logic = new MarblerunLogic(true), i = restInput('face.trackpad', Mode.tilt)
  i.tilt = [.06, .05]; logic.step([i], 1 / 60)
  expect(logic.units[0].tiltX).toBe(0)
  i.tilt = [.6, -.4]; logic.step([i], 1 / 60)
  const target = stick(...i.tilt), follow = 1 - Math.exp(-12 / 60)
  expect(logic.units[0].tiltX).toBeCloseTo(target[0] * follow, 10)
  const twoFrames = new MarblerunLogic(true)
  twoFrames.step([i], 1 / 120); twoFrames.step([i], 1 / 120)
  expect(twoFrames.units[0].tiltX).toBeCloseTo(logic.units[0].tiltX, 10)
  i.recentred = true; logic.step([i], 1 / 60); i.recentred = false
  for (let n = 0; n < 90; n++) logic.step([i], 1 / 60)
  expect(logic.units[0].tiltX).toBe(0); expect(logic.units[0].tiltZ).toBe(0)
})

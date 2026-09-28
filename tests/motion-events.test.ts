import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceScreenAngle, qAxisAngle, qConj, qIdentity, qRotate, quatFromDeviceOrientation, type Quat } from '@obpal/core'
import { Motion, requestMotionPermission, setLockedScreenAngle } from '../src/controller/motion'
import { readTilt, tiltState } from '../src/landing/tilt'

afterEach(() => { setLockedScreenAngle(null); vi.unstubAllGlobals() })

describe('browser motion frames and permissions', () => {
  it('uses screen.orientation, including negative angles, and falls back to iOS orientation', () => {
    vi.stubGlobal('screen', { orientation: { angle: -90 } })
    expect(deviceScreenAngle()).toBe(270)
    vi.stubGlobal('screen', {}); vi.stubGlobal('orientation', -90)
    expect(deviceScreenAngle()).toBe(270)
  })

  it('keeps the neutral samples in one frame when the screen turns during home calibration', () => {
    const state = tiltState()
    for (let n = 0; n < 7; n++) expect(readTilt(state, 65, 12, n < 4 ? 0 : 90, n * 16, 25)).toBeNull()
    for (let n = 7; n < 12; n++) expect(readTilt(state, 65, 12, 90, n * 16, 25)).toBeNull()
  })

  it('home recenter captures the stationary reading before the next physical turn', async () => {
    vi.resetModules()
    const home = await import('../src/landing/tilt')
    const window = new EventTarget(), orientation = { angle: 0 }
    vi.stubGlobal('addEventListener', window.addEventListener.bind(window))
    vi.stubGlobal('screen', { orientation })
    vi.stubGlobal('document', { hidden: false, documentElement: { classList: { add() {} } } })
    vi.stubGlobal('DeviceOrientationEvent', Event)
    vi.stubGlobal('DeviceMotionEvent', undefined)
    let q: Quat = qIdentity(), generation = -1
    const stop = home.onOrientation((value, gen) => { q = value; generation = gen })
    await home.startTilt()
    const read = (alpha: number) => window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha, beta: 90, gamma: 0 }))
    read(20); read(50)
    const before = generation
    orientation.angle = 90
    home.recentre()
    const centered = q, recentered = generation
    read(60)
    const expected = qAxisAngle(0, 1, 0, 10 * Math.PI / 180)
    qRotate(q, [1, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo(qRotate(expected, [1, 0, 0])[i], 8))
    expect(recentered).toBe(before + 1)
    expect(centered).toEqual(qIdentity())
    stop()
  })

  it('requests both permissions synchronously in the original gesture', async () => {
    const calls: string[] = []
    vi.stubGlobal('window', {
      DeviceMotionEvent: { requestPermission: () => { calls.push('motion'); return Promise.resolve('granted') } },
      DeviceOrientationEvent: { requestPermission: () => { calls.push('orientation'); return Promise.resolve('granted') } },
    })
    const result = requestMotionPermission()
    expect(calls).toEqual(['motion', 'orientation'])
    expect(await result).toBe('granted')
  })

  it('handles denied permission and a missing gesture without starting sensors', async () => {
    vi.stubGlobal('window', { DeviceOrientationEvent: { requestPermission: () => Promise.resolve('denied') } })
    expect(await requestMotionPermission()).toBe('denied')
    vi.stubGlobal('window', { DeviceOrientationEvent: { requestPermission: () => { throw new Error('gesture required') } } })
    expect(await requestMotionPermission()).toBe('prompt')
  })

  it('refreshes orientation before anchoring after unlock, with matching gyro and acceleration axes', () => {
    const window = new EventTarget(), orientation = Object.assign(new EventTarget(), { angle: 90 })
    vi.stubGlobal('window', window); vi.stubGlobal('screen', { orientation })
    const m = new Motion(); m.start()
    setLockedScreenAngle(0)
    window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha: 25, beta: 65, gamma: 12 }))
    expect(m.q).toEqual(quatFromDeviceOrientation(25, 65, 12, 0))
    setLockedScreenAngle(null); m.refreshScreen()
    expect(m.q).toEqual(quatFromDeviceOrientation(25, 65, 12, 90))
    expect(m.up()).toEqual(qRotate(qConj(m.q!), [0, 0, 1]))
    window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 1, y: 0, z: 0 }, rotationRate: { beta: 180, gamma: 0, alpha: 0 } }))
    expect(m.accel![0]).toBeCloseTo(0); expect(m.accel![1]).toBeCloseTo(1)
    expect(m.gyro[1]).toBeCloseTo(Math.PI)
    const worldAccel = qRotate(m.q!, m.accel!)
    orientation.angle = 270; orientation.dispatchEvent(new Event('change'))
    expect(m.q).toEqual(quatFromDeviceOrientation(25, 65, 12, 270))
    expect(m.accel![0]).toBeCloseTo(0); expect(m.accel![1]).toBeCloseTo(-1)
    expect(m.gyro[1]).toBeCloseTo(-Math.PI)
    qRotate(m.q!, m.accel!).forEach((v, i) => expect(v).toBeCloseTo(worldAccel[i], 8))
    m.stop()
    orientation.angle = 0; orientation.dispatchEvent(new Event('change'))
    expect(m.q).toEqual(quatFromDeviceOrientation(25, 65, 12, 270))
  })
})

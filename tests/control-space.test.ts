import { describe, expect, it } from 'vitest'
import { Mode, qAxisAngle, qMul, qRotate, quatFromDeviceOrientation, type Quat } from '@obpal/core'
import { CONTROL_SPACES, readControlAim, reachAxis, sceneCells } from '../src/control-space'
import { CalibratedControl } from '../src/controller/control-space'
import { Motion } from '../src/controller/motion'
import { SIMS } from '../src/sim/catalogue'
import { armHeight, armWorkspace } from '../src/sim/arm/control-space'
import { KINDS } from '../src/sim/arm/kind'
import { homeOf, reachDown, within } from '../src/sim/arm/kin'
import { controlSpot, deviceTarget, mapDeviceSpace, sceneSelects } from '../src/sim/devices/control-space'
import { DEVICES } from '../src/sim/devices/registry'
import { restInput, type DeviceInput } from '../src/sim/devices/types'
import { CLAW } from '../src/sim/devices/claw'
import { AirhockeyLogic, AIRHOCKEY } from '../src/sim/devices/airhockey'
import { PainterLogic } from '../src/sim/devices/painter'
import { SliderLogic } from '../src/sim/devices/slider'
import { MarblerunLogic } from '../src/sim/devices/marblerun'
import { PTZ, PtzLogic } from '../src/sim/devices/ptz'
import { FootballLogic, RODS } from '../src/sim/devices/football'
import { PendulumLogic } from '../src/sim/devices/pendulum'
import { PinballLogic } from '../src/sim/devices/pinball'
import { LampLogic } from '../src/sim/devices/lamp'

const D = Math.PI / 180
const input = (x = 0, y = 0): DeviceInput => ({ ...restInput('face.trackpad', Mode.hold), scope: 'object', space: { aim: [x, y], tilt: [x, y], active: true } })
const turn = (degrees: number, q: Quat) => qMul(qAxisAngle(0, 0, 1, -degrees * D), q)

describe('a position and comfortable reach for every sim', () => {
  it('covers the complete playable catalogue exactly once', () => {
    expect(Object.keys(CONTROL_SPACES).sort()).toEqual(SIMS.map(s => s.id).sort())
    expect(SIMS).toHaveLength(41)
  })
  it.each(Object.entries(CONTROL_SPACES))('%s reaches both horizontal limits from an arbitrary centre', (id, profile) => {
    const motion = new Motion(), control = new CalibratedControl(motion)
    control.sim = id
    const neutral = quatFromDeviceOrientation(128, 75, 0, 0)
    motion.q = neutral; control.recenter()
    for (const sign of [-1, 1]) {
      motion.q = turn(sign * profile.reach[0], neutral)
      expect(control.sample().aim[0]).toBeCloseTo(sign, 5)
      expect(control.sample().aim[1]).toBeCloseTo(0, 5)
    }
    control.recenter()
    expect(control.sample().aim[0]).toBeCloseTo(0, 5)
    expect(control.sample().tilt.every(n => Math.abs(n) < 1e-6)).toBe(true)
    motion.q = turn(profile.reach[0] * 0.5, motion.q!)
    expect(control.sample().aim[0]).toBeCloseTo(0.5, 5)
  })
  it.each([0, 90, 180, 270])('calibrates upright, flat and rotated screens (%s degrees)', screen => {
    for (const beta of [0, 80]) {
      const motion = new Motion(), c = new CalibratedControl(motion)
      c.sim = 'studio'; c.recenter() // permissions may supply the first pose later
      motion.q = quatFromDeviceOrientation(17, beta, 0, screen)
      expect(c.sample().aim.every(n => Math.abs(n) < 1e-6)).toBe(true)
      const forward = qRotate(motion.q, beta === 0 ? [0, 1, 0] : [0, 0, -1]), length = Math.hypot(forward[0], forward[1])
      motion.q = qMul(qAxisAngle(forward[1] / length, -forward[0] / length, 0, 25 * D), motion.q)
      expect(c.sample().aim[1]).toBeCloseTo(1, 5)
      c.recenter()
      expect(c.sample().aim[1]).toBeCloseTo(0, 5)
    }
  })
  it('has a continuous three-degree neutral and clamps overtravel', () => {
    for (const degrees of [-3, -1, 0, 1, 3]) expect(Math.abs(reachAxis(degrees, 20, 3))).toBe(0)
    expect(reachAxis(3.001, 20, 3)).toBeLessThan(0.001)
    expect(reachAxis(11.5, 20, 3)).toBe(0.5)
    expect(reachAxis(-100, 20, 3)).toBe(-1)
    expect(reachAxis(NaN, 20)).toBe(0)
  })
  it('does not flip heading or lose upward reach in a near-upright grip', () => {
    for (const beta of [50, 60, 70, 80, 90]) {
      const m = new Motion(), c = new CalibratedControl(m)
      c.sim = 'studio'; m.q = quatFromDeviceOrientation(0, beta, 0, 0); c.recenter()
      m.q = quatFromDeviceOrientation(325, beta + 25, 0, 0)
      expect(c.sample().aim[0], `grip ${beta}`).toBeCloseTo(1, 5)
      expect(c.sample().aim[1], `grip ${beta}`).toBeCloseTo(1, 5)
    }
  })
  it('rejects nonfinite, oversized and malformed snapshots', () => {
    const good = { aim: [0.2, -1], tilt: [0, 0.5], active: true, pointer: true }
    expect(readControlAim(JSON.stringify(good))).toEqual(good)
    for (const bad of [{ ...good, aim: [2, 0] }, { ...good, tilt: [null, 0] }, { ...good, active: 1 }, { ...good, pointer: 'yes' }, null, []]) expect(readControlAim(JSON.stringify(bad))).toBeNull()
    expect(readControlAim('x'.repeat(161))).toBeNull()
  })
  it('waits for fresh orientation after sensors wake instead of capturing a cached pose', () => {
    const m = new Motion(), c = new CalibratedControl(m)
    m.q = quatFromDeviceOrientation(0, 70, 0, 0); c.recenter(); c.defer(); c.recenter()
    expect(c.sample().active).toBe(false)
    m.q = quatFromDeviceOrientation(40, 65, 0, 0)
    const s = c.sample()
    expect(s.active).toBe(true)
    expect(s.aim.every(n => Math.abs(n) < 1e-6)).toBe(true)
  })
})

describe('scope distribution', () => {
  it('centres a single unit and leaves comfortable spacing and margins in complete and partial rows', () => {
    expect(sceneCells(1)).toEqual([[0, 0]])
    for (let count = 2; count <= 12; count++) {
      const cells = sceneCells(count)
      expect(cells.reduce((sum, c) => sum + c[0], 0)).toBeCloseTo(0, 6)
      for (const [i, cell] of cells.entries()) {
        expect(Math.abs(cell[0])).toBeLessThanOrEqual(0.721)
        expect(Math.abs(cell[1])).toBeLessThanOrEqual(0.621)
        for (const next of cells.slice(i + 1)) expect(Math.hypot(cell[0] - next[0], cell[1] - next[1])).toBeGreaterThanOrEqual(0.359)
      }
    }
  })
  it.each(DEVICES.map(d => [d.spec.id, d.spec.units] as const))('%s maps scene reach to every unit and object reach only to the held unit', (id, count) => {
    sceneCells(count).forEach((aim, n) => {
      expect(deviceTarget(id, 'object', 0, aim, count)).toBe(0)
      expect(deviceTarget(id, 'scene', 0, aim, count)).toBe(sceneSelects(id) ? n : 0)
    })
  })
  it('fits each arm workspace before IK rather than using the screen camera', () => {
    for (const reach of [[0.15, 0.6], [0.22, 1.25]] as const) {
      const left = armWorkspace([-1, -1], [-95, 95], reach), right = armWorkspace([1, 1], [-95, 95], reach)
      expect(left.yaw).toBe(-95); expect(right.yaw).toBe(95)
      expect(Math.hypot(left.x, left.z)).toBeCloseTo(reach[0]); expect(Math.hypot(right.x, right.z)).toBeCloseTo(reach[1])
      expect(armHeight(1, [0.1, 0.8])).toBeCloseTo(0.8)
      expect(armHeight(-1, [0.1, 0.8])).toBeCloseTo(0.1)
    }
  })
  it.each(Object.entries(KINDS))('%s projects object aim into a joint-limited playable workspace', (_id, kind) => {
    const near = homeOf(kind.kin)
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
      const target = armWorkspace([x, y], kind.kin.yawRange, kind.drive.reach)
      const result = reachDown(kind.kin, target.yaw, target.reach, kind.drive.hover[0], 0, null, near)
      expect(result).not.toBeNull()
      expect(within(kind.kin, result!.pose)).toBe(true)
    }
  })
})

describe('reachable sim workspaces', () => {
  it('reaches the entire claw pit including the prize rows near its walls', () => {
    for (const n of [0, 1]) for (const sign of [-1, 1]) {
      const at = controlSpot('claw', [sign, sign], n)!
      expect(at[0] - (n ? 1 : -1)).toBeCloseTo(sign * (CLAW.half - 0.04))
      expect(at[1]).toBeCloseTo(-sign * (CLAW.half - 0.04))
      expect(Math.abs(at[1])).toBeGreaterThan(0.55)
    }
  })
  it('maps all drive and tilt profiles to calibrated deflection and leaves physical sticks alone', () => {
    for (const [id, profile] of Object.entries(CONTROL_SPACES)) {
      if (!['drive', 'tilt'].includes(profile.kind) || id === 'tank') continue
      const i = input(0.6, -0.8), mapped = mapDeviceSpace(id, i, 0)
      expect(mapped.mode, id).toBe(Mode.tilt)
      expect(mapped.tilt, id).toEqual([0.6, -0.8])
      const physical = { ...i, pad: { axes: [0, 0, 0, 0], triggers: [0, 0], buttons: 0 } } as DeviceInput
      expect(mapDeviceSpace(id, physical, 0)).toBe(physical)
    }
  })
  it('covers only each hockey player’s half, with a mallet-radius margin', () => {
    const l = new AirhockeyLogic()
    for (const sign of [-1, 1]) {
      l.step([0, 1].map(n => mapDeviceSpace('airhockey', input(sign, sign), n)), 1 / 60)
      l.units.forEach((u, n) => {
        expect(u.tx).toBeCloseTo(sign * (AIRHOCKEY.halfWidth - AIRHOCKEY.mallet))
        expect(u.tz * (n ? -1 : 1)).toBeGreaterThanOrEqual(AIRHOCKEY.mallet - 1e-8)
        expect(Math.abs(u.tz)).toBeLessThanOrEqual(AIRHOCKEY.halfLength - AIRHOCKEY.mallet + 1e-8)
      })
    }
  })
  it('maps the painter to its wall and never leaves a stroke floating off that canvas', () => {
    const l = new PainterLogic()
    for (const sign of [-1, 1]) for (let n = 0; n < 120; n++) l.step([{ ...input(sign, sign), touching: true }], 1 / 60)
    expect(l.units[0].x).toBeCloseTo(3.5); expect(l.units[0].y).toBeCloseTo(3.5)
    expect(l.strokes.length).toBeGreaterThan(10)
    expect(l.strokes.every(s => s.a[2] === -2.91 && s.b[2] === -2.91)).toBe(true)
  })
  it('keeps PTZ zoom available throughout calibrated pan and tilt travel', () => {
    const l = new PtzLogic()
    const zoom = l.cams[0].zoom
    l.step([{ ...input(1, -1), presses: ['wii-plus'] }], 1 / 60)
    expect(l.cams[0].goal).toEqual([-PTZ.pan, PTZ.tiltDown])
    expect(l.cams[0].zoom).toBeCloseTo(zoom * 1.25)
    l.step([input()], 1 / 60)
    expect(l.cams[0].goal).toEqual(l.cams[0].home)
    l.step([input(-1, 1)], 1 / 60)
    expect(l.cams[0].goal[0]).toBeCloseTo(PTZ.pan)
    expect(l.cams[0].goal[1]).toBeCloseTo(PTZ.tiltUp)
  })
  it('holds a lamp setting when pointing stops painting, including wheel brightness', () => {
    const l = new LampLogic(), i = mapDeviceSpace('lamp', { ...input(0.5, 0.3), point: { x: 0, y: 0, yaw: 0, pitch: 0, off: false }, held: new Set(['wii-b']) }, 0)
    l.step([i], 1 / 60)
    expect(l.lamps[0].h).toBeCloseTo(269.85)
    const level = l.lamps[0].v
    l.step([{ ...i, held: new Set(), wheel: 240 }], 1 / 60)
    for (let n = 0; n < 20; n++) l.step([{ ...i, held: new Set() }], 1 / 60)
    expect(l.lamps[0].v).toBeCloseTo(level - 0.1)
  })
  it('does not cancel a slider take until the phone actually moves', () => {
    const l = new SliderLogic(), i = input(-0.7, 0)
    l.step([{ ...i, presses: ['key'] }], 1 / 60)
    l.step([{ ...input(0.7, 0), presses: ['key'] }], 1 / 60)
    l.step([{ ...input(0.7, 0), presses: ['play'] }], 1 / 60)
    for (let n = 0; n < 60; n++) l.step([input(0.7, 0)], 1 / 60)
    expect(l.units[0].playing).toBe(true)
    expect(l.units[0].elapsed).toBeGreaterThan(1)
    l.step([{ ...input(), positioned: true }], 1 / 60)
    expect(l.units[0].playing).toBe(true)
    expect(l.units[0].keys).toHaveLength(2)
    l.step([input(0.4, 0)], 1 / 60)
    expect(l.units[0].playing).toBe(false)
  })
  it('selects all marble-run cells and uses the phone neutral after a run starts', () => {
    const l = new MarblerunLogic()
    l.step([mapDeviceSpace('marblerun', input(-1, 1), 0)], 1 / 60)
    expect([l.units[0].cursorX, l.units[0].cursorZ]).toEqual([0, 0])
    l.step([mapDeviceSpace('marblerun', { ...input(0.6, -0.4), presses: ['run'] }, 0)], 1 / 60)
    expect([l.units[0].tiltX, l.units[0].tiltZ]).toEqual([0.6, -0.4])
    l.step([mapDeviceSpace('marblerun', input(), 0)], 1 / 60)
    expect([l.units[0].tiltX, l.units[0].tiltZ]).toEqual([0, 0])
  })
  it('never moves the opposing football rods', () => {
    const l = new FootballLogic(), before = structuredClone(l.rods)
    l.step([input(1, 1)], 1 / 60)
    l.rods.forEach((r, n) => {
      if (RODS[n].seat % 2 === 1) expect(r).toEqual(before[n])
      else expect(r.x).toBe(0.3)
    })
  })
  it('never treats a new pendulum neutral as a push', () => {
    const l = new PendulumLogic()
    l.step([mapDeviceSpace('pendulum', input(0.8, 0), 0)], 1 / 60)
    l.step([mapDeviceSpace('pendulum', { ...input(), positioned: true }, 0)], 1 / 60)
    expect(l.units[0].actions).toBe(0)
    expect(l.units[0].omega).toBe(0)
    l.step([mapDeviceSpace('pendulum', input(-0.8, 0), 0)], 1 / 60)
    expect(l.units[0].actions).toBe(1)
  })
  it('starts pinball reversal detection afresh at Set position', () => {
    const l = new PinballLogic()
    l.step([mapDeviceSpace('pinball', input(1, 0), 0)], 1 / 60)
    l.step([mapDeviceSpace('pinball', { ...input(), positioned: true }, 0)], 1 / 60)
    l.step([mapDeviceSpace('pinball', input(-1, 0), 0)], 1 / 60)
    expect(l.units[0].actions).toBe(0)
    l.step([mapDeviceSpace('pinball', input(1, 0), 0)], 1 / 60)
    expect(l.units[0].actions).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { Euler, Group, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { emptyPad, Mode } from '@obpal/core'
import { ControlFrame } from '../src/sim/vr/control-frame'
import { driving, planar, rail } from '../src/sim/vr/intent'
import { RideLook, SteadyPose, upright, viewFov } from '../src/sim/vr/steady'
import { HandFrame } from '../src/sim/vr/inputs'
import { bodyPose, deviceRides, deviceState, deviceStyle } from '../src/sim/vr/rigs'
import { DEVICES } from '../src/sim/devices/registry'
import { restInput } from '../src/sim/devices/types'
import { ClawLogic } from '../src/sim/devices/claw'
import { DroneLogic } from '../src/sim/devices/drone'
import { AirhockeyLogic } from '../src/sim/devices/airhockey'
import { MazeLogic } from '../src/sim/devices/maze'
import { PtzLogic, lookOf } from '../src/sim/devices/ptz'
import { StudioLogic, studioKey } from '../src/sim/devices/studio'
import { PainterLogic } from '../src/sim/devices/painter'
import { DogLogic } from '../src/sim/devices/dog'
import { RoverLogic } from '../src/sim/devices/rover'
import { bucketTip, ExcavatorLogic } from '../src/sim/devices/excavator'
import { controlSpot, mapDeviceSpace } from '../src/sim/devices/control-space'
import { armWorkspace } from '../src/sim/arm/control-space'
import { musicTarget, resolveStrike } from '../src/music-space'
import { captureDevice, applyDevice } from '../src/sim/vr/snapshot'

const rotation = (yaw: number, pitch = 0, roll = 0) => new Quaternion().setFromEuler(new Euler(pitch, yaw, roll, 'YXZ'))
const inputFrame = (yaw: number, heading = 0, immersive = false) => ({ yaw, heading, immersive })

describe('the active view supplies one ground-plane control frame', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.7]) {
    for (const pitch of [0, -0.7, -Math.PI / 2]) it(`right, forward and up at yaw ${yaw}, pitch ${pitch}`, () => {
      const q = rotation(yaw, pitch), frame = new ControlFrame().set(q)
      expect(frame.move(1, 0, 0).dot(new Vector3(1, 0, 0).applyQuaternion(q))).toBeCloseTo(1)
      expect(frame.move(0, 0, 1).dot(frame.right)).toBeCloseTo(0)
      expect(frame.move(0, 1, 0).distanceTo(new Vector3(0, 1, 0))).toBe(0)
      expect(Math.hypot(...planar(inputFrame(yaw), 0.3, -0.7))).toBeCloseTo(Math.hypot(0.3, 0.7))
      frame.planar(0.3, -0.7).forEach((v, n) => expect(v).toBeCloseTo(planar(inputFrame(yaw), 0.3, -0.7)[n]))
    })
  }
  it('reverses spatial drive after orbiting behind, preserving wheels, pedals and cockpit drive', () => {
    expect(driving(inputFrame(Math.PI), 0, 1)[1]).toBeCloseTo(-1)
    expect(driving(inputFrame(Math.PI), 0, 1, true)).toEqual([0, 1])
    expect(driving(inputFrame(Math.PI, 0, true), 0.5, 1)).toEqual([0.5, 1])
    expect(rail(inputFrame(Math.PI))).toBe(-1)
    expect(driving(inputFrame(0), 0, 0)).toEqual([0, 0])
  })
  it('accounts for body yaw exactly once for a flying translation', () => {
    expect(planar(inputFrame(Math.PI / 2, Math.PI / 2, true), 1, 0, true)).toEqual([1, 0])
    const [x, z] = planar(inputFrame(Math.PI, Math.PI / 2), 1, 0, true)
    expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(-1)
  })
  it('keeps full diagonal stick input within the throttle range after rotation', () => {
    for (const ackermann of [false, true]) {
      const [, power] = driving(inputFrame(Math.PI / 4), 1, 1, false, ackermann)
      expect(power).toBeCloseTo(1)
    }
  })
})

describe('device intents point the way the view suggests', () => {
  it('turns the dog before walking across the wrong screen axis from an oblique overview', () => {
    const l = new DogLogic(), u = l.units[0], start = new Vector3(u.x, 0, u.z), i = restInput(), yaw = Math.atan2(-2.1, 3.15)
    i.pad = emptyPad(); i.pad.axes = [0.55, -0.65, 0, 0]
    for (let n = 0; n < 40; n++) { i.controlFrame = inputFrame(yaw, u.h); l.step([i], 1 / 60) }
    expect(new Vector3(u.x, 0, u.z).sub(start).dot(new ControlFrame().set(rotation(yaw)).right)).toBeGreaterThan(0.01)
  })
  for (const make of [() => new DogLogic(), () => new RoverLogic()]) it('steers a reversing body toward screen right after a half orbit', () => {
    const l = make(), u = deviceState(l, 0), start = new Vector3(u.x, 0, u.z), i = restInput()
    i.pad = emptyPad(); i.pad.axes = [0.6, -0.8, 0, 0]
    for (let n = 0; n < 100; n++) { i.controlFrame = inputFrame(Math.PI, u.h); l.step([i], 1 / 60) }
    expect(u.x).toBeLessThan(start.x - 0.02)
    expect(u.z).toBeGreaterThan(start.z + 0.02)
  })
  it('keeps note order across octave boundaries and plays an XR-selected key once', () => {
    const notes = [60, 62, 64, 67, 69, 72, 74, 76].map(studioKey)
    expect(notes).toEqual([...notes].sort((a, b) => a - b))
    const l = new StudioLogic(), i = restInput(); i.pad = emptyPad(); i.pad.axes[0] = 0.8; i.controlFrame = inputFrame(Math.PI)
    l.step([null, null, null, null, i], 0.1); expect(l.cursor[4]).toBeLessThan(7)
    i.padPressed = 1; l.step([null, null, null, null, i], 0.01)
    i.padPressed = 0; l.step([null, null, null, null, i], 0.01); expect(l.counts[4]).toBe(1)
  })
  it('retains painter depth between wheel events', () => {
    const l = new PainterLogic(), i = restInput(); i.point = { x: 0, y: 0, yaw: 0, pitch: 0, off: false }; i.wheel = 100
    l.step([i], 0.05); i.wheel = 0; l.step([i], 0.05); expect(l.units[0].z).toBeCloseTo(0.2)
  })
  for (const side of [0, Math.PI]) for (const face of ['pad', 'drag', 'point', 'motion', 'calibrated']) it(`PTZ ${face} follows screen pan from side ${side}`, () => {
    const l = new PtzLogic(), c = l.cams[0], i = restInput(), yaw = c.pan + side
    i.controlFrame = inputFrame(yaw)
    const before = new Vector3(...lookOf(c.pan, c.tilt))
    if (face === 'pad') { i.pad = emptyPad(); i.pad.axes[2] = 0.5 }
    if (face === 'drag') i.drag = [3, 0]
    if (face === 'point') i.point = { x: 0, y: 0, yaw: 5, pitch: 0, off: false }
    if (face === 'motion') { i.mode = Mode.tilt; i.tilt = [0.5, 0] }
    if (face === 'calibrated') i.space = { aim: [0.1, 0], tilt: [0, 0], active: true }
    l.step([i], 1 / 60)
    expect(new Vector3(...lookOf(c.pan, c.tilt)).sub(before).dot(new ControlFrame().set(rotation(yaw)).right)).toBeGreaterThan(0)
  })
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (const face of ['face.gamepad', 'face.trackpad', 'motion']) it(`claw ${face} at ${yaw}`, () => {
      const l = new ClawLogic(), u = l.claws[0], input = restInput()
      u.x = u.z = 0
      input.controlFrame = inputFrame(yaw)
      if (face === 'face.gamepad') { input.pad = emptyPad(); input.pad.axes[0] = 0.8 }
      else if (face === 'motion') { input.mode = Mode.tilt; input.tilt = [0.8, 0] }
      else { input.touching = true; input.drag = [4, 0] }
      for (let n = 0; n < 8; n++) l.step([input], 1 / 60)
      expect(new Vector3(u.x, 0, u.z).dot(new ControlFrame().set(rotation(yaw)).right)).toBeGreaterThan(0)
    })
    it(`drone overview translation at ${yaw}`, () => {
      const l = new DroneLogic(), u = l.drones[0], input = restInput()
      Object.assign(u, { x: 0, y: 2, z: 0, yaw: 0.6, phase: 'flying' })
      input.controlFrame = inputFrame(yaw, u.yaw); input.pad = emptyPad(); input.pad.axes[2] = 0.8
      for (let n = 0; n < 20; n++) l.step([input], 1 / 60)
      expect(new Vector3(u.x, 0, u.z).dot(new ControlFrame().set(rotation(yaw)).right)).toBeGreaterThan(0.02)
    })
    it(`air hockey drag at ${yaw}`, () => {
      const l = new AirhockeyLogic(), input = restInput('face.trackpad'), start = l.units[0].z
      input.controlFrame = inputFrame(yaw); input.touching = true; input.drag = [3, 0]
      l.step([input], 1 / 60)
      expect(new Vector3(l.units[0].x, 0, l.units[0].z - start).dot(new ControlFrame().set(rotation(yaw)).right)).toBeGreaterThan(0.001)
    })
    it(`maze motion tilt at ${yaw}`, () => {
      const l = new MazeLogic(), input = restInput('face.trackpad', Mode.tilt)
      input.controlFrame = inputFrame(yaw); input.tilt = [0.7, 0]
      for (let n = 0; n < 5; n++) l.step([input], 1 / 60)
      const u = l.boards[0]
      expect(new Vector3(u.tx, 0, u.tz).dot(new ControlFrame().set(rotation(yaw)).right)).toBeGreaterThan(0)
    })
  }
  it('ratchets air position through a changed view without moving an existing goal', () => {
    const h = new HandFrame(), p = { p: [0, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number], gen: 1, touching: true, tracked: true }
    h.map(p, inputFrame(0))
    p.p[0] = 0.2
    expect(h.map(p, inputFrame(0)).p[0]).toBeCloseTo(0.2)
    expect(h.map(p, inputFrame(Math.PI)).p[0]).toBeCloseTo(0.2)
    p.p[0] = 0.3
    expect(h.map(p, inputFrame(Math.PI)).p[0]).toBeCloseTo(0.1)
    p.touching = false; h.map(p, inputFrame(0)); p.touching = true
    expect(h.map(p, inputFrame(0)).p).toEqual([0, 0, 0])
  })
  it('keeps a painter or bucket orientation already present in the first tracked sample', () => {
    const h = new HandFrame(), q = rotation(0, 0.4), p = { p: [0, 0, 0] as [number, number, number], q: q.toArray(), gen: 1, touching: true, tracked: true }
    expect(new Quaternion(...h.map(p, inputFrame(0), false, false).q).angleTo(q)).toBeCloseTo(0)
  })
})

describe('calibrated control spaces turn with the active view', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (const id of ['claw', 'rover', 'spotlights', 'airhockey']) it(`${id} right and forward reach at ${yaw}`, () => {
      const frame = inputFrame(yaw), basis = new ControlFrame().set(rotation(yaw)), centre = controlSpot(id, [0, 0], 0, frame)!
      for (const [aim, direction] of [[[0.2, 0], basis.right], [[0, 0.2], basis.forward]] as const) {
        const [x, z] = controlSpot(id, aim, 0, frame)!
        const delta = new Vector3(x - centre[0], 0, z - centre[1])
        expect(delta.dot(direction)).toBeGreaterThan(0.01)
        expect(delta.clone().normalize().distanceTo(direction)).toBeLessThan(1e-6)
      }
      const i = restInput('face.wii', Mode.point); i.controlFrame = frame; i.space = { aim: [0.2, 0], tilt: [0, 0], active: true }
      i.point = { x: 0, y: 0, yaw: 0, pitch: 0, off: false }
      expect(mapDeviceSpace(id, i, 0).spot).toEqual(controlSpot(id, [0.2, 0], 0, frame))
    })
    it(`arm workspace preserves limits and screen right at ${yaw}`, () => {
      const centre = armWorkspace([0, 0], [-170, 170], [0.1, 1], yaw), target = armWorkspace([0.2, 0], [-170, 170], [0.1, 1], yaw)
      expect(new Vector3(target.x - centre.x, 0, target.z - centre.z).dot(new ControlFrame().set(rotation(yaw)).right)).toBeGreaterThan(0.1)
      expect(target.yaw).toBeGreaterThanOrEqual(-170); expect(target.yaw).toBeLessThanOrEqual(170)
      expect(target.reach).toBeGreaterThanOrEqual(0.1); expect(target.reach).toBeLessThanOrEqual(1)
    })
  }
  it('mirrors studio air targets and strike snapshots together after a half orbit', () => {
    const left = musicTarget([0.6, 0], 'object', 5, -1), right = musicTarget([-0.6, 0], 'object', 5, -1)
    expect(left.surface).toBeLessThan(right.surface)
    expect(resolveStrike([0.6, 0], 'object', 'object', 5, () => true, -1)).toEqual(left)
    expect(resolveStrike([0.6, 0], 'object', 'object', 5, () => false, -1)).toBeNull()
  })
  it('shares studio target highlights with a headset without replacing their sets', () => {
    const host = new StudioLogic(), guest = new StudioLogic(), set = guest.aimed[4]
    host.aimed[4].add(9); host.cursor[4] = 9
    applyDevice(guest, captureDevice(host))
    expect(guest.aimed[4]).toBe(set); expect([...set]).toEqual([9]); expect(guest.cursor[4]).toBe(9)
  })
})

describe('rig styles, steadying, view switch and recenter', () => {
  it('preserves workspace width in portrait without widening a lens or body view', () => {
    for (const aspect of [0.45, 0.6, 1, 1.6]) {
      const fov = viewFov(aspect, true)
      expect(Math.tan(fov * Math.PI / 360) * aspect).toBeCloseTo(Math.tan(75 * Math.PI / 360) * Math.max(1, aspect))
      expect(viewFov(aspect, false)).toBe(75)
    }
  })
  it('keeps the excavator bucket in its operator view throughout the reachable swing', () => {
    const logic = new ExcavatorLogic(), p = deviceRides(logic, new Group())[0].pose()
    for (const aspect of [0.45, 1.6]) {
      const camera = new PerspectiveCamera(viewFov(aspect, true), aspect, 0.015, 300)
      camera.position.copy(p.p); camera.quaternion.copy(p.q); camera.updateMatrixWorld(true)
      for (let swing = -Math.PI; swing < Math.PI; swing += Math.PI / 12) for (const boom of [0.05, 0.65, 1.35]) for (const stick of [-2.4, -1.35, -0.1]) {
        Object.assign(logic.units[0], { swing, boom, stick })
        const tip = new Vector3(...bucketTip(logic.units[0]))
        if (tip.y < 0.08) continue
        tip.project(camera)
        expect(Math.max(Math.abs(tip.x), Math.abs(tip.y))).toBeLessThan(0.9)
        expect(tip.z).toBeLessThan(1)
      }
    }
  })
  for (const d of DEVICES) it(`${d.spec.id} has two finite, upright view choices`, () => {
    const logic = d.logic(), rides = deviceRides(logic, new Group())
    expect(rides.every(r => r.views!.length >= 2)).toBe(true)
    for (const r of rides) for (const v of r.views!) {
      const p = v.pose()
      expect([...p.p.toArray(), ...p.q.toArray()].every(Number.isFinite)).toBe(true)
      expect(new Vector3(1, 0, 0).applyQuaternion(upright(p.q)).y).toBeCloseTo(0)
    }
    if (['body', 'flyer'].includes(deviceStyle(d.spec.id))) {
      const before = bodyPose(logic, 0), u = deviceState(logic, 0)
      Object.assign(u, { pitch: 0.5, roll: 0.7, turret: 1.2, mastPan: 0.5, gait: 3, sit: 1 })
      expect(bodyPose(logic, 0)).toEqual(before)
    }
  })
  it('is independent of refresh rate and takes the shortest yaw across pi', () => {
    const run = (hz: number) => {
      const f = new SteadyPose(); f.step({ p: new Vector3(), q: rotation(3.1) }, 0)
      let p
      for (let n = 0; n < hz; n++) p = f.step({ p: new Vector3(1, 0, 0), q: rotation(-3.1) }, 1 / hz)
      return p!
    }
    const a = run(60), b = run(90)
    expect(a.p.distanceTo(b.p)).toBeLessThan(1e-8); expect(a.q.angleTo(b.q)).toBeLessThan(1e-6)
    expect(new Vector3(0, 0, -1).applyQuaternion(a.q).z).toBeGreaterThan(0.99)
  })
  it('removes roll without removing the lens tilt', () => {
    const q = upright(rotation(0.7, -0.8, 1.1)), e = new Euler().setFromQuaternion(q, 'YXZ')
    expect(e.x).toBeCloseTo(-0.8); expect(e.y).toBeCloseTo(0.7); expect(e.z).toBeCloseTo(0)
    expect(new Vector3(0, 0, -1).applyQuaternion(upright(q, true)).y).toBeCloseTo(0)
  })
  it('switches cyclically, recentres both offsets, and eases only temporary driving look', () => {
    const l = new RideLook(); l.yaw = 1; l.pitch = 0.5; l.snap(1, 30)
    expect(l.turn).toBeLessThan(0)
    l.step(1, true, false); expect(l.yaw).toBeLessThan(0.1); expect(l.turn).toBeCloseTo(-Math.PI / 6)
    l.switch(2); expect(l.viewpoint).toBe(1); expect(l.yaw + l.pitch + l.turn).toBe(0)
    l.switch(2); expect(l.viewpoint).toBe(0)
    l.yaw = 1; l.held = true; l.step(1, true, false); expect(l.yaw).toBe(1)
    l.step(1, true, true); expect(l.yaw).toBeLessThan(0.01)
    l.recenter(); expect(l.yaw).toBe(0)
  })
})

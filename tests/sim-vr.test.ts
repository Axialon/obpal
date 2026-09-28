import { describe, expect, it } from 'vitest'
import { Group, Quaternion, Vector3 } from 'three'
import { validSimMessage, emptyPad } from '@obpal/core'
import { DEVICES } from '../src/sim/devices/registry'
import { ARM_KINDS } from '../src/sim/arm/kinds'
import { kindFrom } from '../src/sim/arm/kind'
import { DEVICE_RIGS, anchorPose, armRide, deviceRides, fallbackPose } from '../src/sim/vr/rigs'
import { comfort, vignetteStrength, XRQuality } from '../src/sim/vr/comfort'
import { PropWorld } from '../src/sim/vr/world'
import { captureDevice, applyDevice } from '../src/sim/vr/snapshot'
import { validPresence } from '../src/sim/vr/presence'
import { collideDevices } from '../src/sim/vr/collisions'
import { SubmarineLogic } from '../src/sim/devices/submarine'

describe('every catalogue device can be occupied', () => {
  for (const d of DEVICES) it(`${d.spec.id}: every unit has a finite moving pose and a bounded snapshot`, () => {
    const logic = d.logic(), scene = new Group(), rides = deviceRides(logic, scene)
    expect(DEVICE_RIGS[d.spec.id]).toBeDefined()
    expect(rides).toHaveLength(d.spec.units)
    for (const r of rides) {
      const pose = r.pose()
      expect([...pose.p.toArray(), ...pose.q.toArray()].every(Number.isFinite)).toBe(true)
      expect(pose.q.length()).toBeCloseTo(1)
    }
    for (let i = 0; i < 10; i++) logic.step(Array(d.spec.units).fill(null), 1 / 60)
    const state = captureDevice(logic)
    expect(validSimMessage({ t: 'sim', v: 1, kind: 'frame', seq: 1, data: state })).toBe(true)
    const copy = d.logic(); applyDevice(copy, state)
    expect(captureDevice(copy)).toEqual(state)
  })
  for (const kind of ARM_KINDS) it(`${kind.id}: the wrist camera follows its grasp transform`, () => {
    const k = kindFrom(kind.id)
    expect(k.kin.forward(Object.fromEntries(k.kin.keys.map((key, i) => [key, k.kin.joints[i].home])))).toBeDefined()
    const root = new Group(), grasp = new Group(); root.add(grasp)
    const ride = armRide('a1', 'Wrist', root, grasp), before = ride.pose().p
    grasp.position.set(0.1, 0.2, 0.3); grasp.rotation.z = 0.8
    expect(ride.pose().p.distanceTo(before)).toBeGreaterThan(0.2)
  })
  it('prefers +Z-forward anchors, including replacements loaded later', () => {
    const scene = new Group(), model = new Group(), anchor = new Group(); anchor.name = 'pov'; model.add(anchor); scene.add(model)
    model.position.set(2, 3, 4); model.rotation.y = 0.6
    const r = deviceRides(DEVICES[0].logic(), scene)[0].pose()
    expect(r.p.toArray()).toEqual([2, 3, 4])
    expect(new Vector3(0, 0, -1).applyQuaternion(r.q).distanceTo(new Vector3(0, 0, 1).applyQuaternion(model.quaternion))).toBeLessThan(1e-6)
    model.remove(anchor)
    expect(deviceRides(DEVICES[0].logic(), scene)[0].pose().p.equals(r.p)).toBe(false)
  })
  it('mobile vehicle poses follow logic without a model', () => {
    const l = new SubmarineLogic(), p = fallbackPose(l, 0)
    l.units[0].x += 3; l.units[0].h = Math.PI / 2
    const next = fallbackPose(l, 0)
    expect(next.p.x).toBeGreaterThan(p.p.x + 1)
    expect(next.q.angleTo(p.q)).toBeCloseTo(Math.PI / 2)
  })
  it('arena and viewer roots can supply the same anchor contract', () => {
    for (const name of ['arena', 'viewer']) { const anchor = new Group(); anchor.name = name; expect(anchorPose(anchor).q.angleTo(new Quaternion())).toBeCloseTo(Math.PI) }
  })
})

describe('comfort and XR budget', () => {
  it('defaults and stored values are bounded', () => { expect(comfort({ snap: 90, horizon: 'no' })).toEqual({ snap: 30, horizon: true, vignette: true }); expect(comfort({ horizon: false, snap: 45 }).snap).toBe(45) })
  it('shades fast travel but leaves slow viewing clear', () => { expect(vignetteStrength(0, 0, true)).toBe(0); expect(vignetteStrength(20, 0, true)).toBe(0.8); expect(vignetteStrength(20, 3, false)).toBe(0) })
  it('uses the requested frame rate and recovers gradually', () => {
    const q = new XRQuality()
    for (let i = 0; i < 96; i++) q.frame(1 / 45, 90)
    expect(q.foveation).toBe(1); expect(q.shadows).toBe(false)
    for (let i = 0; i < 2400; i++) q.frame(1 / 90, 90)
    expect(q.foveation).toBeCloseTo(0.5); expect(q.shadows).toBe(true)
  })
})

describe('untrusted presence and authoritative grabs', () => {
  const input = () => ({ ride: 'drone1', active: true, head: { p: [0, 1, 0], q: [0, 0, 0, 1] }, hands: [], grab: false, pad: emptyPad() })
  it('rejects malformed envelopes, nonfinite data, versions and prototype keys', () => {
    for (const data of [NaN, Infinity, JSON.parse('{"__proto__":0}'), Array(4097).fill(0), 'x'.repeat(2049)]) expect(validSimMessage({ t: 'sim', v: 1, kind: 'input', seq: 1, data })).toBe(false)
    expect(validSimMessage({ t: 'sim', v: 2, kind: 'input', seq: 1, data: null })).toBe(false)
    expect(validSimMessage({ t: 'sim', v: 1, kind: 'input', seq: -1, data: null })).toBe(false)
  })
  it('validates head, hands and gamepad bounds before physics sees them', () => {
    expect(validPresence(input())).toBe(true)
    const p = input(); p.head.q[3] = 8; expect(validPresence(p)).toBe(false)
    const p2 = input(); p2.pad.axes[0] = NaN; expect(validPresence(p2)).toBe(false)
    expect(validPresence({ ...input(), hands: [input().head, input().head, input().head] })).toBe(false)
  })
  it('one owner wins; distant grabs and teleporting hands fail', () => {
    const w = new PropWorld(), b = w.add('ball', [0, 1, 0], 0.1)
    expect(w.grab('a', b.id, [0, 1, 0], 0)).toBe(true)
    expect(w.grab('b', b.id, [0, 1, 0], 0)).toBe(false)
    expect(w.move('a', [8, 1, 0], 50)).toBe(false)
    w.release('a'); expect(w.grab('b', b.id, [8, 1, 0], 60)).toBe(false)
  })
  it('throws with measured, capped velocity and releases stale hands', () => {
    const w = new PropWorld(), b = w.add('ball', [0, 1, 0], 0.1)
    w.grab('a', b.id, [0, 1, 0], 0); w.move('a', [0.3, 1.2, 0], 50); w.release('a')
    expect(b.v).toEqual([expect.closeTo(6), expect.closeTo(4), 0]); w.step(0.05, 100); expect(b.p[0]).toBeGreaterThan(0.3)
    w.grab('a', b.id, [...b.p], 100); w.step(0.05, 601); expect(b.owner).toBeNull(); expect(b.v[0]).toBe(0)
  })
  it('a moving device displaces a shared cone', () => {
    const w = new PropWorld(), b = w.add('cone', [0, 0.18, 0], 0.18)
    w.step(1 / 60, 0, [{ p: [-0.2, 0.18, 0], r: 0.3 }])
    expect(b.p[0]).toBeGreaterThan(0.2)
  })
  it('fills missing device contacts and respects vertical separation', () => {
    const l = new SubmarineLogic(); Object.assign(l.units[1], { x: l.units[0].x, z: l.units[0].z }); collideDevices(l)
    expect(Math.abs(l.units[0].x - l.units[1].x)).toBeCloseTo(0.6)
    l.units[1].x = l.units[0].x; l.units[1].y += 2; collideDevices(l); expect(l.units[0].x).toBe(l.units[1].x)
  })
})

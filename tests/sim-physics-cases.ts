/** The same assertions run under Vitest and the offline Node evidence harness. */
import { assert } from './sim-node.mjs'
import { FixedWorld, type PhysicsAdapter } from '../src/sim/physics/world'
import { PendulumAdapter, pendulumEnergy } from '../src/sim/physics/pendulum'
import { interpolateTransform } from '../src/sim/physics/interpolation'
import { contactMaterial } from '../src/sim/physics/materials'
import { PendulumLogic } from '../src/sim/devices/pendulum'
import { restInput } from '../src/sim/devices/types'
import { captureDevice, applyDevice } from '../src/sim/vr/snapshot'
import { Mode } from '@obpal/core'

const near = (a: number, b: number, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b} by more than ${tolerance}`)
const unit = () => ({ length: 1.2, damping: .08, angle: 0, omega: 0 })
function linear() {
  let position = 0, disposed = 0
  const adapter: PhysicsAdapter<number> = {
    name: 'linear-test', bodyCount: 1, sleepingCount: 0,
    step: dt => { position += dt }, capture: () => position,
    interpolate: (a, b, t) => a + (b - a) * t,
    dispose: () => { disposed++ },
  }
  return { adapter, position: () => position, disposed: () => disposed }
}

export function physicsCases(test: (name: string, run: () => void) => unknown) {
  test('physics: fixed ticks are independent of render partition for the same elapsed time', () => {
    const a = linear(), b = linear(), wa = new FixedWorld(a.adapter), wb = new FixedWorld(b.adapter)
    for (let n = 0; n < 60; n++) wa.advance(1 / 60)
    for (let n = 0; n < 120; n++) wb.advance(1 / 120)
    assert.equal(wa.diagnostics().tick, 240); assert.equal(wb.diagnostics().tick, 240)
    assert.equal(a.position(), b.position()); assert.equal(wa.render(), wb.render())
  })
  test('physics: fractional frames interpolate continuously without changing the solver', () => {
    const a = linear(), w = new FixedWorld(a.adapter)
    w.advance(1 / 240); near(w.render(), 0)
    w.advance(1 / 480); near(w.render(), 1 / 480); near(a.position(), 1 / 240)
    w.advance(1 / 480); near(w.render(), 1 / 240); near(a.position(), 1 / 120)
    assert.equal(w.diagnostics().tick, 2)
  })
  test('physics: time lost to frame clamping and step budgets is accounted, not caught up later', () => {
    const a = linear(), w = new FixedWorld(a.adapter, { maxSteps: 2 })
    w.advance(2)
    assert.equal(w.diagnostics().steps, 2); near(w.diagnostics().droppedSeconds, 2 - 2 / 240)
    w.advance(0); assert.equal(w.diagnostics().steps, 0); assert.equal(w.diagnostics().tick, 2)
  })
  test('physics: invalid and negative frame times cannot poison the accumulator', () => {
    const a = linear(), w = new FixedWorld(a.adapter)
    for (const dt of [NaN, Infinity, -Infinity, -1]) w.advance(dt)
    assert.equal(w.diagnostics().invalidFrames, 4); assert.equal(a.position(), 0)
    w.advance(1 / 240); assert.equal(w.diagnostics().tick, 1)
  })
  test('physics: invalid budgets and excess bodies are rejected', () => {
    for (const budget of [{ step: 0 }, { step: NaN }, { maxSteps: 1.5 }, { maxBodies: 0 }, { maxFrame: Infinity }])
      assert.throws(() => new FixedWorld(linear().adapter, budget))
    assert.throws(() => new FixedWorld({ ...linear().adapter, bodyCount: 4 }, { maxBodies: 3 }))
  })
  test('physics: snapshot reset preserves fractional time without interpolating from the old pose', () => {
    const a = linear(), w = new FixedWorld(a.adapter)
    w.advance(1 / 160); const alpha = w.diagnostics().alpha
    w.snap(); near(w.render(), a.position()); assert.equal(w.diagnostics().alpha, alpha)
  })
  test('physics: disposal releases the backend once and prevents reuse', () => {
    const a = linear(), w = new FixedWorld(a.adapter)
    w.dispose(); w.dispose(); assert.equal(a.disposed(), 1)
    assert.throws(() => w.advance(.01)); assert.throws(() => w.render()); assert.throws(() => w.snap())
  })
  test('physics: pendulum states and snapshots are independent', () => {
    const a = unit(), b = unit(); a.omega = 1
    const adapter = new PendulumAdapter([a, b]), before = adapter.capture()
    adapter.step(1 / 240)
    assert.equal(before[0].angle, 0); assert.ok(a.angle > 0); assert.equal(b.angle, 0)
  })
  test('physics: undamped pendulum energy stays bounded for sixty seconds', () => {
    const u = unit(); u.angle = .8; u.damping = 0
    const a = new PendulumAdapter([u]), initial = pendulumEnergy(u)
    let error = 0
    for (let n = 0; n < 60 * 240; n++) { a.step(1 / 240); error = Math.max(error, Math.abs(pendulumEnergy(u) / initial - 1)) }
    assert.ok(error < .001, `relative energy error ${error}`)
  })
  test('physics: sleeping pendulums stay exactly still and wake on a push', () => {
    const u = unit(), a = new PendulumAdapter([u])
    for (let n = 0; n < 240; n++) a.step(1 / 240)
    assert.equal(a.sleepingCount, 1); assert.equal(pendulumEnergy(u), 0)
    u.omega = 1; a.step(1 / 240); assert.equal(a.sleepingCount, 0); assert.ok(u.angle > 0)
  })
  test('physics: damping removes energy and leaves no persistent rest jitter', () => {
    const u = unit(); u.angle = .6; u.damping = 1.2
    const a = new PendulumAdapter([u]), initial = pendulumEnergy(u)
    for (let n = 0; n < 30 * 240; n++) a.step(1 / 240)
    assert.ok(pendulumEnergy(u) < initial * 1e-8); assert.equal(a.sleepingCount, 1)
    assert.equal(u.angle, 0); assert.equal(u.omega, 0)
  })
  test('physics: invalid pendulum state is rejected before any body advances', () => {
    const a = unit(), b = unit(); a.omega = 1; b.length = NaN
    assert.throws(() => new PendulumAdapter([a, b])); assert.equal(a.angle, 0)
    b.length = 1.2; const adapter = new PendulumAdapter([a, b]); b.angle = NaN
    assert.throws(() => adapter.step(1 / 240)); assert.equal(a.angle, 0)
  })
  test('physics: extreme pushes stay inside the lab angular and speed stops', () => {
    const u = unit(); u.angle = 1.39; u.omega = 5; u.damping = 0
    const a = new PendulumAdapter([u])
    for (let n = 0; n < 2400; n++) { a.step(1 / 240); assert.ok(Math.abs(u.angle) <= 1.4); assert.ok(Math.abs(u.omega) <= 5) }
  })
  test('physics: material combination is symmetric and returns fresh defaults', () => {
    assert.deepEqual(contactMaterial('metal', 'rubber'), contactMaterial('rubber', 'metal'))
    const a = contactMaterial('metal', 'metal'); a.friction = 9
    assert.ok(contactMaterial('metal', 'metal').friction < 1)
  })
  test('physics: transforms interpolate position and the shortest quaternion arc', () => {
    const a = { p: [0, 0, 0] as const, q: [0, 0, 0, 1] as const }
    const b = { p: [2, 4, 6] as const, q: [0, 0, 0, -1] as const }
    const r = interpolateTransform(a, b, .5)
    assert.deepEqual(r.p, [1, 2, 3]); near(Math.abs(r.q[3]), 1)
    assert.deepEqual(a.p, [0, 0, 0]); near(Math.hypot(...r.q), 1)
  })
  test('physics: transform endpoints clamp interpolation and reject corrupt rotations', () => {
    const a = { p: [0, 0, 0] as const, q: [0, 0, 0, 1] as const }
    const b = { p: [2, 4, 6] as const, q: [0, 1, 0, 0] as const }
    assert.deepEqual(interpolateTransform(a, b, -1).p, a.p)
    assert.deepEqual(interpolateTransform(a, b, 2).p, b.p)
    assert.throws(() => interpolateTransform(a, { ...b, q: [0, 0, 0, 0] }, .5))
    assert.throws(() => interpolateTransform(a, b, NaN))
  })
  test('pendulum migration: touch limits and experiment isolation remain intact', () => {
    const l = new PendulumLogic(), i = restInput(); i.drag = [10000, -10000]; l.step([i], .05)
    assert.equal(l.units[0].length, 2.2); assert.equal(l.units[0].damping, 1.2); assert.equal(l.units[1].length, 1.45)
    i.drag = [-10000, 10000]; l.step([i], .05); assert.equal(l.units[0].length, .55); assert.equal(l.units[0].damping, 0)
  })
  test('pendulum migration: tilt pushes debounce and quiet inputs do not derive fresh impulses', () => {
    const l = new PendulumLogic(), i = restInput('face.trackpad', Mode.tilt)
    l.step([i], .05); i.tilt = [.6, 0]; l.step([i], .05)
    assert.equal(l.units[0].actions, 1); assert.ok(l.units[0].omega > 1)
    i.tilt = [-.6, 0]; l.step([i], .05); assert.equal(l.units[0].actions, 1)
    i.quiet = true; for (let n = 0; n < 20; n++) l.step([i], .05)
    assert.equal(l.units[0].actions, 1)
  })
  test('pendulum migration: period, damping, bounded history and home match the old contract', () => {
    const l = new PendulumLogic(), u = l.units[0]; u.angle = .1; u.damping = 0
    const period = 2 * Math.PI * Math.sqrt(u.length / 9.81)
    for (let t = 0; t < period; t += 1 / 240) l.step([], 1 / 240)
    near(u.angle, .1, .005)
    u.damping = 1; for (let n = 0; n < 200; n++) l.step([], .05)
    assert.ok(Math.abs(u.angle) + Math.abs(u.omega) < .01); assert.ok(u.trace.length <= 300)
    l.home(0); assert.deepEqual(u.trace, []); assert.deepEqual(l.renderState()[0], { angle: 0, length: 1.2 })
  })
  test('pendulum migration: free motion is identical at 30, 60 and 120 rendering frames per second', () => {
    const result = [30, 60, 120].map(fps => {
      const l = new PendulumLogic(); l.units[0].angle = .6
      for (let n = 0; n < fps * 5; n++) l.step([], 1 / fps)
      return { angle: l.units[0].angle, omega: l.units[0].omega, trace: l.units[0].trace }
    })
    assert.deepEqual(result[0], result[1]); assert.deepEqual(result[1], result[2])
  })
  test('pendulum migration: one tray edge applies only once even when no fixed tick is due', () => {
    const l = new PendulumLogic(), i = restInput(); i.presses = ['push']
    l.step([i], 1 / 1000); assert.equal(l.units[0].actions, 1)
    l.step([], 1 / 1000); assert.equal(l.units[0].actions, 1)
    l.step([], 1 / 1000); l.step([], 1 / 1000); l.step([], 1 / 1000)
    assert.ok(l.units[0].angle > 0); assert.equal(l.units[0].actions, 1)
  })
  test('pendulum migration: shared guests render replicated state without running host physics', () => {
    const host = new PendulumLogic(), guest = new PendulumLogic()
    host.units[0].omega = 1.4; host.step([], .05)
    applyDevice(guest, captureDevice(host))
    near(guest.renderState()[0].angle, host.units[0].angle)
    assert.equal(guest.physicsDiagnostics().tick, 0)
  })
  test('pendulum migration: non-finite touch deltas and frame times cannot create NaN', () => {
    const l = new PendulumLogic(), i = restInput(); i.drag = [NaN, Infinity]
    for (const dt of [NaN, Infinity, -1, 0, 1 / 60]) l.step([i], dt)
    for (const u of l.units) assert.ok([u.angle, u.omega, u.length, u.damping].every(Number.isFinite))
  })
}

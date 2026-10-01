/** Dependency-free contract assertions; also registered unchanged by the canonical Vitest entry. */
import { assert } from './sim-node.mjs'
import { validateScene, DEFAULT_LIMITS, STEP } from '../src/sim/physics/schema'
import { quaternion, rotationVector, fromRotationVector, swingTwist, clampCone, norm, sub } from '../src/sim/physics/math'
import { Simulation } from '../src/sim/physics/runtime'
import { createCustomBackend } from '../src/sim/physics/backends/custom'
import { fixture, measureFixture } from '../src/sim/physics/fixtures'
import type { BackendFactory, SceneInput } from '../src/sim/physics/schema'

const near = (a: number, b: number, e = 1e-8) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b} (+/- ${e})`)
const fail = async (run: () => Promise<unknown>) => { let rejected = false; try { await run() } catch { rejected = true }; assert.ok(rejected, 'expected rejection') }
const ball = (): SceneInput => ({ bodies: [{ id: 'ball', shape: { kind: 'sphere', radius: .25 }, position: { x: 0, y: 2, z: 0 } }] })


export function backendCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown, factory: BackendFactory = createCustomBackend) {
  const open = async (scene = ball(), selected: BackendFactory = factory) => { const s = new Simulation(scene, selected); await s.init(); return s }
  test('backend: rejects non-finite and out-of-range scene parameters before allocating', () => {
    for (const value of [NaN, Infinity, -Infinity, 0, -1, 10001]) {
      const input = ball(); input.bodies[0].mass = value
      assert.throws(() => validateScene(input), RangeError)
    }
    const q = ball(); q.bodies[0].rotation = { x: 0, y: 0, z: 0, w: 0 }
    assert.throws(() => validateScene(q), RangeError)
    const large = ball(); large.bodies = Array.from({ length: DEFAULT_LIMITS.maxBodies + 1 }, (_, n) => ({ ...ball().bodies[0], id: `b${n}` }))
    assert.throws(() => validateScene(large), RangeError)
    const duplicate = ball(); duplicate.bodies.push({ ...duplicate.bodies[0] })
    assert.throws(() => validateScene(duplicate), RangeError)
    assert.throws(() => validateScene(ball(), { maxForces: Infinity }), RangeError)
  })
  test('backend: scene validation owns its inputs and rejects impossible joint trees', () => {
    const input = ball(), scene = validateScene(input)
    input.bodies[0].position.y = 99; near(scene.bodies[0].position.y, 2)
    const chain = fixture('motor-chain').scene
    chain.joints![0].child = 'absent'; assert.throws(() => validateScene(chain), RangeError)
    const cycle = fixture('motor-chain').scene
    cycle.joints!.push({ ...cycle.joints![0], id: 'cycle', parent: 'link2', child: 'root' })
    assert.throws(() => validateScene(cycle), RangeError)
  })
  test('backend: quaternion sign and wrap give the same shortest rotation and cone target', () => {
    const q = fromRotationVector({ x: .2, y: .4, z: -.1 })
    assert.deepEqual(quaternion(q), quaternion({ x: -q.x, y: -q.y, z: -q.z, w: -q.w }))
    near(norm(rotationVector(fromRotationVector({ x: Math.PI * 2 + .2, y: 0, z: 0 }))), .2)
    const cone = { swingY: .3, swingZ: .4, twistMin: -.2, twistMax: .2 }
    const a = swingTwist(clampCone(fromRotationVector({ x: 1, y: 1, z: 1 }), cone))
    assert.ok(Math.abs(a.twist) <= .20000001)
    assert.ok((a.swingY / .3) ** 2 + (a.swingZ / .4) ** 2 <= 1.0000001)
  })
  test('backend: body force and fixed-step budgets reject without poisoning the next valid step', async () => {
    const s = await open()
    try {
      const before = s.snapshot()
      assert.throws(() => s.applyForce('ball', { x: NaN, y: 1, z: 0 }), RangeError)
      assert.throws(() => s.applyForce('absent', { x: 0, y: 1, z: 0 }), RangeError)
      assert.throws(() => s.applyForce('ball', { x: 1e10, y: 0, z: 0 }), RangeError)
      assert.deepEqual(s.snapshot(), before)
      for (let n = 0; n < DEFAULT_LIMITS.maxForces; n++) s.applyForce('ball', { x: 0, y: 0, z: 0 })
      assert.throws(() => s.applyForce('ball', { x: 0, y: 0, z: 0 }), RangeError)
      s.advance(1); assert.ok(s.diagnostics().steps <= DEFAULT_LIMITS.maxSteps)
      assert.ok(s.diagnostics().droppedSeconds > .9)
      s.advance(NaN); assert.ok(s.diagnostics().invalidFrames > 0)
      assert.equal(s.status, 'ready')
    } finally { s.dispose() }
  })
  test('backend: force at a point produces angular motion and force does not persist across steps', async () => {
    const input = ball(); input.gravity = { x: 0, y: 0, z: 0 }
    const s = await open(input)
    try {
      s.applyForce('ball', { x: 1, y: 0, z: 0 }, { x: 0, y: 2.25, z: 0 }); s.advance(STEP)
      const a = s.snapshot()[0]; assert.ok(a.angularVelocity.z < 0); assert.ok(a.velocity.x > 0)
      s.advance(STEP); near(s.snapshot()[0].velocity.x, a.velocity.x)
      const snap = s.snapshot(); snap[0].position.y = 999
      assert.ok(s.snapshot()[0].position.y < 3)
    } finally { s.dispose() }
  })
  test('backend: explicit sleep holds; force wakes; reset preserves IDs and disposal is terminal', async () => {
    const s = await open()
    s.sleep('ball'); const before = s.snapshot()[0].position
    s.advance(STEP); near(norm(sub(s.snapshot()[0].position, before)), 0)
    assert.ok(s.snapshot()[0].sleeping)
    s.applyForce('ball', { x: 1, y: 0, z: 0 }); s.advance(STEP); assert.ok(!s.snapshot()[0].sleeping)
    await s.reset(); near(s.snapshot()[0].position.y, 2); assert.equal(s.snapshot()[0].id, 'ball')
    s.dispose(); s.dispose(); assert.throws(() => s.advance(STEP)); await fail(() => s.reset())
  })
  test('backend: rejected init can be retried and a late init cannot resurrect a disposed session', async () => {
    let attempt = 0
    const s = new Simulation(ball(), async (scene, limits) => { if (!attempt++) throw new Error('fixture init failure'); return factory(scene, limits) })
    await fail(() => s.init()); assert.equal(s.status, 'faulted'); await s.reset(); assert.equal(s.status, 'ready'); s.dispose()
    let resolve!: () => void, released = 0
    const pending = new Promise<void>(r => { resolve = r })
    const late = new Simulation(ball(), async (scene, limits) => {
      await pending; const backend = await factory(scene, limits)
      return { ...backend, dispose: () => { released++; backend.dispose() } }
    })
    const done = late.init(); late.dispose(); resolve(); await fail(() => done)
    assert.equal(late.status, 'disposed'); assert.equal(released, 1)
  })
  test('backend: a native step fault freezes the last good snapshot and reset rebuilds the backend', async () => {
    let count = 0
    const s = await open(ball(), async (scene, limits) => {
      const backend = await factory(scene, limits)
      return { ...backend, step: dt => { if (++count === 2) throw new Error('fixture step failure'); backend.step(dt) } }
    })
    try {
      s.advance(STEP); const before = s.snapshot(); assert.throws(() => s.advance(STEP))
      assert.equal(s.status, 'faulted'); assert.deepEqual(s.snapshot(), before)
      assert.throws(() => s.applyForce('ball', { x: 1, y: 0, z: 0 }))
      await s.reset(); s.advance(STEP); assert.equal(s.status, 'ready')
    } finally { s.dispose() }
  })
  test('backend: a returned scene cannot mutate the validated live definition', async () => {
    const s = await open()
    try { const copy = s.scene; copy.bodies[0].position.y = 999; copy.bodies[0].mass = -1; await s.reset(); near(s.snapshot()[0].position.y, 2) }
    finally { s.dispose() }
  })
  test('backend: init retry after a step fault releases the failed native world', async () => {
    let calls = 0, released = 0
    const s = await open(ball(), async (scene, limits) => {
      const backend = await factory(scene, limits), shouldFail = calls++ === 0
      return { ...backend, step: dt => { if (shouldFail) throw new Error('native fault'); backend.step(dt) }, dispose: () => { released++; backend.dispose() } }
    })
    try { assert.throws(() => s.advance(STEP)); await s.init(); assert.equal(released, 1); s.advance(STEP) }
    finally { s.dispose() }
    assert.equal(released, 2)
  })
  test('backend: one combined force budget reserves actuator work before external commands', async () => {
    const s = await open(fixture('wheels').scene)
    try {
      for (let n = 0; n < DEFAULT_LIMITS.maxForces - 8; n++) s.applyForce('chassis', { x: 0, y: 0, z: 0 })
      assert.throws(() => s.applyForce('chassis', { x: 0, y: 0, z: 0 }), RangeError)
    } finally { s.dispose() }
  })
  test('backend: motor, suspension and fluid parameters reject invalid values before init', () => {
    const chain = fixture('motor-chain').scene; chain.joints![0].motor.stiffness = Infinity
    assert.throws(() => validateScene(chain), RangeError)
    const wheel = fixture('wheels').scene; wheel.wheels![0].maxForce = NaN
    assert.throws(() => validateScene(wheel), RangeError)
    const fluid = fixture('buoyancy').scene; fluid.buoys![0].samples[0].volume = -1
    assert.throws(() => validateScene(fluid), RangeError)
  })
  test('backend: sphere colliders contact spheres and rotated boxes, not an invisible ground', async () => {
    for (const kind of ['sphere', 'box'] as const) {
      const scene = ball()
      scene.bodies.push({ id: 'base', fixed: true, position: { x: 0, y: 0, z: 0 }, rotation: fromRotationVector({ x: 0, y: .4, z: 0 }),
        shape: kind === 'sphere' ? { kind: 'sphere', radius: .5 } : { kind: 'box', half: { x: 1, y: .2, z: 1 } } })
      const s = await open(scene)
      try { for (let n = 0; n < 960; n++) s.advance(STEP); near(s.snapshot()[0].position.y, kind === 'sphere' ? .75 : .45, .025) }
      finally { s.dispose() }
    }
  })
  test('backend: equal tick streams give equal state under different render frame grouping', async () => {
    const a = await open(fixture('motor-chain').scene), b = await open(fixture('motor-chain').scene)
    try {
      for (let n = 0; n < 240; n++) a.advance(STEP)
      for (let n = 0; n < 60; n++) b.advance(STEP * 4)
      const aa = a.snapshot(), bb = b.snapshot()
      aa.forEach((body, n) => { near(norm(sub(body.position, bb[n].position)), 0, 1e-6); near(norm(sub(body.angularVelocity, bb[n].angularVelocity)), 0, 1e-6) })
    } finally { a.dispose(); b.dispose() }
  })
  for (const name of ['drop', 'motor-chain', 'saturated-cone', 'wheels', 'buoyancy', 'energy', 'damping'] as const) {
    test(`backend: ${name} fixture performs real dynamics`, async () => {
      const result = await measureFixture(factory, name)
      assert.equal(result.status, 'measured')
      assert.deepEqual(result.failures, [], JSON.stringify(result.metrics))
      assert.ok(result.cpuMs.p95 >= 0)
    })
  }
  test('backend: failed init and failed disposal still leave a recoverable fault, not loading', async () => {
    let calls = 0
    const s = new Simulation(ball(), async (scene, limits) => {
      const native = await factory(scene, limits)
      if (calls++) return native
      return { ...native, read() { throw new Error('injected invalid initial state') }, dispose() { native.dispose(); throw new Error('injected release failure') } }
    })
    await fail(() => s.init()); assert.equal(s.status, 'faulted')
    assert.ok(s.fault?.includes('initial state'))
    await s.init(); assert.equal(s.status, 'ready'); s.dispose()
  })

}

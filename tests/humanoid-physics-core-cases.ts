/** Shared offline/Vitest contracts. Numeric tolerances here are numerical test tolerances, not hardware specifications. */
import { assert, readFileSync } from './sim-node.mjs'
import { clampCone, swingTwist, fromRotationVector, IDENTITY, angleBetween } from '../src/sim/physics/math'
import { validateScene, STEP } from '../src/sim/physics/schema'
import { Simulation } from '../src/sim/physics/runtime'
import { createCustomBackend } from '../src/sim/physics/backends/custom'
import { fixture } from '../src/sim/physics/fixtures'

const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`)
export function humanoidPhysicsCoreCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('measurement: a 55 mm sole offset gives a 2 mm initial gap; a tipped 320 mm foot has different lower-face corner heights', async () => {
    const { buildHumanoid, soleCorners } = await import('../src/sim/humanoid/physics/model')
    const model = buildHumanoid('keel-v1'), foot = model.scene.bodies.find(b => b.id === model.feet[0])!
    assert.equal(foot.shape.kind, 'box')
    const initial = soleCorners(foot)
    near(foot.position.y, .057); for (const p of initial) near(p.y, .002)
    const tipped = soleCorners({ ...foot, position: { x: 0, y: .165, z: 0 }, rotation: fromRotationVector({ x: Math.PI / 2, y: 0, z: 0 }) })
    // Independent geometry: the local +/-160 mm longitudinal corners become world vertical extrema.
    near(Math.min(...tipped.map(p => p.y)), .005); near(Math.max(...tipped.map(p => p.y)), .325)
  })
  test('anatomy: asymmetric swing limits retain both independent extrema and q/-q identity', () => {
    const cone = { swingY: .8, swingYMin: -.2, swingZ: .5, swingZMin: -.1, twistMin: -.3, twistMax: .4 }
    near(swingTwist(clampCone(fromRotationVector({ x: 0, y: -1, z: 0 }), cone)).swingY, -.2)
    near(swingTwist(clampCone(fromRotationVector({ x: 0, y: 1, z: 0 }), cone)).swingY, .8)
    near(swingTwist(clampCone(fromRotationVector({ x: 0, y: 0, z: -1 }), cone)).swingZ, -.1)
    const q = fromRotationVector({ x: .2, y: -.4, z: -.2 }), inverseSign = { x: -q.x, y: -q.y, z: -q.z, w: -q.w }
    near(angleBetween(clampCone(q, cone), clampCone(inverseSign, cone)), 0)
  })
  test('anatomy: impossible asymmetric cones and solver settings reject before native allocation', () => {
    for (const value of [NaN, Infinity, 0, .1, -Math.PI]) {
      const input = fixture('motor-chain').scene
      Object.assign(input.joints![0].cone, { swingYMin: value })
      assert.throws(() => validateScene(input), RangeError)
    }
    const input = fixture('motor-chain').scene
    Object.assign(input, { contact: { solverIterations: 0, allowedLinearError: .0002, predictionDistance: .001 } })
    assert.throws(() => validateScene(input), RangeError)
  })
  test('tick input: exactly one synchronous input callback per completed fixed tick', async () => {
    const s = new Simulation({ bodies: [{ id: 'ball', shape: { kind: 'sphere', radius: .1 }, position: { x: 0, y: 1, z: 0 } }] }, createCustomBackend)
    try {
      await s.init(); const ticks: number[] = []
      s.advance(STEP / 2, tick => { ticks.push(tick) }); assert.equal(ticks.length, 0)
      s.advance(STEP * 3.5, tick => { ticks.push(tick) }); assert.deepEqual(ticks, [0, 1, 2, 3])
      assert.equal(s.diagnostics().tick, 4)
      s.advance(-1, () => { throw new Error('Invalid frame must not poll input') })
      assert.equal(s.status, 'ready')
    } finally { s.dispose() }
  })
  test('tick input: exception faults before integration and recursive advancement is rejected', async () => {
    const s = new Simulation({ bodies: [{ id: 'ball', shape: { kind: 'sphere', radius: .1 }, position: { x: 0, y: 1, z: 0 } }] }, createCustomBackend)
    try {
      await s.init(); const before = s.snapshot()
      assert.throws(() => s.advance(STEP, () => s.advance(STEP)))
      assert.equal(s.status, 'faulted'); assert.equal(s.diagnostics().tick, 0); assert.deepEqual(s.snapshot(), before)
      await s.reset(); assert.equal(s.status, 'ready')
      assert.throws(() => s.advance(STEP, () => { throw new Error('input failure') }))
      assert.equal(s.status, 'faulted'); assert.equal(s.diagnostics().tick, 0)
    } finally { s.dispose() }
  })
  test('batch targets: validate everything before changing any target; no interpolation snap', async () => {
    const s = new Simulation(fixture('motor-chain').scene, createCustomBackend)
    try {
      await s.init()
      assert.equal(typeof s.setMotorTargets, 'function')
      const ids = s.scene.joints.map(j => j.id), before = s.diagnostics()
      assert.throws(() => s.setMotorTargets({ [ids[0]]: IDENTITY, unknown: IDENTITY }), RangeError)
      const targets = s.setMotorTargets(Object.fromEntries(ids.map(id => [id, IDENTITY])))
      assert.equal(Object.keys(targets).length, ids.length)
      assert.equal(s.diagnostics().tick, before.tick)
      s.advance(STEP * 1.5)
      const render = s.render(), snap = s.snapshot()
      s.setMotorTargets(Object.fromEntries(ids.map(id => [id, IDENTITY])))
      assert.deepEqual(s.render(), render); assert.deepEqual(s.snapshot(), snap)
      targets[ids[0]].x = 999; s.advance(STEP)
      assert.equal(s.status, 'ready')
    } finally { s.dispose() }
  })
  test('contacts: non-unit backend normals fault rather than manufacturing a support load', async () => {
    const input = { bodies: [
      { id: 'a', shape: { kind: 'sphere' as const, radius: .1 }, position: { x: 0, y: 1, z: 0 } },
      { id: 'b', shape: { kind: 'sphere' as const, radius: .1 }, position: { x: 0, y: 2, z: 0 } },
    ] }
    const s = new Simulation(input, async (scene, limits) => ({ ...await createCustomBackend(scene, limits), contacts: () => [
      { a: 'a', b: 'b', pointA: { x: 0, y: 1, z: 0 }, pointB: { x: 0, y: 2, z: 0 },
        normalOnB: { x: 1, y: 1, z: 1 }, distance: 0, impulse: 1 },
    ] })) // Deliberately corrupt adapter sample; not contact physics evidence.
    try { await s.init(); assert.throws(() => s.contacts(), /normal/); assert.equal(s.status, 'faulted') }
    finally { s.dispose() }
  })
  test('evidence: build, temporary-folder and report-write failures still emit JSON before assertion', async () => {
    // Execute only the reporter's failure paths with injected I/O. This does NOT run a browser or Vite.
    const text = readFileSync(new URL('../scripts/e2e-humanoid-physics.mjs', import.meta.url), 'utf8')
    const body = text.slice(text.indexOf('export async function'), text.indexOf('\nconst percentile'))
      .replace('export ', '') + '\nreturn runHumanoidPilotProof'
    const make = new Function('rawRun', 'join', 'build', 'resolve', 'ROOT', 'PREFIX', 'writeFile', 'console', 'markupBuild', body)
    for (const directoryFails of [false, true]) {
      const logs: string[] = []
      const run = make(() => { if (directoryFails) throw new Error('synthetic directory failure'); return '/fixture' },
        (...p: string[]) => p.join('/'), async () => { throw new Error('synthetic build failure') },
        (...p: string[]) => p.join('/'), '/fixture', '/', async () => { throw new Error('synthetic write failure') }, { log: (s: string) => logs.push(s) }, () => ({}))
      let asserted = false
      await run({ origin: 'http://localhost' }, async (_name: string, check: () => void) => {
        const line = logs.find(s => s.startsWith('{')); assert.ok(line)
        const report = JSON.parse(line); assert.equal(report.pass, false)
        assert.ok(report.errors.some((e: string) => e.includes(directoryFails ? 'synthetic directory failure' : 'synthetic write failure')))
        asserted = true; assert.throws(check, /incomplete or failed/)
      })
      assert.equal(asserted, true)
    }
  })
  test('contacts: unsupported sampling is explicit rather than an empty support measurement', async () => {
    const s = new Simulation({ bodies: [] }, createCustomBackend)
    try { await s.init(); assert.equal(typeof s.contacts, 'function'); assert.throws(() => s.contacts(), /not support/i) }
    finally { s.dispose() }
  })
}

export function humanoidServoCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('inertia damping: small links cannot receive explicit damping sign-flip torques', async () => {
    const { bodyInertia, dampedServo } = await import('../src/sim/physics/servo')
    const scene = validateScene({ bodies: [{ id: 'link', position: { x: 0, y: 0, z: 0 }, mass: 2, shape: { kind: 'box', half: { x: .1, y: .2, z: .3 } } }] })
    const inertia = bodyInertia(scene.bodies[0]); near(inertia.x, 2 / 3 * (.04 + .09))
    near(inertia.y, 2 / 3 * (.01 + .09)); near(inertia.z, 2 / 3 * (.01 + .04))
    const s = { id: 'link', position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY, velocity: { x: 0, y: 0, z: 0 }, angularVelocity: { x: 0, y: 0, z: 0 }, sleeping: false }
    const tiny = { ...scene.bodies[0], mass: .01 }, fixed = { ...scene.bodies[0], fixed: true }
    const torque = dampedServo(tiny, s, fixed, s, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 200, 30, 10, STEP)
    assert.ok(torque.x < 0); assert.ok(20 + torque.x / bodyInertia(tiny).x * STEP >= -1e-10)
    assert.ok(Math.hypot(torque.x, torque.y, torque.z) <= 10)
    assert.throws(() => dampedServo(tiny, s, fixed, s, { x: 0, y: 0, z: 0 }, s.velocity, 200, 30, 10, 0), RangeError)
  })
  test('inertia damping: explicit opt-in is validated and preserved; defaults remain unchanged', () => {
    const input = fixture('motor-chain').scene
    Object.assign(input.joints![0].motor, { integration: 'inertia-damped' })
    assert.equal(validateScene(input).joints[0].motor.integration, 'inertia-damped')
    Object.assign(input.joints![0].motor, { integration: 'bogus' })
    assert.throws(() => validateScene(input), RangeError)
  })
  test('inertia damping: rotating an anisotropic link and its command preserves the physical torque', async () => {
    const { dampedServo } = await import('../src/sim/physics/servo')
    const { rotate } = await import('../src/sim/physics/math')
    const scene = validateScene({ bodies: [{ id: 'link', position: { x: 0, y: 0, z: 0 }, mass: .1,
      shape: { kind: 'box', half: { x: .01, y: .2, z: .03 } } }] })
    const b = scene.bodies[0], fixed = { ...b, fixed: true }
    const state = { ...b, sleeping: false }, error = { x: .02, y: -.03, z: .01 }, velocity = { x: 2, y: -3, z: 1 }
    const q = fromRotationVector({ x: .8, y: -.5, z: .4 })
    const expected = rotate(q, dampedServo(b, state, fixed, state, error, velocity, 200, 30, 10, STEP))
    const actual = dampedServo(b, { ...state, rotation: q }, fixed, state, rotate(q, error), rotate(q, velocity), 200, 30, 10, STEP)
    near(actual.x, expected.x); near(actual.y, expected.y); near(actual.z, expected.z)
  })
  test('inertia damping: motor and active stop cannot each reverse a tiny link in the same step', async () => {
    const { dampedServo, bodyInertia } = await import('../src/sim/physics/servo')
    const b = validateScene({ bodies: [{ id: 'link', position: { x: 0, y: 0, z: 0 }, mass: .01,
      shape: { kind: 'box', half: { x: .01, y: .02, z: .03 } } }] }).bodies[0]
    const state = { ...b, sleeping: false }, fixed = { ...b, fixed: true }, velocity = { x: 20, y: 0, z: 0 }
    const torque = dampedServo(b, state, fixed, state, { x: 0, y: 0, z: 0 }, velocity, 200, 30, 10, STEP, { x: -.00001, y: 0, z: 0 })
    const next = 20 + torque.x / bodyInertia(b).x * STEP
    assert.ok(next >= -.001 && next < 20, `combined damping injected/reversed speed: ${next}`)
  })
  test('inertia damping: a directional stop satisfies the combined implicit free-body force balance', async () => {
    const { dampedServo, bodyInertia } = await import('../src/sim/physics/servo')
    const { rotate, conjugate, add, sub, scale, dot, unit, norm } = await import('../src/sim/physics/math')
    const b = validateScene({ bodies: [{ id: 'link', position: { x: 0, y: 0, z: 0 }, mass: .1,
      shape: { kind: 'box', half: { x: .01, y: .2, z: .03 } } }] }).bodies[0]
    const state = { ...b, rotation: fromRotationVector({ x: .8, y: -.5, z: .4 }), sleeping: false }
    const error = { x: .02, y: -.03, z: .01 }, velocity = { x: 2, y: -3, z: 1 }, stop = { x: .01, y: .03, z: -.02 }
    const torque = dampedServo(b, state, { ...b, fixed: true }, state, error, velocity, 200, 30, 10, STEP, stop)
    const localTorque = rotate(conjugate(state.rotation), torque), i = bodyInertia(b)
    const acceleration = rotate(state.rotation, { x: localTorque.x / i.x, y: localTorque.y / i.y, z: localTorque.z / i.z })
    const nextVelocity = add(velocity, scale(acceleration, STEP)), n = unit(stop), damping = dot(velocity, n) < 0 ? 30 : 0
    const motor = sub(scale(sub(error, scale(nextVelocity, STEP)), 200), scale(nextVelocity, 30))
    const expected = add(motor, scale(n, 1200 * norm(stop) - (damping + 1200 * STEP) * dot(n, nextVelocity)))
    near(torque.x, expected.x); near(torque.y, expected.y); near(torque.z, expected.z)
  })
}

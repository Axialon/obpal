import { assert } from './sim-node.mjs'
import { robotRoster } from '../src/sim/humanoid/profile'
import { angleBetween, localPoint, norm, sub, IDENTITY, clampCone } from '../src/sim/physics/math'
export function humanoidPilotCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('profiles: all eight forms have a free root, two spine links, owned primitive inertia and closed anchors', async () => {
    const { buildHumanoid, framesFromBodies } = await import('../src/sim/humanoid/physics/model')
    const forms = robotRoster(true).flatMap(r => r.forms)
    assert.equal(forms.length, 8); assert.equal(robotRoster(false).length, 2)
    for (const profile of forms) {
      const model = buildHumanoid(profile.id, 'seat1')
      const bodies = new Map(model.scene.bodies.map(b => [b.id, b]))
      assert.equal(model.scene.bodies.length, 17); assert.equal(model.scene.joints.length, 15)
      assert.equal(model.scene.bodies.filter(b => b.fixed).length, 1)
      assert.equal(bodies.get(model.root)!.fixed, false)
      assert.ok(model.parts.lumbar && model.parts.thorax)
      for (const j of model.scene.joints) {
        const a = bodies.get(j.parent)!, b = bodies.get(j.child)!
        assert.ok(norm(sub(localPoint(a.position, a.rotation, j.anchorParent), localPoint(b.position, b.rotation, j.anchorChild))) < 1e-9)
        assert.ok(angleBetween(j.motor.target, clampCone(j.motor.target, j.cone)) < 1e-8)
      }
      for (const p of Object.values(model.parts)) {
        const i = p.inertia; assert.ok([i.x, i.y, i.z].every(n => n > 0 && Number.isFinite(n)))
        assert.ok(i.x + i.y >= i.z - 1e-12 && i.y + i.z >= i.x - 1e-12 && i.z + i.x >= i.y - 1e-12)
      }
      const state = model.scene.bodies.map(b => ({ ...b, sleeping: b.fixed }))
      const frames = framesFromBodies(model, state)
      assert.deepEqual(Object.keys(frames).sort(), profile.joints.map(j => j.id).sort())
      assert.ok(norm(sub(frames.pelvis.position, bodies.get(model.root)!.position)) < 1e-12)
      assert.ok(model.feet.every(id => bodies.has(id)))
      frames.pelvis.position.y = -100
      assert.ok(framesFromBodies(model, state).pelvis.position.y > 0)
      assert.throws(() => framesFromBodies(model, state.filter(b => b.id !== model.root)), /Missing/)
    }
  })
  test('profiles: unknown actors/forms reject and authored poses are finite, bounded and independent', async () => {
    const { buildHumanoid, targetsFromAngles, canonicalPoses } = await import('../src/sim/humanoid/physics/model')
    assert.throws(() => buildHumanoid('unknown', 'seat1'), RangeError)
    assert.throws(() => buildHumanoid('keel-v1', '../root'), RangeError)
    for (const profile of robotRoster(true).flatMap(r => r.forms)) {
      const model = buildHumanoid(profile.id, 'seat1'), poses = canonicalPoses(profile.id)
      assert.equal(Object.keys(poses).length, 7)
      for (const angles of Object.values(poses)) {
        const targets = targetsFromAngles(model, angles)
        assert.equal(Object.keys(targets).length, 15)
        for (const j of model.scene.joints) assert.ok(angleBetween(targets[j.id], clampCone(targets[j.id], j.cone)) < 1e-8)
      }
      assert.throws(() => targetsFromAngles(model, { pelvis: NaN }), RangeError)
      assert.throws(() => targetsFromAngles(model, { invented: 1 }), RangeError)
      assert.throws(() => targetsFromAngles(model, { pelvis: 1 }), /root/i)
    }
  })
  test('contract: full per-tick targets own their data, limit slew, reject root, order, identity and nonfinite input atomically', async () => {
    const { buildHumanoid } = await import('../src/sim/humanoid/physics/model')
    const { ActuationGate } = await import('../src/sim/humanoid/physics/contract')
    const model = buildHumanoid('keel-v1', 'seat1'), gate = new ActuationGate(model, 1)
    const frame = { schema_version: 1 as const, profileId: model.profileId, actorId: model.actorId, generation: 1, tick: 0, source: 'policy' as const,
      targets: Object.fromEntries(model.scene.joints.map(j => [j.id, { ...IDENTITY }])) }
    for (const bad of [{ ...frame, root: [0, 1, 0] }, { ...frame, actorId: 'seat2' }, { ...frame, generation: 2 }, { ...frame, tick: 1 },
      { ...frame, targets: {} }, { ...frame, targets: { ...frame.targets, unknown: IDENTITY } },
      { ...frame, targets: { ...frame.targets, [model.scene.joints[0].id]: { x: NaN, y: 0, z: 0, w: 1 } } }]) assert.throws(() => gate.accept(bad), RangeError)
    const out = gate.accept(frame), before = model.scene.joints
    for (const j of before) assert.ok(angleBetween(j.motor.target, out.targets[j.id]) <= 4 / 240 + 1e-8)
    out.targets[before[0].id].x = 999
    assert.throws(() => gate.accept(frame), /tick/i)
    const next = gate.accept({ ...frame, tick: 1 })
    assert.ok(Object.values(next.targets).every(q => Number.isFinite(q.x) && Math.abs(q.x) <= 1))
    assert.throws(() => new ActuationGate(model, -1), RangeError)
  })
  test('support: geometry alone is not contact support, and copied impulses establish a measured footprint', async () => {
    const { buildHumanoid } = await import('../src/sim/humanoid/physics/model')
    const { observe } = await import('../src/sim/humanoid/physics/observation')
    const m = buildHumanoid('keel-v1', 'seat1'), states = m.scene.bodies.map(b => ({ ...b, sleeping: b.fixed }))
    const floating = observe(m, states, [], 1, 0)
    assert.equal(floating.support.points.length, 0); assert.equal(floating.support.marginM, null)
    assert.ok(floating.feet.every(f => f.maxSoleY - f.minSoleY < 1e-10 && Math.abs(f.minSoleY - .002) < 1e-9))
    const foot = m.feet[0], contact = { a: 'floor', b: foot, pointA: { x: -.1, y: 0, z: 0 }, pointB: { x: -.1, y: 0, z: 0 }, normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: 1 }
    const measured = observe(m, states, [contact], 1, 0)
    assert.equal(measured.support.points.length, 1); assert.equal(measured.support.normalImpulseNs, 1)
    contact.pointB.x = 20; assert.equal(measured.support.points[0].x, -.1)
    assert.equal(observe(m, states, [{ ...contact, impulse: 0 }], 1, 0).support.points.length, 0)
  })
}

export function humanoidSessionCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('session: fixed-tick observation/action pairing, bounded journal and render partition replay (orchestration double)', async () => {
    const { HumanoidPilot } = await import('../src/sim/humanoid/physics/pilot')
    const { buildHumanoid, canonicalPoses, targetsFromAngles } = await import('../src/sim/humanoid/physics/model')
    const { orchestrationBackend } = await import('./humanoid-pilot-double')
    const model = buildHumanoid('keel-v1', 'seat1')
    const run = async (dt: number, replay?: import('../src/sim/humanoid/physics/contract').ActuationFrame[]) => {
      const pilot = await HumanoidPilot.create(model, { factory: orchestrationBackend, journalCapacity: 240 })
      try {
        const targets = targetsFromAngles(model, canonicalPoses(model.profileId).t)
        for (let n = 0; n < Math.round(1 / dt); n++) pilot.advance(dt, o => replay ? { ...replay[o.stateTick], source: 'replay' } :
          { schema_version: 1, profileId: model.profileId, actorId: model.actorId, generation: o.generation, tick: o.stateTick, source: 'policy', targets })
        const journal = pilot.journal()
        assert.equal(journal.length, 240)
        journal.forEach((r, i) => { assert.equal(r.observation.stateTick, i); assert.equal(r.action.tick, i); assert.equal(r.observation.generation, r.action.generation) })
        assert.equal(pilot.diagnostics().tick, 240)
        return { states: pilot.snapshot(), actions: journal.map(r => r.action) }
      } finally { pilot.dispose() }
    }
    const sixty = await run(1 / 60), thirty = await run(1 / 30, sixty.actions), oneTwenty = await run(1 / 120, sixty.actions)
    assert.deepEqual(sixty.states, thirty.states); assert.deepEqual(sixty.states, oneTwenty.states)
  })
  test('session: quiet invalidates stale input without freezing dynamics; no pair is recorded for failed ticks', async () => {
    const { HumanoidPilot } = await import('../src/sim/humanoid/physics/pilot')
    const { buildHumanoid } = await import('../src/sim/humanoid/physics/model')
    const { orchestrationBackend } = await import('./humanoid-pilot-double')
    const model = buildHumanoid('keel-v1', 'seat1'), pilot = await HumanoidPilot.create(model, { factory: orchestrationBackend, journalCapacity: 2 })
    try {
      pilot.advance(3 / 240)
      assert.equal(pilot.journal().length, 2)
      const stale = pilot.journal()[1].action
      const oldPosition = pilot.snapshot().find(s => s.id === model.root)!.position.x
      const generation = pilot.quiet(); assert.equal(generation, 2)
      pilot.advance(1 / 240)
      assert.ok(pilot.snapshot().find(s => s.id === model.root)!.position.x > oldPosition)
      assert.equal(pilot.journal()[1].action.source, 'hold')
      const count = pilot.journal().length
      assert.throws(() => pilot.advance(1 / 240, () => ({ ...stale, tick: 4 })), /generation/)
      assert.equal(pilot.diagnostics().status, 'faulted'); assert.equal(pilot.journal().length, count)
      assert.equal(pilot.diagnostics().tick, 4)
      await pilot.reset(); assert.equal(pilot.diagnostics().tick, 0); assert.equal(pilot.journal().length, 0)
      assert.equal(pilot.generation, 3)
    } finally { pilot.dispose(); pilot.dispose() }
  })
}

export function humanoidBindingCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('binding: full dynamic root rotation and hierarchical local transforms reconstruct all world frames without mutating input', async () => {
    const { localRigFrames } = await import('../src/sim/humanoid/physics/binding')
    const { buildHumanoid, framesFromBodies, profileFor } = await import('../src/sim/humanoid/physics/model')
    const { fromRotationVector, multiply, conjugate, rotate, add } = await import('../src/sim/physics/math')
    const model = buildHumanoid('morrow-v1'), p = profileFor(model.profileId), rotation = fromRotationVector({ x: .3, y: .7, z: -.2 })
    const input = framesFromBodies(model, model.scene.bodies.map(b => ({ ...b, sleeping: b.fixed,
      position: add(rotate(rotation, b.position), { x: 2, y: .1, z: 1 }), rotation: multiply(rotation, b.rotation) })))
    const before = structuredClone(input), local = localRigFrames(p, input), out = new Map<string, typeof input[string]>()
    for (const j of p.joints) {
      const parent = j.parent ? out.get(j.parent)! : local.root, frame = local.joints[j.id]
      out.set(j.id, { position: localPoint(parent.position, parent.rotation, frame.position), rotation: multiply(parent.rotation, frame.rotation) })
      assert.ok(norm(sub(out.get(j.id)!.position, input[j.id].position)) < 1e-9)
      assert.ok(norm(Object.assign({ x: 0, y: 0, z: 0 }, multiply(out.get(j.id)!.rotation, conjugate(input[j.id].rotation)))) < 1e-8)
    }
    assert.deepEqual(input, before)
    const broken = structuredClone(input); broken['head.pitch'].position.x = NaN
    assert.throws(() => localRigFrames(p, broken), RangeError)
  })
}

export function humanoidReviewCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('motion evidence: rotating the entire actor is not relative arm actuation', async () => {
    const { jointMotionRad, observe } = await import('../src/sim/humanoid/physics/observation')
    const { buildHumanoid } = await import('../src/sim/humanoid/physics/model')
    const { fromRotationVector, multiply, rotate } = await import('../src/sim/physics/math')
    const model = buildHumanoid('keel-v1'), id = model.scene.joints.find(j => j.child === model.parts.left_upper_arm.bodyId)!.id
    const states = model.scene.bodies.map(b => ({ ...b, sleeping: b.fixed }))
    const q = fromRotationVector({ x: .5, y: .2, z: .3 })
    const rotated = states.map(b => ({ ...b, position: rotate(q, b.position), rotation: multiply(q, b.rotation) }))
    const before = observe(model, states, [], 1, 0), after = observe(model, rotated, [], 1, 1)
    assert.ok(jointMotionRad(before, after, id) < 1e-7)
    after.joints.find(j => j.id === id)!.rotation = fromRotationVector({ x: 1, y: 0, z: 0 })
    assert.ok(jointMotionRad(before, after, id) > .1)
    assert.throws(() => jointMotionRad(before, { ...after, generation: 2 }, id), /identity/)
  })
  test('support: a load-bearing foot uses its actual manifold footprint, including zero-pressure points', async () => {
    const { buildHumanoid } = await import('../src/sim/humanoid/physics/model')
    const { observe } = await import('../src/sim/humanoid/physics/observation')
    const model = buildHumanoid('keel-v1'), states = model.scene.bodies.map(b => ({ ...b, sleeping: b.fixed }))
    const points = [{ x: -.1, y: 0, z: -.1 }, { x: -.2, y: 0, z: -.1 }, { x: -.15, y: 0, z: .1 }]
    const contacts = points.map((p, i) => ({ a: 'floor', b: model.feet[0], pointA: p, pointB: p, normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: i ? 0 : 1 }))
    const observation = observe(model, states, contacts, 1, 1)
    assert.equal(observation.support.points.length, 3); assert.equal(observation.support.polygon.length, 3)
    assert.equal(observation.support.normalImpulseNs, 1)
  })
  test('contract: source isolation, owned model preconditions and independent episode disposal', async () => {
    const { HumanoidPilot } = await import('../src/sim/humanoid/physics/pilot')
    const { buildHumanoid } = await import('../src/sim/humanoid/physics/model')
    const { orchestrationBackend } = await import('./humanoid-pilot-double')
    const a = await HumanoidPilot.create(buildHumanoid('keel-v1', 'seat1'), { factory: orchestrationBackend })
    const b = await HumanoidPilot.create(buildHumanoid('morrow-v1', 'seat2'), { factory: orchestrationBackend })
    try {
      a.advance(1 / 240); b.advance(1 / 240)
      const before = b.snapshot(), record = a.journal()[0].action
      assert.throws(() => a.advance(1 / 240, () => ({ ...record, actorId: 'seat2', tick: 1 })))
      assert.equal(b.diagnostics().status, 'ready'); assert.deepEqual(b.snapshot(), before)
      const model = b.definition(); model.scene.bodies.find(x => x.id === model.root)!.fixed = true
      let rejected = false
      try { await HumanoidPilot.create(model, { factory: orchestrationBackend }) } catch { rejected = true }
      assert.equal(rejected, true)
      b.advance(1 / 240); assert.equal(b.diagnostics().tick, 2)
    } finally { a.dispose(); b.dispose() }
  })
}

/** Native world isolation and replay gates. Measurements precede assertions; fixtures stay in TEMP. */
import { describe, expect, it } from 'vitest'
import { HumanoidWorld, PUSH_SECONDS, type ActorId, type ActorSpec } from '../src/sim/humanoid/physics/world'
import { ALL_PHYSICAL_PROFILES, buildHumanoid } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { STEP, type BackendFactory, type ContactSample } from '../src/sim/physics/schema'
import { PHYSICS_SELECTION } from '../src/sim/physics/selection'
import { localPoint, rotate, angleBetween } from '../src/sim/physics/math'
import { type ActuationFrame } from '../src/sim/humanoid/physics/contract'
import { emitMeasurement, mkdtempSync, writeFileSync, tmpdir, join } from './humanoid-physics-node.mjs'

const output = mkdtempSync(join(tmpdir(), 'obpal-hc-world-'))
const specs = (profileId: string, count = 2): ActorSpec[] => [
  { actorId: 'seat1', profileId, spawn: { x: -1, z: 0, yaw: 0 } },
  { actorId: 'seat2', profileId, spawn: { x: 1, z: 0, yaw: 0 } },
].slice(0, count) as ActorSpec[]
function report(name: string, value: unknown) {
  writeFileSync(join(output, `${name}.json`), JSON.stringify(value)); emitMeasurement(value)
}
/** The maximum numeric component error also rejects missing/non-finite fields. */
function error(a: unknown, b: unknown): number {
  if (typeof a === 'number') return typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : Infinity
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length ? a.reduce((m, v, i) => Math.max(m, error(v, b[i])), 0) : Infinity
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') return Infinity
    const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>
    return Object.keys(aa).length === Object.keys(bb).length ? Object.keys(aa).reduce((m, k) => Math.max(m, error(aa[k], bb[k])), 0) : Infinity
  }
  return a === b ? 0 : Infinity
}
function nominal(world: HumanoidWorld, o: Observation): ActuationFrame {
  return { schema_version: 1, actorId: o.actorId, profileId: o.profileId, generation: o.generation, tick: o.stateTick,
    source: 'classical', targets: world.targets(o.actorId as ActorId) }
}

for (const profileId of ALL_PHYSICAL_PROFILES) describe(`humanoid world: ${profileId}`, () => {
  it('I1: a class C push 2 m away leaves the other actor identical at every tick', async () => {
    const one = await HumanoidWorld.create({ actors: specs(profileId, 1), journalCapacity: 480 })
    const two = await HumanoidWorld.create({ actors: specs(profileId), journalCapacity: 480 })
    let maximum = 0, completed = 0
    try {
      for (let tick = 0; tick < 480; tick++) {
        if (tick === 120) two.push('seat2', 'C', 'toe')
        one.advance(STEP); two.advance(STEP)
        maximum = Math.max(maximum, error(one.observation('seat1'), two.observation('seat1'))); completed++
      }
      report(`I1-${profileId}`, { kind: 'I1', profileId, completedTicks: completed, expectedTicks: 480, maximumComponentErrorSI: maximum,
        pushTicks: two.journal('seat2').filter(r => r.disturbances.length).length })
      expect(completed).toBe(480); expect(maximum).toBeLessThanOrEqual(1e-6)
      expect(two.journal('seat2').filter(r => r.disturbances.length)).toHaveLength(24)
    } finally { one.dispose(); two.dispose() }
  }, 120_000)

  it('I2: wrong-actor frames reject atomically for either seat', async () => {
    const rows: unknown[] = []
    for (const invalidSeat of ['seat1', 'seat2'] as const) {
      const world = await HumanoidWorld.create({ actors: specs(profileId) })
      try {
        world.advance(4 * STEP)
        const before = Object.fromEntries(world.actorIds.map(id => [id, { generation: world.generation(id), targets: world.targets(id), journal: world.journal(id) }]))
        let rejected = false
        try { world.advance(STEP, o => ({ ...nominal(world, o), actorId: o.actorId === invalidSeat ? invalidSeat === 'seat1' ? 'seat2' : 'seat1' : o.actorId })) }
        catch { rejected = true }
        const after = Object.fromEntries(world.actorIds.map(id => [id, { generation: world.generation(id), targets: world.targets(id), journal: world.journal(id) }]))
        rows.push({ invalidSeat, rejected, unchanged: error(before, after) === 0 })
        report(`I2-reject-${profileId}-${invalidSeat}`, { kind: 'I2-reject', profileId, invalidSeat, rejected, maximumComponentErrorSI: error(before, after) })
        expect(rejected).toBe(true); expect(after).toEqual(before)
      } finally { world.dispose() }
    }
    expect(rows).toHaveLength(2)
  }, 120_000)

  it('I2: loss and quiet renew only their seat; reset renews both and clears journals', async () => {
    const world = await HumanoidWorld.create({ actors: specs(profileId) })
    try {
      world.advance(4 * STEP)
      const rows: { actorId: ActorId; command: string; otherUnchanged: boolean; renewed: boolean }[] = []
      for (const id of world.actorIds) for (const command of ['loss', 'quiet'] as const) {
        const other: ActorId = id === 'seat1' ? 'seat2' : 'seat1', generation = world.generation(id)
        const before = { generation: world.generation(other), targets: world.targets(other), journal: world.journal(other) }
        world[command](id)
        const after = { generation: world.generation(other), targets: world.targets(other), journal: world.journal(other) }
        rows.push({ actorId: id, command, otherUnchanged: error(before, after) === 0, renewed: world.generation(id) === generation + 1 })
      }
      const generations = world.actorIds.map(id => world.generation(id))
      await world.reset()
      const reset = world.actorIds.map((id, i) => ({ actorId: id, renewed: world.generation(id) === generations[i] + 1,
        journalTicks: world.journal(id).length, stateTick: world.observation(id).stateTick }))
      report(`I2-renew-${profileId}`, { kind: 'I2-renew', profileId, rows, reset })
      expect(rows).toHaveLength(4); expect(rows.every(r => r.otherUnchanged && r.renewed)).toBe(true)
      expect(reset.every(r => r.renewed && r.journalTicks === 0 && r.stateTick === 0)).toBe(true)
      world.advance(STEP); expect(world.diagnostics().tick).toBe(1)
    } finally { world.dispose() }
  }, 120_000)

  it('R1: both journals and disturbances replay 480 ticks at 60/30/120 Hz', async () => {
    const recorded = await HumanoidWorld.create({ actors: specs(profileId), journalCapacity: 480 })
    try {
      for (let tick = 0; tick < 480; tick++) {
        if (tick === 60) recorded.push('seat1', 'A', 'heel')
        if (tick === 240) recorded.push('seat2', 'C', 'toe')
        recorded.advance(STEP)
      }
      const journals = { seat1: recorded.journal('seat1'), seat2: recorded.journal('seat2') }, snapshot = recorded.snapshot()
      const rows: { hz: number; ticks: number; journalTicks: number[]; maximumComponentErrorSI: number; disturbanceTicks: number[]; nativeStateIdentical: boolean }[] = []
      for (const hz of [60, 30, 120]) {
        const replay = await HumanoidWorld.create({ actors: specs(profileId), journalCapacity: 480 })
        try {
          for (let frame = 0; frame < 2 * hz; frame++) replay.replay(1 / hz, journals)
          let maximum = error(snapshot, replay.snapshot())
          const journalTicks: number[] = [], disturbanceTicks: number[] = []
          for (const id of replay.actorIds) {
            const actual = replay.journal(id), expected = journals[id]; journalTicks.push(actual.length)
            disturbanceTicks.push(actual.filter(r => r.disturbances.length).length)
            if (actual.length !== expected.length) maximum = Infinity
            for (let tick = 0; tick < Math.min(actual.length, expected.length); tick++) {
              maximum = Math.max(maximum, error(expected[tick].observation, actual[tick].observation),
                error(expected[tick].action.targets, actual[tick].action.targets), error(expected[tick].disturbances, actual[tick].disturbances))
            }
          }
          rows.push({ hz, ticks: replay.diagnostics().tick, journalTicks, maximumComponentErrorSI: maximum, disturbanceTicks,
            nativeStateIdentical: JSON.stringify(snapshot) === JSON.stringify(replay.snapshot()) })
        } finally { replay.dispose() }
      }
      report(`R1-${profileId}`, { kind: 'R1', profileId, expectedTicks: 480, rows })
      expect(rows).toHaveLength(3)
      for (const row of rows) {
        expect(row.ticks).toBe(480); expect(row.journalTicks).toEqual([480, 480]); expect(row.disturbanceTicks).toEqual([24, 24])
        expect(row.maximumComponentErrorSI).toBeLessThanOrEqual(1e-6)
        expect(row.nativeStateIdentical).toBe(true)
      }
    } finally { recorded.dispose() }
  }, 180_000)

  it('upright, prone and supine fixtures are free rigid transforms released 2 mm up', async () => {
    const rows: { posture: string; releaseGapM: number; upY: number; forwardY: number; maximumJointErrorRad: number; fixedLinks: number }[] = []
    const original = buildHumanoid(profileId, 'seat1'), originalObservation = observe(original, original.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, 0)
    for (const posture of ['upright', 'prone', 'supine'] as const) {
      const world = await HumanoidWorld.create({ actors: [{ actorId: 'seat1', profileId, spawn: { x: 1.5, z: -2, yaw: .7, posture } }] })
      try {
        const model = world.definition('seat1'), o = world.observation('seat1')
        const minimum = Math.min(...model.scene.bodies.filter(b => !b.fixed).flatMap(b => {
          if (b.shape.kind !== 'box') throw new Error('Expected box fixture')
          const h = b.shape.half
          return [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => localPoint(b.position, b.rotation, { x: x * h.x, y: y * h.y, z: z * h.z }).y)))
        }))
        const root = o.bodies.find(b => b.id === model.root)!
        rows.push({ posture, releaseGapM: minimum, upY: rotate(root.rotation, { x: 0, y: 1, z: 0 }).y,
          forwardY: rotate(root.rotation, { x: 0, y: 0, z: -1 }).y,
          maximumJointErrorRad: Math.max(...o.joints.map((j, i) => angleBetween(j.rotation, originalObservation.joints[i].rotation))),
          fixedLinks: model.scene.bodies.filter(b => b.fixed && b.id !== 'floor').length })
      } finally { world.dispose() }
    }
    report(`fixtures-${profileId}`, { kind: 'fixtures', profileId, rows })
    expect(rows).toHaveLength(3)
    for (const row of rows) { expect(row.releaseGapM).toBeCloseTo(.002, 10); expect(row.maximumJointErrorRad).toBeLessThan(1e-6); expect(row.fixedLinks).toBe(0) }
    expect(rows[0].upY).toBeCloseTo(1, 6); expect(rows[1].forwardY).toBeLessThan(-.99); expect(rows[2].forwardY).toBeGreaterThan(.99)
  }, 120_000)
})

it('world contact fields contain all own floor links and only inter-actor contacts', () => {
  const a = buildHumanoid('keel-v1', 'seat1'), b = buildHumanoid('morrow-v1', 'seat2')
  const sample = (a: string, b: string): ContactSample => ({ a, b, pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 },
    normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: 1 })
  const hand = a.parts.left_hand.bodyId, other = b.parts.thorax.bodyId
  const contacts = [sample('floor', hand), sample(a.feet[0], 'floor'), sample(hand, other), sample(other, a.feet[0]),
    sample(hand, a.feet[0]), sample('floor', b.feet[0]), sample(hand, 'fixture')]
  const actorBodies = new Set([...a.scene.bodies, ...b.scene.bodies].filter(b => !b.fixed).map(b => b.id))
  const o = observe(a, a.scene.bodies.map(b => ({ ...b, sleeping: false })), contacts, 1, 0, actorBodies)
  expect(o.floorContacts).toEqual(contacts.slice(0, 2)); expect(o.actorContacts).toEqual(contacts.slice(2, 4))
  o.floorContacts![0].pointA.y = 99; expect(contacts[0].pointA.y).toBe(0)
})

it('native contact samples are shared once per state tick across servo and both observations', async () => {
  const factory = await PHYSICS_SELECTION.load(); let samples = 0
  const counted: BackendFactory = async (scene, limits) => {
    const backend = await factory(scene, limits)
    return { ...backend, contacts: () => { samples++; return backend.contacts!() } }
  }
  const world = await HumanoidWorld.create({ factory: counted })
  try {
    for (let tick = 0; tick < 40; tick++) {
      world.observations(); world.observation('seat1'); world.observation('seat2'); world.advance(STEP)
    }
    const first = world.observations(); world.observations()
    first.seat1.floorContacts!.splice(0); first.seat2.bodies[0].position.y = 99
    const after = world.observations()
    report('contact-cache', { kind: 'contact-cache', completedTicks: world.diagnostics().tick, nativeSampleCalls: samples, expectedSamples: 41 })
    expect(samples).toBe(41); expect(after.seat2.bodies[0].position.y).not.toBe(99)
    expect(after.seat1.floorContacts!.length).toBeGreaterThan(0)
    await world.reset(); world.observations(); expect(samples).toBe(42)
  } finally { world.dispose() }
}, 120_000)

it('pushes use facing-relative thorax force for 24 ticks, with a bounded owned journal', async () => {
  const world = await HumanoidWorld.create({ actors: [{ actorId: 'seat1', profileId: 'keel-v1', spawn: { x: 0, z: 0, yaw: Math.PI / 2 } }], journalCapacity: 30 })
  try {
    world.push('seat1', 'C', 'toe')
    for (let tick = 0; tick < 28; tick++) world.advance(STEP)
    const journal = world.journal('seat1'), pushed = journal.filter(r => r.disturbances.length)
    const impulse = pushed.reduce((n, r) => ({ x: n.x + r.disturbances[0].forceN.x * STEP, y: n.y + r.disturbances[0].forceN.y * STEP,
      z: n.z + r.disturbances[0].forceN.z * STEP }), { x: 0, y: 0, z: 0 })
    report('push-journal', { kind: 'push-journal', ticks: journal.length, pushedTicks: pushed.length, durationS: pushed.length * STEP, impulseNs: impulse })
    expect(pushed).toHaveLength(24); expect(pushed.length * STEP).toBe(PUSH_SECONDS)
    expect(impulse.x).toBeCloseTo(-40, 6); expect(impulse.y).toBe(0); expect(impulse.z).toBeCloseTo(0, 6)
    journal[0].disturbances[0].forceN.x = 99; expect(world.journal('seat1')[0].disturbances[0].forceN.x).not.toBe(99)
    for (let tick = 0; tick < 8; tick++) world.advance(STEP)
    expect(world.journal('seat1')).toHaveLength(30); expect(world.journal('seat1')[0].action.tick).toBe(6)
  } finally { world.dispose() }
}, 120_000)

for (const profileId of ['keel-v1', 'morrow-v1']) it(`demo Class A toe push holds the stance envelope: ${profileId}`, async () => {
  const world = await HumanoidWorld.create({ actors: specs(profileId, 1) })
  const model = world.definition('seat1'), standingHeightM = world.observation('seat1').bodies.find(b => b.id === model.root)!.position.y
  const row = { kind: 'demo-class-A', profileId, actors: 1, settleTicks: 480, completedTicks: 0, expectedTicks: 960,
    impulseNs: 10, pushDurationS: PUSH_SECONDS, standingHeightM, minPelvisHeightM: Infinity, minRootUpY: 1, minThoraxUpY: 1,
    maxPenetrationMm: 0, maxEffortRatio: 0, maxFootUnloadedSeconds: 0, error: null as string | null }
  const unloaded = new Map(model.feet.map(id => [id, 0]))
  try {
    try {
      for (let tick = 0; tick < 480; tick++) world.advance(STEP)
      world.push('seat1', 'A', 'toe')
      for (let tick = 0; tick < 960; tick++) {
        world.advance(STEP)
        const o = world.observation('seat1'), root = o.bodies.find(b => b.id === model.root)!, thorax = o.bodies.find(b => b.id === model.parts.thorax.bodyId)!
        row.completedTicks++
        row.minPelvisHeightM = Math.min(row.minPelvisHeightM, root.position.y)
        row.minRootUpY = Math.min(row.minRootUpY, rotate(root.rotation, { x: 0, y: 1, z: 0 }).y)
        row.minThoraxUpY = Math.min(row.minThoraxUpY, rotate(thorax.rotation, { x: 0, y: 1, z: 0 }).y)
        for (const foot of o.feet) {
          row.maxPenetrationMm = Math.max(row.maxPenetrationMm, -foot.minSoleY * 1000)
          const ticks = foot.normalImpulseNs > 0 ? 0 : unloaded.get(foot.id)! + 1
          unloaded.set(foot.id, ticks); row.maxFootUnloadedSeconds = Math.max(row.maxFootUnloadedSeconds, ticks * STEP)
        }
        for (const [id, torque] of Object.entries(world.diagnostics().forces.motorTorques))
          row.maxEffortRatio = Math.max(row.maxEffortRatio, torque / model.scene.joints.find(j => j.id === id)!.motor.maxTorque)
      }
    } catch (caught) { row.error = String(caught) }
    report(`demo-class-A-${profileId}`, row)
    expect(row.error).toBeNull(); expect(row.completedTicks).toBe(960)
    expect(row.minRootUpY).toBeGreaterThanOrEqual(.98); expect(row.minThoraxUpY).toBeGreaterThanOrEqual(.98)
    expect(row.minPelvisHeightM).toBeGreaterThanOrEqual(.9 * standingHeightM)
    expect(row.maxPenetrationMm).toBeLessThanOrEqual(5); expect(row.maxEffortRatio).toBeLessThanOrEqual(1 + 1e-8)
    expect(row.maxFootUnloadedSeconds).toBeLessThanOrEqual(.1)
  } finally { world.dispose() }
}, 120_000)

it('reports complete one- and two-actor native world tick costs after warm-up', async () => {
  const rows: { profileId: string; actors: number; warmupTicks: number; sampledTicks: number; p50Ms: number; p95Ms: number; p99Ms: number; maximumMs: number; workerRecommended: boolean }[] = []
  for (const profileId of ['keel-v1', 'morrow-v1']) for (const count of [1, 2]) {
    const world = await HumanoidWorld.create({ actors: specs(profileId, count) })
    try {
      for (let tick = 0; tick < 240; tick++) world.advance(STEP)
      const times: number[] = []
      for (let tick = 0; tick < 480; tick++) { const start = performance.now(); world.advance(STEP); times.push(performance.now() - start) }
      times.sort((a, b) => a - b)
      const quantile = (p: number) => times[Math.ceil(p * times.length) - 1]
      rows.push({ profileId, actors: count, warmupTicks: 240, sampledTicks: times.length, p50Ms: quantile(.5), p95Ms: quantile(.95),
        p99Ms: quantile(.99), maximumMs: times.at(-1)!, workerRecommended: quantile(.95) > 1.2 })
    } finally { world.dispose() }
  }
  report('world-tick', { kind: 'world-tick-probe', note: 'Node native wall-clock work, including observation, supervisor, gates and journals; browser frame acceptance is separate.', rows })
  expect(rows).toHaveLength(4)
  for (const row of rows) { expect(row.sampledTicks).toBe(480); expect(Number.isFinite(row.p95Ms)).toBe(true); expect(row.p95Ms).toBeGreaterThan(0) }
}, 180_000)

/** Supervisor handoffs use measured support fixtures; native stability remains a browser gate. */
import { describe, expect, it } from 'vitest'
import { restIntent } from '../src/sim/humanoid/controls'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { ActuationGate } from '../src/sim/humanoid/physics/contract'
import { GaitController, GAIT_CONTROL } from '../src/sim/humanoid/physics/gait'
import { buildHumanoid, soleCorners } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { Supervisor, type Behaviour, type BehaviourMode, type BehaviourRegistry } from '../src/sim/humanoid/physics/supervisor'
import { HumanoidWorld } from '../src/sim/humanoid/physics/world'
import { fromRotationVector } from '../src/sim/physics/math'
import { STEP, type ContactSample } from '../src/sim/physics/schema'

const model = buildHumanoid('keel-v1'), forward = { ...restIntent(), z: -1, manual: true }
function measured(tick: number, gait: GaitController, speed = 0, zOffset = 0): Observation {
  const d = gait.diagnostics(), loaded = d.phase === 'strike' ? [1, 1] : d.swing === 'left' ? [0, 1] : [1, 0]
  const contacts: ContactSample[] = model.feet.flatMap((id, index) => {
    const foot = model.scene.bodies.find(b => b.id === id)!
    return soleCorners(foot).map(p => ({ a: 'floor', b: id, pointA: { ...p, y: 0, z: p.z + zOffset }, pointB: { ...p, y: 0, z: p.z + zOffset },
      normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: loaded[index] }))
  })
  const o = observe(model, model.scene.bodies.map(b => ({ ...b, position: { ...b.position, z: b.position.z + zOffset }, sleeping: false })), contacts, 1, tick)
  const stance = o.feet[d.swing === 'left' ? 1 : 0].centre
  if (tick) { o.com.x += .4 * (stance.x - o.com.x); o.com.z += .4 * (stance.z - o.com.z) }
  o.comVelocity = { x: speed, y: 0, z: 0 }
  return o
}
function controllers() {
  const gait = new GaitController(model, 1), balance = new BalanceController(model, 1)
  const registry: BehaviourRegistry = new Map<BehaviourMode, Behaviour>([
    ['walk', gait], ['balance', { mode: 'balance', canEnter: () => true, done: () => true, step: o => balance.step(o).frame }],
  ])
  return { gait, supervisor: new Supervisor(model, 1, registry) }
}

describe('walking through the humanoid supervisor', () => {
  it.each(['release', 'stand'] as const)('finishes the lifted foot on %s before returning to balance', command => {
    const { gait, supervisor } = controllers(), gate = new ActuationGate(model, 1)
    const start = Math.round(GAIT_CONTROL.startSeconds / STEP)
    for (let tick = 0; tick <= start; tick++) gate.accept(supervisor.step(measured(tick, gait), forward))
    expect(supervisor.mode).toBe('walk'); expect(gait.diagnostics().phase).toBe('lift')
    const stopped = command === 'stand' ? { ...forward, yaw: 1, command: 'stand' as const } : restIntent()
    const end = start + Math.round((GAIT_CONTROL.liftSeconds + GAIT_CONTROL.strikeSeconds) / STEP) + 2
    for (let tick = start + 1; tick < end; tick++) {
      const before = gait.diagnostics().phase
      gate.accept(supervisor.step(measured(tick, gait, .1), stopped))
      if (before === 'lift' || before === 'strike') expect(supervisor.mode).toBe('walk')
    }
    expect(gait.diagnostics().phase).toBe('idle')
    expect(supervisor.mode).toBe('walk') // Measured COM speed must drop below the declared stop threshold.
    gate.accept(supervisor.step(measured(end, gait, .099), stopped))
    expect(supervisor.mode).toBe('balance')
    for (let tick = end + 1; tick < end + 5; tick++) {
      gate.accept(supervisor.step(measured(tick, gait), stopped)); expect(supervisor.mode).toBe('balance')
    }
  })

  it('keeps fallen walking joints in measured hold despite a held stick', () => {
    const { gait, supervisor } = controllers()
    supervisor.step(measured(0, gait), forward)
    for (let tick = 1; tick < 4; tick++) {
      const o = measured(tick, gait)
      o.bodies.find(b => b.id === model.root)!.rotation = fromRotationVector({ x: 1, y: 0, z: 0 })
      const frame = supervisor.step(o, forward)
      expect(frame.source).toBe('hold')
      expect(frame.targets).toEqual(Object.fromEntries(o.joints.map(j => [j.id, j.rotation])))
      expect(gait.diagnostics().phase).toBe('idle')
    }
  })

  it('finishes the active swing near the arena wall and cannot reenter with outward input', () => {
    const { gait, supervisor } = controllers(), start = Math.round(GAIT_CONTROL.startSeconds / STEP)
    for (let tick = 0; tick <= start; tick++) supervisor.step(measured(tick, gait), forward)
    expect(gait.diagnostics().phase).toBe('lift')
    const end = start + Math.round((GAIT_CONTROL.liftSeconds + GAIT_CONTROL.strikeSeconds) / STEP) + 3
    for (let tick = start + 1; tick <= end; tick++) supervisor.step(measured(tick, gait, 0, -2.8), forward)
    expect(supervisor.mode).toBe('balance')
    for (let tick = end + 1; tick < end + 5; tick++) {
      supervisor.step(measured(tick, gait, 0, -2.8), forward); expect(supervisor.mode).toBe('balance')
    }
    supervisor.step(measured(end + 5, gait, 0, -2.8), { ...forward, z: 1 })
    expect(supervisor.mode).toBe('walk')
  })

  it.each(['keel-v1', 'morrow-v1'])('%s registers gait by default and clears held motion on loss and Reset', async profileId => {
    const world = await HumanoidWorld.create({ actors: [{ actorId: 'seat1', profileId, spawn: { x: 0, z: 0, yaw: 0 } }] })
    try {
      world.setIntent('seat1', forward); world.advance(STEP)
      expect(world.supervisor('seat1').mode).toBe('walk')
      const old = world.supervisor('seat1'), generation = world.generation('seat1')
      world.loss('seat1'); world.advance(STEP)
      expect(world.generation('seat1')).toBe(generation + 1)
      expect(world.supervisor('seat1')).not.toBe(old)
      expect(world.supervisor('seat1').mode).toBe('balance')
      expect(world.journal('seat1').at(-1)!.intent).toEqual(restIntent())
      world.setIntent('seat1', forward); world.advance(STEP)
      expect(world.supervisor('seat1').mode).toBe('walk')
      await world.reset(); world.advance(STEP)
      expect(world.generation('seat1')).toBe(generation + 2)
      expect(world.supervisor('seat1').mode).toBe('balance')
      expect(world.journal('seat1')).toHaveLength(1)
      expect(world.journal('seat1')[0].intent).toEqual(restIntent())
    } finally { world.dispose() }
  }, 30_000)

  it.each(['keel-v1', 'morrow-v1'])('%s retains the in-place fallback across loss and Reset', async profileId => {
    const world = await HumanoidWorld.create({ actors: [{ actorId: 'seat1', profileId, spawn: { x: 0, z: 0, yaw: 0 } }], gaitMode: 'in-place' })
    try {
      const enter = () => {
        world.setIntent('seat1', forward); world.advance(STEP)
        expect(world.supervisor('seat1').mode).toBe('walk')
        expect(world.supervisor('seat1').diagnostics()!.gait!.desiredVelocity).toEqual({ x: 0, y: 0, z: 0 })
      }
      enter()
      world.loss('seat1'); world.advance(STEP)
      expect(world.supervisor('seat1').mode).toBe('balance')
      enter()
      await world.reset(); world.advance(STEP)
      expect(world.supervisor('seat1').mode).toBe('balance')
      enter()
    } finally { world.dispose() }
  }, 30_000)
})

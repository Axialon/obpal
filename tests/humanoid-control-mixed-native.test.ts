/** The page's mixed step/turn/release sequence includes the one-tick-sensitive Keel start. */
import { expect, it } from 'vitest'
import { emitMeasurement } from './humanoid-physics-node.mjs'
import { colliderFloorMinimum, unwrappedYawDelta } from './humanoid-control-gait-cases'
import { HumanoidWorld } from '../src/sim/humanoid/physics/world'
import { rotate } from '../src/sim/physics/math'
import { STEP } from '../src/sim/physics/schema'

// Before the settled turn transition, Keel fell at 26.558 s with 6.559 mm foot penetration.
// These are page-sequence gates; the separate 30 s pure-turn test still requires 0.3 rad.
it.each([{ profileId: 'keel-v1', settleTicks: 359 }, { profileId: 'morrow-v1', settleTicks: 360 }])(
  '$profileId finishes stepping, turning and release after $settleTicks settle ticks', async ({ profileId, settleTicks }) => {
    const expectedTicks = settleTicks + Math.round(36 / STEP)
    const row = { schema_version: 1, kind: 'humanoid-control-mixed-sequence', profileId, settleTicks,
      completedTicks: 0, expectedTicks, maxPenetrationMm: 0, maxEffortRatio: 0, maxTranslationM: 0,
      minRootUpY: 1, minThoraxUpY: 1, minHeightFraction: 1, turnRad: 0,
      finite: true, fault: null as string | null, finalMode: '', loadedFeet: 0 }
    let world: HumanoidWorld | undefined
    try {
      world = await HumanoidWorld.create({ actors: [{ actorId: 'seat1', profileId, spawn: { x: 0, z: 0, yaw: 0 } }],
        gaitMode: 'in-place', journalCapacity: 2 })
      const model = world.definition('seat1'), height = model.scene.bodies.find(body => body.id === model.root)!.position.y
      let origin: { x: number; z: number } | null = null, previousYaw = 0
      for (let tick = 0; tick < expectedTicks; tick++) {
        if (tick === settleTicks) world.setIntent('seat1', { x: 0, z: -.65, yaw: 0, manual: true })
        if (tick === settleTicks + Math.round(10 / STEP)) world.setIntent('seat1', { x: 0, z: 0, yaw: .65, manual: true })
        if (tick === settleTicks + Math.round(30 / STEP)) world.setIntent('seat1', { x: 0, z: 0, yaw: 0, manual: false })
        world.advance(STEP)
        const d = world.diagnostics()
        if (d.status !== 'ready' || d.tick !== tick + 1) throw new Error(`Native mixed tick failed: ${d.status}, ${d.tick}, ${d.fault}`)
        row.completedTicks++
        const o = world.observation('seat1'), root = o.bodies.find(body => body.id === model.root)!
        const thorax = o.bodies.find(body => body.id === model.parts.thorax.bodyId)!
        row.finite &&= o.bodies.every(body => [...Object.values(body.position), ...Object.values(body.rotation),
          ...Object.values(body.velocity), ...Object.values(body.angularVelocity)].every(Number.isFinite))
        row.maxPenetrationMm = Math.max(row.maxPenetrationMm, ...o.bodies.map(body => -1000 * colliderFloorMinimum(model, body)))
        row.maxEffortRatio = Math.max(row.maxEffortRatio, ...model.scene.joints.map(joint =>
          (d.forces.motorTorques[joint.id] ?? 0) / joint.motor.maxTorque))
        row.minRootUpY = Math.min(row.minRootUpY, rotate(root.rotation, { x: 0, y: 1, z: 0 }).y)
        row.minThoraxUpY = Math.min(row.minThoraxUpY, rotate(thorax.rotation, { x: 0, y: 1, z: 0 }).y)
        row.minHeightFraction = Math.min(row.minHeightFraction, root.position.y / height)
        const forward = rotate(root.rotation, { x: 0, y: 0, z: -1 }), yaw = Math.atan2(-forward.x, -forward.z)
        if (tick >= settleTicks + Math.round(10 / STEP) && tick < settleTicks + Math.round(30 / STEP))
          row.turnRad += unwrappedYawDelta(previousYaw, yaw)
        previousYaw = yaw
        if (tick === settleTicks) origin = { x: root.position.x, z: root.position.z }
        if (origin) row.maxTranslationM = Math.max(row.maxTranslationM, Math.hypot(root.position.x - origin.x, root.position.z - origin.z))
        row.finalMode = d.actors.seat1.mode ?? ''
        row.loadedFeet = o.feet.filter(foot => foot.normalImpulseNs > 0).length
      }
    } catch (error) { row.fault = String(error) }
    finally { world?.dispose() }
    emitMeasurement(row)
    expect(row.fault).toBeNull(); expect(row.finite).toBe(true)
    expect(row.completedTicks).toBe(expectedTicks)
    expect(row.maxPenetrationMm).toBeLessThanOrEqual(5)
    expect(row.maxEffortRatio).toBeLessThanOrEqual(1 + 1e-8)
    expect(row.minRootUpY).toBeGreaterThanOrEqual(.8)
    expect(row.minThoraxUpY).toBeGreaterThanOrEqual(.8)
    expect(row.minHeightFraction).toBeGreaterThanOrEqual(.8)
    expect(row.maxTranslationM).toBeLessThanOrEqual(.3)
    expect(row.turnRad).toBeGreaterThan(.05)
    expect(row.finalMode).toBe('balance'); expect(row.loadedFeet).toBe(2)
  }, 180_000)

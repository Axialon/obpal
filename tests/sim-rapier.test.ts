import { it, expect } from 'vitest'
import { backendCases } from './sim-backend-cases'
import { createRapierBackend } from '../src/sim/physics/backends/rapier'
import { Simulation } from '../src/sim/physics/runtime'
import { fixture } from '../src/sim/physics/fixtures'
import { angleBetween } from '../src/sim/physics/math'
import { STEP } from '../src/sim/physics/schema'
backendCases((name, run) => it(`rapier ${name}`, run, 120_000), createRapierBackend)
it('preserves a displaced spherical joint pose on the first tick', async () => {
  const s = new Simulation(fixture('energy').scene, createRapierBackend)
  try {
    await s.init(); const before = s.snapshot()[1]
    s.advance(STEP); const after = s.snapshot()[1]
    expect(angleBetween(before.rotation, after.rotation)).toBeLessThan(.005)
    expect(after.position.x).toBeGreaterThan(.16)
    expect(after.angularVelocity.z).toBeLessThan(0)
  } finally { s.dispose() }
})

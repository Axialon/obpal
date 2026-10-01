import { it, expect } from 'vitest'
import { measureCandidate, candidateFailures } from '../src/sim/physics/bench'
import { createCustomBackend } from '../src/sim/physics/backends/custom'
import { createRapierBackend } from '../src/sim/physics/backends/rapier'
it('prints real Node comparison rows for the custom and Rapier backends, then enforces correctness', async () => {
  const rows = [await measureCandidate('custom', async () => createCustomBackend, 'node:canonical-vitest'),
    await measureCandidate('rapier', async () => createRapierBackend, 'node:canonical-vitest')]
  console.log(`OBPAL_PHYSICS_BENCH ${JSON.stringify({ schema_version: 1, kind: 'node', rows,
    notRun: [{ id: 'physx', reason: 'Pinned 2.8.0 build is web-only; the full sims browser suite measures it' }],
    byteAccounting: 'Node rows do not measure browser delivery; transfer remains null' })}`)
  for (const row of rows) expect(candidateFailures(row), row.id).toEqual([])
}, 240_000)

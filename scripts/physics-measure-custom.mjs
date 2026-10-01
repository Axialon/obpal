// Offline evidence only. Same code/fixtures as Vitest/browser; no invented WASM results.
import { measureCandidate, candidateFailures } from '../src/sim/physics/bench.ts'
import { createCustomBackend } from '../src/sim/physics/backends/custom.ts'
const row = await measureCandidate('custom', async () => createCustomBackend, `node:${process.version}:offline`)
console.log(`OBPAL_PHYSICS_BENCH ${JSON.stringify({ schema_version: 1, kind: 'offline', rows: [row],
  notRun: ['Rapier: dependency not installed', 'PhysX: dependency not installed and pinned build is browser-only'],
  byteAccounting: 'No production bundle available; browser transfer bytes unmeasured' })}`)
const failures = candidateFailures(row)
for (const failure of failures) console.error(failure)
if (failures.length) process.exitCode = 1

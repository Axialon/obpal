/** Dependency-free contracts only. Does NOT execute Rapier, rendering, BODY, stance, recovery or browser acceptance.
 * node --experimental-transform-types --experimental-loader ./scripts/lib/physics-types-loader.mjs scripts/humanoid-physics-selfcheck.mjs */
import { humanoidPhysicsCoreCases, humanoidServoCases } from '../tests/humanoid-physics-core-cases.ts'
import { humanoidPilotCases, humanoidSessionCases, humanoidBindingCases, humanoidReviewCases } from '../tests/humanoid-pilot-cases.ts'
import { humanoidAcceptanceCases } from '../tests/humanoid-acceptance-cases.ts'
const cases = []
for (const register of [humanoidPhysicsCoreCases, humanoidServoCases, humanoidPilotCases, humanoidSessionCases, humanoidBindingCases, humanoidReviewCases, humanoidAcceptanceCases]) register((name, run) => cases.push({ name, run }))
let failed = 0
for (const { name, run } of cases) { try { await run(); console.log(`PASS ${name}`) } catch (error) { failed++; console.error(`FAIL ${name}: ${error?.stack ?? error}`) } }
console.log(JSON.stringify({ schema_version: 1, kind: 'humanoid-f1a-offline-contracts', passed: cases.length - failed, failed,
  physicalAcceptance: 'not executed; orchestration double is not physics evidence' }))
process.exitCode = failed ? 1 : 0

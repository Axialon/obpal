/** Same pure assertions as Vitest, without installing dependencies. No browser or WASM claims. */
import { decisionCases } from '../tests/sim-decision-cases.ts'
import { backendCases } from '../tests/sim-backend-cases.ts'
const cases = []
decisionCases((name, run) => cases.push({ name, run }))
backendCases((name, run) => cases.push({ name, run }))
let failed = 0
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}
console.log(JSON.stringify({ suite: 'physics-offline', passed: cases.length - failed, failed }))
process.exitCode = failed ? 1 : 0

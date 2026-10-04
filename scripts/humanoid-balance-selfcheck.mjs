import { humanoidBalanceSessionCases } from '../tests/humanoid-balance-session-cases.ts'
/** Offline numerical/contracts runner, NOT native physics or browser evidence. */
import { humanoidConstraintCases, humanoidCoupledRuntimeCases, humanoidSupportCases, humanoidReviewFollowupCases, humanoidIsolationCases } from '../tests/humanoid-balance-cases.ts'
const cases=[]
for (const register of [humanoidConstraintCases, humanoidCoupledRuntimeCases, humanoidSupportCases, humanoidReviewFollowupCases, humanoidIsolationCases, humanoidBalanceSessionCases]) register((name,run)=>cases.push({name,run}))
let failed=0
for(const {name,run} of cases) { try { await run(); console.log(`PASS ${name}`) } catch(error) { failed++;console.error(`FAIL ${name}: ${error?.stack??error}`) } }
console.log(JSON.stringify({schema_version:1,kind:'humanoid-f1a2-offline',passed:cases.length-failed,failed,nativePhysics:'not executed',browser:'not executed'}))
process.exitCode=failed?1:0

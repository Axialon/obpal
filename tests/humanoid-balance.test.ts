import { humanoidBalanceSessionCases } from './humanoid-balance-session-cases'
import { it } from 'vitest'
import { humanoidConstraintCases, humanoidCoupledRuntimeCases, humanoidSupportCases, humanoidReviewFollowupCases, humanoidIsolationCases } from './humanoid-balance-cases'
for (const register of [humanoidConstraintCases, humanoidCoupledRuntimeCases, humanoidSupportCases, humanoidReviewFollowupCases, humanoidIsolationCases, humanoidBalanceSessionCases]) register((name,run)=>it(name,run,30_000))

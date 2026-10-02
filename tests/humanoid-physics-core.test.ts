import { it } from 'vitest'
import { humanoidPhysicsCoreCases, humanoidServoCases } from './humanoid-physics-core-cases'
import { humanoidPilotCases, humanoidSessionCases, humanoidBindingCases, humanoidReviewCases } from './humanoid-pilot-cases'
import { humanoidAcceptanceCases } from './humanoid-acceptance-cases'
for (const register of [humanoidPhysicsCoreCases, humanoidServoCases, humanoidPilotCases, humanoidSessionCases, humanoidBindingCases, humanoidReviewCases, humanoidAcceptanceCases])
  register((name, run) => it(name, run, 30_000))

import { it } from 'vitest'
import { backendCases } from './sim-backend-cases'
backendCases((name, run) => it(name, run, 120_000))

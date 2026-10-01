import { describe, it } from 'vitest'
import { layoutCases } from './astra-layout-node.mjs'

describe('Astra exchange layout', { timeout: 30_000 }, () => {
  for (const fixture of layoutCases) it(fixture.name, fixture.run)
})

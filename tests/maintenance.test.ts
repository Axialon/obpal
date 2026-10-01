import { describe, it } from 'vitest'
import { cases } from './maintenance-node.mjs'

describe('backup and cleanup tooling', { timeout: 60_000 }, () => {
  for (const fixture of cases) it(fixture.name, fixture.run)
})

import { describe, it } from 'vitest'
import { cases } from './tooling-tune-node.mjs'

describe('coordinator tooling tune-up', () => {
  for (const fixture of cases) it(fixture.name, fixture.run)
})

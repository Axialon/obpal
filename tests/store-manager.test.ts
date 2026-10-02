import { describe, it } from 'vitest'
import { cases } from './store-manager-node.mjs'

describe('Chrome Web Store update manager', () => {
  for (const fixture of cases) it(fixture.name, fixture.run)
})

import { describe, it } from 'vitest'
import { cases } from './store-manager-node.mjs'

// Each case builds a temporary git repository and runs the CLI, which takes a few seconds alone and longer under the
// full parallel suite, so the default 5 s limit times out without a real failure.
describe('Chrome Web Store update manager', () => {
  for (const fixture of cases) it(fixture.name, fixture.run, 30_000)
})

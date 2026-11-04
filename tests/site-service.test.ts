import { describe, expect, it } from 'vitest'
import { Remote, type RemoteOptions } from '@obpal/host'
import { siteOptions } from '../src/service'
import { readText } from './devtools-node.mjs'

// Construct only: destination validation precedes init, so these fixtures open no sockets or rooms.
const Screen = Remote as unknown as new (options: RemoteOptions) => Remote
const origin = 'https://controller.example.org'

describe('the independent site service', () => {
  it('pairs through the site origin while preserving the screen options', () => {
    const options = siteOptions({ appName: 'Example scene', seats: 4 }, origin)
    expect(options).toMatchObject({ appName: 'Example scene', seats: 4 })
    expect(new Screen(options).service).toBe(origin)
  })
  it('retains an explicit SDK service and the existing transport validation', () => {
    expect(new Screen(siteOptions({ appName: 'Example', service: 'https://other.example.org' }, origin)).service).toBe('https://other.example.org')
    expect(() => new Screen(siteOptions({ appName: 'Example' }, 'http://public.example.org'))).toThrow('https URL')
  })
  it('selects the site service in each screen factory, including the lazy home factory', () => {
    for (const file of ['src/landing/pair.ts', 'src/sim/scene.ts', 'src/viewer/main.ts']) {
      expect(readText(file), file).toContain('Remote.create(siteOptions(')
    }
  })
})

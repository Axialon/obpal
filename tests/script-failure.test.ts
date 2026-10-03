import { describe, expect, it } from 'vitest'
import { ownModuleFailed } from '../src/sim/kit/script-failure'

const site = 'https://obpal.blackboxes.net'

describe('a failed script is a scene failure only when it is the site\'s own module', () => {
  it('counts the site\'s modules, by relative or absolute address', () => {
    expect(ownModuleFailed({ type: 'module', src: `${site}/assets/simDevice-QKv5d0Jg.js` }, site)).toBe(true)
    expect(ownModuleFailed({ type: 'module', src: '/assets/simEarly-BvUPR9Qh.js' }, site)).toBe(true)
  })

  it('does not count the analytics script Cloudflare adds to a page and the page policy blocks', () => {
    expect(ownModuleFailed({ type: 'module', src: 'https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495' }, site)).toBe(false)
    expect(ownModuleFailed({ type: 'module', src: 'https://obpal.blackboxes.net.example.org/assets/x.js' }, site)).toBe(false)
    expect(ownModuleFailed({ type: 'module', src: 'http://obpal.blackboxes.net/assets/x.js' }, site)).toBe(false)
  })

  it('leaves classic scripts and unreadable addresses alone', () => {
    expect(ownModuleFailed({ type: '', src: `${site}/assets/x.js` }, site)).toBe(false)
    expect(ownModuleFailed({ type: 'module', src: 'http://[bad' }, site)).toBe(false)
  })
})

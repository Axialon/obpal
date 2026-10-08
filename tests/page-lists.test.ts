import { describe, expect, it } from 'vitest'
import { PAGES as LIVE_PAGES } from '../scripts/lib/live.mjs'
import { readText } from './devtools-node.mjs'
import { PAGES } from './site-pages'

/**
 * The lists of pages the gates load and read must hold every page the build routes. The overclaims and messaging tests
 * (tests/site-pages.ts), the live check (scripts/lib/live.mjs) and the pages suite (scripts/e2e-pages.mjs) each keep their
 * own list. Retained offer previews stay in source-copy checks, but the native asset exclusion keeps them out of public
 * lists. This reads the build's inputs, so
 * a page that lands later (the physics humanoid's, say) fails here until each list names it.
 */

/** The HTML pages vite.config.ts builds (`build.rollupOptions.input`), as files in the build. */
function inputPages(): string[] {
  const input = /rollupOptions:\s*\{\s*input:\s*\{([^}]*)\}/.exec(readText('vite.config.ts'))?.[1]
  expect(input, 'vite.config.ts has no rollupOptions.input').toBeTruthy()
  return [...input!.matchAll(/:\s*'([^']+\.html)'/g)].map((m) => m[1])
}

/** The address a page is served at: `sim/arm/index.html` is `/sim/arm/`. */
const route = (file: string) => `/${file.replace(/index\.html$/, '')}`

const excluded = ['campaign/phone-control/index.html', 'campaign/phone-control/guide/index.html', 'campaign/phone-control/sample/index.html']
const publicPages = () => inputPages().filter(page => !excluded.includes(page))

/** The `const PAGES = [...]` list of the pages suite, which is a script and not a module. */
function suitePages(): string[] {
  const list = /^const PAGES = \[([^\]]*)\]/m.exec(readText('scripts/e2e-pages.mjs'))?.[1]
  expect(list, 'scripts/e2e-pages.mjs has no const PAGES list').toBeTruthy()
  return [...list!.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('page lists', () => {
  it('reads the pages the build routes, humanoid among them', () => {
    const pages = inputPages()
    expect(pages.length).toBeGreaterThan(15)
    for (const page of ['index.html', 'sim/humanoid/index.html', 'sim/arena/index.html', 'trust/index.html']) expect(pages).toContain(page)
  })

  it('the overclaims and messaging tests read every routed page', () => {
    expect(inputPages().filter((page) => !PAGES.includes(page))).toEqual([])
  })

  it('the live check loads every routed page', () => {
    expect(publicPages().map(route).filter((path) => !LIVE_PAGES.includes(path))).toEqual([])
  })

  it('the pages suite loads every routed page', () => {
    expect(publicPages().map(route).filter((path) => !suitePages().includes(path))).toEqual([])
  })

  it('retains offer source checks while excluding only their subtree from public assets', () => {
    expect(readText('public/.assetsignore').trim()).toBe('/campaign/phone-control/')
    for (const page of excluded) {
      expect(inputPages()).toContain(page)
      expect(PAGES).toContain(page)
      expect(readText(page)).toContain('Local review preview')
      expect(LIVE_PAGES).not.toContain(route(page))
      expect(suitePages()).not.toContain(route(page))
    }
    expect(publicPages()).toContain('campaign/index.html')
    expect(LIVE_PAGES).toContain('/campaign/')
    expect(suitePages()).toContain('/campaign/')
  })

  it('names no page the build does not route, apart from the generated sim pages', () => {
    const routed = inputPages()
    expect(PAGES.filter((page) => !routed.includes(page))).toEqual([])
    // A sim of the device registry has no input of its own: the build writes /sim/<id>/ from the device template.
    const extra = (paths: string[]) => paths.filter((path) => !routed.map(route).includes(path) && !/^\/sim\/[a-z0-9-]+\/$/.test(path))
    expect(extra(LIVE_PAGES)).toEqual([])
    expect(extra(suitePages())).toEqual([])
  })
})

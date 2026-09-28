import { afterEach, describe, expect, it, vi } from 'vitest'
import { quickActions, quickViews, type QuickView } from '../src/ui/quick-actions'

/** The page's views, each noting when it's shown; first person says when it's showing. */
function page() {
  const shown: string[] = []
  let firstPerson = false
  const view = (name: string): QuickView => ({ name, show: () => { shown.push(name); firstPerson = false } })
  const views: QuickView[] = [view('Play view'), view('Overview'), view('Close-up'),
    { name: 'First person', show: () => { shown.push('First person'); firstPerson = true }, current: () => firstPerson, phone: true }]
  return { shown, views, enter: () => { firstPerson = true } }
}
const camera = () => quickActions().get('camera')!
const press = (n = 1) => { for (let i = 0; i < n; i++) camera().run() }

describe('the tray’s camera (quick actions)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('steps through the page’s views from where it starts, round again, and names the next', () => {
    const p = page()
    quickViews(p.views)
    expect(camera().hint).toBe('Next: Overview')
    press(4)
    expect(p.shown).toEqual(['Overview', 'Close-up', 'First person', 'Play view'])
    expect(camera().hint).toBe('Next: Overview')
  })

  it('on a touch screen, first person is one press away', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }))
    const p = page()
    quickViews(p.views)
    expect(camera().hint).toBe('Next: First person')
    press(4)
    expect(p.shown).toEqual(['First person', 'Overview', 'Close-up', 'Play view'])
  })

  it('goes on from first person when the page entered it by its own button', () => {
    const p = page()
    quickViews(p.views)
    p.enter()
    expect(camera().hint).toBe('Next: Play view')
    press()
    expect(p.shown).toEqual(['Play view'])
    expect(camera().hint).toBe('Next: Overview')
  })

  it('a page with one view names it', () => {
    quickViews([{ name: 'Home view', show: () => {} }])
    expect(camera().hint).toBe('Home view')
  })
})

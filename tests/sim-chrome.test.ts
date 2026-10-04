import { describe, expect, it } from 'vitest'
import { keyedQuickActions, orderedQuickActions, quickKey, type QuickAction, type QuickId } from '../src/ui/quick-actions'
import { SIM_TRAY, trayShows } from '../src/sim/ui/chrome'
import { foldsByDefault, readFolds, writeFolds, type FoldStore } from '../src/sim/ui/sections'

const action = (id: QuickId, group: QuickAction['group'], key?: string): QuickAction => ({ id, group, key, label: id, icon: 'phone', run: () => {} })
/** What a sim offers today: pairing, its page actions, then the system controls. */
const sim = new Map<QuickId, QuickAction>([
  action('pair', 'primary', 'P'), action('switch', 'page', 'K'), action('reset', 'page', 'R'), action('camera', 'page', 'C'),
  action('stop', 'page', 'Space'), action('body', 'page'), action('fullscreen', 'system', 'F'), action('minimise', 'system', '\\'),
  action('sound', 'system', 'M'), action('theme', 'system', 'T'),
].map(a => [a.id, a]))
const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, target: null })

describe('a sim’s quick-actions tray (src/sim/ui/chrome.ts)', () => {
  it('shows only system actions, each with one home: no pairing, reset, stop, body camera or sound', () => {
    const shown = orderedQuickActions(sim, (id) => trayShows(id, true)).map(a => a.id)
    expect(shown).toEqual(['switch', 'camera', 'fullscreen', 'minimise', 'theme'])
    for (const id of ['pair', 'reset', 'stop', 'body', 'sound'] as QuickId[]) expect(shown).not.toContain(id)
    expect(shown.every(id => SIM_TRAY.includes(id))).toBe(true)
  })

  it('on a phone, whose pill scans other screens, also shows the way to this screen’s own code', () => {
    expect(orderedQuickActions(sim, (id) => trayShows(id, true, true)).map(a => a.id)).toEqual(['pair', 'switch', 'camera', 'fullscreen', 'minimise', 'theme'])
  })

  it('keeps every key, shown in the tray or not', () => {
    const all = keyedQuickActions(sim)
    expect(quickKey(key('r'), all)).toBe('reset')
    expect(quickKey(key(' '), all)).toBe('stop')
    expect(quickKey(key('m'), all)).toBe('sound')
    expect(quickKey(key('p'), all)).toBe('pair')
    expect(quickKey(key('\\'), all)).toBe('minimise')
  })

  it('leaves other pages’ trays as they were', () => {
    expect(orderedQuickActions(sim, (id) => trayShows(id, false)).map(a => a.id)).toEqual(['pair', 'switch', 'reset', 'camera', 'stop', 'fullscreen', 'minimise', 'sound'])
  })
})

describe('the Controls window’s folding sections (src/sim/ui/sections.ts)', () => {
  const memory = (): FoldStore & { values: Map<string, string> } => {
    const values = new Map<string, string>()
    return { values, getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v) } }
  }
  it('starts the rarely used sections folded: controllers’ how-to, the sound level, a single unit', () => {
    expect(foldsByDefault('dev-faces-h', 3)).toBe(true)
    expect(foldsByDefault('sim-sound-h', 3)).toBe(true)
    expect(foldsByDefault('dev-units-h', 1)).toBe(true)
    expect(foldsByDefault('practice', 2)).toBe(true)
    expect(foldsByDefault('dev-units-h', 4)).toBe(false)
    // Whatever drives the sim starts open.
    for (const key of ['dev-view-h', 'your-seat', 'moves', 'arm-arms-h']) expect(foldsByDefault(key, 1)).toBe(false)
  })
  it('remembers what a person folds per sim and screen class, and survives storage that is blocked or holds junk', () => {
    const store = memory()
    writeFolds(store, 'obpal.sections.v1:device:drone:desktop', { 'dev-faces-h': false, 'sim-sound-h': true })
    expect(readFolds(store, 'obpal.sections.v1:device:drone:desktop')).toEqual({ 'dev-faces-h': false, 'sim-sound-h': true })
    expect(readFolds(store, 'obpal.sections.v1:device:drone:portrait')).toEqual({})
    store.values.set('junk', '{"a":1,"b":true}')
    expect(readFolds(store, 'junk')).toEqual({ b: true })
    store.values.set('broken', '{')
    expect(readFolds(store, 'broken')).toEqual({})
    const blocked: FoldStore = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readFolds(blocked, 'x')).toEqual({})
    expect(() => writeFolds(blocked, 'x', { a: true })).not.toThrow()
    expect(readFolds(null, 'x')).toEqual({})
  })
})

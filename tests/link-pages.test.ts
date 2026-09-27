import { describe, expect, it } from 'vitest'
import { LOOK_KEY, parseLook, wearCachedLook } from '../extension/src/ui/lookcache'
import { radioStep } from '../extension/src/ui/radios'

/** A stand-in for <html>: the attributes set on it, and its dataset. */
function fakeRoot() {
  const attrs: Record<string, string> = {}
  const dataset: Record<string, string> = {}
  const el = { setAttribute: (k: string, v: string) => { attrs[k] = v }, dataset }
  return { el: el as unknown as HTMLElement, attrs, dataset }
}
const storageOf = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null })

describe('Link pages: the look kept in chrome.storage, cached for the first paint', () => {
  it('takes a stored look with ids of the right shape, and nothing else', () => {
    expect(LOOK_KEY).toBe('look')
    expect(parseLook({ theme: 'light', accent: 'product' })).toEqual({ theme: 'light', accent: 'product' })
    expect(parseLook({ theme: 'navy', accent: 'rose', extra: 1 })).toEqual({ theme: 'navy', accent: 'rose' })
    for (const bad of [null, undefined, 'light', 3, {}, { theme: 'light' }, { theme: 'Light', accent: 'product' }, { theme: 'light', accent: '"><x' }, { theme: 'a'.repeat(17), accent: 'product' }]) {
      expect(parseLook(bad)).toBeNull()
    }
  })

  it('puts the cached surface on before the first paint: the family cookie first, then localStorage', () => {
    const a = fakeRoot()
    wearCachedLook(a.el, 'x=1; bb_theme=light; y=2', storageOf({ bb_theme: 'navy' }))
    expect(a.attrs['data-bb-theme']).toBe('light')
    expect(a.dataset.theme).toBe('light')
    expect(a.attrs['data-bb-product']).toBe('obpal')
    const b = fakeRoot()
    wearCachedLook(b.el, '', storageOf({ bb_theme: 'violet', bb_accent: 'mint' }))
    expect([b.attrs['data-bb-theme'], b.dataset.theme, b.attrs['data-bb-accent']]).toEqual(['violet', 'violet', 'mint'])
  })

  it('wears the default surface and ob.Pal lime while nothing (or nothing valid) is cached, and survives blocked storage', () => {
    const empty = fakeRoot()
    wearCachedLook(empty.el, '', storageOf({}))
    expect(empty.attrs['data-bb-theme']).toBe('carbon')
    expect('data-bb-accent' in empty.attrs).toBe(false)
    const junk = fakeRoot()
    wearCachedLook(junk.el, 'bb_theme=', storageOf({ bb_theme: 'NOT a theme', bb_accent: 'product' }))
    expect(junk.attrs['data-bb-theme']).toBe('carbon')
    expect('data-bb-accent' in junk.attrs).toBe(false)
    const blocked = fakeRoot()
    wearCachedLook(blocked.el, '', { getItem: () => { throw new Error('blocked') } })
    expect(blocked.attrs['data-bb-theme']).toBe('carbon')
    const none = fakeRoot()
    wearCachedLook(none.el, '', null)
    expect(none.attrs['data-bb-theme']).toBe('carbon')
  })
})

describe('Link pages: radio groups from the keyboard', () => {
  it('moves to the next and the previous radio with the arrows, wrapping around', () => {
    expect(radioStep('ArrowRight', 0, 4)).toBe(1)
    expect(radioStep('ArrowDown', 3, 4)).toBe(0)
    expect(radioStep('ArrowLeft', 0, 4)).toBe(3)
    expect(radioStep('ArrowUp', 2, 4)).toBe(1)
  })

  it('goes to the first and the last with Home and End, and leaves other keys alone', () => {
    expect(radioStep('Home', 2, 6)).toBe(0)
    expect(radioStep('End', 2, 6)).toBe(5)
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a', 'PageDown']) expect(radioStep(key, 1, 4)).toBeNull()
  })

  it('stays put in a group of one', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) expect(radioStep(key, 0, 1)).toBe(0)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { reservePhoneNotices } from '../src/controller/notices'
import { readText } from './devtools-node.mjs'

function fixture() {
  let height = 8, items = 0, resized = () => {}, changed = () => {}
  const styles = new Map<string, string>(), attributes = new Set<string>()
  const root = { style: { setProperty: (key: string, value: string) => styles.set(key, value), removeProperty: (key: string) => styles.delete(key) }, toggleAttribute: (key: string, on: boolean) => on ? attributes.add(key) : attributes.delete(key), removeAttribute: (key: string) => attributes.delete(key) }
  const host = { dataset: {} as Record<string, string>, querySelector: () => items ? {} : null, get offsetHeight() { return height } }
  let resizeDisconnected = false, changeDisconnected = false
  const lifecycle = new EventTarget(), remove = vi.spyOn(lifecycle, 'removeEventListener')
  vi.stubGlobal('window', lifecycle)
  vi.stubGlobal('ResizeObserver', class { constructor(fn: () => void) { resized = fn } observe(node: unknown) { expect(node).toBe(host) } disconnect() { resizeDisconnected = true } })
  vi.stubGlobal('MutationObserver', class { constructor(fn: () => void) { changed = fn } observe(node: unknown, options: MutationObserverInit) { expect(node).toBe(host); expect(options.childList).toBe(true); expect(options.subtree).toBe(true) } disconnect() { changeDisconnected = true } })
  return { host: host as unknown as HTMLElement, root: root as unknown as HTMLElement, styles, attributes, lifecycle, remove,
    set(nextHeight: number, count: number) { height = nextHeight; items = count }, resized: () => resized(), changed: () => changed(), disconnected: () => resizeDisconnected && changeDisconnected }
}

afterEach(() => vi.unstubAllGlobals())

describe('phone notice space', () => {
  it('keeps and refreshes its reservation through repeated cached returns, then releases owned state on final hide', () => {
    const f = fixture(); f.set(80, 1)
    const main = readText('src/controller/main.ts').replaceAll('\r\n', '\n')
    const start = main.indexOf('\nmountNotices()\n') + '\nmountNotices()\n'.length, end = main.indexOf('const isApple', start)
    expect(start).toBeGreaterThan(20); expect(end).toBeGreaterThan(start)
    new Function('reservePhoneNotices', 'document', 'addEventListener', main.slice(start, end))(reservePhoneNotices, { querySelector: () => f.host, documentElement: f.root }, f.lifecycle.addEventListener.bind(f.lifecycle))
    const transition = (type: string, persisted: boolean) => { const event = new Event(type); Object.defineProperty(event, 'persisted', { value: persisted }); f.lifecycle.dispatchEvent(event) }
    for (let i = 0; i < 3; i++) {
      transition('pagehide', true)
      expect(f.host.dataset.phoneReserved).toBe('')
      expect(f.disconnected()).toBe(false)
      f.set(48 + i, 1); transition('pageshow', true)
      expect(f.styles.get('--phone-notice-height')).toBe(`${48 + i}px`)
      expect(f.attributes.has('data-phone-notices')).toBe(true)
    }
    transition('pagehide', false)
    expect(f.disconnected()).toBe(true)
    expect(f.host.dataset.phoneReserved).toBeUndefined()
    expect(f.styles.has('--phone-notice-height')).toBe(false)
    expect(f.remove.mock.calls.map(([type]) => type).sort()).toEqual(['pagehide', 'pageshow'])
    f.set(120, 1); transition('pageshow', true); f.resized(); f.changed()
    expect(f.styles.has('--phone-notice-height')).toBe(false)
  })

  it('reserves the whole visible stack and follows full, quiet and removed notices', () => {
    const f = fixture(); f.set(96.4, 1)
    const stop = reservePhoneNotices(f.host, f.root)
    expect(f.styles.get('--phone-notice-height')).toBe('97px')
    expect(f.attributes.has('data-phone-notices')).toBe(true)
    f.set(48.2, 1); f.resized()
    expect(f.styles.get('--phone-notice-height')).toBe('49px')
    f.set(146.5, 2); f.changed()
    expect(f.styles.get('--phone-notice-height')).toBe('147px')
    f.set(8, 0); f.changed()
    expect(f.styles.get('--phone-notice-height')).toBe('0px')
    expect(f.attributes.has('data-phone-notices')).toBe(false)
    stop()
  })

  it('does not reserve an empty rail gap and removes only its own observers and layout state', () => {
    const f = fixture(), stop = reservePhoneNotices(f.host, f.root)
    expect(f.styles.get('--phone-notice-height')).toBe('0px')
    expect(f.host.dataset.phoneReserved).toBe('')
    stop(); stop()
    expect(f.disconnected()).toBe(true)
    expect(f.styles.has('--phone-notice-height')).toBe(false)
    expect(f.attributes.has('data-phone-notices')).toBe(false)
    expect(f.host.dataset.phoneReserved).toBeUndefined()
    f.set(120, 1); f.resized(); f.changed()
    expect(f.styles.has('--phone-notice-height')).toBe(false)
  })
})

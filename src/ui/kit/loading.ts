import { DotLoader, DOT_LOADER_STYLE } from './dot-field'
import { ICONS } from '../icons'
import { setMarkup } from '../markup'

/** State owners mark a reserved host; the adapter owns its loader's mount, suspension and disposal. */
export function dotLoading(host: HTMLElement, busy: boolean, label = 'Working', size = 24) {
  if (host.dataset.dotLoading !== String(busy)) host.dataset.dotLoading = String(busy)
  if (host.dataset.dotLabel !== label) host.dataset.dotLabel = label
  if (host.dataset.dotSize !== String(size)) host.dataset.dotSize = String(size)
  if (host.getAttribute('aria-busy') !== String(busy)) host.setAttribute('aria-busy', String(busy))
}

/** Completed and failed checks leave a family glyph, while their explanation stays readable. */
export function dotState(host: HTMLElement, state: 'waiting' | 'working' | 'done' | 'failed', label: string) {
  const busy = state === 'waiting' || state === 'working'
  dotLoading(host, busy, label)
  host.querySelector('[data-dot-result]')?.remove()
  if (!busy) {
    const icon = document.createElement('span')
    icon.dataset.dotResult = state
    icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', label)
    setMarkup(icon, ICONS[state === 'done' ? 'check' : 'close'])
    host.prepend(icon)
  }
}

/** One observer per product document, including Link's family-styled popup and options. No idle polling. */
export function mountDotLoaders() {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(DOT_LOADER_STYLE + `.dot-wait-label{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;overflow:hidden!important;clip-path:inset(50%);white-space:nowrap}.dot-loading-slot{display:inline-flex;align-items:center;justify-content:center}.dot-loading-slot[data-dot-scene]>.dot-loader{visibility:hidden}`)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  const loaders = new Map<HTMLElement, DotLoader>()
  const thumbnails = new WeakSet<HTMLImageElement>()
  const visible = new Map<HTMLElement, boolean>()
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) visible.set(entry.target as HTMLElement, entry.isIntersecting)
    sync()
  })
  const sync = () => {
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-dot-thumbnail]')) if (!thumbnails.has(image)) {
      thumbnails.add(image); dotThumbnail(image, image.dataset.dotThumbnail || 'Opening preview', () => {
        const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); setMarkup(icon, ICONS.cube); image.replaceWith(icon)
      })
    }
    let moving = false
    for (const [host, loader] of loaders) if (!host.isConnected) { loader.destroy(); loader.el.remove(); loaders.delete(host); visibility.unobserve(host); visible.delete(host) }
    for (const host of document.querySelectorAll<HTMLElement>('[data-dot-loading]')) {
      let loader = loaders.get(host)
      const busy = host.dataset.dotLoading === 'true' && !host.hasAttribute('data-dot-scene')
      if (!loader && !busy) continue
      if (!loader) {
        loader = new DotLoader({ size: Number(host.dataset.dotSize) || 24, label: host.dataset.dotLabel })
        loaders.set(host, loader)
        visible.set(host, true); visibility.observe(host)
      }
      if (!host.contains(loader.el)) host.append(loader.el)
      const label = host.dataset.dotLabel || 'Working'
      if (loader.el.getAttribute('aria-label') !== label) loader.el.setAttribute('aria-label', label)
      if (loader.el.hidden === busy) loader.el.hidden = !busy
      const animate = busy && !moving && visible.get(host) && !host.hasAttribute('data-dot-static')
      if (animate) { loader.start(); moving = true } else loader.finish()
    }
  }
  const observer = new MutationObserver(records => {
    const relevant = records.some(record => record.type === 'attributes' || loaders.has(record.target as HTMLElement) ||
      record.removedNodes.length && [...loaders.keys()].some(host => !host.isConnected) ||
      [...record.addedNodes].some(node => node instanceof Element && (node.matches('[data-dot-loading],img[data-dot-thumbnail]') || node.querySelector('[data-dot-loading],img[data-dot-thumbnail]'))))
    if (relevant) sync()
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-dot-loading', 'data-dot-label', 'data-dot-scene', 'data-dot-static'] })
  sync()
  addEventListener('pagehide', () => { observer.disconnect(); visibility.disconnect(); loaders.forEach(loader => { loader.destroy(); loader.el.remove() }); loaders.clear(); visible.clear() })
  addEventListener('pageshow', event => { if (event.persisted) { observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-dot-loading', 'data-dot-label', 'data-dot-scene', 'data-dot-static'] }); sync() } })
}

/** Lazy thumbnails keep a fixed footprint; failures hand back to the caller's family glyph. */
export function dotThumbnail(image: HTMLImageElement, label: string, failed?: () => void) {
  const host = image.parentElement
  if (!host || image.complete) { if (image.complete && !image.naturalWidth) failed?.(); return }
  host.dataset.dotStatic = ''
  dotLoading(host, true, label, 20)
  const done = () => { dotLoading(host, false); image.removeEventListener('load', done); image.removeEventListener('error', error) }
  const error = () => { done(); failed?.() }
  image.addEventListener('load', done, { once: true })
  image.addEventListener('error', error, { once: true })
}

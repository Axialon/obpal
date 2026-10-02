/** The same standalone vector assets on the site, controller, Link and store surfaces. */
import { html } from './markup'

export const BRAND_MARK = new URL('../../public/logo-mark.svg', import.meta.url).href
export const BRAND_LOCKUP = new URL('../../public/brand/obpal-link-lockup.svg', import.meta.url).href
/** Native string templates in the extension reference exactly the same vector asset. */
export const LINK_LOGO = `<img class="brand-lockup" data-brand-link="true" src="${BRAND_LOCKUP}" alt="" width="172.5216" height="40">`
let watching = false
const light = () => document.documentElement?.dataset.bbTheme === 'light'
const source = (link: boolean) => BRAND_LOCKUP + (link ? light() ? '#light' : '' : light() ? '#base-light' : '#base')

/** Keep the wordmark legible on the visitor's surface; the mark and lime pill keep their brand colours. */
export function syncBrand(root: ParentNode = document) {
  watchBrand()
  for (const image of root.querySelectorAll<HTMLImageElement>('img.brand-lockup')) image.src = source(image.dataset.brandLink === 'true')
}

function watchBrand() {
  if (watching || typeof MutationObserver === 'undefined' || !document.documentElement) return
  watching = true
  new MutationObserver(() => syncBrand()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bb-theme'] })
}

export function brandLockup(link = false) {
  watchBrand()
  return html`<img class="brand-lockup" data-brand-link="${link}" src="${source(link)}" alt="" width="${link ? 172.5216 : 114.903}" height="40">`
}

export const brandMark = () => html`<img class="mark" src="${BRAND_MARK}" alt="">`

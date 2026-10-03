/** Inline the canonical vectors on themed surfaces; static exports keep their authored colours. */
import markSource from '../../public/logo-mark.svg?raw'
import lockupSource from '../../public/brand/obpal-link-lockup.svg?raw'
import { setMarkup } from './markup'

export const BRAND_MARK = new URL('../../public/logo-mark.svg', import.meta.url).href
export const BRAND_LOCKUP = new URL('../../public/brand/obpal-link-lockup.svg', import.meta.url).href
/** Native extension templates mount this placeholder through syncBrand. */
export const LINK_LOGO = `<img class="brand-lockup" data-brand-link="true" src="${BRAND_LOCKUP}" alt="" width="172.5216" height="40">`
let sequence = 0

/** Parse only the exact build-catalogued asset, then scope its paint servers to this instance. */
function vector(source: string, className: string) {
  const holder = document.createElement('div')
  setMarkup(holder, source)
  const svg = holder.firstElementChild as SVGSVGElement
  const prefix = `brand-${++sequence}-`
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  // Static fragment views and their fixed-colour lettering rules belong to the image exports.
  svg.querySelectorAll('view, style').forEach(el => el.remove())
  for (const el of svg.querySelectorAll<SVGElement>('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name === 'id') el.setAttribute('id', prefix + attr.value)
      else if (attr.value.includes('url(#')) el.setAttribute(attr.name, attr.value.replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`))
      else if (attr.value.toLowerCase() === '#c6ff34') {
        el.removeAttribute(attr.name)
        el.style.setProperty(attr.name, 'var(--bb-accent)')
      }
    }
  }
  return svg
}

export function brandLockup(link = false) {
  const svg = vector(lockupSource, 'brand-lockup')
  const width = link ? 172.5216 : 114.903
  svg.dataset.brandLink = String(link)
  svg.setAttribute('viewBox', `0 0 ${width} 40`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', '40')
  ;(svg.querySelector('.wordmark') as SVGElement).style.fill = 'var(--bb-ink)'
  ;(svg.querySelector('.brand-point path') as SVGElement).style.fill = 'var(--bb-accent-text)'
  for (const path of svg.querySelectorAll<SVGElement>('.link-label path')) path.style.fill = 'var(--bb-accent-text)'
  if (!link) svg.querySelectorAll('.link-label, rect').forEach(el => el.remove())
  return svg
}

export function brandMark() { return vector(markSource, 'mark') }

/** The family menu shares the same geometry and follows the page's live accent. */
export function familyBrandMark(opts?: { accent?: string; title?: boolean }) {
  const svg = brandMark()
  svg.setAttribute('class', 'bb-mark')
  if (opts?.accent) svg.style.setProperty('--bb-accent', opts.accent)
  if (opts?.title !== false) {
    svg.removeAttribute('aria-hidden')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', 'ob.Pal')
  }
  return svg
}

/** Replace native image placeholders once; CSS tokens handle subsequent theme and accent switches. */
export function syncBrand(root: ParentNode = document) {
  for (const image of root.querySelectorAll<HTMLImageElement>('img.brand-lockup')) image.replaceWith(brandLockup(image.dataset.brandLink === 'true'))
  for (const image of root.querySelectorAll<HTMLImageElement>('img.mark')) image.replaceWith(brandMark())
}

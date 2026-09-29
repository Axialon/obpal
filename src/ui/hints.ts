import { setMarkup, html } from './markup'
import { ICONS } from './icons'

type Place = 'top' | 'bottom' | 'left' | 'right'
const KEY = 'obpal.hint.'
const live = new Map<string, { el: HTMLElement; place: () => void }>()
/** One hint at a time: later ones wait here and show when the current one is dismissed. */
const queue: { id: string; show: () => void }[] = []
const visible = (t: Element | null) => !!t && !!(t as HTMLElement).offsetParent

/** Where hints measure: the viewport by default; the controller's own frame while its UI is counter-rotated. */
let frame = {
  rect: (el: Element): { left: number; top: number; width: number; height: number } => el.getBoundingClientRect(),
  size: () => ({ w: innerWidth, h: innerHeight }),
}
export function setHintFrame(f: typeof frame) { frame = f }

const seen = (id: string) => { try { return sessionStorage.getItem(KEY + id) === '1' } catch { return false } }
const markSeen = (id: string) => { try { sessionStorage.setItem(KEY + id, '1') } catch { /* private mode */ } }

/**
 * A glass coach-mark that points at an element. Closing it (or calling dismissHint) hides it
 * for the rest of this browser session. Only one shows at a time; while its element is hidden
 * (another mode, a closed panel) it steps out of the way and comes back with it.
 */
export function hint(id: string, anchor: () => Element | null, text: string, opts: { place?: Place; delay?: number; mount?: HTMLElement; gap?: number } = {}) {
  if (seen(id) || live.has(id)) return
  const show = () => {
    const target = anchor()
    if (seen(id) || live.has(id) || !visible(target)) return
    if ([...live.values()].some((h) => h.el.parentElement === (opts.mount ?? document.body))) { if (!queue.some((q) => q.id === id)) queue.push({ id, show }); return }
    const place = opts.place ?? 'bottom'
    const el = document.createElement('div')
    el.className = `hint hint-${place}`
    el.setAttribute('role', 'status')
    setMarkup(el, html`<span class="hint-text"></span><button class="hint-x" aria-label="Dismiss hint">${ICONS.close}</button>`)
    el.querySelector('.hint-text')!.textContent = text
    el.querySelector('button')!.onclick = (e) => { e.stopPropagation(); dismissHint(id) }
    ;(opts.mount ?? document.body).appendChild(el)
    const position = () => {
      const t = anchor()
      el.classList.toggle('away', !visible(t))
      if (!t || !visible(t)) return
      const r = opts.mount ? t.getBoundingClientRect() : frame.rect(t)
      const b = opts.mount ? el.getBoundingClientRect() : frame.rect(el)
      const { w: vw, h: vh } = opts.mount ? { w: innerWidth, h: innerHeight } : frame.size()
      const gap = opts.gap ?? 12
      let x = 0
      let y = 0
      if (place === 'top' || place === 'bottom') {
        x = Math.min(vw - b.width - 12, Math.max(12, r.left + r.width / 2 - b.width / 2))
        y = place === 'top' ? r.top - b.height - gap : r.top + r.height + gap
        el.style.setProperty('--arrow', `${r.left + r.width / 2 - x}px`)
      } else {
        y = Math.min(vh - b.height - 12, Math.max(12, r.top + r.height / 2 - b.height / 2))
        x = place === 'left' ? r.left - b.width - gap : r.left + r.width + gap
        el.style.setProperty('--arrow', `${r.top + r.height / 2 - y}px`)
      }
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
    position()
    requestAnimationFrame(() => el.classList.add('in'))
    addEventListener('resize', position)
    live.set(id, { el, place: position })
  }
  setTimeout(show, opts.delay ?? 0)
}

/** Hide a hint now and for the rest of the session (e.g. once the user has done the thing it suggests). */
export function dismissHint(id: string) {
  markSeen(id)
  const h = live.get(id)
  if (!h) return
  live.delete(id)
  removeEventListener('resize', h.place)
  h.el.classList.remove('in')
  setTimeout(() => h.el.remove(), 260)
  const next = queue.shift()
  if (next) setTimeout(next.show, 700)
}

export function repositionHints() {
  for (const h of live.values()) h.place()
}

/**
 * The pairing chip <obpal-remote> shows, for now: a corner pill (the mark, "Scan to control", a status dot) that opens
 * to the QR code and closes once a phone is in. Its options and methods are those of the host-branded PairingChip
 * (PLAN §10 step 3), which replaces it here and nowhere else.
 */
import type { Remote } from './remote'

export interface ChipOptions {
  remote: Remote
  /** A corner of the window (fixed), or inline: wherever `parent` puts it. */
  corner?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'inline'
  /** A CSS colour for the dot, the mark and the focus ring. */
  accent?: string
  /** Start open (showing the code). */
  open?: boolean
  label?: string
  /** Where the chip goes (default document.body). */
  parent?: HTMLElement | ShadowRoot
  /** The inset from the corner. */
  offset?: string
  scheme?: 'auto' | 'light' | 'dark'
  /** The short code beside the QR code (the host-branded chip). */
  code?: boolean
  /** A link that opens the controller on this device. */
  testLink?: boolean
  onToggle?: (open: boolean) => void
}

export interface Chip {
  readonly el: HTMLElement
  readonly expanded: boolean
  expand(): void
  collapse(): void
  toggle(): void
  /** Read the page's look again. */
  refresh(): void
  destroy(): void
}

const MARK = `<svg class="mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
<ellipse class="orbit" cx="50" cy="57" rx="47" ry="15" transform="rotate(-14 50 57)"/>
<polygon class="cube" points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4"/>
<polygon class="lid" points="50,19 78,34.4 50,49.8 22,34.4"/>
<path class="edge" d="M22,34.4 L50,49.8 L78,34.4"/>
<path class="ring" d="M95.6 45.63 A47 15 -14 0 1 4.4 68.37"/>
<circle class="sat" cx="82.1" cy="60.8" r="5.4"/>
</svg>`

const CSS = `
:host{all:initial;display:contents;font-family:var(--obpal-font,inherit)}
.wrap{--_accent:var(--obpal-accent,#c6ff34);--_bg:rgb(12 14 22 / .8);--_ink:#eef2f8;--_muted:#9aa6b8;--_line:rgb(255 255 255 / .14);--_plate:#fff;
 position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:10px;align-items:flex-end;
 font-size:14px;line-height:1.3;color:var(--_ink);-webkit-font-smoothing:antialiased}
.wrap[data-scheme=light]{--_bg:rgb(255 255 255 / .84);--_ink:#10131a;--_muted:#5b6576;--_line:rgb(10 20 40 / .12)}
@media (prefers-color-scheme:light){.wrap[data-scheme=auto]{--_bg:rgb(255 255 255 / .84);--_ink:#10131a;--_muted:#5b6576;--_line:rgb(10 20 40 / .12)}}
.wrap[data-corner=bottom-right]{right:var(--_offset,16px);bottom:var(--_offset,16px)}
.wrap[data-corner=bottom-left]{left:var(--_offset,16px);bottom:var(--_offset,16px);align-items:flex-start}
.wrap[data-corner=top-right]{right:var(--_offset,16px);top:var(--_offset,16px);flex-direction:column-reverse}
.wrap[data-corner=top-left]{left:var(--_offset,16px);top:var(--_offset,16px);flex-direction:column-reverse;align-items:flex-start}
.wrap[data-corner=inline]{position:relative;z-index:auto;display:inline-flex;align-items:flex-start}
.chip{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:10px;height:44px;padding:0 16px 0 6px;border-radius:999px;cursor:pointer;
 font:inherit;font-weight:650;color:var(--_ink);transition:transform .16s ease}
.glass{background:var(--_bg);border:1px solid var(--_line);box-shadow:0 18px 48px rgb(0 0 0 / .28),inset 0 1px 0 rgb(255 255 255 / .12);
 backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%)}
.chip:hover{transform:translateY(-1px)}
.chip:focus-visible,.self:focus-visible{outline:2px solid var(--_accent);outline-offset:3px}
.badge{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#07080c;border:1px solid rgb(255 255 255 / .16)}
.mark{width:26px;height:26px;display:block}
.mark .orbit{fill:none;stroke:var(--_accent);stroke-width:3;opacity:.3}
.mark .cube{fill:#050505;stroke:rgb(255 255 255 / .4);stroke-width:1.3;stroke-linejoin:round}
.mark .lid{fill:#2a2a2a}
.mark .edge{fill:none;stroke:var(--_accent);stroke-width:2.6;stroke-linejoin:round}
.mark .ring{fill:none;stroke:var(--_accent);stroke-width:4;stroke-linecap:round}
.mark .sat{fill:var(--_accent)}
.label{white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--_muted);flex:none}
.dot[data-s=ready]{background:var(--_accent);animation:pulse 1.6s ease-in-out infinite}
.dot[data-s=connecting]{background:#fcd34d}
.dot[data-s=connected]{background:#6ee7b7}
.dot[data-s=offline]{background:#fb7185}
.card{box-sizing:border-box;width:216px;padding:14px;border-radius:24px;display:flex;flex-direction:column;align-items:center;gap:10px;
 transform-origin:bottom right;transition:opacity .18s ease,transform .18s ease}
.wrap[data-corner$=left] .card{transform-origin:bottom left}
.wrap[data-corner^=top] .card{transform-origin:top right}
.wrap[data-corner=top-left] .card{transform-origin:top left}
.card[hidden]{display:none}
.card.in{opacity:0;transform:scale(.92)}
.qr{width:184px;height:184px;box-sizing:border-box;padding:8px;border-radius:16px;background:var(--_plate)}
.qr svg{display:block;width:100%;height:100%}
.how{margin:0;font-size:13px;color:var(--_muted);text-align:center}
.self{font-size:12px;font-weight:600;color:var(--_muted);text-decoration:none}
.self:hover{color:var(--_ink)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none!important}.card,.chip{transition:none}}`

/** One constructed stylesheet for every chip (CSP-safe without 'unsafe-inline'), or a <style> where there are none. */
let sheet: CSSStyleSheet | null = null
function style(root: ShadowRoot) {
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS) }
    root.adoptedStyleSheets = [sheet]
    return
  }
  const s = document.createElement('style')
  s.textContent = CSS
  root.appendChild(s)
}

export function createChip(o: ChipOptions): Chip {
  const { remote } = o
  const el = document.createElement('div')
  el.className = 'obpal-chip'
  const root = el.attachShadow({ mode: 'open' })
  style(root)
  const wrap = document.createElement('div')
  wrap.className = 'wrap'
  wrap.dataset.corner = o.corner ?? 'bottom-right'
  wrap.dataset.scheme = o.scheme ?? 'auto'
  wrap.innerHTML = `
    <div class="card glass" id="card" role="group" aria-label="Pair your phone" hidden>
      <div class="qr" role="img" aria-label="QR code: scan it with your phone to control this page"></div>
      <p class="how">Scan with your phone</p>
      ${o.testLink ? '<a class="self" target="_blank" rel="noopener">Open on this device ↗</a>' : ''}
    </div>
    <button class="chip glass" type="button" aria-expanded="false" aria-controls="card"><span class="badge">${MARK}</span><span class="label"></span><span class="dot"></span></button>
    <span class="sr" aria-live="polite"></span>`
  root.appendChild(wrap)
  if (o.accent) el.style.setProperty('--obpal-accent', o.accent)
  if (o.offset) wrap.style.setProperty('--_offset', o.offset)
  ;(o.parent ?? document.body).appendChild(el)

  const card = wrap.querySelector<HTMLElement>('.card')!
  const button = wrap.querySelector<HTMLButtonElement>('.chip')!
  const qr = wrap.querySelector<HTMLElement>('.qr')!
  const self = wrap.querySelector<HTMLAnchorElement>('.self')
  const label = o.label ?? 'Scan to control'
  let open = false
  let dead = false
  let drawn = ''

  const draw = () => {
    if (dead) return
    const n = remote.participants.length
    const s = remote.status
    const text = s === 'connected' ? (n > 1 ? `${n} connected` : 'Connected') : s === 'connecting' ? 'Connecting…' : s === 'offline' ? 'Offline' : label
    button.querySelector('.label')!.textContent = text
    button.querySelector<HTMLElement>('.dot')!.dataset.s = s
    wrap.querySelector('.sr')!.textContent = s === 'ready' ? '' : text
    if (open && drawn !== remote.pairingUrl) {
      const url = remote.pairingUrl
      drawn = url
      if (self) self.href = url
      void import('uqr').then(({ renderSVG }) => { if (!dead && drawn === url) qr.innerHTML = renderSVG(url, { border: 2, ecc: 'M' }) })
    }
  }
  const set = (on: boolean, tell = true) => {
    if (dead || on === open) return
    open = on
    button.setAttribute('aria-expanded', String(on))
    card.hidden = !on
    if (on) {
      // Grow from the chip: start small and clear, then settle on the next frame.
      card.classList.add('in')
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove('in')))
    }
    draw()
    if (tell) o.onToggle?.(on)
  }

  button.addEventListener('click', () => set(!open))
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { set(false); button.focus() } })
  remote.on('status', draw).on('join', draw).on('leave', draw)
  // Once a phone is in, the code steps aside; the chip says who is connected.
  remote.on('connect', () => set(false))
  if (o.open && remote.status !== 'connected') set(true, false)
  draw()

  return {
    el,
    get expanded() { return open },
    expand: () => set(true),
    collapse: () => set(false),
    toggle: () => set(!open),
    refresh: draw,
    destroy() {
      dead = true
      el.remove()
    },
  }
}

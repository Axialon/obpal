/**
 * Floating glass tooltips for any [data-tip] element. The tip lives on <body>, so it is never
 * clipped by panels; it shows after a short delay, then instantly while moving between icons.
 * Placement: data-tip-side="right|left|top|bottom" (default: below, or above near the bottom edge).
 */
export function initTips() {
  if (typeof matchMedia === 'undefined' || !matchMedia('(hover: hover)').matches) return
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  let target: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let cool: ReturnType<typeof setTimeout> | undefined
  let warm = false

  const place = () => {
    if (!target) return
    const r = target.getBoundingClientRect()
    const b = tip.getBoundingClientRect()
    const side = target.dataset.tipSide ?? (r.bottom > innerHeight - 80 ? 'top' : 'bottom')
    let x = r.left + r.width / 2 - b.width / 2
    let y = r.bottom + 10
    if (side === 'top') y = r.top - b.height - 10
    if (side === 'right' || side === 'left') {
      y = r.top + r.height / 2 - b.height / 2
      x = side === 'right' ? r.right + 12 : r.left - b.width - 12
    }
    tip.dataset.side = side
    tip.style.left = `${Math.min(innerWidth - b.width - 8, Math.max(8, x))}px`
    tip.style.top = `${Math.min(innerHeight - b.height - 8, Math.max(8, y))}px`
  }
  const show = (el: HTMLElement) => {
    target = el
    tip.textContent = el.dataset.tip ?? ''
    place()
    tip.classList.add('in')
    warm = true
    clearTimeout(cool)
  }
  const hide = () => {
    clearTimeout(timer)
    target = null
    tip.classList.remove('in')
    clearTimeout(cool)
    cool = setTimeout(() => { warm = false }, 450)
  }

  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null
    if (el === target) return
    clearTimeout(timer)
    if (!el || !el.dataset.tip) { if (target) hide(); return }
    timer = setTimeout(() => show(el), warm ? 0 : 320)
  })
  document.addEventListener('pointerdown', hide, true)
  addEventListener('blur', hide)
  addEventListener('scroll', hide, true)
  document.addEventListener('focusin', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null
    if (el && (e.target as HTMLElement).matches(':focus-visible')) show(el)
  })
  document.addEventListener('focusout', hide)
}

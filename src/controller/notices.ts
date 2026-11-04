/** Reserve phone layout space without changing the shared notice content or lifetime. */
export function reservePhoneNotices(host: HTMLElement | null, root: HTMLElement): () => void {
  if (!host) return () => {}
  let active = true, previous = -1
  host.dataset.phoneReserved = ''
  const update = () => {
    if (!active) return
    // Layout height stays correct when the phone's locked frame rotates; an empty rail's gap reserves nothing.
    const height = host.querySelector('.nt-item') ? Math.ceil(host.offsetHeight) : 0
    if (height === previous) return
    previous = height
    root.style.setProperty('--phone-notice-height', `${height}px`)
    root.toggleAttribute('data-phone-notices', height > 0)
  }
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
  resize?.observe(host)
  const contents = new MutationObserver(update)
  contents.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-quiet'] })
  const view = window
  const hide = (event: PageTransitionEvent) => { if (!event.persisted) stop() }
  const show = (event: PageTransitionEvent) => { if (event.persisted) { previous = -1; update() } }
  const stop = () => {
    if (!active) return
    active = false
    resize?.disconnect(); contents.disconnect()
    view.removeEventListener('pagehide', hide)
    view.removeEventListener('pageshow', show)
    delete host.dataset.phoneReserved
    root.style.removeProperty('--phone-notice-height')
    root.removeAttribute('data-phone-notices')
  }
  view.addEventListener('pagehide', hide)
  view.addEventListener('pageshow', show)
  update()
  return stop
}

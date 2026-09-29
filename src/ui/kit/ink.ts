/**
 * Fit a control's text to its visible glyphs. Cap trimming alone misses descenders ("Try it"), accents and side
 * bearings. The shared label uses the loaded font's metrics for those edges; it never stores a button-specific nudge.
 */
const controls = 'button, a.kit-action, a.kit-cta, a.dcard-go, a.sim-crumb, .kit-chip, .arm-badge, .sim-badge'
const skip = 'svg, kbd, sup, .kit-sr, .quick-tray, .quick-tab, .bb-menu, .bb-header'

export function fitControlInk(root: HTMLElement = document.body) {
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!
  const cache = new Map<string, Record<string, number>>()
  const baselines = new Map<string, { baseline: number; height: number }>()
  const pending = new Set<HTMLElement>()
  const observed = new WeakSet<HTMLElement>()
  let frame = 0, active = true
  // Content-visibility can defer an offscreen card's SVG geometry until it approaches the viewport.
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) pending.add(entry.target as HTMLElement)
    if (pending.size && !frame) frame = requestAnimationFrame(flush)
  }, { rootMargin: '100px' })
  const labels = (button: HTMLElement) => {
    for (const svg of button.querySelectorAll<SVGSVGElement>('svg')) {
      const view = svg.viewBox.baseVal, bounds = svg.getBBox()
      if (!view.width || !bounds.width || !bounds.height) continue
      const style = getComputedStyle(svg)
      svg.style.translate = `${100 * (view.x + view.width / 2 - bounds.x - bounds.width / 2) / view.width}% ${100 * (view.y + view.height / 2 - bounds.y - bounds.height / 2) / view.height}%`
      if ((svg.parentElement === button || svg.parentElement?.matches('.kit-select-chev, .kit-select-ic')) && style.backgroundColor === 'rgba(0, 0, 0, 0)' && !parseFloat(style.paddingLeft)) {
        const gutter = parseFloat(style.width) * (1 - bounds.width / view.width) / 2
        svg.style.marginInline = `${-gutter}px`
      }
      if (svg.parentElement === button && getComputedStyle(button).flexDirection === 'column') {
        svg.style.marginBlock = `${-parseFloat(style.height) * (1 - bounds.height / view.height) / 2}px`
      } else if (svg.parentElement === button) svg.style.removeProperty('margin-block')
    }
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT), nodes: Text[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (node.textContent?.trim() && !node.parentElement?.closest(skip)) nodes.push(node)
    }
    for (const node of nodes) {
      let label = node.parentElement!
      if (!label.classList.contains('kit-ink')) {
        if (label.tagName === 'SPAN' && !label.children.length && !label.matches(controls)) label.classList.add('kit-ink')
        else {
          label = document.createElement('span'); label.className = 'kit-ink'
          node.replaceWith(label); label.append(node)
        }
      }
      delete label.dataset.inkLines
      const style = getComputedStyle(label)
      if (style.fontSize === '0px') continue
      let text = node.textContent ?? ''
      if (style.textTransform === 'uppercase') text = text.toUpperCase()
      if (style.textTransform === 'lowercase') text = text.toLowerCase()
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const key = `${font}|${style.letterSpacing}|${text}`
      let metrics = cache.get(key)
      if (!metrics) {
        context.font = font; context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing
        const ink = context.measureText(text)
        let line = baselines.get(font)
        if (!line) {
          const probe = document.createElement('span'), marker = document.createElement('i')
          probe.style.cssText = `position:fixed;left:-10000px;top:0;display:inline-block;font:${font};line-height:1;white-space:pre`
          marker.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;vertical-align:baseline'
          probe.append('Hg', marker); document.body.append(probe)
          const box = probe.getBoundingClientRect()
          line = { baseline: marker.getBoundingClientRect().top - box.top, height: box.height }
          baselines.set(font, line); probe.remove()
        }
        metrics = { ascent: ink.actualBoundingBoxAscent, descent: ink.actualBoundingBoxDescent,
          left: ink.actualBoundingBoxLeft, right: ink.actualBoundingBoxRight - ink.width,
          top: ink.actualBoundingBoxAscent - line.baseline, bottom: ink.actualBoundingBoxDescent - (line.height - line.baseline) }
        cache.set(key, metrics)
      }
      for (const [name, value] of Object.entries(metrics)) label.style.setProperty(`--ink-${name}`, `${value}px`)
      // A wrapped label hugs its longest rendered line, so empty line-box width cannot pull its icon off centre.
      const range = document.createRange(); range.selectNodeContents(node)
      const lines = [...range.getClientRects()]
      if (lines.length > 1 && style.whiteSpace !== 'nowrap') {
        label.style.setProperty('--ink-width', `${Math.max(...lines.map(line => line.width))}px`)
        label.dataset.inkLines = 'true'
      }
    }
  }
  const scan = (node: HTMLElement | null) => {
    if (!node?.isConnected) return
    const add = (button: HTMLElement) => {
      if (button.closest(skip)) return
      // Some dialogs reuse the status class for ordinary prose, without a chip's painted boundary.
      if (button.matches('.sim-badge')) {
        const style = getComputedStyle(button)
        if (style.backgroundColor === 'rgba(0, 0, 0, 0)' && !parseFloat(style.borderWidth) && style.boxShadow === 'none') return
      }
      pending.add(button)
      if (!observed.has(button)) { observed.add(button); visibility.observe(button) }
    }
    const button = node.closest<HTMLElement>(controls)
    if (button) add(button)
    for (const el of node.querySelectorAll<HTMLElement>(controls)) add(el)
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if ((record.target as Element).getAttribute(record.attributeName!) !== record.oldValue) scan(record.target as HTMLElement)
      }
      else if (record.type === 'characterData') scan(record.target.parentElement)
      else {
        for (const node of record.removedNodes) if (node instanceof HTMLElement && !node.isConnected) {
          for (const el of [node, ...node.querySelectorAll<HTMLElement>(controls)]) { visibility.unobserve(el); observed.delete(el); pending.delete(el) }
        }
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) scan(node)
          else if (node.nodeType === Node.TEXT_NODE) scan(node.parentElement)
        }
      }
    }
    if (pending.size && !frame) frame = requestAnimationFrame(flush)
  })
  const watch = () => observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'class', 'aria-expanded'] })
  function flush() {
    frame = 0; observer.disconnect()
    for (const button of pending) if (button.isConnected) labels(button)
    pending.clear(); watch()
  }
  void document.fonts.ready.then(() => { if (active) { scan(root); flush() } })
  const refresh = () => { cache.clear(); baselines.clear(); scan(root); if (!frame) frame = requestAnimationFrame(flush) }
  const resize = new ResizeObserver(() => { scan(root); if (!frame) frame = requestAnimationFrame(flush) })
  resize.observe(root)
  document.fonts.addEventListener('loadingdone', refresh)
  addEventListener('resize', refresh)
  return () => { active = false; observer.disconnect(); resize.disconnect(); visibility.disconnect(); cancelAnimationFrame(frame); document.fonts.removeEventListener('loadingdone', refresh); removeEventListener('resize', refresh) }
}

/**
 * Fit a control's text to its visible glyphs. Cap trimming alone misses descenders ("Try it"), accents and side
 * bearings. The shared label uses the loaded font's metrics for those edges; it never stores a button-specific nudge.
 */
import inkCss from '../../styles/ink.css?inline'
import '../../styles/ink.css'

const controls = 'button, [role="button"], a.kit-action, a.kit-cta, a.dcard-go, a.sim-crumb, a.btn, .top-nav a, .page-top nav a, .kit-chip, .arm-badge, .sim-badge, .tag, .count, .fact'
const skip = 'svg, kbd, sup, .kit-sr, .bb-header'
const fitted = new WeakMap<HTMLElement | ShadowRoot, () => void>()

export function fitControlInk(root: HTMLElement | ShadowRoot = document.body, opts: { defer?: (fn: () => void) => number; cancel?: (id: number) => void } = {}) {
  const existing = fitted.get(root)
  if (existing) return existing
  if (root instanceof ShadowRoot) {
    const sheet = new CSSStyleSheet(); sheet.replaceSync(inkCss)
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  }
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!
  const cache = new Map<string, Record<string, number>>()
  const baselines = new Map<string, { baseline: number; height: number }>()
  const pending = new Set<HTMLElement>()
  const observed = new WeakSet<HTMLElement>()
  let frame = 0, active = true
  const defer = opts.defer ?? requestAnimationFrame
  const cancel = opts.cancel ?? cancelAnimationFrame
  // Content-visibility can defer an offscreen card's SVG geometry until it approaches the viewport.
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) pending.add(entry.target as HTMLElement)
    if (pending.size && !frame) frame = defer(flush)
  }, { rootMargin: '100px' })
  const labels = (button: HTMLElement) => {
    for (const svg of button.querySelectorAll<SVGSVGElement>('svg')) {
      const view = svg.viewBox.baseVal, bounds = svg.getBBox()
      if (!view.width || !bounds.width || !bounds.height) continue
      const style = getComputedStyle(svg)
      svg.style.translate = `${100 * (view.x + view.width / 2 - bounds.x - bounds.width / 2) / view.width}% ${100 * (view.y + view.height / 2 - bounds.y - bounds.height / 2) / view.height}%`
      const owner = svg.parentElement === button ? svg : svg.parentElement?.matches('.kit-select-chev, .kit-select-ic, .kit-seg-ic, .ctl-tab-ic, .gp-chip-ic, .gp-scope-ic') ? svg.parentElement : null
      const surface = owner && getComputedStyle(owner)
      const trim = surface && surface.backgroundColor === 'rgba(0, 0, 0, 0)' && surface.backgroundImage === 'none' && surface.boxShadow === 'none' && !parseFloat(surface.borderTopWidth) && !parseFloat(surface.paddingLeft)
      if (owner && trim) {
        const gutter = parseFloat(style.width) * (1 - bounds.width / view.width) / 2
        if (owner !== svg) svg.style.removeProperty('margin-inline')
        owner.style.marginInline = `${-gutter}px`
      } else if (owner) owner.style.removeProperty('margin-inline')
      const layout = getComputedStyle(button), column = layout.flexDirection === 'column' || layout.display.includes('grid') && layout.gridAutoFlow !== 'column'
      if (owner && trim && column) {
        if (owner !== svg) svg.style.removeProperty('margin-block')
        owner.style.marginBlock = `${-parseFloat(style.height) * (1 - bounds.height / view.height) / 2}px`
      } else if (owner) owner.style.removeProperty('margin-block')
    }
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT), nodes: Text[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (node.textContent?.trim() && !node.parentElement?.closest(skip)) nodes.push(node)
    }
    for (const node of nodes) {
      let label = node.parentElement!
      if (!label.classList.contains('kit-ink')) {
        const painted = label.matches('.badge, .kit-select-badge, .panel-badge, .sims-filters-n, .ns-count b, .sel-thumb, .person')
        if (painted) label.classList.add('kit-ink-box')
        if (!painted && /^(SPAN|B|SMALL|EM|I)$/.test(label.tagName) && !label.children.length && !label.matches(controls)) label.classList.add('kit-ink')
        else {
          label = document.createElement('span'); label.className = 'kit-ink'
          node.replaceWith(label); label.append(node)
        }
      }
      delete label.dataset.inkLines
      const style = getComputedStyle(label)
      if (style.fontSize === '0px') continue
      let text = node.textContent ?? ''
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      // The seal can shorten the screen-name slot. Fit the visible prefix, including the ellipsis's own edges.
      if (label.classList.contains('host-t') && style.textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth) {
        context.font = font; context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing
        const limit = label.getBoundingClientRect().right - context.measureText('…').width
        const range = document.createRange()
        let end = 0
        for (; end < node.length; end++) {
          range.setStart(node, end); range.setEnd(node, end + 1)
          if (range.getBoundingClientRect().right > limit) break
        }
        text = text.slice(0, end) + '…'
      }
      if (style.textTransform === 'uppercase') text = text.toUpperCase()
      if (style.textTransform === 'lowercase') text = text.toLowerCase()
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
        // The first line's ascent and the last line's descent bound a wrapped label, rather than the whole string's.
        const rendered = new Map<string, { start: number; end: number }>()
        for (let i = 0; i < node.length; i++) {
          if (/\s/.test(node.data[i])) continue
          range.setStart(node, i); range.setEnd(node, i + 1)
          const key = range.getBoundingClientRect().y.toFixed(3), line = rendered.get(key)
          if (line) line.end = i + 1
          else rendered.set(key, { start: i, end: i + 1 })
        }
        const edges = [...rendered.values()]
        if (edges.length) {
          context.font = font; context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing
          const first = context.measureText(text.slice(edges[0].start, edges[0].end)), last = context.measureText(text.slice(edges.at(-1)!.start, edges.at(-1)!.end))
          label.style.setProperty('--ink-ascent', `${first.actualBoundingBoxAscent}px`)
          label.style.setProperty('--ink-descent', `${last.actualBoundingBoxDescent}px`)
          const line = baselines.get(font)!
          label.style.setProperty('--ink-top', `${first.actualBoundingBoxAscent - line.baseline}px`)
          label.style.setProperty('--ink-bottom', `${last.actualBoundingBoxDescent - (line.height - line.baseline)}px`)
        }
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
    for (const el of [node, ...node.querySelectorAll<HTMLElement>('*')]) if (el.shadowRoot) fitControlInk(el.shadowRoot)
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
          if (node instanceof Element) scan(node instanceof HTMLElement ? node : node.parentElement)
          else if (node.nodeType === Node.TEXT_NODE) scan(node.parentElement)
        }
      }
    }
    if (pending.size && !frame) frame = defer(flush)
  })
  const watch = () => observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'class', 'aria-expanded'] })
  function flush() {
    frame = 0; observer.disconnect()
    for (const button of pending) if (button.isConnected) labels(button)
    pending.clear(); watch()
  }
  const scanRoot = () => {
    if (root instanceof HTMLElement) scan(root)
    else for (const el of root.children) if (el instanceof HTMLElement) scan(el)
  }
  void document.fonts.ready.then(() => { if (active) { scanRoot(); flush() } })
  const refresh = () => { cache.clear(); baselines.clear(); scanRoot(); if (!frame) frame = defer(flush) }
  const resize = new ResizeObserver(() => { scanRoot(); if (!frame) frame = defer(flush) })
  resize.observe(root instanceof ShadowRoot ? root.host : root)
  document.fonts.addEventListener('loadingdone', refresh)
  addEventListener('resize', refresh)
  const release = () => { active = false; fitted.delete(root); observer.disconnect(); resize.disconnect(); visibility.disconnect(); cancel(frame); document.fonts.removeEventListener('loadingdone', refresh); removeEventListener('resize', refresh) }
  fitted.set(root, release)
  return release
}

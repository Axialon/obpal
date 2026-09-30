/** Browser-side ink measurement. Text uses the loaded font's actual glyph bounds, not its line box. */
export function measureButtonInk({ surfaces = false } = {}) {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')
  const baselines = new Map()
  const box = r => ({ x: r.x, y: r.y, width: r.width, height: r.height })
  const union = boxes => boxes.length ? { x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)),
    width: Math.max(...boxes.map(b => b.x + b.width)) - Math.min(...boxes.map(b => b.x)),
    height: Math.max(...boxes.map(b => b.y + b.height)) - Math.min(...boxes.map(b => b.y)) } : null
  const centre = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const offset = (a, b) => { const x = centre(a), y = centre(b); return { x: x.x - y.x, y: x.y - y.y } }
  const rendered = el => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    const s = getComputedStyle(el), r = el.getBoundingClientRect()
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).clipPath !== 'none') return false
    return s.clipPath === 'none' && r.width > 1 && r.height > 1
  }
  const visible = el => {
    if (!rendered(el)) return false
    if (el.matches('.sim-badge')) {
      const s = getComputedStyle(el)
      if (s.backgroundColor === 'rgba(0, 0, 0, 0)' && !parseFloat(s.borderWidth) && s.boxShadow === 'none') return false
    }
    const r = el.getBoundingClientRect()
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p === document.body || p === document.documentElement) break
      const ps = getComputedStyle(p), pr = p.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(ps.overflowY) && (r.bottom <= pr.top || r.top >= pr.bottom)) return false
      if (/(auto|scroll|hidden|clip)/.test(ps.overflowX) && (r.right <= pr.left || r.left >= pr.right)) return false
    }
    return true
  }
  function ink(node) {
    const el = node.parentElement
    if (!el || el.closest('svg, .kit-sr, sup, kbd' + (surfaces ? ', .ctl-mark, .hw-badges' : '')) || !rendered(el) || !node.textContent.trim()) return []
    const s = getComputedStyle(el), font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
    let clipLeft = -Infinity, clipRight = Infinity, ellipsis = false
    if (surfaces) for (let p = el; p && p !== document.body; p = p.parentElement) {
      // A scroller can reveal the rest of a button later. Only its label's own clipping trims its glyphs here.
      if (p.matches('button, [role="button"], a.btn, a.kit-action, a.kit-cta')) break
      const style = getComputedStyle(p), rect = p.getBoundingClientRect()
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
        clipLeft = Math.max(clipLeft, rect.left); clipRight = Math.min(clipRight, rect.right)
        if (style.textOverflow === 'ellipsis' && p.scrollWidth > p.clientWidth) ellipsis = true
      }
    }
    // A zero-height inline marker finds the alphabetic baseline without assuming the engine's line metrics.
    if (!baselines.has(font)) {
      const probe = document.createElement('span'), marker = document.createElement('i'), t = document.createTextNode('Hg')
      probe.style.cssText = `position:fixed;left:-10000px;top:0;font:${font};line-height:normal;white-space:pre`
      marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline'
      probe.append(t, marker); document.body.append(probe)
      const range = document.createRange(); range.selectNodeContents(t)
      baselines.set(font, marker.getBoundingClientRect().top - range.getBoundingClientRect().top)
      probe.remove()
    }
    const text = node.textContent, lines = new Map(), range = document.createRange()
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue
      range.setStart(node, i); range.setEnd(node, i + 1)
      const r = range.getBoundingClientRect()
      if (!r.width) continue
      const key = r.y.toFixed(3), line = lines.get(key)
      if (line) { line.end = i + 1; line.right = r.right }
      else lines.set(key, { start: i, end: i + 1, x: r.x, y: r.y, right: r.right })
    }
    ctx.font = font
    ctx.letterSpacing = s.letterSpacing === 'normal' ? '0px' : s.letterSpacing
    return [...lines.values()].map(line => {
      let label = text.slice(line.start, line.end)
      if (s.textTransform === 'uppercase') label = label.toUpperCase()
      if (s.textTransform === 'lowercase') label = label.toLowerCase()
      // Ranges include the hidden tail of an ellipsised label. Measure the prefix the browser actually paints.
      if (ellipsis && line.right > clipRight) {
        const limit = clipRight - ctx.measureText('…').width
        let end = line.start
        for (; end < line.end; end++) {
          range.setStart(node, end); range.setEnd(node, end + 1)
          if (range.getBoundingClientRect().right > limit) break
        }
        label = label.slice(0, end - line.start) + '…'
      }
      const m = ctx.measureText(label)
      // Canvas has no numeric-feature setting. Preserve the DOM's tabular advances between glyphs.
      const advance = !ellipsis && /tabular-nums/.test(s.fontVariantNumeric) ? line.right - line.x - m.width : 0
      const edgeAdvance = index => {
        range.setStart(node, index); range.setEnd(node, index + 1)
        return range.getBoundingClientRect().width - ctx.measureText(text[index]).width
      }
      const first = advance ? edgeAdvance(line.start) / 2 : 0, last = advance ? edgeAdvance(line.end - 1) / 2 : 0
      const left = Math.max(clipLeft, line.x - m.actualBoundingBoxLeft + first), right = Math.min(clipRight, line.x + m.actualBoundingBoxRight + advance - last)
      return { x: left, y: line.y + baselines.get(font) - m.actualBoundingBoxAscent,
        width: Math.max(0, right - left), height: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) }
    }).filter(b => b.width > 0 && b.height > 0)
  }
  const roots = [document]
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
  const selector = 'button, [role="button"], a.kit-action, a.kit-cta, a.dcard-go, a.sim-crumb, .kit-chip, .arm-badge, .sim-badge' + (surfaces ? ', a.btn, .top-nav a, .page-top nav a, .tag, .count, .fact' : '')
  return roots.flatMap(root => [...root.querySelectorAll(selector)]).filter(visible).map((el, index) => {
    const button = box(el.getBoundingClientRect()), texts = [], icons = [], annotations = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) texts.push(...ink(walker.currentNode))
    for (const svg of el.querySelectorAll('svg')) if (rendered(svg)) {
      const r = svg.getBBox(), m = svg.getScreenCTM()
      if (!m || !r.width || !r.height) continue
      const a = new DOMPoint(r.x, r.y).matrixTransform(m), b = new DOMPoint(r.x + r.width, r.y + r.height).matrixTransform(m)
      const target = svg.closest('.ns-lock' + (surfaces ? ', .ctl-mark, .hw-badges' : '')) ? annotations : icons
      target.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) })
    }
    // A badge/disc or keycap is part of the visible group, while its glyph's own centre is still reported separately.
    const decorations = [...el.querySelectorAll('kbd, .panel-badge, .dev-face-ic, .kit-side-ic, .kit-seg-ic, .kit-select-ic, .kit-select-badge, .sel-thumb, .mark, .dot, .ns-count b, .kit-chip > button, .sims-filters-n' + (surfaces ? ', .look > i, .bb-theme > i, .swatch, .gyro-ic, .gyro-sw, .row-ic, .sw, img, .tile-art, .pick-art, .ctl-gauge, .person, .fact, .music-pad > i' : ''))].filter(rendered).filter(e => {
      const s = getComputedStyle(e)
      return e.matches('img, .swatch, .tile-art, .pick-art, .ctl-gauge') || s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.backgroundImage !== 'none' || s.boxShadow !== 'none'
    }).map(e => box(e.getBoundingClientRect()))
    for (const svg of el.querySelectorAll('svg')) if (rendered(svg) && getComputedStyle(svg).backgroundColor !== 'rgba(0, 0, 0, 0)') decorations.push(box(svg.getBoundingClientRect()))
    const labelInk = union(texts), iconInk = union(icons), groupInk = union([...texts, ...icons, ...decorations])
    const point = centre(groupInk ?? button), hit = el.getRootNode().elementFromPoint(point.x, point.y)
    const occluded = surfaces && (!hit || !el.contains(hit))
    const iconGaps = icons.map(icon => {
      if (!labelInk) return { axis: null, distance: null }
      const x = Math.max(labelInk.x - (icon.x + icon.width), icon.x - (labelInk.x + labelInk.width))
      const y = Math.max(labelInk.y - (icon.y + icon.height), icon.y - (labelInk.y + labelInk.height))
      return y > x ? { axis: 'y', distance: y } : { axis: 'x', distance: x }
    })
    const closest = iconGaps.filter(g => g.distance !== null).sort((a, b) => a.distance - b.distance)[0]
    const name = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').map(id => el.getRootNode().getElementById(id)?.textContent || '').join(' ').trim() || el.textContent.trim() || el.getAttribute('title') || ''
    // Full-width menu rows and switches intentionally lead from the start. Their group still centres vertically.
    const verticalOnly = surfaces && (el.matches('.row, .connection-use, .connection-title, .bb-product, .sel-opt, .kit-option, .lf-where, .sc-pick, .phone-pick, .type-open, .scan-open, .set-row, .gyro') || el.matches('.chip') && getComputedStyle(el).textAlign === 'left' || el.matches('.facts') && getComputedStyle(el).justifyContent !== 'center')
    return { index, id: el.id, classes: typeof el.className === 'string' ? el.className : '', name, label: el.textContent.trim(), button, labelInk, iconInk, decorations, groupInk, verticalOnly, occluded,
      labelOffset: labelInk ? offset(labelInk, button) : null, iconOffset: iconInk ? offset(iconInk, button) : null,
      groupOffset: groupInk ? offset(groupInk, button) : null,
      icons: icons.map((ink, i) => ({ box: ink, centre: centre(ink), offset: offset(ink, button), labelGap: iconGaps[i] })), annotations,
      gapAxis: closest?.axis ?? null, gap: closest?.distance ?? null,
      iconOnly: !labelInk && !!iconInk, font: getComputedStyle(el).font, padding: getComputedStyle(el).padding }
  })
}

export const inkError = r => r.groupOffset ? Math.max(r.verticalOnly ? 0 : Math.abs(r.groupOffset.x), Math.abs(r.groupOffset.y)) : 0
export function inkSummary(rows) {
  const errors = rows.filter(r => r.groupInk && !r.occluded).map(inkError).sort((a, b) => a - b)
  return { controls: rows.length, measured: errors.length, worst: errors.at(-1) ?? 0, p95: errors[Math.ceil(errors.length * .95) - 1] ?? 0 }
}

/** Let font, mutation and visibility observers fit controls revealed by a sheet before reading their ink. */
export async function readButtonInk(page, options = {}) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(180)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return page.evaluate(measureButtonInk, options)
}

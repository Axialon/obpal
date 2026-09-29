/** Browser-side ink measurement. Text uses the loaded font's actual glyph bounds, not its line box. */
export function measureButtonInk() {
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
    if (!el || el.closest('svg, .kit-sr, sup, kbd') || !rendered(el) || !node.textContent.trim()) return []
    const s = getComputedStyle(el), font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
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
      const m = ctx.measureText(label)
      return { x: line.x - m.actualBoundingBoxLeft, y: line.y + baselines.get(font) - m.actualBoundingBoxAscent,
        width: (m.actualBoundingBoxLeft + m.actualBoundingBoxRight), height: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) }
    })
  }
  const roots = [document]
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
  return roots.flatMap(root => [...root.querySelectorAll('button, [role="button"], a.kit-action, a.kit-cta, a.dcard-go, a.sim-crumb, .kit-chip, .arm-badge, .sim-badge')]).filter(visible).map((el, index) => {
    const button = box(el.getBoundingClientRect()), texts = [], icons = [], annotations = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) texts.push(...ink(walker.currentNode))
    for (const svg of el.querySelectorAll('svg')) if (rendered(svg)) {
      const r = svg.getBBox(), m = svg.getScreenCTM()
      if (!m || !r.width || !r.height) continue
      const a = new DOMPoint(r.x, r.y).matrixTransform(m), b = new DOMPoint(r.x + r.width, r.y + r.height).matrixTransform(m)
      const target = svg.closest('.ns-lock') ? annotations : icons
      target.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) })
    }
    // A badge/disc or keycap is part of the visible group, while its glyph's own centre is still reported separately.
    const decorations = [...el.querySelectorAll('kbd, .panel-badge, .dev-face-ic, .kit-side-ic, .kit-seg-ic, .kit-select-ic, .kit-select-badge, .sel-thumb, .mark, .dot, .ns-count b, .kit-chip > button, .sims-filters-n')].filter(rendered).filter(e => {
      const s = getComputedStyle(e)
      return s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.backgroundImage !== 'none' || s.boxShadow !== 'none'
    }).map(e => box(e.getBoundingClientRect()))
    for (const svg of el.querySelectorAll('svg')) if (rendered(svg) && getComputedStyle(svg).backgroundColor !== 'rgba(0, 0, 0, 0)') decorations.push(box(svg.getBoundingClientRect()))
    const labelInk = union(texts), iconInk = union(icons), groupInk = union([...texts, ...icons, ...decorations])
    const iconGaps = icons.map(icon => {
      if (!labelInk) return { axis: null, distance: null }
      const x = Math.max(labelInk.x - (icon.x + icon.width), icon.x - (labelInk.x + labelInk.width))
      const y = Math.max(labelInk.y - (icon.y + icon.height), icon.y - (labelInk.y + labelInk.height))
      return y > x ? { axis: 'y', distance: y } : { axis: 'x', distance: x }
    })
    const closest = iconGaps.filter(g => g.distance !== null).sort((a, b) => a.distance - b.distance)[0]
    const name = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').map(id => el.getRootNode().getElementById(id)?.textContent || '').join(' ').trim() || el.textContent.trim() || el.getAttribute('title') || ''
    return { index, id: el.id, classes: typeof el.className === 'string' ? el.className : '', name, label: el.textContent.trim(), button, labelInk, iconInk, decorations, groupInk,
      labelOffset: labelInk ? offset(labelInk, button) : null, iconOffset: iconInk ? offset(iconInk, button) : null,
      groupOffset: groupInk ? offset(groupInk, button) : null,
      icons: icons.map((ink, i) => ({ box: ink, centre: centre(ink), offset: offset(ink, button), labelGap: iconGaps[i] })), annotations,
      gapAxis: closest?.axis ?? null, gap: closest?.distance ?? null,
      iconOnly: !labelInk && !!iconInk, font: getComputedStyle(el).font, padding: getComputedStyle(el).padding }
  })
}

export const inkError = r => r.groupOffset ? Math.max(Math.abs(r.groupOffset.x), Math.abs(r.groupOffset.y)) : 0
export function inkSummary(rows) {
  const errors = rows.filter(r => r.groupInk).map(inkError).sort((a, b) => a - b)
  return { controls: rows.length, measured: errors.length, worst: errors.at(-1) ?? 0, p95: errors[Math.ceil(errors.length * .95) - 1] ?? 0 }
}

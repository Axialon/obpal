/** Sample the live controller's touch regions for collisions with unrelated controls. */
export async function readControlOverlaps(page) {
  return page.evaluate(() => {
    const selector = 'button, a[href], input, select, textarea, [role="tab"], [role="button"], .pad, .gp-stick, .gp-dpad, .mouse-seam, .mouse-wheel'
    const name = el => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`
    const bounds = el => {
      const box = el.getBoundingClientRect()
      let { left, top, right, bottom } = box
      // Include touch extensions, such as the mouse wheel's wider ::before.
      for (const pseudo of ['::before', '::after']) {
        const s = getComputedStyle(el, pseudo)
        if (s.content === 'none' || s.position !== 'absolute' || s.pointerEvents === 'none') continue
        const extra = v => v.endsWith('px') ? Math.min(0, parseFloat(v)) : 0
        left = Math.min(left, box.left + extra(s.left)); right = Math.max(right, box.right - extra(s.right))
        top = Math.min(top, box.top + extra(s.top)); bottom = Math.max(bottom, box.bottom - extra(s.bottom))
      }
      return { left, top, right, bottom }
    }
    const overlaps = []
    for (const el of document.querySelectorAll(selector)) {
      if (!el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) || el.closest('[inert]')) continue
      const box = el.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) continue
      let { left, top, right, bottom } = bounds(el)
      // Scrolled-out targets do not own a hit area on screen.
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const s = getComputedStyle(parent), r = parent.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right) }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom) }
      }
      left = Math.max(0, left); top = Math.max(0, top); right = Math.min(innerWidth, right); bottom = Math.min(innerHeight, bottom)
      const nx = Math.ceil((right - left) / 8), ny = Math.ceil((bottom - top) / 8)
      const seen = new Set()
      for (let ix = 0; ix <= nx; ix++) for (let iy = 0; iy <= ny; iy++) {
        const x = left + .5 + (right - left - 1) * ix / Math.max(1, nx)
        const y = top + .5 + (bottom - top - 1) * iy / Math.max(1, ny)
        const hit = document.elementFromPoint(x, y)?.closest(selector)
        // A wheel or button inset in a pad owns that part of the parent's region.
        if (!hit || hit === el || el.contains(hit) || hit.contains(el) || seen.has(hit)) continue
        // Chromium can round a sample on a shared edge into its neighbour; adjoining boxes do not overlap.
        const other = bounds(hit)
        if (Math.min(right, other.right) - Math.max(left, other.left) < .5 || Math.min(bottom, other.bottom) - Math.max(top, other.top) < .5) continue
        // Rounded corners and clipped decorations are outside the actual target.
        if (!document.elementsFromPoint(x, y).some(node => node === el || (el.contains(node) && node.closest(selector) === el))) continue
        seen.add(hit)
        overlaps.push(`${name(el)} hit ${name(hit)} at ${x.toFixed(1)},${y.toFixed(1)}`)
      }
    }
    return overlaps
  })
}

// The ob.Pal mark (public/logo-mark.svg) drawn for one pixel size: the cube's corners on whole pixels and its edges
// at an exact 2:1 slope, so every edge steps the same way along its length and reads as a clean line where an
// arbitrary angle beads. Its straight lines get whole-pixel widths (even ones on the vertical edges, which then fill
// whole columns), heavier than the scaled-down mark's hairlines. The orbit is a curve, so it keeps its shape.
// The bold version (`bold: true`) is the mark redrawn for small sizes and the store art. Plain string building, so a
// page can import it too.

const T = '<linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#565656"/><stop offset=".35" stop-color="#2a2a2a"/><stop offset=".75" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient>'
const L = '<linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1d1d"/><stop offset=".45" stop-color="#0a0a0a"/><stop offset="1" stop-color="#000"/></linearGradient>'
const R = '<linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#313131"/><stop offset=".5" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient>'
const S = '<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset=".42" stop-color="#C6FF34" stop-opacity="0"/><stop offset="1" stop-color="#C6FF34" stop-opacity=".5"/></linearGradient>'

/**
 * The mark as an SVG whose viewBox is `size` pixels square, to be drawn at exactly that many pixels (or a whole
 * multiple, then averaged down).
 * @param {number} size the mark's box in pixels
 * @param {{ width?: number, bold?: boolean }} [o] `width`: the SVG's width and height attributes (the drawing size),
 *   when not `size`; `bold`: the bold mark (boldMark below)
 */
export function markSVG(size, { width = size, bold = false } = {}) {
  if (bold) return boldMark(size, width)
  const k = size / 100
  const cx = Math.round(50 * k)
  const w = 2 * Math.max(2, Math.round(14 * k + 0.25)) // half the cube's width: even, so its 2:1 rise is whole
  const rise = w / 2
  const top = Math.round(19 * k)
  const tall = Math.round(30.8 * k)
  const P = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ')
  const up = [cx, top], right = [cx + w, top + rise], mid = [cx, top + 2 * rise], left = [cx - w, top + rise]
  const rightLow = [cx + w, top + rise + tall], low = [cx, top + 2 * rise + tall], leftLow = [cx - w, top + rise + tall]
  const hair = Math.max(2, 2 * Math.round(0.65 * k)) // the seams: even, so the vertical ones fill whole columns
  const lime = Math.max(3, Math.round(2.6 * k))
  const f = (n) => +n.toFixed(2)
  // The orbit, as the original's: an ellipse turned -14 degrees about (50, 57), its back faint and its front bold.
  const ox = f(50 * k), oy = f(57 * k), rx = f(47 * k), ry = f(15 * k)
  const a = (-14 * Math.PI) / 180
  const at = (t) => [f(ox + rx * Math.cos(t) * Math.cos(a) - ry * Math.sin(t) * Math.sin(a)), f(oy + rx * Math.cos(t) * Math.sin(a) + ry * Math.sin(t) * Math.cos(a))]
  // The front half: from the right end round the near side to the left end (the original's arc, 95.6,45.63 → 4.4,68.37).
  const [sx, sy] = at(0), [ex, ey] = at(Math.PI)
  const bead = at(0.87)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${width}" height="${width}">
<defs>${T}${L}${R}${S}</defs>
<ellipse cx="${ox}" cy="${oy}" rx="${rx}" ry="${ry}" transform="rotate(-14 ${ox} ${oy})" fill="none" stroke="#C6FF34" stroke-width="${f(3.6 * k)}" opacity=".4"/>
<polygon points="${P([up, right, rightLow, low, leftLow, left])}" fill="#000"/>
<polygon points="${P([up, right, mid, left])}" fill="url(#t)"/>
<polygon points="${P([left, mid, low, leftLow])}" fill="url(#l)"/>
<polygon points="${P([mid, right, rightLow, low])}" fill="url(#r)"/>
<polygon points="${P([left, mid, low, leftLow])}" fill="url(#s)" opacity=".7"/>
<polygon points="${P([mid, right, rightLow, low])}" fill="url(#s)"/>
<polygon points="${P([up, right, rightLow, low, leftLow, left])}" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="${hair}" stroke-linejoin="round"/>
<path d="M${P([mid])} L${P([low])}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="${hair}"/>
<path d="M${P([left])} L${P([mid])} L${P([right])}" fill="none" stroke="#C6FF34" stroke-width="${lime}" stroke-linejoin="round" stroke-linecap="round"/>
<path d="M${P([up])} L${P([right])}" fill="none" stroke="rgba(255,255,255,.72)" stroke-width="${hair}"/>
<path d="M${P([up])} L${P([right])}" fill="none" stroke="#C6FF34" stroke-width="${hair}" opacity=".55"/>
<path d="M${sx} ${sy} A${rx} ${ry} -14 0 1 ${ex} ${ey}" fill="none" stroke="#C6FF34" stroke-width="${f(4.6 * k)}" stroke-linecap="round"/>
<circle cx="${bead[0]}" cy="${bead[1]}" r="${f(5.4 * k)}" fill="#C6FF34"/>
<circle cx="${bead[0]}" cy="${bead[1]}" r="${f(2.2 * k)}" fill="#fff"/>
</svg>`
}

/**
 * The mark redrawn for small sizes (the 48 and 128 px icons) and the store art: fewer, heavier parts. A bigger cube
 * inside a tighter orbit; at 96 px its lime edges are 4.5 px thick, the orbit 6 px, the bead 14 px across. The cube is
 * all filled polygons with their corners on whole pixels (half ones for an odd keyline) and their edges at an exact
 * 2:1, so its rim, lime edges and seam are bands a whole number of pixels tall in every column, stepping the same way
 * along their length: no hairlines, and every line opaque. A dark keyline round the cube, and under the orbit where
 * it crosses the cube, keeps the shape crisp on a light page and vanishes on a dark one. Below 64 px the cube is a
 * little smaller, for room to show the orbit, and has no seam.
 * @param {number} size the mark's box in pixels
 * @param {number} width the drawing size
 */
function boldMark(size, width) {
  const small = size < 64
  const cx = Math.floor(size / 2)
  const w = 2 * Math.max(2, Math.round(size * (small ? 0.146 : 0.165))) // half the cube's width: even, so its 2:1 rise is whole
  const rise = w / 2
  const tall = Math.round(1.1 * w)
  const top = Math.round((size - w - tall) / 2)
  const rim = Math.max(2, 2 * Math.round(size * 0.0105)) // even, so the faces' corners stay whole
  const key = Math.max(1, Math.round(size / 48))
  const lime = Math.max(3, Math.round(size * 0.05)) // the lime edges' height in each column
  const s = small ? 0 : Math.round(size / 96) // half the seam's width
  const P = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ')
  const f = (n) => +n.toFixed(2)
  /** The cube's outline moved out by e pixels (in, for e < 0), its corners staying on the 2:1 lines. */
  const hex = (e) => [
    [cx, top - e], [cx + w + e, top + rise - e / 2], [cx + w + e, top + rise + tall + e / 2],
    [cx, top + 2 * rise + tall + e], [cx - w - e, top + rise + tall + e / 2], [cx - w - e, top + rise - e / 2],
  ]
  const [up, right, rightLow, low, leftLow, left] = hex(-rim) // the faces' outline, inside the rim
  const mid = [cx, top + 2 * rise]
  // The side faces, and the seam between them: a band from the lime edges down to the rim.
  const leftFace = [left, [cx - s, mid[1] - s / 2], [cx - s, low[1] - s / 2], leftLow]
  const rightFace = [[cx + s, mid[1] - s / 2], right, rightLow, [cx + s, low[1] - s / 2]]
  const seam = [[cx - s, mid[1] - s / 2], mid, [cx + s, mid[1] - s / 2], [cx + s, low[1] - s / 2], low, [cx - s, low[1] - s / 2]]
  // The lime edges: the top face's two front edges as one chevron band, from corner to corner of the cube.
  const a = Math.floor(lime / 2), b = lime - a
  const edges = [[cx - w, top + rise - a], [cx, top + 2 * rise - a], [cx + w, top + rise - a], [cx + w, top + rise + b], [cx, top + 2 * rise + b], [cx - w, top + rise + b]]
  // The orbit, turned -14 degrees as the original's, as wide as the box allows.
  const tilt = (-14 * Math.PI) / 180
  const front = Math.max(4, Math.round(size * 0.064)), back = Math.max(2, Math.round(size * 0.042))
  const reach = Math.hypot(Math.cos(tilt), 0.32 * Math.sin(tilt)) // the turned ellipse's half-width over rx
  const rx = f(Math.min(1.45 * w, (size / 2 - front / 2 - 0.75) / reach)), ry = f(0.32 * rx)
  const ox = cx, oy = f(top + 0.58 * (w + tall))
  const at = (t) => [f(ox + rx * Math.cos(t) * Math.cos(tilt) - ry * Math.sin(t) * Math.sin(tilt)), f(oy + rx * Math.cos(t) * Math.sin(tilt) + ry * Math.sin(t) * Math.cos(tilt))]
  const [sx, sy] = at(0), [ex, ey] = at(Math.PI), bead = at(0.87)
  const arc = `M${sx} ${sy} A${rx} ${ry} -14 0 1 ${ex} ${ey}`
  const faceTop = top + rise, faceBottom = top + 2 * rise + tall
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${width}" height="${width}">
<defs>
<linearGradient id="bt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#626262"/><stop offset="1" stop-color="#2a2a2a"/></linearGradient>
<linearGradient id="bl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#161616"/><stop offset="1" stop-color="#030303"/></linearGradient>
<linearGradient id="br" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#0a0a0a"/></linearGradient>
<linearGradient id="bs" gradientUnits="userSpaceOnUse" x1="0" y1="${faceTop}" x2="0" y2="${faceBottom}"><stop offset=".42" stop-color="#C6FF34" stop-opacity="0"/><stop offset="1" stop-color="#C6FF34" stop-opacity=".5"/></linearGradient>
<linearGradient id="bm" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${faceBottom}"><stop offset="0" stop-color="#bdbdbd"/><stop offset="1" stop-color="#7c7c7c"/></linearGradient>
<clipPath id="bk"><polygon points="${P(hex(key))}"/></clipPath>
</defs>
<ellipse cx="${ox}" cy="${oy}" rx="${rx}" ry="${ry}" transform="rotate(-14 ${ox} ${oy})" fill="none" stroke="#6d8c1d" stroke-width="${back}"/>
<polygon points="${P(hex(key))}" fill="#050505"/>
<polygon points="${P(hex(0))}" fill="url(#bm)"/>
${s ? `<polygon points="${P(seam)}" fill="#5a5a5a"/>` : ''}
<polygon points="${P([up, right, mid, left])}" fill="url(#bt)"/>
<polygon points="${P(leftFace)}" fill="url(#bl)"/>
<polygon points="${P(rightFace)}" fill="url(#br)"/>
<polygon points="${P(leftFace)}" fill="url(#bs)" opacity=".7"/>
<polygon points="${P(rightFace)}" fill="url(#bs)"/>
<polygon points="${P(edges)}" fill="#C6FF34"/>
<path d="${arc}" fill="none" stroke="#050505" stroke-width="${f(front + 2 * Math.max(1, size / 64))}" stroke-linecap="round" clip-path="url(#bk)"/>
<path d="${arc}" fill="none" stroke="#C6FF34" stroke-width="${front}" stroke-linecap="round"/>
<circle cx="${bead[0]}" cy="${bead[1]}" r="${f(0.075 * size)}" fill="#C6FF34"/>
<circle cx="${bead[0]}" cy="${bead[1]}" r="${f(0.03 * size)}" fill="#fff"/>
</svg>`
}

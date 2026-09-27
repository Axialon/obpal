/**
 * The hero's 3D letters: the display face's outlines (Plus Jakarta Sans ExtraBold, SIL Open Font License 1.1),
 * subset to what a headline needs and written as a three.js typeface (src/landing/glyphs.json), with the font's
 * kerning for those characters. three.js builds each letter's shape from it (FontLoader's Font), so the page loads
 * a few kilobytes of outlines, not a font parser.
 *
 * Some of the font's outlines cross over themselves (the e's crossbar is one outline that runs back over its bowl):
 * a font renderer fills them by the nonzero rule, but three.js can't triangulate a crossing outline cleanly (slivers
 * and notches on the letter's top). Those glyphs are merged here into clean outlines (their nonzero union, finely
 * flattened); the others keep their curves.
 *
 * Usage: node scripts/hero-font.mjs <PlusJakartaSans-ExtraBold.ttf>
 * (The static ExtraBold instance: https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@800 with a
 * non-woff2 user agent names its .ttf.)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import ClipperLib from 'clipper-lib'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/hero-font.mjs <PlusJakartaSans-ExtraBold.ttf>')
  process.exit(2)
}
const buf = readFileSync(src)
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))

/** Every character a headline might use. */
const CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,:;!?\'’-– ']
const r = (v) => Math.round(v)
/** Flattening: at most this far (font units) from the true curve. Clipper works in integers: this many per unit. */
const TOLERANCE = 0.25
const SCALE = 16
const { Clipper, PolyFillType } = ClipperLib

/** A glyph's outlines as polygons (font units, y up), its curves cut into short straight pieces. */
function flatten(commands) {
  const rings = []
  let ring = null, x = 0, y = 0
  for (const c of commands) {
    if (c.type === 'M') { ring = [[c.x, c.y]]; rings.push(ring); x = c.x; y = c.y; continue }
    if (c.type === 'Z' || !ring) continue
    if (c.type === 'L') ring.push([c.x, c.y])
    else if (c.type === 'Q') {
      const n = Math.max(1, Math.ceil(Math.sqrt(Math.hypot(x - 2 * c.x1 + c.x, y - 2 * c.y1 + c.y) / (4 * TOLERANCE))))
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t
        ring.push([u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y])
      }
    } else if (c.type === 'C') {
      const d = Math.max(Math.hypot(x - 2 * c.x1 + c.x2, y - 2 * c.y1 + c.y2), Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y))
      const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * d) / TOLERANCE)))
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t
        ring.push([
          u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        ])
      }
    }
    x = c.x; y = c.y
  }
  return rings.filter((q) => q.length > 2)
}

/** The glyph's filled area by the nonzero rule, as clean polygons (none crossing itself or another). */
function union(rings) {
  const paths = rings.map((q) => q.map(([px, py]) => ({ X: Math.round(px * SCALE), Y: Math.round(py * SCALE) })))
  const out = Clipper.SimplifyPolygons(paths, PolyFillType.pftNonZero)
  return Clipper.CleanPolygons(out, 0.05 * SCALE).filter((p) => p.length > 2)
}

const area = (paths) => paths.reduce((s, p) => s + Clipper.Area(p), 0)
let merged = 0
const glyphs = {}
for (const ch of CHARS) {
  const g = font.charToGlyph(ch)
  if (!g || (g.index === 0 && ch !== ' ')) continue
  const o = []
  const rings = flatten(g.path.commands)
  const clean = union(rings)
  const raw = rings.map((q) => q.map(([px, py]) => ({ X: Math.round(px * SCALE), Y: Math.round(py * SCALE) })))
  // Clean already when its union has as many outlines and the same area (holes count negative either way).
  const crossed = clean.length !== raw.length || Math.abs(Math.abs(area(clean)) - Math.abs(area(raw))) > Math.abs(area(raw)) * 0.002
  if (crossed) {
    merged++
    // three.js reads clockwise outlines as solid and the others as holes (TrueType's way): Clipper's are the reverse.
    for (const p of clean) {
      const pts = [...p].reverse()
      pts.forEach((pt, i) => o.push(i ? 'l' : 'm', +(pt.X / SCALE).toFixed(1), +(pt.Y / SCALE).toFixed(1)))
    }
  } else {
    for (const c of g.path.commands) {
      switch (c.type) {
        case 'M': o.push('m', r(c.x), r(c.y)); break
        case 'L': o.push('l', r(c.x), r(c.y)); break
        // three.js typeface order: the end point first, then the control point(s).
        case 'Q': o.push('q', r(c.x), r(c.y), r(c.x1), r(c.y1)); break
        case 'C': o.push('b', r(c.x), r(c.y), r(c.x1), r(c.y1), r(c.x2), r(c.y2)); break
      }
    }
  }
  const bb = g.getBoundingBox()
  glyphs[ch] = { ha: r(g.advanceWidth), x_min: r(bb.x1), x_max: r(bb.x2), o: o.join(' ') }
}

// Kerning between the characters kept, in font units (only the pairs that have any).
const kerning = {}
const kept = Object.keys(glyphs).filter((c) => c !== ' ')
for (const a of kept) {
  for (const b of kept) {
    const k = font.getKerningValue(font.charToGlyph(a), font.charToGlyph(b))
    if (k) kerning[a + b] = k
  }
}

const out = {
  glyphs,
  kerning,
  familyName: font.names.fontFamily?.en ?? 'Plus Jakarta Sans',
  ascender: font.ascender,
  descender: font.descender,
  underlinePosition: font.tables.post?.underlinePosition ?? -100,
  underlineThickness: font.tables.post?.underlineThickness ?? 50,
  boundingBox: { xMin: font.tables.head.xMin, yMin: font.tables.head.yMin, xMax: font.tables.head.xMax, yMax: font.tables.head.yMax },
  resolution: font.unitsPerEm,
  original_font_information: {
    copyright: font.names.copyright?.en ?? '',
    license: 'SIL Open Font License 1.1 (https://openfontlicense.org). Outlines subset from Plus Jakarta Sans ExtraBold.',
  },
}
const path = resolve(root, 'src/landing/glyphs.json')
writeFileSync(path, JSON.stringify(out))
console.log(`${Object.keys(glyphs).length} glyphs (${merged} merged into clean outlines), ${Object.keys(kerning).length} kerning pairs -> ${path} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB)`)

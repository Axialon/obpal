/**
 * The hero's 3D letters: the display face's outlines (Plus Jakarta Sans ExtraBold, SIL Open Font License 1.1),
 * subset to what a headline needs and written as a three.js typeface (src/landing/glyphs.json), with the font's
 * kerning for those characters. three.js builds each letter's shape from it (FontLoader's Font), so the page loads
 * a few kilobytes of outlines, not a font parser.
 *
 * Usage: node scripts/hero-font.mjs <PlusJakartaSans-ExtraBold.ttf>
 * (The static ExtraBold instance: https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@800 with a
 * non-woff2 user agent names its .ttf.)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'

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

const glyphs = {}
for (const ch of CHARS) {
  const g = font.charToGlyph(ch)
  if (!g || (g.index === 0 && ch !== ' ')) continue
  const o = []
  for (const c of g.path.commands) {
    switch (c.type) {
      case 'M': o.push('m', r(c.x), r(c.y)); break
      case 'L': o.push('l', r(c.x), r(c.y)); break
      // three.js typeface order: the end point first, then the control point(s).
      case 'Q': o.push('q', r(c.x), r(c.y), r(c.x1), r(c.y1)); break
      case 'C': o.push('b', r(c.x), r(c.y), r(c.x1), r(c.y1), r(c.x2), r(c.y2)); break
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
console.log(`${Object.keys(glyphs).length} glyphs, ${Object.keys(kerning).length} kerning pairs -> ${path} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB)`)

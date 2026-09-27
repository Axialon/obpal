/**
 * The site's web fonts, served from this origin: Inter, JetBrains Mono and Plus Jakarta Sans (each under the SIL Open
 * Font License 1.1, whose texts ship beside them). Nothing is fetched from a font service when a page loads, so no
 * visitor's address goes to a third party for a font.
 *
 * Takes the same faces the pages used from Google Fonts, in the same unicode-range subsets (a browser downloads only
 * the subsets its text needs), and writes:
 *   - public/fonts/<family>-<subset>.woff2 (one file per family and subset: all three are variable fonts),
 *   - public/fonts/OFL-<Family>.txt, the licences,
 *   - src/styles/fonts.css, the @font-face rules (font-display: swap).
 *
 * Usage: node scripts/fonts.mjs (run again to update the fonts).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const FAMILIES = 'family=Inter:opsz,wght@14..32,400..800&family=JetBrains+Mono:wght@500;600&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap'
/** A browser that takes woff2 and unicode-range subsets (the CSS API answers by user agent). */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const LICENCES = {
  Inter: 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt',
  'JetBrains Mono': 'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt',
  'Plus Jakarta Sans': 'https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/OFL.txt',
}
/** The subsets in the order the rules are written (latin first: the one nearly every page needs). */
const ORDER = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese']

const slug = (family) => family.toLowerCase().replace(/\s+/g, '-')
async function get(url, as = 'text') {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return as === 'text' ? r.text() : new Uint8Array(await r.arrayBuffer())
}

const css = await get(`https://fonts.googleapis.com/css2?${FAMILIES}`)
/** family|subset -> the face: its file, the weights it covers, its unicode-range. */
const faces = new Map()
for (const [, subset, body] of css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g)) {
  const prop = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1].trim()
  const family = prop('font-family').replace(/^'|'$/g, '')
  const url = /url\(([^)]+)\)/.exec(prop('src'))[1]
  const weights = prop('font-weight').split(/\s+/).map(Number)
  const key = `${family}|${subset}`
  const face = faces.get(key) ?? { family, subset, url, style: prop('font-style') ?? 'normal', range: prop('unicode-range'), min: Infinity, max: -Infinity }
  if (face.url !== url) throw new Error(`${family} ${subset}: more than one file (${face.url}, ${url}); this script expects variable fonts`)
  face.min = Math.min(face.min, ...weights)
  face.max = Math.max(face.max, ...weights)
  faces.set(key, face)
}
if (!faces.size) throw new Error('no @font-face rules in the CSS API answer')

const dir = join(root, 'public/fonts')
await mkdir(dir, { recursive: true })
const rules = []
const sorted = [...faces.values()].sort((a, b) => a.family.localeCompare(b.family) || ORDER.indexOf(a.subset) - ORDER.indexOf(b.subset))
let bytes = 0
for (const f of sorted) {
  const file = `${slug(f.family)}-${f.subset}.woff2`
  const data = await get(f.url, 'bytes')
  bytes += data.length
  await writeFile(join(dir, file), data)
  rules.push(`/* ${f.family}, ${f.subset} */
@font-face {
  font-family: '${f.family}';
  font-style: ${f.style};
  font-weight: ${f.min === f.max ? f.min : `${f.min} ${f.max}`};
  font-display: swap;
  src: url('/fonts/${file}') format('woff2');
  unicode-range: ${f.range};
}`)
}
for (const [family, url] of Object.entries(LICENCES)) await writeFile(join(dir, `OFL-${family.replace(/\s+/g, '')}.txt`), await get(url))

const header = `/*
 * The site's web fonts, served from this origin (scripts/fonts.mjs writes this file and public/fonts): Inter,
 * JetBrains Mono and Plus Jakarta Sans, each under the SIL Open Font License 1.1 (public/fonts/OFL-*.txt). Split into
 * unicode-range subsets, so a browser fetches only those its text needs.
 */
`
await writeFile(join(root, 'src/styles/fonts.css'), `${header}\n${rules.join('\n\n')}\n`)
const prev = await readFile(join(root, 'src/styles/fonts.css'), 'utf8')
console.log(`fonts: ${sorted.length} files, ${(bytes / 1024).toFixed(0)} KB in public/fonts; src/styles/fonts.css ${prev.length} characters`)

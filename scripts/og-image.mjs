/**
 * ob.Pal's link preview (Open Graph and Twitter), 1200 × 630: scripts/og/card.html, the home hero's words over its
 * night with the phone of scripts/og/phone.js, shot with Playwright's Chromium into public/og.png as a 24-bit PNG.
 * Every page's og:image and twitter:image point at it (scripts/lib/preview.mjs). The card's words are read from the
 * hero in index.html, so render it again when they change.
 *
 * Text is smoothed in grey and colours kept in plain sRGB, as the store art is (extension/store/src/render.mjs); the
 * card is drawn at its own size, so its text is hinted to whole pixels, and the phone is drawn twice over and
 * averaged down by the browser. WebGL runs in SwiftShader, so it draws the same on any machine.
 *
 * Usage: node scripts/og-image.mjs [--out <file>]
 * Chromium: OBPAL_E2E_CHROMIUM, else Playwright's own, else the newest an earlier Playwright left (scripts/lib/browser.mjs).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { markSVG } from '../extension/scripts/mark.mjs'
import { resolveChromium } from './lib/browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const ORIGIN = 'https://og.obpal.test'
const [W, H] = [1200, 630]
const PAGE = '#0a0718'
const CLEAN = ['--disable-lcd-text', '--force-color-profile=srgb']
const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}
const inside = (path, dir) => { const r = relative(dir, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
const at = process.argv.indexOf('--out')
const out = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(root, 'public', 'og.png')

/** The hero's words in index.html: the headline (with its part kept on one line) and the sub-line. */
function heroWords() {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const h1 = /<h1 id="hero-h"[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? ''
  const keep = /<span class="keep">([\s\S]*?)<\/span>/.exec(h1)?.[1] ?? ''
  const sub = /<section class="hero"[\s\S]*?<p class="lede">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''
  const text = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  const words = { h: `${text(h1.replace(/<span class="keep">[\s\S]*?<\/span>/, ''))} `, keep: text(keep), sub: text(sub) }
  if (!words.h.trim() || !words.sub) throw new Error('index.html: no hero headline or sub-line found')
  return words
}

const { path } = await resolveChromium()
const browser = await chromium.launch({ executablePath: path || undefined, args: [...CLEAN, ...GL] })
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  // The repository at ORIGIN, and the mark drawn for the size it's shown at (/mark/<px>.svg).
  await page.route(`${ORIGIN}/**`, (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname)
    const mark = p.match(/^\/mark\/(\d+)\.svg$/)
    if (mark) return route.fulfill({ body: markSVG(Number(mark[1]), { bold: true }), contentType: 'image/svg+xml' })
    const file = resolve(root, p.slice(1))
    if (!inside(file, root) || !existsSync(file) || !statSync(file).isFile()) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ path: file, contentType: MIME[extname(file)] ?? 'application/octet-stream' })
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${ORIGIN}/scripts/og/card.html?${new URLSearchParams(heroWords())}`)
  await page.waitForFunction(() => window.__laidOut && window.__ready, null, { timeout: 30000 })
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})))
  })
  if (errors.length) throw new Error(`the card: ${errors.join(' | ')}`)
  const png = await page.screenshot()
  await sharp(png).flatten({ background: PAGE }).removeAlpha().png({ compressionLevel: 9 }).toFile(out)
  const m = await sharp(out).metadata()
  if (m.width !== W || m.height !== H || m.channels !== 3) throw new Error(`${out}: ${m.width}x${m.height}, ${m.channels} channels`)
  console.log(`og-image: ${relative(root, out)}  ${W}x${H}, ${Math.round(statSync(out).size / 1024)} KB`)
} finally {
  await browser.close()
}

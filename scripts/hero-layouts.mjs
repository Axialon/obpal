/**
 * The home page's hero as the physics harness sees it (tests/harness/layouts.json), measured in Playwright's Chromium
 * from this checkout's build: at each of the harness's six screens, the headline's lines and the box its letters fill,
 * every raised thing's box (the buttons, the three steps' icons, the hint and the sound control, in the order the field
 * counts them), the play area, the pixel ratio and whether the pointer is coarse. It measures them the way
 * src/landing/hero.ts does (measure, measurePads, playArea), so run it again whenever the hero's words or layout move.
 *
 * The build is served to the browser from dist/client directly (no server, no port), at a stand-in origin.
 *
 * Usage: vite build, then node scripts/hero-layouts.mjs [--check]
 *   --check   compare with the committed file instead of writing it: exit 1, naming what moved, when they differ.
 * Chromium: OBPAL_E2E_CHROMIUM, else Playwright's own, else the newest an earlier Playwright left (scripts/lib/browser.mjs).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { resolveChromium } from './lib/browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist', 'client')
const file = join(root, 'tests', 'harness', 'layouts.json')
const ORIGIN = 'https://hero.obpal.test'
const check = process.argv.includes('--check')
/** The harness's screens: a computer's window, or a phone (three device pixels a CSS pixel, a coarse pointer). */
const SCREENS = {
  'desk-1280x800': { width: 1280, height: 800, phone: false },
  'desk-1920x1080': { width: 1920, height: 1080, phone: false },
  'phone-390x844': { width: 390, height: 844, phone: true },
  'phone-360x800': { width: 360, height: 800, phone: true },
  'phone-412x915': { width: 412, height: 915, phone: true },
  'phone-844x390': { width: 844, height: 390, phone: true },
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.glb': 'model/gltf-binary',
}
const inside = (path, dir) => { const r = relative(dir, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(join(dist, 'index.html'))) {
  console.error('hero-layouts: no build in dist/client; run vite build first')
  process.exit(2)
}

/** What the hero measures, in the page: hero px, rounded to a thousandth as the file keeps them. */
function measureHero() {
  const round = (v) => Math.round(v * 1000) / 1000
  const hero = document.querySelector('.hero')
  const title = document.getElementById('hero-h')
  const hr = hero.getBoundingClientRect()
  // The headline as the page wraps it (hero.ts measure()).
  const range = document.createRange()
  const words = []
  const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const t = walker.currentNode
    for (const m of t.data.matchAll(/\S+/g)) {
      range.setStart(t, m.index)
      range.setEnd(t, m.index + m[0].length)
      words.push({ text: m[0], top: Math.round(range.getBoundingClientRect().top) })
    }
  }
  const lines = []
  let top = NaN
  for (const w of words) {
    if (!(Math.abs(w.top - top) <= 4)) { lines.push(w.text); top = w.top } else lines[lines.length - 1] += ` ${w.text}`
  }
  range.selectNodeContents(title)
  const rects = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0)
  const box = { x: 0, y: 0, w: hr.width, h: hr.height }
  if (rects.length) {
    box.x = Math.min(...rects.map((q) => q.left)) - hr.left
    box.y = Math.min(...rects.map((q) => q.top)) - hr.top
    box.w = Math.max(...rects.map((q) => q.right)) - hr.left - box.x
    box.h = Math.max(...rects.map((q) => q.bottom)) - hr.top - box.y
  }
  // The raised things (hero.ts PADS and measurePads()), at rest: the hint's bob held at its start.
  const padEls = [...hero.querySelectorAll('.cta .btn, [data-hint], [data-sound], .quick .qi')]
  for (const a of padEls.flatMap((el) => el.getAnimations())) { a.pause(); a.currentTime = 0 }
  const pads = padEls.map((el) => {
    const text = el.textContent?.trim() ?? ''
    if (el.hidden || el.classList.contains('gone') || !el.getClientRects().length) return { x: 0, y: 0, w: 0, h: 0, r: 0, text }
    const r = el.getBoundingClientRect()
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
    return { x: round(r.left - hr.left), y: round(r.top - hr.top), w: round(r.width), h: round(r.height), r: round(Math.min(radius, r.height / 2)), text }
  })
  // What of the hero the marbles may use, with the page at its top (hero.ts playArea()).
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  const screen = probe.getBoundingClientRect().height || innerHeight
  probe.remove()
  const docTop = hr.top + scrollY
  const bar = document.querySelector('header.top')
  const play = { top: round(bar ? Math.max(0, bar.offsetHeight - docTop) : 0), bottom: round(Math.min(hr.height, screen - docTop)) }
  return {
    W: round(hr.width), H: round(hr.height), lines,
    box: { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) },
    pads, play, dpr: devicePixelRatio, coarse: matchMedia('(pointer: coarse)').matches,
  }
}

const { path } = await resolveChromium()
const browser = await chromium.launch({ executablePath: path || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const layouts = {}
try {
  for (const [name, s] of Object.entries(SCREENS)) {
    const ctx = await browser.newContext({
      viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.phone ? 3 : 1, isMobile: s.phone, hasTouch: s.phone,
    })
    await ctx.route(`${ORIGIN}/**`, (route) => {
      const url = new URL(route.request().url())
      let target = resolve(dist, decodeURIComponent(url.pathname).slice(1))
      if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
      if (!inside(target, dist) || !existsSync(target)) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ path: target, contentType: MIME[extname(target)] ?? 'application/octet-stream' })
    })
    const page = await ctx.newPage()
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    // The 3D field puts up the sound control; wait for it (and for the layout to settle), then measure.
    for (let i = 0; i < 100 && (await page.evaluate(() => document.querySelector('[data-sound]')?.hidden !== false)); i++) await sleep(100)
    await sleep(500)
    layouts[name] = await page.evaluate(measureHero)
    await ctx.close()
  }
} finally {
  await browser.close()
}

const text = `${JSON.stringify(layouts, null, 1)}\n`
if (!check) {
  writeFileSync(file, text)
  console.log(`hero-layouts: wrote ${relative(root, file)}`)
} else {
  const was = JSON.parse(readFileSync(file, 'utf8'))
  const moved = []
  const walk = (a, b, at) => {
    if (typeof a !== 'object' || a === null) { if (a !== b) moved.push(`${at}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`); return }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b ?? {})])) walk(a[k], b?.[k], `${at}.${k}`)
  }
  walk(layouts, was, 'layouts')
  if (moved.length) {
    console.log(`hero-layouts: ${moved.length} values differ from ${relative(root, file)}\n  ${moved.slice(0, 40).join('\n  ')}`)
    process.exit(1)
  }
  console.log(`hero-layouts: ${relative(root, file)} matches the build`)
}

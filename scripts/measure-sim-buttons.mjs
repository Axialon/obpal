/** Glyph metrics and before/after evidence. Build first; requires the lane's two free OBPAL_E2E_* ports.
 * --sheets-only redraws the contact sheets from saved measurements and screenshots without starting a browser.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'
import { buttonRoutes, BUTTON_SIZES, PHONE_BUTTON_ROUTES, visitButtonStates, visitNodeButtons } from './lib/sim-buttons.mjs'
import { inkError, inkSummary } from './lib/button-ink.mjs'
import { captionSvg } from './lib/caption.mjs'

const phase = process.argv.includes('--before') ? 'before' : 'after'
const capture = !process.argv.includes('--metrics-only')
const sheetsOnly = process.argv.includes('--sheets-only')
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',')
const out = 'artifacts/sim-buttons', rows = [], errors = []
if (only || sheetsOnly) {
  try {
    const prior = JSON.parse(await readFile(join(out, `${phase}.json`), 'utf8'))
    rows.push(...prior.rows.filter(r => sheetsOnly || !only.includes(r.page)))
    errors.push(...prior.errors.filter(e => sheetsOnly || !only.some(name => e.startsWith(`${name} `) || e.startsWith(`${name}:`))))
  } catch (e) { if (sheetsOnly || e.code !== 'ENOENT') throw e }
}
await mkdir(join(out, phase), { recursive: true })
if (!sheetsOnly) {
  for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
    const port = Number(process.env[key]); if (!port) throw new Error(`${key} is required`)
    await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)) })
  }
  const local = await startLocal()
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: (await resolveChromium()).path || undefined })
    for (const [width, height] of BUTTON_SIZES) for (const [name, path] of await buttonRoutes()) {
      if (only && !only.includes(name)) continue
      const size = `${width}x${height}`
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: width < 900, isMobile: width < 900, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
      try {
        const page = await context.newPage()
        await visitButtonStates(page, local.origin, path, async (state, measured) => {
          const shot = `${phase}/${name}-${size}-${state}.png`
          if (capture) await page.screenshot({ path: join(out, shot) })
          rows.push(...measured.map(r => ({ page: name, size, state, shot, ...r })))
        })
        console.log(`${phase} ${name} ${size}: ${rows.filter(r => r.page === name && r.size === size).length} controls`)
      } catch (e) { errors.push(`${name} ${size}: ${e.message}`); console.error(errors.at(-1)) }
      finally { await context.close() }
    }
    for (const name of PHONE_BUTTON_ROUTES) {
      if (only && !only.includes(`node-${name}`)) continue
      try {
        await visitNodeButtons(browser, local.origin, name, async (page, size, state, measured) => {
          const shot = `${phase}/node-${name}-${size}-${state}.png`
          if (capture) await page.screenshot({ path: join(out, shot) })
          rows.push(...measured.map(r => ({ page: `node-${name}`, size, state, shot, ...r })))
        })
        console.log(`${phase} node-${name}: measured at all three sizes`)
      } catch (e) { errors.push(`node-${name}: ${e.message}`); console.error(errors.at(-1)) }
    }
  } finally { await browser?.close(); await local.close() }
}
const rank = measured => {
  const ranked = [...measured].sort((a, b) => inkError(b) - inkError(a))
  return ranked.filter((r, i) => ranked.findIndex(v => v.page === r.page && v.size === r.size && v.name === r.name && v.classes === r.classes) === i)
}
const unique = rank(rows)
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
await writeFile(join(out, `${phase}-ranked.csv`), [['page', 'size', 'state', 'name', 'group x', 'group y', 'label x', 'label y', 'icon x', 'icon y', 'gap axis', 'gap'], ...unique.map(r => [r.page, r.size, r.state, r.name, r.groupOffset?.x, r.groupOffset?.y, r.labelOffset?.x, r.labelOffset?.y, r.iconOffset?.x, r.iconOffset?.y, r.gapAxis, r.gap])].map(r => r.map(quote).join(',')).join('\n'))
await writeFile(join(out, `${phase}.json`), JSON.stringify({ summary: inkSummary(rows), sizes: Object.fromEntries(BUTTON_SIZES.map(s => [s.join('x'), inkSummary(rows.filter(r => r.size === s.join('x')))])), errors, rows }, null, 2))
if (!capture) { console.log(JSON.stringify({ phase, summary: inkSummary(rows), errors }, null, 2)); process.exit(errors.length ? 1 : 0) }
let reference = unique
if (phase === 'after') {
  try { reference = rank(JSON.parse(await readFile(join(out, 'before.json'), 'utf8')).rows) }
  catch (e) { if (e.code !== 'ENOENT') throw e }
}
for (const size of BUTTON_SIZES.map(s => s.join('x'))) {
  // After sheets revisit the same twenty offenders, so a reviewer can compare each crop directly.
  const worst = reference.filter(r => r.size === size).slice(0, 20).map(before => {
    if (phase === 'before') return before
    const matches = rows.filter(r => r.page === before.page && r.size === before.size && (before.id ? r.id === before.id : r.name === before.name))
    const match = matches.find(r => r.state === before.state) ?? matches[0]
    if (!match) throw new Error(`No after crop for ${before.page} ${before.size}: ${before.name}`)
    return match
  }), tiles = []
  for (let i = 0; i < worst.length; i++) {
    const r = worst[i], [w, h] = size.split('x').map(Number), b = r.button
    const left = Math.max(0, Math.floor((b.x - 8) * 2)), top = Math.max(0, Math.floor((b.y - 8) * 2))
    const width = Math.min(w * 2 - left, Math.ceil((b.width + 16) * 2)), height = Math.min(h * 2 - top, Math.ceil((b.height + 16) * 2))
    if (width <= 0 || height <= 0) continue
    const crop = await sharp(await readFile(join(out, r.shot))).extract({ left, top, width, height }).png().toBuffer()
    await writeFile(join(out, phase, `worst-${size}-${String(i + 1).padStart(2, '0')}.png`), crop)
    const thumb = await sharp(crop).resize(430, 100, { fit: 'contain', background: '#11151b' }).png().toBuffer()
    const caption = `${i + 1}. ${r.page}: ${r.name.slice(0, 32)} (${inkError(r).toFixed(2)}px)`.replace(/[<&]/g, ' ')
    const label = await sharp(captionSvg(caption)).png().toBuffer()
    const x = (i % 2) * 450, y = Math.floor(i / 2) * 140
    tiles.push({ input: thumb, left: x + 10, top: y }, { input: label, left: x, top: y + 100 })
  }
  await sharp({ create: { width: 900, height: 1400, channels: 3, background: '#11151b' } }).composite(tiles).png().toFile(join(out, `${phase}-${size}-contact-sheet.png`))
}
console.log(JSON.stringify({ phase, summary: inkSummary(rows), errors }, null, 2))
if (errors.length) process.exitCode = 1

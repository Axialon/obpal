/**
 * Build the site and Link first; supply both lane ports. Link's copy cannot name the installed helper.
 * --before records the baseline; --only=phone,popup revisits named surfaces; --sheets-only reuses saved captures.
 * --revision=<sha> labels an exported baseline without its git history.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'
import { BUTTON_SIZES, SITE_BUTTON_ROUTES, visitSiteButtons, visitPhoneButtons, visitLinkButtons } from './lib/surface-buttons.mjs'
import { measureButtonInk, readButtonInk, inkError, inkSummary } from './lib/button-ink.mjs'
import { captionSvg } from './lib/caption.mjs'

const phase = process.argv.includes('--before') ? 'before' : 'after'
const sheetsOnly = process.argv.includes('--sheets-only')
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',')
let revision = process.argv.find(a => a.startsWith('--revision='))?.slice(11)
if (!revision) try { revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { revision = 'baseline' }
const out = 'artifacts/align', rows = [], errors = []
await mkdir(join(out, phase), { recursive: true })
if (only) try { const prior = JSON.parse(await readFile(join(out, `${phase}.json`))); rows.push(...prior.rows.filter(r => !only.includes(r.page))) } catch (e) { if (e.code !== 'ENOENT') throw e }
if (sheetsOnly) {
  const prior = JSON.parse(await readFile(join(out, `${phase}.json`)))
  rows.splice(0, rows.length, ...prior.rows); errors.push(...prior.errors)
} else {
const wanted = name => !only || only.includes(name)
for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  const port = Number(process.env[key]); if (!port) throw new Error(`${key} is required`)
  await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)) })
}
const local = await startLocal(), executablePath = (await resolveChromium()).path || undefined
const browser = await chromium.launch({ executablePath, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
let serial = 0, progressAt = 0
const sample = name => async (page, size, state, measured) => {
  const shot = `${phase}/${name}-${size}-${state.replace(/[^\w-]/g, '')}-${serial++}.png`
  // The passive pairing seal paints above the tabs without catching pointer hits. Let its brief presentation finish.
  if (name === 'phone' && await page.locator('.seal-moment').count()) {
    await page.locator('.seal-moment').waitFor({ state: 'detached' })
    measured = await readButtonInk(page, { surfaces: true })
  }
  // A transient sheet can arrive between a measurement and its screenshot. Keep each crop tied to that frame.
  const geometry = rows => JSON.stringify(rows.map(r => [r.name, r.occluded, ...Object.values(r.button).map(n => Math.round(n * 100))]))
  let capture
  for (let attempt = 0; attempt < 4; attempt++) {
    capture = await page.screenshot()
    const current = await page.evaluate(measureButtonInk, { surfaces: true })
    if (geometry(measured) === geometry(current)) break
    if (attempt === 3) throw new Error(`Unstable capture geometry: ${name} ${size} ${state}`)
    measured = await readButtonInk(page, { surfaces: true })
  }
  await writeFile(join(out, shot), capture)
  rows.push(...measured.map(r => ({ page: name, size, state, shot, ...r })))
  if (Date.now() - progressAt > 15_000) {
    await writeFile(join(out, `${phase}-progress.json`), JSON.stringify({ rows }))
    progressAt = Date.now()
  }
}
try {
  for (const [name, path] of SITE_BUTTON_ROUTES) if (wanted(name)) for (const [width, height] of BUTTON_SIZES) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, isMobile: width < 900, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    try { await visitSiteButtons(await context.newPage(), local.origin, path, (page, state, measured) => sample(name)(page, `${width}x${height}`, state, measured)); console.log(`${phase} ${name} ${width}x${height}`) }
    catch (e) { errors.push(`${name} ${width}x${height}: ${e.message}`); console.error(errors.at(-1)) }
    finally { await context.close() }
  }
  if (wanted('phone')) try { await visitPhoneButtons(browser, local.origin, sample('phone')) } catch (e) { errors.push(`phone: ${e.message}`); console.error(errors.at(-1)) }
  if (wanted('popup') || wanted('options')) {
    const ext = await mkdtemp(join(tmpdir(), 'obpal-align-link-'))
    await cp('extension/dist', ext, { recursive: true })
    const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'))); delete manifest.key
    await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest))
    for (const f of await readdir(ext, { recursive: true })) if (f.endsWith('.js')) {
      const file = join(ext, f), source = await readFile(file, 'utf8')
      await writeFile(file, source.replaceAll('net.blackboxes.obpal', 'net.blackboxes.obpal.e2e'))
    }
    for (const f of await readdir(ext, { recursive: true })) if ((await stat(join(ext, f))).isFile() && /net\.blackboxes\.obpal(?![\w.-])/.test(await readFile(join(ext, f), 'latin1'))) throw new Error('Guarded Link copy still names the real helper')
    if ('key' in JSON.parse(await readFile(join(ext, 'manifest.json')))) throw new Error('Guarded Link copy retained key')
    const profile = await mkdtemp(join(tmpdir(), 'obpal-align-profile-'))
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, deviceScaleFactor: 2, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...local.serviceArgs] })
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
      const id = new URL(worker.url()).host
      for (const name of ['popup', 'options']) if (wanted(name)) {
        const page = await context.newPage(); await page.goto(`chrome-extension://${id}/${name}.html`)
        await visitLinkButtons(page, sample(name)); await page.close()
      }
    } finally { await context.close() }
  }
} finally { await browser.close(); await local.close() }
}

const surfaces = Object.fromEntries([...new Set(rows.map(r => r.page))].map(name => [name, inkSummary(rows.filter(r => r.page === name))]))
await writeFile(join(out, `${phase}.json`), JSON.stringify({ revision, surfaces, errors, rows }, null, 2))
const ranked = rows.filter(r => !r.occluded).sort((a, b) => inkError(b) - inkError(a))
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
await writeFile(join(out, `${phase}-ranked.csv`), ['surface,size,state,label,error,x,y', ...ranked.map(r => [r.page, r.size, r.state, r.name, inkError(r), r.groupOffset?.x, r.groupOffset?.y].map(quote).join(','))].join('\n'))
let reference = ranked
if (phase === 'after') try { reference = JSON.parse(await readFile(join(out, 'before.json'))).rows.sort((a, b) => inkError(b) - inkError(a)) } catch (e) { if (e.code !== 'ENOENT') throw e }
for (const name of Object.keys(surfaces)) {
  const tiles = []
  const source = reference.some(r => r.page === name) ? reference : ranked
  // Show the three worst distinct controls in each viewport and surface, so both appearances remain reviewable.
  const worst = BUTTON_SIZES.flatMap(([width, height]) => ['carbon', 'light'].flatMap(theme => {
    const seen = new Set()
    return source.filter(r => r.page === name && !r.occluded && r.size === `${width}x${height}` && r.state.startsWith(theme)).filter(r => {
      const key = `${r.id}|${r.name}|${r.classes}`
      if (seen.has(key)) return false
      seen.add(key); return true
    }).slice(0, 3)
  }))
  for (let i = 0; i < worst.length; i++) {
    const before = worst[i], matches = rows.filter(r => r.page === name && r.size === before.size && r.id === before.id && r.name === before.name && !r.occluded)
    const r = phase === 'before' ? before : matches.find(r => r.state === before.state) ?? matches[0]
    if (!r) continue
    const [w, h] = r.size.split('x').map(Number), b = r.button
    const left = Math.max(0, Math.floor((b.x - 6) * 2)), top = Math.max(0, Math.floor((b.y - 6) * 2))
    const width = Math.min(w * 2 - left, Math.ceil((b.width + 12) * 2)), height = Math.min(h * 2 - top, Math.ceil((b.height + 12) * 2))
    if (width <= 0 || height <= 0) continue
    const crop = await sharp(await readFile(join(out, r.shot))).extract({ left, top, width, height }).png().toBuffer()
    await writeFile(join(out, phase, `${name}-crop-${i + 1}.png`), crop)
    const thumb = await sharp(crop).resize(430, 100, { fit: 'contain', background: '#11151b' }).png().toBuffer()
    const caption = `${r.size} ${r.name.slice(0, 26)} ${inkError(r).toFixed(3)}px`.replace(/[<&]/g, ' ')
    const context = `${phase} ${revision.slice(0, 7)} ${r.state}`.replace(/[<&]/g, ' ')
    const cellLeft = i % 2 * 450, cellTop = Math.floor(i / 2) * 180
    tiles.push({ input: thumb, left: cellLeft + 10, top: cellTop }, { input: await sharp(captionSvg(caption)).png().toBuffer(), left: cellLeft, top: cellTop + 100 }, { input: await sharp(captionSvg(context)).png().toBuffer(), left: cellLeft, top: cellTop + 136 })
  }
  await sharp({ create: { width: 900, height: 1620, channels: 3, background: '#11151b' } }).composite(tiles).png().toFile(join(out, `${phase}-${name}-contact-sheet.png`))
}
console.log(JSON.stringify({ phase, surfaces, errors }, null, 2))
if (errors.length) process.exitCode = 1

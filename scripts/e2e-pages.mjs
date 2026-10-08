/**
 * Every page of the site, as its own policies and fonts leave it: this checkout's build and worker (`wrangler dev` on
 * OBPAL_E2E_WORKER_PORT, default 5179: scripts/local-worker.mjs, so public/_headers applies too). Each page opens
 * (a computer, and a phone for the controller), scrolls to its end, and:
 *   - breaks no Content Security Policy directive (scripts/csp-watch.mjs) and throws no error;
 *   - has its policy: the page's own <meta> one and the headers' frame-ancestors one;
 *   - takes its fonts from this origin, never from a font service, and they load.
 * The trust page also keeps its source links, phone layout and reduced-motion dots; its origin marker is checked
 * on a community and the official address, with every response fetched from the local worker.
 * Then the quick-actions tray on each kind of page (scripts/e2e-quick.mjs), and the Viewer open across a deploy
 * (src/ui/recover.ts): its lazy QR chunk is asked for after a pretend deploy (scripts/lib/deploy-sim.mjs) has
 * removed the old build's chunks, and the page reloads once into the new build; it doesn't when the chunks are kept,
 * and it never reloads twice.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { cspCheck, cspViolations } from './csp-watch.mjs'
import { startWorker } from './local-worker.mjs'
import { checkFrost, setSurface } from './lib/frost.mjs'
import { runQuick } from './e2e-quick.mjs'
import { runPackCatalogue } from './lib/packs-ui.mjs'
import { runViewerScene } from './lib/viewer-scene.mjs'
import { runDotLoaders } from './e2e-dot-loaders.mjs'
import { runLinkHero } from './e2e-link-hero.mjs'
import { nextBuild } from './lib/deploy-sim.mjs'
import { guardSiteButtons, SITE_BUTTON_ROUTES } from './lib/surface-buttons.mjs'
import { runGraphicsRecoveryLayouts } from './e2e-graphics-recovery.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'
import { runStoreKit } from './e2e-store-kit.mjs'
import { siteInteractionStates } from './lib/interaction-states.mjs'
import { runBrand } from './e2e-brand.mjs'
import { rawRun } from './lib/distill.mjs'

const PORT = Number(process.env.OBPAL_E2E_WORKER_PORT) || 5179
const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.OBPAL_SHOTS || ''
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const ONLY = process.env.OBPAL_E2E_PAGES_ONLY || ''
if (ONLY && !['try', 'viewer', 'store', 'interactions', 'campaign', 'partner-films', 'partner-films-accounting', 'partner-films-http', 'partner-films-playback'].includes(ONLY)) throw new Error(`unknown pages selector: ${ONLY}`)
const PAGES = ['/', '/p/', '/view/', '/sim/', '/sim/arm/', '/sim/arena/', '/sim/humanoid/', '/sim/humanoid/physics/', '/sim/octopus/', '/sim/device/', '/embed/', '/link/', '/link/desktop/', '/link/try/', '/catalogue/', '/buttons/', '/sponsor/', '/donate/', '/privacy/', '/trust/', '/campaign/']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ ok: true })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push({ ok: false })
    console.log(`  ✗ ${name}: ${e?.message ?? e}`)
  }
}

async function runTry(browser, origin) {
  const observations = []
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  for (const mode of ['reduced', 'unavailable', 'lost']) {
    for (const width of [1280, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, deviceScaleFactor: 1, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' })
      try {
        await ctx.addInitScript(({ mode }) => {
          window.__tryPad = null
          Object.defineProperty(navigator, 'getGamepads', { value: () => [window.__tryPad] })
          if (mode === 'unavailable') {
            const context = HTMLCanvasElement.prototype.getContext
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
              return type.startsWith('webgl') ? null : context.call(this, type, ...args)
            }
          }
        }, { mode })
        const page = await ctx.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(origin + '/link/try/')
        await page.evaluate(() => document.fonts.ready)
        const state = page.locator('#demo-state')
        const waitText = text => page.waitForFunction(text => document.querySelector('#demo-state').textContent.includes(text), text)
        await waitText('enable This tab')
        if (await state.getAttribute('role') !== 'status' || await state.getAttribute('aria-live') !== 'polite' || await state.getAttribute('aria-atomic') !== 'true') throw new Error('feedback is not one atomic polite status')
        if (mode === 'lost') {
          await page.waitForFunction(() => Number(document.querySelector('#link-space').dataset.dotFrames) > 0)
          const lost = await page.locator('#link-space').evaluate(canvas => {
            const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
            extension?.loseContext()
            return !!extension
          })
          if (!lost) throw new Error('cannot exercise actual WebGL context loss')
        }
        const feedbackMode = mode === 'reduced' ? 'reduced' : 'unavailable'
        await page.waitForFunction(mode => document.querySelector('#demo-state').dataset.feedbackMode === mode, feedbackMode)
        if (mode !== 'reduced') await page.locator('#link-flat').waitFor({ state: 'visible' })
        const guidance = await page.locator('#demo-guidance').textContent()
        if (!guidance.includes(mode === 'reduced' ? 'stays still with reduced motion' : 'motion is unavailable')) throw new Error('movement guidance is not qualified')
        await page.evaluate(() => { window.__tryPad = { connected: true, axes: [0, 0] } })
        await waitText('Left stick is neutral')
        await sleep(300)
        const frames = await page.locator('#link-space').getAttribute('data-dot-frames')
        await page.evaluate(() => { window.__tryPad.axes = [0.7, 0] })
        await waitText('Left stick input detected')
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${mode}-${width}-input.png`), fullPage: true })
        await page.evaluate(() => {
          window.__tryWrites = 0
          window.__tryObserver = new MutationObserver(records => { window.__tryWrites += records.length })
          window.__tryObserver.observe(document.querySelector('#demo-state'), { childList: true, characterData: true, subtree: true })
          window.__tryPad.axes = [-0.8, 0.5]
        })
        await sleep(250)
        const heldWrites = await page.evaluate(() => window.__tryWrites)
        if (heldWrites !== 0) throw new Error('held input repeatedly mutates the live-region text')
        if (mode === 'reduced' && frames !== await page.locator('#link-space').getAttribute('data-dot-frames')) throw new Error('reduced-motion input animates the constellation')
        await page.getByRole('button', { name: 'Reset view', exact: true }).click()
        await waitText('Left stick input detected')
        await page.evaluate(() => { window.__tryPad.axes = [0, 0] })
        await waitText('Left stick released. Input is neutral')
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${mode}-${width}-neutral.png`), fullPage: true })
        await page.evaluate(() => { window.__tryPad = null })
        await waitText('Controller disconnected')
        await sleep(100)
        await page.getByRole('button', { name: 'Reset view', exact: true }).click()
        await waitText('Controller disconnected')
        if (await page.locator('#link-space').getAttribute('data-pad-input') !== 'false') throw new Error('stale input marker after disconnect')
        // Playwright disables bfcache: dispatch its persisted lifecycle, then also navigate back normally.
        for (let i = 0; i < 2; i++) {
          await page.evaluate(() => {
            dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
            window.__tryPad = { connected: true, axes: [0, 0] }
          })
          await waitText('paused')
          await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
          await waitText('Left stick is neutral')
        }
        await page.evaluate(() => { window.__tryPad.axes = [0.6, 0] })
        await waitText('Left stick input detected')
        const reset = page.getByRole('button', { name: 'Reset view', exact: true })
        await reset.focus()
        if (!await reset.evaluate(node => node === document.activeElement && node.getBoundingClientRect().height >= 44)) throw new Error('Reset focus or target lost')
        const back = page.getByRole('link', { name: 'Back to the Link guide', exact: true })
        await back.focus()
        if (!await back.evaluate(node => node === document.activeElement) || await back.getAttribute('href') !== '/link/') throw new Error('Back to Link unavailable')
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`overflow at ${width}px`)
        observations.push({ mode, width, dpr: 1, guidance, input: await state.textContent(), liveWritesDuringHeldInput: heldWrites })
        await page.evaluate(() => window.__tryObserver.disconnect())
        await page.goto(origin + '/privacy/')
        await page.goBack()
        await waitText('enable This tab')
        await page.evaluate(() => { window.__tryPad = { connected: true, axes: [0.4, 0] } })
        await waitText('Left stick input detected')
        if (errors.length) throw new Error(errors.join(' | '))
      } catch (error) { throw new Error(`${mode}, ${width}px: ${error.message}`) }
      finally { await ctx.close() }
    }
  }
  if (SHOTS) writeFileSync(join(SHOTS, 'try-observations.json'), JSON.stringify({ browser: browser.version(), observations }, null, 2))
  cspCheck()
  return '6 scenarios: reduced motion, unavailable/lost WebGL; 1280px and 390px; input, release, disconnect, reset and history'
}

/** Retained offer sources are excluded by the native asset pipeline, not robots directives. */
async function runCampaignExclusion(origin) {
  const root = fileURLToPath(new URL('../dist/client/', import.meta.url))
  const ignore = readFileSync(join(root, '.assetsignore'), 'utf8')
  assert(ignore.split(/\r?\n/).includes('/campaign/phone-control/'), 'emitted native exclusion missing')
  for (const path of ['/campaign/phone-control/', '/campaign/phone-control/guide/', '/campaign/phone-control/sample/']) {
    assert(readFileSync(join(root, path.slice(1), 'index.html'), 'utf8').includes('Local review preview'), 'retained built source missing')
    for (const suffix of ['', 'index.html']) {
      const response = await fetch(origin + path + suffix)
      assert.equal(response.status, 404, path + suffix)
      assert(!(await response.text()).includes('Local review preview'), 'excluded draft content served')
    }
  }
  return 'three retained HTML sources; emitted .assetsignore; six public URL forms return 404'
}

/** Measure completed downloads and the campaign-only transport through the real local Worker. */
async function runFilmDownloads(browser, origin) {
  const films = JSON.parse(readFileSync(fileURLToPath(new URL('../public/campaign/films/manifest.json', import.meta.url)), 'utf8')).films
  const out = process.env.OBPAL_E2E_EVIDENCE_ROOT
  const measurements = []
  const protection = { binding: 'RL_FILM enabled at its production 60/60 setting', requests: [], burst: [], capacity: {}, variants: [], pacedMinimumMs: 2000 }
  const note = (url, method, status) => protection.requests.push({ atMs: Date.now(), path: new URL(url).pathname, method, status })
  const request = async (url, options = {}) => {
    await sleep(2000) // Stay below the production bucket; do not change or disable its binding for proof traffic.
    const response = await fetch(url, options)
    note(url, options.method || 'GET', response.status)
    return response
  }
  await check('partner films protection: slow response cancellation, required limiter and shared query/path admission', async () => {
    const url = origin + '/campaign/films/' + films[0].file
    const initialHead = await fetch(url, { method: 'HEAD' }); note(url, 'HEAD', initialHead.status)
    protection.initialHead = { status: initialHead.status, length: initialHead.headers.get('content-length') }
    assert.equal(initialHead.status, 200); assert.equal(Number(initialHead.headers.get('content-length')), films[0].bytes)
    const aborts = [new AbortController(), new AbortController()]
    try {
      const slow = []
      for (const abort of aborts) { const response = await fetch(url, { signal: abort.signal }); note(url, 'GET', response.status); assert.equal(response.status, 200); slow.push(response) }
      const busy = await fetch(url, { method: 'HEAD' }); note(url, 'HEAD', busy.status)
      protection.capacity = { slowResponses: slow.map(r => r.status), busyStatus: busy.status, retry: busy.headers.get('retry-after'), cache: busy.headers.get('cache-control') }
      assert.equal(busy.status, 503, 'slow consumers must retain the two operation reservations')
      assert.equal(busy.headers.get('retry-after'), '1'); assert.equal(busy.headers.get('cache-control'), 'no-store')
    } finally { aborts.forEach(abort => abort.abort()) }
    await sleep(1000)
    const recovered = await fetch(url, { method: 'HEAD' }); note(url, 'HEAD', recovered.status)
    protection.capacity.recoveredStatus = recovered.status
    assert.equal(recovered.status, 200, 'client cancellation must restore capacity')
    for (let i = 0; i < 65; i++) {
      const target = origin + '/campaign/films/' + films[i % 6].file + '?burst=' + i
      const response = await fetch(target, { method: 'HEAD' }); note(target, 'HEAD', response.status)
      protection.burst.push({ film: films[i % 6].id, status: response.status })
      if (response.status === 429) {
        assert.equal(response.headers.get('retry-after'), '60'); assert.equal(response.headers.get('cache-control'), 'no-store')
        break
      }
      assert.equal(response.status, 200)
    }
    assert(protection.burst.some(r => r.status === 429), 'required limiter must actually deny the shared burst')
    for (const path of [
      '/campaign/films/' + films[0].file + '?different=1',
      '/campaign/films/./' + films[0].file,
      '/campaign/films/%2e/' + films[0].file,
      '/campaign/films/%6fbpal-original-complete-web.mp4',
      '/campaign%2ffilms/' + films[0].file,
    ]) {
      const response = await fetch(origin + path, { method: 'HEAD' }); note(origin + path, 'HEAD', response.status)
      const adapter = response.headers.get('accept-ranges') === 'bytes' && response.headers.get('etag') === `"${films[0].sha256}"`
      protection.variants.push({ path, requestedPath: new URL(origin + path).pathname, status: response.status, adapter })
      if (new URL(origin + path).pathname === '/campaign/films/' + films[0].file) assert.equal(response.status, 429)
      else { assert(!adapter, 'noncanonical native spellings must never bypass admission into the expensive adapter'); assert([200, 404, 429].includes(response.status)) }
    }
    // A new minute, with the binding still enabled, before the 78 deliberate transport conditions.
    await sleep(61_000)
    return 'native slow consumers denied at two operations, cancel recovery; shared six-film/query burst denied; normalized and percent-encoded paths classified'
  })
  await check('partner films HTTP: six actual download hashes, content types, lengths and tail-range 206', async () => {
    const ctx = await browser.newContext({ acceptDownloads: true })
    ctx.on('response', response => { if (new URL(response.url()).pathname.startsWith('/campaign/films/') && response.url().includes('.mp4')) note(response.url(), response.request().method(), response.status()) })
    try {
      const page = await ctx.newPage()
      await page.goto(origin + '/campaign/')
      for (const film of films) {
        const url = origin + '/campaign/films/' + film.file
        const head = await request(url, { method: 'HEAD' })
        const range = await request(url, { headers: { Range: `bytes=${film.bytes - 1024}-${film.bytes - 1}` } })
        const rangeData = new Uint8Array(await range.arrayBuffer())
        const downloading = page.waitForEvent('download')
        await page.locator(`#${film.id} a[download]`).click()
        const download = await downloading
        assert.equal(await download.failure(), null)
        const data = readFileSync(await download.path())
        const sha256 = createHash('sha256').update(data).digest('hex')
        const measured = { id: film.id, filename: download.suggestedFilename(), bytes: data.length, sha256, head: { status: head.status, contentType: head.headers.get('content-type'), contentLength: head.headers.get('content-length'), acceptRanges: head.headers.get('accept-ranges') }, range: { status: range.status, contentRange: range.headers.get('content-range'), contentLength: range.headers.get('content-length'), measuredBytes: rangeData.byteLength } }
        measurements.push(measured)
        assert.equal(measured.filename, film.file)
        assert.equal(measured.bytes, film.bytes)
        assert.equal(measured.sha256, film.sha256)
        assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD must suppress response content')
        assert.equal(head.headers.get('accept-ranges'), 'bytes')
        assert.equal(Number(range.headers.get('content-length')), 1024)
        assert.deepEqual(Buffer.from(rangeData), data.subarray(film.bytes - 1024), 'actual tail bytes')
        const variants = []
        for (const [value, start, end] of [['bytes=0-511', 0, 511], ['bytes=-512', film.bytes - 512, film.bytes - 1], [`bytes=${film.bytes - 512}-`, film.bytes - 512, film.bytes - 1]]) {
          const response = await request(url, { headers: { Range: value } })
          const body = Buffer.from(await response.arrayBuffer())
          assert.equal(response.status, 206)
          assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${film.bytes}`)
          assert.equal(Number(response.headers.get('content-length')), end - start + 1)
          assert.deepEqual(body, data.subarray(start, end + 1), 'actual selected bytes')
          variants.push({ request: value, status: response.status, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })
        }
        const etag = head.headers.get('etag')
        assert.equal(etag, `"${film.sha256}"`)
        for (const headers of [{ Range: 'bytes=garbage' }, { Range: 'bytes=0-1,4-5' }, { Range: 'bytes=0-1', 'If-Range': '"different"' }, { Range: 'bytes=0-1', 'If-Range': `W/${etag}` }, { Range: 'bytes=0-1', 'If-Range': 'Wed, 01 Oct 2025 00:00:00 GMT' }]) {
          const response = await request(url, { headers })
          const body = Buffer.from(await response.arrayBuffer())
          assert.equal(response.status, 200)
          assert.equal(response.headers.get('content-range'), null)
          assert.equal(Number(response.headers.get('content-length')), film.bytes)
          assert.equal(createHash('sha256').update(body).digest('hex'), film.sha256)
          variants.push({ request: headers, status: response.status, measuredBytes: body.length })
        }
        for (const value of [`bytes=${film.bytes}-`, 'bytes=-0']) {
          const response = await request(url, { headers: { Range: value } })
          assert.equal(response.status, 416)
          assert.equal(response.headers.get('content-range'), `bytes */${film.bytes}`)
          assert.equal((await response.arrayBuffer()).byteLength, 0)
          variants.push({ request: value, status: response.status })
        }
        for (const [headers, status] of [[{ Range: 'bytes=0-1', 'If-Range': etag }, 206], [{ Range: 'bytes=0-1', 'If-None-Match': `W/${etag}` }, 304], [{ 'If-Match': '"different"' }, 412]]) {
          const response = await request(url, { headers })
          const body = Buffer.from(await response.arrayBuffer())
          assert.equal(response.status, status)
          assert.deepEqual(body, status === 206 ? data.subarray(0, 2) : Buffer.alloc(0))
          variants.push({ request: headers, status: response.status, measuredBytes: body.length })
        }
        measured.variants = variants
        await download.delete()
      }
      const bad = measurements.filter((m, i) => m.head.status !== 200 || !/^video\/mp4/.test(m.head.contentType ?? '') || Number(m.head.contentLength) !== films[i].bytes || m.range.status !== 206 || m.range.contentRange !== `bytes ${films[i].bytes - 1024}-${films[i].bytes - 1}/${films[i].bytes}` || m.range.measuredBytes !== 1024)
      assert.equal(bad.length, 0, JSON.stringify(bad))
      return 'six TEMP downloads hashed before deletion; exact HEAD lengths and byte slices; suffix/open-ended, conditional, invalid/multipart and 416 responses'
    } finally {
      writeFileSync(join(out, 'partner-films-http.json'), JSON.stringify({ revision: process.env.OBPAL_PARTNER_REVISION, protection, measurements }, null, 2))
      await ctx.close()
    }
  })
  if (measurements.length === 6) await sleep(61_000) // Clear artificial transport traffic before an ordinary browser visit.
}

/** Complete playback remains measurable independently of the native worker's early range-seek limitation. */
async function runFilmPlayback(browser, origin) {
  const films = JSON.parse(readFileSync(fileURLToPath(new URL('../public/campaign/films/manifest.json', import.meta.url)), 'utf8')).films
  const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'film-playback')
  mkdirSync(out, { recursive: true })
  const raw = rawRun(out), frames = [], measurements = []
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  let page
  const state = video => video.evaluate(el => ({ duration: el.duration, width: el.videoWidth, height: el.videoHeight, readyState: el.readyState, currentTime: el.currentTime, seeking: el.seeking, ended: el.ended, error: el.error?.message, bufferedEnd: el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0 }))
  const until = async (video, predicate, deadline) => {
    let seen
    do { seen = await state(video); if (predicate(seen)) return seen; await sleep(100) } while (Date.now() < deadline)
    throw new Error(JSON.stringify(seen))
  }
  const shot = async (id, failed = false) => {
    mkdirSync(join(raw, id), { recursive: true })
    await page.screenshot({ path: join(raw, id, 'screen.png') })
    frames.push({ path: `${id}/screen.png`, failed })
  }
  try {
    page = await ctx.newPage()
    await page.goto(origin + '/campaign/')
    for (const film of films) await check(`partner film buffered playback: ${film.id} (early HTTP range seeking remains a separate gate)`, async () => {
      const video = page.locator(`#${film.id} video`)
      try {
        await video.scrollIntoViewIfNeeded()
        await video.evaluate(el => { el.muted = true; return el.play() })
        const playing = await until(video, s => s.currentTime > .2 && s.readyState >= 2, Date.now() + 30_000)
        assert(Math.abs(playing.duration - film.duration) < .1)
        assert.equal(playing.width, film.width); assert.equal(playing.height, film.height)
        // Buffered completion is separate from the early range-seek proof in the main collection check.
        const buffered = await until(video, s => s.bufferedEnd >= s.duration - .05, Date.now() + (film.duration + 10) * 1000)
        await video.evaluate(el => { el.pause(); el.currentTime = el.duration - .3 })
        await until(video, s => !s.seeking && s.currentTime > s.duration - .5 && s.readyState >= 2, Date.now() + 10_000)
        await shot(film.id + '-buffered-ending')
        await video.evaluate(el => el.play())
        const ended = await until(video, s => s.ended, Date.now() + 10_000)
        measurements.push({ id: film.id, playing, buffered, ended, seekScope: 'After full buffer; no claim of early byte-range seek support', mutedForAutomation: true })
        return `${playing.duration}s; ${playing.width}x${playing.height}; advances, full buffer, ending seek and ended`
      } catch (error) {
        await shot(film.id + '-failure', true)
        measurements.push({ id: film.id, failed: true, state: await state(video), error: error.message })
        throw error
      } finally { await video.evaluate(el => el.pause()) }
    })
  } finally {
    writeFileSync(join(out, 'film-playback.json'), JSON.stringify({ revision: process.env.OBPAL_PARTNER_REVISION, limitation: 'Native HTTP range support tested separately; this proves buffered playback only.', measurements }, null, 2))
    writeFileSync(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, frames }, null, 2))
    await ctx.close()
  }
}

/** Static films, real media playback and explicitly injected sharing outcomes, within the runner's browser lease. */
async function runPartnerFilms(browser, origin) {
  const legitimateTraffic = []
  const downloadActions = []
  const browserEvents = [], netEvents = []
  const browserLifecycles = [], cacheSignals = [], cacheCases = []
  let networkSession, clockOffsetMs
  const sequence = { startedAtMs: null, completedAtMs: null, phases: [] }
  const startFilm = (url, method, source, scenario, range = null) => {
    const attempt = { id: legitimateTraffic.length + 1, atMs: Date.now(), path: new URL(url).pathname, method, source, scenario, range }
    legitimateTraffic.push(attempt)
    return attempt
  }
  const watchFilms = (ctx, scenario) => {
    const attempts = new WeakMap()
    let activeDownload = null
    ctx.on('request', request => {
      const path = new URL(request.url()).pathname
      if (!path.startsWith('/campaign/films/') || !path.endsWith('.mp4')) return
      // Page events omit download-attribute requests. NetLog supplies the browser start identities.
      const attempt = { atMs: Date.now(), path, method: request.method(), scenario, range: request.headers().range || null }
      browserEvents.push(attempt)
      attempt.navigation = request.isNavigationRequest()
      attempts.set(request, attempt)
      if (activeDownload && request.method() === 'GET' && path === activeDownload.path) {
        attempt.downloadActionId = activeDownload.id
      }
    })
    ctx.on('response', response => {
      const attempt = attempts.get(response.request())
      if (attempt) { attempt.status = response.status(); attempt.responseAtMs = Date.now() }
    })
    ctx.on('requestfinished', request => { const attempt = attempts.get(request); if (attempt) attempt.finishedAtMs = Date.now() })
    ctx.on('requestfailed', request => {
      const attempt = attempts.get(request)
      if (attempt) { attempt.failure = request.failure()?.errorText || 'Unknown request failure'; attempt.failedAtMs = Date.now() }
    })
    return {
      async attach(page) {
        if (!networkSession) {
          networkSession = await browser.newBrowserCDPSession()
          networkSession.on('Tracing.dataCollected', event => netEvents.push(...event.value.filter(value => value.cat?.includes('netlog'))))
          await networkSession.send('Tracing.start', { categories: 'netlog', transferMode: 'ReportEvents' })
        }
        const session = await ctx.newCDPSession(page)
        const requests = new Map()
        session.on('Network.requestWillBeSent', event => {
          clockOffsetMs ??= event.wallTime * 1000 - event.timestamp * 1000
          requests.set(event.requestId, { path: new URL(event.request.url).pathname, atMs: event.wallTime * 1000 })
        })
        session.on('Network.responseReceived', event => {
          const request = requests.get(event.requestId)
          if (request && (event.response.fromDiskCache || event.response.fromPrefetchCache)) cacheSignals.push({ ...request, status: event.response.status, fromDiskCache: !!event.response.fromDiskCache, fromPrefetchCache: !!event.response.fromPrefetchCache })
        })
        await session.send('Network.enable')
      },
      beginDownload(film) {
        activeDownload = { id: downloadActions.length + 1, film: film.id, scenario, path: '/campaign/films/' + film.file, startedAtMs: Date.now(), attemptIds: [], lifecycleIds: [] }
        downloadActions.push(activeDownload)
        return activeDownload
      },
      endDownload() { activeDownload = null },
    }
  }
  const finishBrowserStarts = async () => {
    const completed = new Promise(resolve => networkSession.once('Tracing.tracingComplete', resolve))
    await networkSession.send('Tracing.end')
    await completed
    assert(Number.isFinite(clockOffsetMs), 'Chromium monotonic/wall clock anchor missing')
    // Chromium reuses exported async trace tokens after a source dies; its creation time distinguishes lifetimes.
    const identity = event => `${event.pid}:${JSON.stringify(event.id2 ?? event.id ?? event.tid)}:${event.args?.params?.source_start_time}`
    const groups = new Map()
    const starts = netEvents.filter(event => event.name === 'URL_REQUEST_START_JOB' && event.args?.params?.url?.includes('/campaign/films/') && event.args.params.url.endsWith('.mp4'))
    const sourceTimes = new Set(starts.map(event => event.args.params.source_start_time))
    writeFileSync(join(out, 'browser-network-starts.json'), JSON.stringify({ clockOffsetMs, starts, events: netEvents.filter(event => sourceTimes.has(event.args?.params?.source_start_time)) }, null, 2))
    for (const event of netEvents) {
      const params = event.args?.params
      if (event.name !== 'URL_REQUEST_START_JOB' || !params?.url || !params.method) continue
      const path = new URL(params.url).pathname
      if (!path.startsWith('/campaign/films/') || !path.endsWith('.mp4')) continue
      const key = identity(event)
      assert(!groups.has(key), 'repeated browser source/job requires explicit redirect accounting')
      groups.set(key, { key, path, method: params.method, atMs: event.ts / 1000 + clockOffsetMs, events: [] })
    }
    for (const event of netEvents) {
      const group = groups.get(identity(event))
      if (group) group.events.push({ name: event.name, phase: event.ph, timeUs: event.ts, params: event.args?.params })
    }
    writeFileSync(join(out, 'browser-network-starts.json'), JSON.stringify({ clockOffsetMs, method: 'Read-only NetLog tracing enabled before actions; no cache or interception changes.', sources: [...groups.values()] }, null, 2))
    for (const group of [...groups.values()].sort((a, b) => a.atMs - b.atMs)) {
      const headers = group.events.flatMap(event => event.params?.headers || [])
      const range = headers.find(value => /^range:/i.test(value))?.replace(/^range:\s*/i, '') || null
      const phase = sequence.phases.find(value => group.atMs >= value.startedAtMs && group.atMs <= value.completedAtMs)
      const lifecycle = { id: group.key, atMs: group.atMs, path: group.path, method: group.method, range, scenario: phase?.name || 'between measured phases', admissionIds: [] }
      browserLifecycles.push(lifecycle)
      const pageEvent = browserEvents.find(value => !value.linked && value.path === group.path && value.method === group.method && Math.abs(value.atMs - group.atMs) < 250 && value.range === range)
      if (pageEvent) { pageEvent.linked = true; Object.assign(lifecycle, { ...pageEvent, atMs: group.atMs }); delete lifecycle.linked }
      const action = downloadActions.find(value => value.path === group.path && group.method === 'GET' && !range && group.atMs >= value.startedAtMs && group.atMs <= value.completedAtMs)
      if (action) { lifecycle.downloadActionId = action.id; action.lifecycleIds.push(lifecycle.id) }
      let transmission = null, sendIndex = 0
      for (const event of group.events.sort((a, b) => a.timeUs - b.timeUs)) {
        if (event.name.includes('SEND_REQUEST_HEADERS')) {
          assert.equal(event.name, 'HTTP_TRANSACTION_SEND_REQUEST_HEADERS', 'unhandled wire protocol must not be discounted')
          const request = event.params.line?.match(/^(\S+) (\S+) HTTP\/\S+/)
          assert(request, 'wire method/path missing')
          const path = new URL(request[2], origin).pathname
          assert.equal(path, group.path, 'wire redirect requires explicit film association')
          const wireRange = event.params.headers.find(value => /^range:/i.test(value))?.replace(/^range:\s*/i, '') || null
          transmission = startFilm(origin + path, request[1], 'Chromium NetLog HTTP_TRANSACTION_SEND_REQUEST_HEADERS', lifecycle.scenario, wireRange)
          Object.assign(transmission, { atMs: event.timeUs / 1000 + clockOffsetMs, browserSourceId: group.key, sendIndex: ++sendIndex, sendTimeUs: event.timeUs, responses: [] })
          lifecycle.admissionIds.push(transmission.id)
          if (action) { transmission.downloadActionId = action.id; action.attemptIds.push(transmission.id) }
        } else if (event.name === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS') {
          assert(transmission, 'wire response without an observed send')
          const status = event.params.headers.find(value => /^HTTP\/\S+ \d{3}/.test(value))?.match(/^HTTP\/\S+ (\d{3})/)
          assert(status, 'wire response status missing')
          const response = { status: Number(status[1]), atMs: event.timeUs / 1000 + clockOffsetMs }
          transmission.responses.push(response)
          if (response.status >= 200) { transmission.status = response.status; transmission.responseAtMs = response.atMs }
        } else if (transmission && event.params?.net_error < 0) {
          transmission.networkError = event.params.net_error
          transmission.failedAtMs = event.timeUs / 1000 + clockOffsetMs
        }
      }
      lifecycle.wireTransmissions = sendIndex
      if (!sendIndex) {
        const cache = cacheSignals.find(value => value.path === group.path && Math.abs(value.atMs - group.atMs) < 250)
        const read = group.events.some(event => /HTTP_CACHE_READ_(?:DATA|SPARSE_DATA)/.test(event.name))
        assert(cache && read, 'zero-send film source has no established cache serving; unknown admissions must not be discounted')
        const attempt = startFilm(origin + group.path, group.method, 'conservative possible admission: confirmed zero-send browser cache', lifecycle.scenario, range)
        Object.assign(attempt, { atMs: group.atMs, browserSourceId: group.key, status: cache.status, cacheEvidence: cache })
        lifecycle.admissionIds.push(attempt.id)
        cacheCases.push({ lifecycleId: group.key, admissionId: attempt.id, cacheEvidence: cache, cacheReadObserved: read })
        if (action) { attempt.downloadActionId = action.id; action.attemptIds.push(attempt.id) }
      }
    }
    assert(browserEvents.every(value => value.linked), 'a page-observed film start is missing from NetLog')
    await networkSession.detach()
    networkSession = null
  }
  const filmFetch = async (url, options = {}) => {
    const attempt = startFilm(url, options.method || 'GET', 'standalone fetch start', 'six-film viewing/early seeks/downloads', options.headers?.Range || null)
    try { const response = await fetch(url, options); attempt.status = response.status; attempt.responseAtMs = Date.now(); return response }
    catch (error) { attempt.failure = error.message; attempt.failedAtMs = Date.now(); throw error }
  }
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../public/campaign/films/manifest.json', import.meta.url)), 'utf8'))
  const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'partner-films')
  mkdirSync(out, { recursive: true })
  const raw = rawRun(out), frames = [], observations = []
  const downloadedMedia = async (download, film, action) => {
    assert.equal(download.suggestedFilename(), film.file)
    assert.equal(await download.failure(), null)
    const data = readFileSync(await download.path())
    const measured = { filename: download.suggestedFilename(), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    assert.equal(measured.bytes, film.bytes, 'downloaded file length')
    assert.equal(measured.sha256, film.sha256, 'downloaded file SHA-256')
    action.completedAtMs = Date.now()
    action.receipt = { ...measured, failure: null, url: download.url() }
    assert.equal(new URL(download.url()).pathname, action.path)
    await download.delete()
    return measured
  }
  // Node polls synchronous media state even when page scripts or animation-frame callbacks cannot run.
  const mediaState = video => video.evaluate(el => ({ duration: el.duration, width: el.videoWidth, height: el.videoHeight, readyState: el.readyState, networkState: el.networkState, currentTime: el.currentTime, seeking: el.seeking, paused: el.paused, ended: el.ended, visibility: document.visibilityState, error: el.error && { code: el.error.code, message: el.error.message }, buffered: Array.from({ length: el.buffered.length }, (_, i) => [el.buffered.start(i), el.buffered.end(i)]) }))
  const mediaUntil = async (video, predicate, step) => {
    const deadline = Date.now() + 30_000
    let state
    do {
      state = await mediaState(video)
      if (predicate(state)) return state
      await sleep(100)
    } while (Date.now() < deadline)
    throw new Error(`${step}: ${JSON.stringify(state)}`)
  }
  const shot = async (page, state, failed = false) => {
    mkdirSync(join(raw, state), { recursive: true })
    await page.screenshot({ path: join(raw, state, 'screen.png') })
    frames.push({ path: `${state}/screen.png`, failed })
  }
  // Observe actual effects; only the separately labelled share cases replace APIs.
  const observe = () => {
    window.__filmEffects = []
    window.__filmDraws = 0
    const fill = CanvasRenderingContext2D.prototype.fill
    CanvasRenderingContext2D.prototype.fill = function (...args) {
      if (this.canvas.id === 'film-dots') window.__filmDraws++
      return fill.apply(this, args)
    }
    const wrap = (object, name, effect) => {
      const method = object?.[name]
      if (typeof method === 'function') object[name] = function (...args) {
        window.__filmEffects.push(effect)
        return method.apply(this, args)
      }
    }
    for (const name of ['setItem', 'removeItem', 'clear']) wrap(Storage.prototype, name, `storage.${name}`)
    wrap(window, 'fetch', 'fetch')
    wrap(XMLHttpRequest.prototype, 'send', 'xhr.send')
    wrap(navigator, 'sendBeacon', 'beacon')
    wrap(indexedDB, 'open', 'indexedDB.open')
    wrap(window.caches, 'open', 'cache.open')
    wrap(navigator.serviceWorker, 'register', 'serviceWorker.register')
    wrap(navigator.clipboard, 'writeText', 'clipboard.writeText')
    wrap(navigator, 'share', 'navigator.share')
    for (const name of ['WebSocket', 'RTCPeerConnection', 'PaymentRequest']) {
      if (typeof window[name] === 'function') window[name] = new Proxy(window[name], { construct(target, args) {
        window.__filmEffects.push(name); return Reflect.construct(target, args)
      } })
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    if (cookie?.set) Object.defineProperty(Document.prototype, 'cookie', { ...cookie, set(value) {
      window.__filmEffects.push('cookie.write'); cookie.set.call(this, value)
    } })
  }
  const geometry = page => page.evaluate(async () => {
    const videos = await Promise.all([...document.querySelectorAll('video')].map(async video => {
      const box = video.getBoundingClientRect(), image = new Image()
      image.src = video.poster
      await image.decode()
      const w = video.videoWidth || image.naturalWidth, h = video.videoHeight || image.naturalHeight
      const scale = Math.min(box.width / w, box.height / h)
      return { id: video.closest('article').id, fit: getComputedStyle(video).objectFit, box: { width: box.width, height: box.height }, frame: { width: w * scale, height: h * scale }, poster: { width: image.naturalWidth, height: image.naturalHeight }, controls: video.controls, playsInline: video.playsInline, preload: video.preload, autoplay: video.autoplay }
    }))
    return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, videos }
  })
  const assertGeometry = layout => {
    assert(!layout.overflow, `overflow at ${layout.width}px`)
    assert.equal(layout.videos.length, 6)
    for (const video of layout.videos) {
      assert.equal(video.fit, 'contain')
      assert(video.poster.width > 0 && video.poster.height > 0, `poster not decoded: ${video.id}`)
      assert(video.frame.width <= video.box.width + 1 && video.frame.height <= video.box.height + 1)
      assert(video.controls && video.playsInline && video.preload === 'none' && !video.autoplay)
    }
  }
  try {
    for (const width of [360, 390, 430, 1440]) for (const reduced of [false, true]) {
      const state = `${width}-${reduced ? 'reduced' : 'normal'}`
      await check(`partner films ${state}: entire posters, native themes, keyboard links and no unsolicited effects`, async () => {
        const ctx = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' })
        let page
        const requests = [], errors = []
        try {
          await ctx.addInitScript(observe)
          page = await ctx.newPage()
          page.on('pageerror', error => errors.push(error.message))
          page.on('request', request => requests.push({ url: request.url(), method: request.method() }))
          await page.goto(origin + '/campaign/')
          await page.evaluate(() => document.fonts.ready)
          await page.waitForLoadState('networkidle')
          const layout = await geometry(page)
          assertGeometry(layout)
          assert(await page.locator('.logo svg').count())
          assert.equal(await page.locator('video').evaluateAll(videos => videos.every(v => v.readyState === 0 && v.networkState === 1)), true)
          assert(!requests.some(request => /\.mp4(?:\?|$)/.test(request.url)), 'media downloaded before play')
          assert(!requests.some(request => request.method !== 'GET' || !request.url.startsWith(origin + '/') || /\/api\/|\/r\//.test(request.url)))
          assert.deepEqual(await page.evaluate(() => window.__filmEffects), [])
          const storage = await ctx.storageState()
          assert.deepEqual(storage.cookies, [])
          assert(storage.origins.every(o => !o.localStorage.length))
          const urls = [origin + '/campaign/', ...manifest.films.map(film => origin + '/campaign/#' + film.id)]
          assert.deepEqual(await page.locator('[data-film-share] input').evaluateAll(inputs => inputs.map(input => input.value)), urls)
          await shot(page, state + '-hero')
          await page.locator('#original').evaluate(el => el.scrollIntoView({ block: 'start' }))
          await shot(page, state + '-landscape')
          await page.locator('#eight-arms').evaluate(el => el.scrollIntoView({ block: 'start' }))
          await shot(page, state + '-portrait')
          for (const theme of ['light', 'carbon']) {
            await page.locator('#film-surface').selectOption(theme)
            await page.waitForFunction(theme => document.documentElement.dataset.bbTheme === theme, theme)
            await page.waitForFunction(() => ![...document.documentElement.getAnimations(), ...document.body.getAnimations()].some(animation => animation.playState === 'running'))
            await page.evaluate(() => scrollTo(0, 0))
            await shot(page, state + '-' + theme)
            assertGeometry(await geometry(page))
          }
          for (const id of ['original', 'eight-arms']) {
            const link = page.locator(`#${id} [data-permalink]`)
            await link.focus()
            assert(await link.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none'))
            await page.keyboard.press('Enter')
            assert.equal(page.url(), origin + '/campaign/#' + id)
            await page.locator(`#${id} [data-film-share]`).evaluate(el => el.scrollIntoView({ block: 'center' }))
            await shot(page, state + '-' + id + '-links')
          }
          await page.evaluate(() => scrollTo(0, 0))
          await sleep(150)
          const draws = await page.evaluate(() => window.__filmDraws)
          assert(draws > 0, 'native dots did not draw')
          await sleep(150)
          if (reduced) assert.equal(await page.evaluate(() => window.__filmDraws), draws)
          assert.deepEqual(await page.evaluate(() => window.__filmEffects), [])
          assert.deepEqual(await ctx.storageState(), storage)
          assert.deepEqual(errors, [])
          observations.push({ state, dpr: 1, layout, urls, requests, effects: [], themes: ['light', 'carbon'], reducedMotion: reduced, initialReadyState: 0 })
          return 'six posters; no MP4 before play; no third-party, API or storage effects; route-qualified URLs'
        } catch (error) { if (page) await shot(page, state + '-failure', true); throw error }
        finally { await ctx.close() }
      })
    }
    await check('partner films: six real players advance, seek to the complete ending and download with range support', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
      const accounting = watchFilms(ctx, 'six-film viewing/early seeks/downloads')
      sequence.startedAtMs = Date.now()
      sequence.phases.push({ name: 'six-film viewing/early seeks/downloads', startedAtMs: sequence.startedAtMs })
      let page, currentFilm
      const media = [], responses = []
      try {
        page = await ctx.newPage()
        page.on('response', response => { if (response.url().endsWith('.mp4')) responses.push({ url: response.url(), status: response.status() }) })
        await accounting.attach(page)
        await page.goto(origin + '/campaign/')
        for (const film of manifest.films) {
          currentFilm = film.id
          const video = page.locator(`#${film.id} video`)
          await video.scrollIntoViewIfNeeded()
          await video.evaluate(el => { el.muted = true; return el.play() })
          const playing = await mediaUntil(video, state => state.readyState >= 2 && state.currentTime > .2, film.id + ' advances')
          assert(Math.abs(playing.duration - film.duration) < .1)
          assert.equal(playing.width, film.width); assert.equal(playing.height, film.height)
          if (film.id === 'original') {
            // This injected click listener exercises the actual Fullscreen API under a trusted gesture.
            await video.evaluate(el => el.addEventListener('click', () => el.requestFullscreen(), { once: true }))
            await video.click()
            await page.waitForFunction(() => document.fullscreenElement?.tagName === 'VIDEO')
            await shot(page, 'fullscreen-original')
            await page.evaluate(() => document.exitFullscreen())
            assert.equal(await page.evaluate(() => document.fullscreenElement), null)
          }
          await video.evaluate(el => { el.pause(); el.currentTime = Math.max(0, el.duration - .3) })
          await video.evaluate(el => el.play())
          await mediaUntil(video, state => !state.seeking && state.currentTime > state.duration - .5 && state.readyState >= 2, film.id + ' near-end seek')
          await shot(page, `ending-${film.id}`)
          const ended = await mediaUntil(video, state => state.ended, film.id + ' ended')
          const url = origin + '/campaign/films/' + film.file
          const head = await filmFetch(url, { method: 'HEAD' })
          assert.equal(head.status, 200)
          assert.match(head.headers.get('content-type'), /^video\/mp4/)
          assert.equal(Number(head.headers.get('content-length')), film.bytes)
          const range = await filmFetch(url, { headers: { Range: `bytes=${film.bytes - 1024}-${film.bytes - 1}` } })
          assert.equal(range.status, 206)
          assert.equal(range.headers.get('content-range'), `bytes ${film.bytes - 1024}-${film.bytes - 1}/${film.bytes}`)
          assert.equal((await range.arrayBuffer()).byteLength, 1024)
          const downloaded = page.waitForEvent('download')
          const action = accounting.beginDownload(film)
          await page.locator(`#${film.id} a[download]`).click()
          const download = await downloaded
          const measured = await downloadedMedia(download, film, action)
          accounting.endDownload()
          media.push({ id: film.id, playing, ended, download: { ...measured, contentType: head.headers.get('content-type'), range: range.headers.get('content-range'), status: range.status } })
        }
        assert(responses.some(response => response.status === 206), 'browser media range request not observed')
        observations.push({ scenario: 'real playback and downloads', mutedForAutomation: true, media, browserMediaResponses: responses })
        return '6/6 advance and end; exact dimensions/durations; six downloads; HEAD lengths and tail-range 206'
      } catch (error) {
        if (page) await shot(page, 'playback-failure', true)
        observations.push({ scenario: 'real playback failure', currentFilm, error: error.message, completedMedia: media, browserMediaResponses: responses })
        throw error
      } finally { await ctx.close(); sequence.phases.at(-1).completedAtMs = Date.now() }
    })
    for (const mode of ['native-resolve', 'native-abort', 'native-denied', 'clipboard-resolve', 'clipboard-denied', 'unsupported']) {
      await check(`partner films sharing: ${mode} (injected mocks, no actual-device sending)`, async () => {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
        try {
          await ctx.addInitScript(mode => {
            window.__filmShareCalls = []
            Object.defineProperty(navigator, 'share', { configurable: true, value: mode.startsWith('native') ? async data => {
              window.__filmShareCalls.push({ kind: 'share', data, active: navigator.userActivation.isActive })
              if (mode === 'native-abort') throw new DOMException('Injected cancellation or absent targets', 'AbortError')
              if (mode === 'native-denied') throw new DOMException('Injected denied sharing', 'NotAllowedError')
            } : undefined })
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unsupported' ? undefined : { writeText: async url => {
              window.__filmShareCalls.push({ kind: 'clipboard', url, active: navigator.userActivation.isActive })
              if (mode === 'clipboard-denied') throw new DOMException('Injected denied clipboard', 'NotAllowedError')
            } } })
          }, mode)
          const page = await ctx.newPage()
          await page.goto(origin + '/campaign/')
          await page.waitForLoadState('networkidle')
          assert.deepEqual(await page.evaluate(() => window.__filmShareCalls), [])
          const groups = page.locator('[data-film-share]')
          const cases = [{ id: 'page', title: 'ob.Pal in motion', url: origin + '/campaign/' }, ...manifest.films.map(film => ({ id: film.id, title: film.title, url: origin + '/campaign/#' + film.id }))]
          for (const [i, item] of cases.entries()) {
            const group = groups.nth(i), button = group.locator('[data-action=share]'), manual = group.locator('input')
            assert.equal(await manual.inputValue(), item.url)
            await button.click()
            await page.waitForFunction(id => !document.querySelector(`#url-${id}`).closest('[data-film-share]').querySelector('button').disabled, item.id)
            const status = await group.locator('[role=status]').innerText()
            if (mode === 'native-resolve') assert.equal(status, "Link handed to your device's sharing feature.")
            else if (mode === 'native-abort') assert.match(status, /cancelled or unavailable/)
            else if (mode === 'clipboard-resolve') assert.equal(status, 'Link copied.')
            else assert.match(status, /Select and copy/)
            assert(await button.isEnabled())
            assert(await manual.isVisible())
            if (mode.endsWith('denied') || mode === 'native-abort' || mode === 'unsupported') {
              assert(await manual.evaluate(input => input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length))
            }
            if (i < 2) await shot(page, `share-${mode}-${item.id}`)
          }
          const calls = await page.evaluate(() => window.__filmShareCalls)
          if (mode === 'unsupported') assert.deepEqual(calls, [])
          else {
            assert.equal(calls.length, 7)
            calls.forEach((call, i) => {
              assert(call.active, 'sharing API called without active user gesture')
              if (mode.startsWith('native')) assert.deepEqual(call.data, { title: cases[i].title, url: cases[i].url })
              else assert.equal(call.url, cases[i].url)
            })
          }
          // Copy is a separate gesture even when native sharing is available or has been cancelled.
          if (mode !== 'unsupported') {
            await groups.first().locator('[data-action=copy]').click()
            await page.waitForFunction(() => !document.querySelector('[data-action=copy]').disabled)
            const copy = (await page.evaluate(() => window.__filmShareCalls)).at(-1)
            assert.deepEqual(copy, { kind: 'clipboard', url: cases[0].url, active: true })
          }
          observations.push({ scenario: 'injected sharing mocks', mode, actualDeviceSending: 'unverified', calls, expectedUrls: cases.map(item => item.url) })
          return '7 exact page/film payloads or selectable URLs; gesture-only APIs; buttons re-enabled'
        } finally { await ctx.close() }
      })
    }
    await check('partner films without JavaScript: native play, downloads and all stable fragment links', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false, acceptDownloads: true })
      const accounting = watchFilms(ctx, 'no-JS native viewing/download')
      sequence.phases.push({ name: 'no-JS native viewing/download', startedAtMs: Date.now() })
      let page
      try {
        page = await ctx.newPage()
        const requests = []
        await accounting.attach(page)
        page.on('request', request => requests.push(request.url()))
        await page.goto(origin + '/campaign/')
        await page.waitForLoadState('networkidle')
        assert.equal(await page.locator('video[controls][playsinline][preload=none]').count(), 6)
        assert.equal(await page.locator('a[download]').count(), 6)
        assert.equal(await page.locator('[data-action=share]:visible, [data-action=copy]:visible').count(), 0)
        assert(!requests.some(url => url.endsWith('.mp4')))
        for (const film of manifest.films) {
          await page.locator(`#${film.id} [data-permalink]`).click()
          assert.equal(page.url(), origin + '/campaign/#' + film.id)
          assert(await page.locator(`#${film.id} video`).isVisible())
        }
        const video = page.locator('#eight-arms video')
        await video.scrollIntoViewIfNeeded()
        await video.evaluate(el => { el.muted = true; return el.play() })
        const playing = await mediaUntil(video, state => state.currentTime > .2 && state.readyState >= 2, 'no-JS native playback advances')
        await video.evaluate(el => el.pause())
        const downloading = page.waitForEvent('download')
        const action = accounting.beginDownload(manifest.films[1])
        await page.locator('#eight-arms a[download]').click()
        const download = await downloading
        const measured = await downloadedMedia(download, manifest.films[1], action)
        accounting.endDownload()
        await page.locator('#eight-arms').evaluate(el => el.scrollIntoView({ block: 'start' }))
        await shot(page, 'no-js-portrait')
        assertGeometry(await geometry(page))
        observations.push({ scenario: 'JavaScript disabled', nativePlaybackAdvanced: true, playing, sixPermalinks: true, download: measured, layout: await geometry(page) })
        return 'six static players/downloads/fragments; native playback advances; download completes'
      } catch (error) {
        if (page) await shot(page, 'no-js-failure', true)
        observations.push({ scenario: 'JavaScript disabled failure', error: error.message })
        throw error
      } finally { await ctx.close(); sequence.completedAtMs = Date.now(); sequence.phases.at(-1).completedAtMs = sequence.completedAtMs }
    })
    await check('partner films admission accounting: every wire send, seven completed downloads and conservative minute budget', async () => {
      await finishBrowserStarts()
      assert.equal(downloadActions.length, 7)
      assert.equal(new Set(legitimateTraffic.map(attempt => attempt.id)).size, legitimateTraffic.length)
      for (const action of downloadActions) {
        assert(action.receipt, `download ${action.id} missing a completed measured receipt`)
        assert(action.attemptIds.length > 0, `download ${action.id} has no observed request start; cache serving is not established`)
        assert(action.lifecycleIds.length > 0, `download ${action.id} missing a browser lifecycle`)
        for (const id of action.lifecycleIds) {
          const lifecycle = browserLifecycles.find(value => value.id === id)
          lifecycle.downloadReceipt = action.receipt
          if (lifecycle.failure?.includes('ERR_ABORTED') && lifecycle.navigation) lifecycle.failureClassification = 'Chromium download-navigation abort with completed measured download; not a failed download'
        }
        for (const id of action.attemptIds) {
          const attempt = legitimateTraffic.find(attempt => attempt.id === id)
          attempt.downloadReceipt = action.receipt
          if (attempt.failure?.includes('ERR_ABORTED') && attempt.navigation) attempt.failureClassification = 'Chromium download-navigation abort with completed measured download; not a failed download'
        }
      }
      const peak = Math.max(0, ...legitimateTraffic.map(attempt => legitimateTraffic.filter(other => other.atMs <= attempt.atMs && other.atMs > attempt.atMs - 60_000).length))
      assert(peak < 60, `ordinary sequence peak ${peak} must stay below 60`)
      assert(!legitimateTraffic.some(attempt => [429, 503].includes(attempt.status) || attempt.responses?.some(response => [429, 503].includes(response.status))), 'ordinary sequence admission denied')
      const wireTransmissions = legitimateTraffic.filter(attempt => attempt.sendIndex).length
      assert.equal(wireTransmissions, browserLifecycles.reduce((count, lifecycle) => count + lifecycle.wireTransmissions, 0))
      observations.push({ scenario: 'complete wire admission accounting', wireTransmissions, standaloneStarts: legitimateTraffic.filter(attempt => !attempt.browserSourceId).length, confirmedZeroSendCacheCases: cacheCases.length, conservativeAdmissions: legitimateTraffic.length, peakRolling60s: peak, remainingMargin: 60 - peak, completedDownloadActions: 7 })
      return `${wireTransmissions} browser wire sends; ${legitimateTraffic.length} total conservative admissions; peak ${peak}/60; margin ${60 - peak}; seven measured download receipts; no 429/503`
    })
    if (process.env.OBPAL_PARTNER_BASELINE) await check('partner films baseline: supplied index at matching phone and desktop widths (local fixture)', async () => {
      let html = readFileSync(process.env.OBPAL_PARTNER_BASELINE, 'utf8')
      const sources = ['obpal-v3-dots-current-logo-16x9.mp4', '01-eight-arms/01-eight-arms.mp4', '02-make-a-mark/02-make-a-mark.mp4', '03-take-the-ring/03-take-the-ring.mp4', '04-screen-to-track/04-screen-to-track.mp4', '05-body-response/05-body-response.mp4']
      const posters = ['revised-original-logo-check.png', '01-eight-arms/poster.jpg', '02-make-a-mark/poster.jpg', '03-take-the-ring/poster.jpg', '04-screen-to-track/poster.jpg', '05-body-response/poster.jpg']
      manifest.films.forEach((film, i) => { html = html.replaceAll(sources[i], '/campaign/films/' + film.file).replaceAll(posters[i], '/campaign/films/' + film.poster) })
      for (const width of [390, 1440]) {
        const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, javaScriptEnabled: false })
        try {
          const page = await ctx.newPage()
          await page.route(origin + '/campaign-source/', route => route.fulfill({ contentType: 'text/html', body: html }))
          await page.goto(origin + '/campaign-source/')
          await page.waitForLoadState('networkidle')
          await shot(page, `baseline-${width}-hero`)
          await page.locator('article').nth(1).evaluate(el => el.scrollIntoView({ block: 'start' }))
          await shot(page, `baseline-${width}-portrait`)
        } finally { await ctx.close() }
      }
      return 'supplied read-only HTML; media URLs mapped to equivalent local assets; fixture never public'
    })
    cspCheck()
  } finally {
    await networkSession?.detach().catch(() => {})
    const maximumMinuteRequests = Math.max(0, ...legitimateTraffic.map(r => legitimateTraffic.filter(other => other.atMs <= r.atMs && other.atMs > r.atMs - 60_000).length))
    writeFileSync(join(out, 'partner-films.json'), JSON.stringify({ revision: process.env.OBPAL_PARTNER_REVISION, browser: browser.version(), deviceScope: 'Desktop Chromium and emulated widths; no physical-device or actual share-delivery claim.', observations, admissionMeasurement: { counting: 'One admission identity per actual browser request-header send (including retries) or standalone Fetch start. Source lifecycles/page callbacks never increment admissions. Confirmed zero-send cache sources count one explicitly conservative possible admission; unknown zero-send sources fail.', sequence: { ...sequence, scope: 'Ordinary six-film viewing/early seeks/downloads, intervening sharing mocks with no film requests, then no-JS viewing/download. Protected HTTP stress and buffered playback are separate phases.' }, requests: legitimateTraffic, browserLifecycles, cacheCases, downloadActions, maximumMinuteRequests, configuredMinuteRequests: 60, measuredBurstMargin: 60 - maximumMinuteRequests } }, null, 2))
    writeFileSync(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, frames }, null, 2))
  }
}


let worker = null
let browser = null
let exitCode = 0
try {
  worker = await startWorker({ port: PORT })
  console.log(`ob.Pal pages e2e (${worker.origin})`)
  browser = await chromium.launch(e2eBrowserOptions({ executablePath, headless: !HEADED }))
  if (!ONLY || ONLY === 'partner-films' || ONLY === 'partner-films-http') await runFilmDownloads(browser, worker.origin)
  if (!ONLY || ONLY === 'partner-films-playback') await runFilmPlayback(browser, worker.origin)
  if (!ONLY || ONLY === 'campaign' || ONLY === 'partner-films' || ONLY === 'partner-films-accounting') await check('Retained offer previews are excluded from public assets', () => runCampaignExclusion(worker.origin))
  if (!ONLY || ONLY === 'partner-films' || ONLY === 'partner-films-accounting') await runPartnerFilms(browser, worker.origin)
  if (!ONLY) await check('Logos inherit live surface and accent tokens', () => runBrand(browser, worker.origin))
  if (!ONLY || ONLY === 'store') await runStoreKit(browser, check, SHOTS)
  if (ONLY === 'try') {
    await check('Try keeps readable controller feedback without constellation motion', () => runTry(browser, worker.origin))
  } else if (ONLY === 'viewer') {
    await runViewerScene(browser, worker.origin, check)
  } else if (ONLY === 'interactions') {
    await siteInteractionStates(browser, worker.origin, check, (process.env.OBPAL_E2E_INTERACTIONS_ONLY || '').split(',').filter(Boolean))
  } else if (!ONLY) {
  await siteInteractionStates(browser, worker.origin, check)
  await runLinkHero(browser, worker.origin, check)
  await guardSiteButtons(browser, worker.origin, SITE_BUTTON_ROUTES.filter(([name]) => name !== 'home'), check)
  await check('IndexNow key is served at its matching public URL', async () => {
    const file = readdirSync(fileURLToPath(new URL('../public/', import.meta.url))).find(name => /^[a-f0-9]{32}\.txt$/.test(name))
    if (!file) throw new Error('key file missing')
    const response = await fetch(worker.origin + '/' + file)
    if (!response.ok || (await response.text()).trim() !== file.slice(0, -4)) throw new Error('key file is not served')
  })
  await check('robots, sitemap and agent digest are served', async () => {
    const [robots, sitemap, llms, full] = await Promise.all(['/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt'].map(p => fetch(worker.origin + p)))
    for (const r of [robots, sitemap, llms, full]) if (!r.ok) throw new Error(`${r.url}: ${r.status}`)
    const rules = await robots.text()
    if (!rules.includes('search=yes, ai-input=yes, ai-train=yes') || !rules.includes('Sitemap: https://obpal.blackboxes.net/sitemap.xml') || rules.includes('Disallow:')) throw new Error('robots rules')
    if (!(await llms.text()).includes('ob.Pal Link') || !(await full.text()).includes('WebRTC')) throw new Error('agent digest')
    const xml = await sitemap.text()
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    if (urls.length < 40 || urls.some(u => u.includes('/sim/device/'))) throw new Error(`${urls.length} sitemap URLs`)
    for (const canonical of urls) {
      const response = await fetch(worker.origin + new URL(canonical).pathname)
      if (!response.ok) throw new Error(`${canonical}: ${response.status}`)
      const html = await response.text()
      if (!html.includes(`<link rel="canonical" href="${canonical}"`)) throw new Error(`${canonical}: canonical`)
      const scripts = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)]
      if (!scripts.length) throw new Error(`${canonical}: JSON-LD missing`)
      for (const script of scripts) {
        const data = JSON.parse(script[1])
        if (new URL(canonical).pathname === '/') {
          for (const type of ['Organization', 'WebSite', 'SoftwareApplication']) {
            const node = data['@graph'].find(n => n['@type'] === type && (type !== 'SoftwareApplication' || n.name === 'ob.Pal'))
            if (!node?.alternateName?.includes('obpal') || !node?.sameAs?.includes('https://github.com/Axialon/obpal')) throw new Error(`${type}: name signals`)
          }
          if (!html.includes('<title>ob.Pal (obpal):')) throw new Error('home title')
          for (const name of ['description', 'og:description', 'twitter:description']) if (!html.match(new RegExp(`<meta (?:name|property)="${name}" content="[^"]*obpal`))) throw new Error(`${name}: plain spelling`)
        }
        if (new URL(canonical).pathname === '/link/') {
          const link = data['@graph'].find(n => n['@type'] === 'SoftwareApplication' && n.name === 'ob.Pal Link')
          const store = 'https://chromewebstore.google.com/detail/obpal-link/jnnpcnoilofjaffabnhecfokjjknlemg'
          if (link?.installUrl !== store || !html.includes(`href="${store}"`)) throw new Error('/link/: store install')
        }
      }
    }
    return `${urls.length} canonical pages with JSON-LD`
  })
  await check('controller is noindexed and old device URLs name the clean canonical', async () => {
    const phone = await (await fetch(worker.origin + '/p/')).text()
    if (!phone.includes('name="robots" content="noindex, follow"')) throw new Error('/p/ indexable')
    const old = await fetch(worker.origin + '/sim/device/?d=rover')
    if (!old.ok || !(await old.text()).includes('href="https://obpal.blackboxes.net/sim/rover/"')) throw new Error('old device URL')
  })
  await check('catalogue and device descriptions show without JavaScript', async () => {
    const ctx = await browser.newContext({ javaScriptEnabled: false })
    try {
      const page = await ctx.newPage()
      await page.goto(worker.origin + '/sim/')
      if (await page.locator('#seo-list li').count() < 41 || !await page.getByRole('link', { name: 'Rover', exact: true }).count()) throw new Error('catalogue text')
      await page.goto(worker.origin + '/sim/rover/')
      if (!await page.getByRole('heading', { name: 'Rover' }).count() || !await page.locator('#seo-device').getByText('Steering wheel').count()) throw new Error('device text and controls')
      await page.goto(worker.origin + '/')
      if (!await page.getByRole('heading', { name: /Your phone is the controller/ }).count() || !await page.getByText('Robot arms follow your hand', { exact: false }).count()) throw new Error('home text')
    } finally { await ctx.close() }
  })
  for (const path of PAGES) {
    await check(`${path} keeps to its policy, and its fonts come from here`, async () => {
      const ctx = await browser.newContext(path === '/p/' ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 800 } })
      try {
        const page = await ctx.newPage()
        const hostileName = '<img src=x onerror="window.templateInjection=true"> & "phone"'
        if (path === '/donate/') await page.route('**/api/donations/live', (route) => route.fulfill({ json: {
          status: 'ok', totalUsd: 10, backerCount: 1, recent: [{ donorName: hostileName, amountUsd: 10 }],
        } }))
        const errors = []
        const elsewhere = []
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('request', (r) => { if (!r.url().startsWith(worker.origin) && !/^(data|blob):/.test(r.url())) elsewhere.push(r.url()) })
        const seen = cspViolations.length
        const res = await page.goto(worker.origin + path, { waitUntil: 'load' })
        const headers = res.headers()
        if (path === '/p/' && !/camera=\(self\)/.test(headers['permissions-policy'] ?? '')) throw new Error('the phone camera is blocked by Permissions-Policy')
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await sleep(1500)
        await page.evaluate(() => window.scrollTo(0, 0))
        const found = await page.evaluate(async () => {
          await document.fonts.ready
          const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''))
          const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
          const fonts = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.woff2(\?|$)/.test(n))
          return { loaded: [...new Set(loaded)], meta, fonts }
        })
        if (errors.length) throw new Error(`page errors: ${errors.slice(0, 2).join(' | ')}`)
        if (path === '/donate/') {
          const recent = page.locator('#recent')
          if (!(await recent.textContent()).includes(hostileName) || await recent.locator('img').count()) throw new Error('network text was parsed as markup')
        }
        if (cspViolations.length > seen) throw new Error(`violations: ${JSON.stringify(cspViolations.slice(seen, seen + 2))}`)
        if (!/script-src 'self'/.test(found.meta) || !/object-src 'none'/.test(found.meta)) throw new Error(`no page policy: "${found.meta.slice(0, 80)}"`)
        if (!/require-trusted-types-for 'script'(;|$)/.test(found.meta) || !/(?:^|;)\s*trusted-types obpal-templates obpal-camera(;|$)/.test(found.meta)) throw new Error('Trusted Types must be enforced with only the site template and camera worker policies')
        if (!/frame-ancestors 'self'/.test(headers['content-security-policy'] ?? '')) throw new Error(`no frame-ancestors header: ${headers['content-security-policy']}`)
        if (elsewhere.length) throw new Error(`requests elsewhere: ${elsewhere.slice(0, 3).join(', ')}`)
        if (found.fonts.some((f) => !f.startsWith(`${worker.origin}/fonts/`))) throw new Error(`fonts from elsewhere: ${found.fonts.join(', ')}`)
        if (!found.loaded.includes('Inter')) throw new Error(`Inter didn't load (${found.loaded.join(', ') || 'no fonts'})`)
        return `${found.loaded.join(', ')}; ${found.fonts.length} font file${found.fonts.length === 1 ? '' : 's'}`
      } finally {
        await ctx.close()
      }
    })
  }
  await check('Link dot surfaces remount after cached-page return, and steady pointer input stops drawing', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      await ctx.addInitScript(() => {
        window.__installPaints = 0
        const clear = CanvasRenderingContext2D.prototype.clearRect
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
          if (this.canvas.id === 'install-dots') window.__installPaints++
          return clear.apply(this, args)
        }
      })
      const page = await ctx.newPage()
      await page.goto(worker.origin + '/link/')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => Number(document.querySelector('#link-space').dataset.dotFrames) > 0 || !document.querySelector('#link-flat').hidden)
      // Playwright disables the back/forward cache; exercise the browser's persisted lifecycle explicitly.
      await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      })
      await sleep(300)
      const space = page.locator('#link-space')
      if (await space.isVisible()) {
        const box = await space.boundingBox()
        const before = Number(await space.getAttribute('data-dot-frames'))
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3)
        await page.waitForFunction(n => Number(document.querySelector('#link-space').dataset.dotFrames) > n, before)
        await space.evaluate(canvas => {
          const box = canvas.getBoundingClientRect()
          canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.x + box.width * 0.8, clientY: box.y + box.height * 0.3 }))
        })
        await sleep(1500)
        const rested = await space.getAttribute('data-dot-frames')
        await space.evaluate(canvas => {
          const box = canvas.getBoundingClientRect()
          for (let i = 0; i < 30; i++) canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.x + box.width * 0.8, clientY: box.y + box.height * 0.3 }))
        })
        await sleep(300)
        if (rested !== await space.getAttribute('data-dot-frames')) throw new Error('a steady input keeps the hero drawing')
      } else if (!await page.locator('#link-flat').isVisible()) throw new Error('flat fallback lost on return')
      await page.goto(worker.origin + '/link/desktop/')
      await page.waitForFunction(() => window.__installPaints > 0)
      const before = await page.evaluate(() => window.__installPaints)
      await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      })
      await page.waitForFunction(n => window.__installPaints > n, before)
      const returned = await page.evaluate(() => window.__installPaints)
      await page.evaluate(() => document.documentElement.dataset.bbAccent = 'turquoise')
      await page.waitForFunction(n => window.__installPaints > n, returned)
      await ctx.addInitScript(() => {
        const context = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return type.startsWith('webgl') ? null : context.call(this, type, ...args)
        }
      })
      await page.goto(worker.origin + '/link/')
      await page.locator('#link-flat').waitFor({ state: 'visible' })
      await page.evaluate(() => document.fonts.ready)
      await sleep(300)
      const flat = page.locator('#link-flat')
      const colorBefore = await flat.evaluate(canvas => canvas.toDataURL())
      await page.evaluate(() => { document.documentElement.dataset.bbTheme = 'light'; document.documentElement.dataset.bbAccent = 'turquoise' })
      await page.waitForFunction(before => document.querySelector('#link-flat').toDataURL() !== before, colorBefore)
      await page.setViewportSize({ width: 390, height: 844 })
      await sleep(300)
      if (await flat.evaluate(canvas => Math.abs(canvas.width / devicePixelRatio - canvas.getBoundingClientRect().width) > 1)) throw new Error('fallback backing size did not follow resize')
      return 'persisted hide/show; idle hero; flat panel and WebGL fallback refresh theme and size'
    } finally { await ctx.close() }
  })
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await check(`/trust/ has source links, no overflow and static reduced-motion dots at ${viewport.width}x${viewport.height}`, async () => {
      const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' })
      try {
        // Count only the hero's paints, so an unrelated page affordance cannot hide a looping dot renderer.
        await ctx.addInitScript(() => {
          const clear = CanvasRenderingContext2D.prototype.clearRect
          window.__trustPaints = 0
          CanvasRenderingContext2D.prototype.clearRect = function (...args) {
            if (this.canvas.id === 'trust-field') window.__trustPaints++
            return clear.apply(this, args)
          }
        })
        const page = await ctx.newPage()
        await page.goto(worker.origin + '/trust/')
        await page.evaluate(() => document.fonts.ready)
        if (await page.locator('link[rel="canonical"]').getAttribute('href') !== 'https://obpal.blackboxes.net/trust/') throw new Error('trust canonical')
        const backings = {
          accounts: ['worker/index.ts'], tracking: ['vite.config.ts'], telemetry: ['wrangler.jsonc'],
          feedback: ['/privacy/#contact'], camera: ['src/controller/scanner.ts', 'tests/scanner.test.ts'],
          open: ['LICENSE', 'TRADEMARKS.md'],
        }
        for (const [promise, files] of Object.entries(backings)) {
          const row = page.locator(`#promise-${promise}`)
          if (!await row.isVisible()) throw new Error(`promise missing: ${promise}`)
          const links = await row.locator('a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')))
          for (const file of files) {
            const href = file.startsWith('/') ? file : `https://github.com/Axialon/obpal/blob/main/${file}`
            if (!links.includes(href)) throw new Error(`${promise}: backing ${href} missing`)
          }
        }
        if (await page.locator('[data-example-glyph]').count() !== 3 || !await page.getByText('Illustration · no active connection', { exact: true }).count()) throw new Error('illustrations are not identified')
        if (!await page.getByRole('heading', { name: 'Check both screens show the same seal.', exact: true }).isVisible()) throw new Error('comparison instruction missing')
        if (!await page.getByText('A malicious copy can remove the marker.', { exact: false }).isVisible()) throw new Error('removable marker limitation missing')
        if (await page.locator('body > .community-build').count()) throw new Error('loopback development marked as a community build')
        for (const theme of ['carbon', 'light']) {
          await setSurface(page, theme)
          await sleep(300)
          const start = await page.evaluate(() => window.__trustPaints)
          await sleep(300)
          const layout = await page.evaluate(() => {
            const hero = document.querySelector('.trust-hero')
            const canvas = document.querySelector('#trust-field')
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
            return {
              overflow: document.documentElement.scrollWidth - innerWidth,
              paints: window.__trustPaints,
              dots: pixels.some((value, i) => i % 4 === 3 && value > 0),
              animations: hero.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
            }
          })
          if (layout.overflow > 0) throw new Error(`${theme}: horizontal overflow ${layout.overflow}px`)
          if (!start || layout.paints !== start || !layout.dots || layout.animations) throw new Error(`${theme}: reduced-motion hero ${JSON.stringify(layout)}, started with ${start} paints`)
          if (SHOTS) await page.screenshot({ path: join(SHOTS, `trust-${viewport.width}-${theme}.png`), fullPage: true })
        }
        return 'canonical; six backed promises; three illustrations; both themes; painted and idle'
      } finally { await ctx.close() }
    })
  }
  for (const [origin, marked] of [['https://community.example.invalid', true], ['https://obpal.blackboxes.net', false]]) {
    await check(`/trust/ ${marked ? 'discloses a community build' : 'keeps the exact official origin unmarked'}`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
      try {
        const elsewhere = []
        // Catch every request before network access. The fake address is only a browser origin, never a remote host.
        await ctx.route('**/*', async route => {
          const url = new URL(route.request().url())
          if (url.origin !== origin) {
            elsewhere.push(url.href)
            return route.abort()
          }
          const response = await route.fetch({ url: new URL(url.pathname + url.search, worker.origin).href, maxRedirects: 0 })
          return route.fulfill({ response })
        })
        const page = await ctx.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(origin + '/trust/')
        await setSurface(page, 'light')
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
        const marker = page.locator('body > .community-build')
        if (await marker.count() !== Number(marked)) throw new Error(`origin marker count for ${origin}`)
        if (marked) {
          if (!await marker.isVisible() || await marker.textContent() !== 'Community build: not run by ob.Pal') throw new Error('community marker is not visible or clear')
          if (await marker.getAttribute('href') !== 'https://obpal.blackboxes.net/trust/') throw new Error('community marker trust link')
          const visible = await marker.evaluate(node => {
            const box = node.getBoundingClientRect()
            return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth
          })
          if (!visible) throw new Error('community marker left the phone viewport after scrolling')
          if (SHOTS) await page.screenshot({ path: join(SHOTS, 'community-build.png') })
        }
        if (elsewhere.length) throw new Error(`nonlocal request blocked: ${elsewhere.join(', ')}`)
        if (errors.length) throw new Error(`origin page errors: ${errors.join(' | ')}`)
        return 'HTML, assets and fonts served only by the local worker'
      } finally { await ctx.close() }
    })
  }
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await check(`/sim/ has compact, readable frost at ${viewport.width}x${viewport.height}`, async () => {
      const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' })
      try {
        const page = await ctx.newPage()
        await page.goto(worker.origin + '/sim/')
        await page.waitForFunction(() => window.__sims?.cards().length)
        await page.evaluate(() => scrollTo(0, 1050))
        const phone = viewport.width < 600
        for (const theme of ['carbon', 'light']) {
          await setSurface(page, theme)
          await checkFrost(page, '.top', { text: ['.top-nav a'] })
          // A computer browses from the sidebar; a phone has its search bar over the cards.
          if (phone) await checkFrost(page, '.sims-bar', { maxHeight: 64, text: ['#search', '.sims-filters'] })
          else await checkFrost(page, '.sims-side', { text: ['.kit-side-text', '.kit-side-label', '#search', '.kit-select-v'] })
          const layout = await page.evaluate((phone) => ({
            top: document.querySelector('.top').getBoundingClientRect().bottom,
            under: document.querySelector(phone ? '.sims-bar' : '.sims-side').getBoundingClientRect().top,
            overflow: document.documentElement.scrollWidth - innerWidth,
          }), phone)
          const gap = layout.under - layout.top
          if (gap < 0 || gap > 16 || layout.overflow > 0) throw new Error(`sticky layout: ${JSON.stringify(layout)}`)
        }
        return `${phone ? 'search bar at most 64px' : 'the sidebar'} held under the bar; both themes; AA over black and white`
      } finally { await ctx.close() }
    })
  }
  await check('frost has an opaque fallback when backdrop filters are unavailable', async () => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      let replaced = false
      await page.route('**/*.css', async route => {
        const response = await route.fetch()
        const css = await response.text()
        const body = css.replace(/\((?:-webkit-)?backdrop-filter:/g, () => { replaced = true; return '(obpal-unsupported-backdrop-filter:' })
        await route.fulfill({ response, body })
      })
      await page.goto(worker.origin + '/sim/')
      await page.waitForFunction(() => window.__sims?.cards().length)
      if (!replaced) throw new Error('no backdrop support query was exercised')
      await checkFrost(page, '.top', { solid: true })
      await checkFrost(page, '.sims-side', { solid: true })
      await page.goto(worker.origin + '/')
      await page.locator('.cta-alt[href="#see"]').hover()
      await checkFrost(page, '.cta-alt[href="#see"]', { solid: true })
    } finally { await ctx.close() }
  })
  for (const [path, surfaces] of [
    ['/', ['.top', '.pair']],
    ['/link/', ['.top']],
    ['/catalogue/', ['.top', '.bld-out']],
    ['/sim/device/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
    ['/sim/arm/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
    ['/sim/arena/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
    ['/sim/humanoid/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
    ['/sim/humanoid/physics/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
    ['/embed/', ['.sim-top', '.sim-panel']],
    ['/view/', ['.topbar', '.catalog', '.presence-floating', '.obpal-chip .pill', '.obpal-chip .card']],
    ['/p/', ['.msg-card']],
  ]) {
    await check(`${path} overlays keep their frost and AA text in both themes`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
      try {
        const page = await ctx.newPage()
        await page.goto(worker.origin + path)
        for (const theme of ['carbon', 'light']) {
          await setSurface(page, theme)
          for (const selector of surfaces) await checkFrost(page, selector, { text: ['p', 'small', 'label', 'h1', 'h2', '.top-nav a', '.presence-controls button', '.k', '.status'] })
          if (path === '/') {
            await page.locator('.cta-alt[href="#see"]').hover()
            await checkFrost(page, '.cta-alt[href="#see"]')
          }
          if (path === '/view/') {
            const overlap = await page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().bottom - document.querySelector('.presence-floating').getBoundingClientRect().top)
            if (overlap > 0) throw new Error(`viewpoint toolbar overlaps the header by ${overlap}px`)
            await page.locator('#t-theme').click()
            await page.locator(`[data-bb-theme-id="${theme}"]`).click()
            await checkFrost(page, '#themes', { text: ['.bb-label', '.bb-theme'] })
            await page.keyboard.press('Escape')
          }
        }
        if (path === '/view/') {
          for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 })
            await checkFrost(page, '.presence-floating', { maxHeight: 64, text: ['button', 'select'] })
            const overlap = await page.evaluate(() => document.querySelector('.presence-floating').getBoundingClientRect().bottom - document.querySelector('.catalog').getBoundingClientRect().top)
            if (overlap > 0) throw new Error(`${width}px: viewpoint toolbar covers the catalogue by ${overlap}px`)
          }
        }
      } finally { await ctx.close() }
    })
  }
  // The quick-actions tray on each kind of page (scripts/e2e-quick.mjs).
  await runQuick(browser, worker.origin, check)
  // The Viewer opened before a deploy. Its lazy QR chunk is asked for only after the deploy, which serves the next build
  // from memory (scripts/lib/deploy-sim.mjs): `kept`, the old build's chunks are still there (scripts/keep-assets.mjs);
  // otherwise they are gone; `stuck`, the next build's QR chunk is missing as well.
  const next = await nextBuild(fileURLToPath(new URL('../dist/client', import.meta.url)))
  const RELOAD_KEY = 'obpal:deploy-reload'
  const isQr = (path) => /^\/assets\/qr-/.test(path)
  async function viewerAcrossDeploy({ kept = false, stuck = false }, run) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      const page = await ctx.newPage()
      const seen = { loads: 0, errors: [] }
      page.on('load', () => { seen.loads++ })
      page.on('pageerror', (e) => seen.errors.push(e.message))
      let deployed = false
      let deploy = () => {}
      const after = new Promise((r) => { deploy = r })
      let asked = () => {}
      const qrAsked = new Promise((r) => { asked = r })
      await ctx.route(`${worker.origin}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname
        if (!deployed && next.gone.has(path) && isQr(path)) { asked(); await after }
        if (!deployed) return route.continue()
        const removed = (next.gone.has(path) && !kept) || (stuck && isQr(path))
        if (removed) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'removed by the deploy' })
        const file = next.files.get(path)
        if (file) return route.fulfill({ status: 200, contentType: file.type, body: file.body, headers: { 'cache-control': 'no-store' } })
        return route.continue()
      })
      await page.goto(`${worker.origin}/view/`)
      await Promise.race([qrAsked, sleep(15000).then(() => { throw new Error('the pairing chip never asked for its QR chunk') })])
      deployed = true
      deploy()
      const qr = page.locator('.obpal-chip .qr svg')
      const drawn = async () => { await qr.first().waitFor({ timeout: 15000 }).catch(() => {}); return await qr.count() > 0 }
      const record = () => page.evaluate((k) => sessionStorage.getItem(k), RELOAD_KEY)
      return await run({ seen, drawn, record })
    } finally { await ctx.close() }
  }
  await check('a Viewer open across a deploy that removed the QR chunk reloads once, into the new build, and draws the code', async () => {
    return await viewerAcrossDeploy({}, async ({ seen, drawn, record }) => {
      if (!(await drawn())) throw new Error(`no QR code drawn; ${seen.loads} loads; ${seen.errors.join(' | ')}`)
      if (seen.loads !== 2) throw new Error(`${seen.loads} page loads (want the first and one reload)`)
      if (!seen.errors.some((e) => /dynamically imported module/.test(e))) throw new Error(`the chunk did not fail: ${seen.errors.join(' | ') || 'no errors'}`)
      if (!(await record())) throw new Error('the reload left no guard in sessionStorage')
      return 'the old chunk 404ed, one reload, the QR drawn from the new build'
    })
  })
  await check('the same deploy with the old chunks kept needs no reload', async () => {
    return await viewerAcrossDeploy({ kept: true }, async ({ seen, drawn, record }) => {
      if (!(await drawn())) throw new Error(`no QR code drawn; ${seen.errors.join(' | ')}`)
      await sleep(1500)
      if (seen.loads !== 1 || seen.errors.length || await record()) throw new Error(`${seen.loads} loads, ${seen.errors.length} errors, guard ${await record()}`)
      return 'the old chunk still served: no error, no reload'
    })
  })
  await check('a chunk missing from the new build too is reloaded for once, never again', async () => {
    return await viewerAcrossDeploy({ stuck: true }, async ({ seen, record }) => {
      const end = Date.now() + 15000
      while (seen.loads < 2 && Date.now() < end) await sleep(100)
      await sleep(3000)
      if (seen.loads !== 2) throw new Error(`${seen.loads} page loads (want the first and one reload)`)
      if (!(await record())) throw new Error('no guard in sessionStorage')
      return `${seen.loads} loads, ${seen.errors.length} errors, and it stopped`
    })
  })
  await runGraphicsRecoveryLayouts(browser, worker.origin, check)
  await runViewerScene(browser, worker.origin, check)
  await runDotLoaders(browser, worker.origin, check)
  await runPackCatalogue({ browser, origin: worker.origin, check })
  await check('no Content Security Policy violations on any page', cspCheck)
  }
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await worker?.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(failed || exitCode ? `FAILED ${failed}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed || exitCode ? 1 : 0)

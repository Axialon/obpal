/** Click every upload, destination and copy action in the real, freshly served kit. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { serveKit } from '../extension/scripts/store-cli.mjs'
import { storeStatus, validatePackage } from '../extension/scripts/store-manager.mjs'
import { git, sha256 } from '../extension/scripts/store-source.mjs'
import { rawRun } from './lib/distill.mjs'
import { newUnwatchedContext } from './csp-watch.mjs'

export async function runStoreKit(browser, check, shots = '') {
  const root = fileURLToPath(new URL('..', import.meta.url))
  // A version in development has no kit yet: the kit holds its art, listing and zip to their receipts, and `store -- kit` prepares it.
  const { version, development } = await storeStatus(root)
  if (development) return check(`store kit: Link ${version} is in development`, async () => 'not prepared, so there is no kit to click through yet (pnpm run store -- kit)')
  // Fresh checkouts have no ignored upload zip. Build through the existing guarded packer.
  try { validatePackage(root) } catch {
    for (const [script, args, cwd] of [
      [join(root, 'node_modules/vite/bin/vite.js'), ['build'], join(root, 'extension')],
      [join(root, 'extension/scripts/store.mjs'), [], root],
    ]) await new Promise((ok, fail) => {
      const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'inherit' })
      child.once('error', fail); child.once('exit', code => code === 0 ? ok() : fail(new Error(`Store fixture build exited ${code}`)))
    })
  }
  const port = Number(process.env.OBPAL_E2E_PORT)
  const origin = `http://127.0.0.1:${port}`, url = origin + '/extension/release/store-kit.html'
  const temp = mkdtempSync(join(tmpdir(), 'obpal-store-download-')), observations = []
  const evidence = process.env.OBPAL_E2E_EVIDENCE_ROOT ? join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'store-kit') : ''
  const captures = evidence ? rawRun(evidence) : shots, frames = []
  if (captures) mkdirSync(captures, { recursive: true })
  let server
  try {
    server = await serveKit(root, port, { renderOnly: true })
    for (const width of [1100, 390]) await check(`store kit ${width}px: every link, image and copy action resolves`, async () => {
      // The links open the live site, not this checkout's pages, so the Content Security Policy watcher leaves this context alone.
      const context = await newUnwatchedContext(browser, { viewport: { width, height: 850 }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce', acceptDownloads: true })
      try {
        const page = await context.newPage(), badResponses = [], errors = [], navigations = [], beacons = new Set()
        context.on('response', response => { if (response.request().isNavigationRequest()) navigations.push(response) })
        page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 400) badResponses.push(response.status()) })
        page.on('pageerror', error => errors.push(error.message))
        assert.equal((await page.goto(url)).status(), 200)
        await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
        assert.equal(await page.locator('img').count(), 8)
        assert(await page.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)))
        const buttons = page.locator('button[data-copy]'), count = await buttons.count()
        let paths = 0
        for (let index = 0; index < count; index++) {
          const button = buttons.nth(index), expected = await button.getAttribute('data-copy'), label = await button.textContent()
          await button.click()
          await button.filter({ hasText: /^Copied$/ }).waitFor()
          const copied = await page.evaluate(() => navigator.clipboard.readText())
          assert.equal(copied.replaceAll('\r\n', '\n'), expected)
          if (label === 'Copy path') { assert(isAbsolute(expected) && existsSync(expected)); paths++ }
        }
        assert.equal(paths, 9)
        const links = page.locator('a'), linkCount = await links.count()
        let downloads = 0, destinations = 0
        for (let index = 0; index < linkCount; index++) {
          const link = links.nth(index), href = await link.getAttribute('href')
          if (await link.getAttribute('download') !== null) {
            const path = await link.locator('..').locator('button[data-copy]').getAttribute('data-copy')
            const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
            const target = join(temp, `${width}-${download.suggestedFilename()}`)
            await download.saveAs(target)
            assert.equal(await download.failure(), null)
            assert.equal(sha256(readFileSync(target)), sha256(readFileSync(path)))
            assert.equal((await context.request.get(new URL(href, url).href)).status(), 200)
            downloads++
          } else {
            const [popup] = await Promise.all([context.waitForEvent('page'), link.click()])
            await popup.waitForURL(target => target.protocol === 'https:', { waitUntil: 'domcontentloaded' })
            const navigation = navigations.findLast(response => response.url() === popup.url())
            assert(navigation, `No document response for ${href}`)
            assert.equal(navigation.status(), 200, href)
            if (await popup.locator('script[src*="static.cloudflareinsights.com"]').count().catch(() => 0)) beacons.add(new URL(popup.url()).pathname)
            await popup.close(); destinations++
          }
        }
        assert.equal(downloads, 9); assert.equal(destinations, 7)
        assert.deepEqual(badResponses, []); assert.deepEqual(errors, [])
        await page.evaluate(() => scrollTo(0, 0))
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        if (captures) for (const section of ['header', 'package']) {
          if (section === 'package') await page.locator('article').first().scrollIntoViewIfNeeded()
          mkdirSync(join(captures, String(width)), { recursive: true })
          const path = `${width}/${section}.png`
          await page.screenshot({ path: join(captures, path) }); frames.push({ path, failed: false })
        }
        observations.push({ width, downloads, destinations, copiedPaths: paths, copyButtons: count, images: 8, broken: 0 })
        // Our code never loads an analytics beacon (the privacy page says there is none, and the pages' policy blocks any). Cloudflare's
        // automatic Web Analytics adds one at the edge: say so here, where the live pages are opened, until it is turned off in the dashboard.
        const injected = beacons.size ? `; NOTE: Cloudflare Web Analytics injects its beacon into live ${[...beacons].join(' ')}: turn off automatic injection in the Cloudflare dashboard` : ''
        return `${url}; ${downloads} downloads, ${destinations} live links, ${count} copies (${paths} existing absolute paths), 8 images; no failures${injected}`
      } finally { await context.close() }
    })
    if (evidence || shots) {
      const out = evidence || shots
      writeFileSync(join(out, 'store-kit-links.json'), JSON.stringify({ url, source: git(root, ['rev-parse', 'HEAD']).trim(), browser: browser.version(), dpr: 1, reducedMotion: true, observations }, null, 2))
      writeFileSync(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: 4, frames }, null, 2))
    }
  } finally { server?.closeAllConnections(); if (server) await new Promise(ok => server.close(ok)); rmSync(temp, { recursive: true, force: true }) }
}

/** Comparable cold-loading captures. Downloads are held until the loading frame is measured. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'
import { rawRun, distill } from './lib/distill.mjs'

const revision = process.argv[2] || 'after'
const extra = process.argv[3] === 'extra'
const motion = process.argv[3] === 'motion'
const out = join('artifacts/dot-loaders', revision, ...(extra ? ['extra'] : motion ? ['motion'] : []))
mkdirSync(out, { recursive: true })
const raw = rawRun(out)
const local = await startLocal({ dist: revision === 'before' ? resolve('artifacts/dot-loaders/before/site/client') : undefined })
const resolved = await resolveChromium()
const browser = await chromium.launch({ executablePath: resolved.path || undefined, args: ['--ignore-certificate-errors', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const observations = [], cells = [], stripCells = [], motionFrames = []
try {
  for (const width of [1280, 390]) {
    for (const [name, path, selector] of (motion ? [
      ['QR card', '/view/', '.obpal-chip .qr'],
      ['Sim warm-up', '/sim/device/?d=drone', '#sim-load'],
      ['Viewer load', '/view/', '#loading'],
    ] : extra ? [
      ['Driver connecting', '/sim/humanoid/?test=humanoid-live', '[data-panel="drivers"]'],
      ['VR support check', '/sim/device/?d=drone', '.presence-controls'],
      ['Shared scene connecting', '/sim/device/?d=drone&join=1', '.guest-status'],
      ['Dropped file', '/view/', '#loading'],
      ['Folder refresh', '/view/', '.lf-bar'],
      ['Phone pack fetch', '/p/?pack=community/example', '#pack-arrival'],
      ['Community thumbnail', '/catalogue/', '.pack-art'],
      ['SDK pairing card', '/view/', '.obpal-card'],
      ['Collapsed pairing pill', '/embed/', '.obpal-chip .pill'],
      ['Phone thumbnails', '/p/', '.picker'],
      ['Saved screen rename', '/p/', '.connection-rename'],
      ['Sheet code lookup', '/p/', '.code-form'],
      ['Saved connection attempt', '/p/', '.connection-list'],
    ] : [
      ['QR card', '/view/', '.obpal-chip .qr'],
      ['Sim warm-up', '/sim/device/?d=drone', '#sim-load'],
      ['Viewer load', '/view/', '#loading'],
      ['Catalogue previews', '/sim/', '.dcard-stage'],
      ['Phone connecting', '/p/', '.msg-card'],
      ['Saved screens', '/p/', '.connection-list'],
      ['Code lookup', '/p/?type=1', '#code-go'],
      ['Camera starting', '/p/', '.obpal-camera'],
      ['Hand model', '/p/', '.obpal-camera'],
      ['Body model', '/p/', '.obpal-camera'],
      ['Community catalogue', '/catalogue/', '#pack-status'],
      ['Viewer thumbnails', '/view/', '.tile-art'],
      ['Desktop check', '/link/desktop/', '#guide-status'],
      ['Audio unlock', '/sim/device/?d=drone', '.sim-sound'],
      ['Folder scan', '/view/', '.lf-card'],
      ['Link journey', '/link/', '#link-space'],
      ['Trust', '/trust/', 'main'],
      ['Embed', '/embed/', 'obpal-remote'],
    ])) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, ignoreHTTPSErrors: true, deviceScaleFactor: 1 })
      const page = await context.newPage()
      const release = []
      await page.route('**/*', async route => {
        const url = route.request().url()
        const held = name === 'Driver connecting' ? url.includes('fake-guardian.worker-') : name === 'Phone pack fetch' ? /catalogue\.json/.test(url) : name === 'Community thumbnail' ? /\.(png|webp)(\?|$)/.test(url) : name === 'Phone thumbnails' ? /\/models\/.*\.(svg|png|webp)/.test(url) : ['VR support check', 'Shared scene connecting', 'Dropped file', 'Folder refresh', 'SDK pairing card', 'Collapsed pairing pill', 'Saved screen rename'].includes(name) ? false : name === 'QR card' ? /\/qr-[^/]+\.js/.test(url) : name === 'Catalogue previews' ? /\/(?:scene-previews|arm-preview|preview)-[^/]+\.js/.test(url) : ['Code lookup', 'Sheet code lookup'].includes(name) ? /\/api\/code$/.test(url) : name === 'Community catalogue' ? /catalogue\.json/.test(url) : name === 'Viewer thumbnails' ? /\/models\/.*\.(svg|png|webp)/.test(url) : ['Audio unlock', 'Folder scan'].includes(name) ? false : /\.(glb|wasm|task)(\?|$)/.test(url)
        if (held) await new Promise(done => release.push(done))
        await route.continue().catch(() => {})
      })
      try {
        if (['Hand model', 'Body model'].includes(name)) await page.addInitScript(() => { Object.defineProperty(navigator, 'connection', { value: { type: 'cellular', saveData: false } }) })
        if (name === 'VR support check') await page.addInitScript(() => { Object.defineProperty(navigator, 'xr', { value: { isSessionSupported: () => new Promise(() => {}) } }) })
        if (name === 'Dropped file') await page.addInitScript(() => { File.prototype.arrayBuffer = () => new Promise(() => {}) })
        if (name === 'Folder refresh') await page.addInitScript(() => {
          let scans = 0
          window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'Model folder', queryPermission: async () => 'granted', values: async function*() {
            if (scans++) await new Promise(() => {})
            yield { kind: 'file', name: 'model.glb', getFile: async () => new File([''], 'model.glb') }
          } })
        })
        if (name === 'Saved screens') await page.addInitScript(() => {
          const original = IDBDatabase.prototype.transaction
          IDBDatabase.prototype.transaction = function(stores, ...args) {
            if (stores === 'connections') return { objectStore: () => ({ getAll: () => ({}) }) }
            return original.call(this, stores, ...args)
          }
        })
        if (name === 'Saved screen rename') await page.addInitScript(() => {
          const original = IDBDatabase.prototype.transaction
          IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
            if (stores !== 'connections') return original.call(this, stores, mode, ...args)
            const transaction = { objectStore: () => ({ getAll: () => ({ result: [{ id: 'example-screen', name: 'Example screen', kind: 'viewer', at: Date.now() }] }), put: () => ({}) }) }
            if (mode === 'readonly') setTimeout(() => transaction.oncomplete?.(), 20)
            return transaction
          }
        })
        if (name === 'Audio unlock') await page.addInitScript(() => { AudioContext.prototype.resume = () => new Promise(() => {}) })
        if (name === 'Folder scan') await page.addInitScript(() => { window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'Model folder', queryPermission: async () => 'granted', values: async function*() { await new Promise(() => {}) } }) })
        if (['Phone connecting', 'Hand model', 'Body model', 'Shared scene connecting', 'Phone thumbnails', 'Saved connection attempt'].includes(name)) {
          const host = await context.newPage()
          await host.goto(local.origin + (name === 'Phone thumbnails' ? '/view/' : name === 'Body model' ? '/sim/humanoid/' : '/sim/arm/'))
          await host.waitForFunction(() => !!window.__obpal?.pairingUrl)
          const invite = await host.evaluate(() => window.__obpal.pairingUrl)
          if (['Phone connecting', 'Shared scene connecting', 'Saved connection attempt'].includes(name)) await page.addInitScript(() => { RTCPeerConnection.prototype.createAnswer = () => new Promise(() => {}); RTCPeerConnection.prototype.createOffer = () => new Promise(() => {}) })
          const url = new URL(invite); url.searchParams.set('test', 'camera')
          if (name === 'Shared scene connecting') { url.pathname = '/sim/device/'; url.searchParams.set('d', 'drone'); url.searchParams.set('join', '1') }
          await page.goto(url.href, { waitUntil: 'domcontentloaded' })
          await page.bringToFront()
          if (['Hand model', 'Body model'].includes(name)) {
            const tab = page.locator(`[data-tab="${name === 'Hand model' ? 'camera-hand' : 'camera-body'}"]`)
            await tab.waitFor({ state: 'attached', timeout: 25000 })
            await tab.evaluate(button => button.click())
          }
        } else await page.goto(local.origin + path, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(700)
        if (name === 'SDK pairing card') {
          await page.waitForFunction(() => !!window.__obpal?.mountPairing)
          await page.evaluate(() => { const host = document.createElement('section'); host.style.cssText = 'position:fixed;inset:80px 20px auto;z-index:100;max-width:480px;margin:auto'; document.body.append(host); window.__obpal.mountPairing(host) })
          await page.locator('.obpal-qr svg').waitFor()
        }
        if (name === 'Collapsed pairing pill') await page.locator('obpal-remote').evaluate(el => el.removeAttribute('open'))
        if (name === 'Phone thumbnails') await page.locator('.tray-btn[data-id="model"]').click()
        if (name === 'Saved connection attempt') {
          await page.getByRole('button', { name: 'Connections', exact: true }).first().click()
          if (revision !== 'before') {
            await page.locator('.connection-mark .dot-loader').waitFor({ state: 'visible' })
            if (!await page.locator('.connection-detail .dot-wait-label').count()) throw new Error('Pending row caption is not accessible-only')
          }
        }
        if (['Saved screen rename', 'Sheet code lookup'].includes(name)) {
          await page.getByRole('button', { name: 'Connections', exact: true }).first().click()
          if (name === 'Saved screen rename') { await page.getByRole('button', { name: 'Rename Example screen', exact: true }).click(); await page.getByRole('button', { name: 'Save', exact: true }).click() }
          else { await page.getByRole('button', { name: 'Enter a code', exact: true }).click(); await page.getByRole('textbox', { name: 'Code from your screen' }).fill('1234567890'); await page.getByRole('button', { name: 'Connect', exact: true }).click() }
        }
        if (name === 'Driver connecting') { await page.locator('[data-panel-toggle="drivers"]').click(); await page.getByRole('button', { name: 'Connect simulated driver', exact: true }).click() }
        if (name === 'VR support check') { if (!await page.locator(selector).isVisible()) await page.locator('[data-panel-toggle="controls"]').click(); await page.locator(selector).scrollIntoViewIfNeeded() }
        if (name === 'Dropped file') await page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File([''], 'model.stl')); dispatchEvent(new DragEvent('drop', { dataTransfer: data })) })
        if (name === 'Folder refresh') { await page.locator('.cat-btn[data-cat="local"]').click(); await page.getByRole('button', { name: 'Connect a folder', exact: true }).click(); await page.locator('.lf-bar').waitFor(); await page.getByRole('button', { name: 'Refresh', exact: true }).click() }
        if (name === 'Community thumbnail') await page.locator(selector).first().scrollIntoViewIfNeeded()
        if (extra) await page.waitForTimeout(250)
        if (name === 'Saved screens') await page.getByRole('button', { name: 'Connections', exact: true }).first().click()
        if (name === 'Code lookup') { await page.locator('#code-in').fill('1234567890'); await page.locator('#code-go').click() }
        if (name === 'Audio unlock') { await page.locator('#sim-sound').evaluate(button => button.click()); if (!await page.locator('.sim-sound').isVisible()) await page.locator('[data-panel-toggle="controls"]').click(); await page.locator('.sim-sound').scrollIntoViewIfNeeded() }
        if (name === 'Folder scan') { await page.locator('.cat-btn[data-cat="local"]').click(); await page.getByRole('button', { name: 'Connect a folder', exact: true }).click() }
        if (name === 'Community catalogue') await page.locator(selector).scrollIntoViewIfNeeded()
        if (['Hand model', 'Body model'].includes(name)) {
          const consent = page.locator('[data-camera-download]')
          await consent.waitFor({ state: 'visible', timeout: 8000 })
          await consent.click()
          await page.waitForFunction(() => document.querySelector('.obpal-camera')?.dataset.state === 'loading', null, { timeout: 8000 })
          await page.waitForTimeout(200)
        }
        if (name === 'Camera starting') {
          await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(() => {}) })
          await page.getByRole('button', { name: /Scan a code/ }).first().click().catch(() => {})
        }
        if (name === 'Desktop check') await page.evaluate(() => window.postMessage({ channel: 'obpal-link/desktop-guide/v1', status: 'connecting' }, location.origin))
        const exists = await page.locator(selector).count()
        const visible = exists && await page.locator(selector).first().isVisible()
        const metrics = ['QR card', 'Sim warm-up', 'Viewer load'].includes(name) ? await page.evaluate(async () => {
          const intervals = [], tasks = []
          const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)))
          observer.observe({ type: 'longtask', buffered: false })
          const start = performance.now(); let previous = start
          await new Promise(done => { const frame = now => { intervals.push(now - previous); previous = now; if (now - start < 2000) requestAnimationFrame(frame); else done() }; requestAnimationFrame(frame) })
          observer.disconnect()
          const sorted = intervals.slice(1).sort((a, b) => a - b)
          return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], maximumMs: sorted.at(-1), frameIntervalsMs: intervals.slice(1), longTasks: tasks }
        }) : null
        if (name === 'Embed') { const chip = page.locator('obpal-remote'); await chip.evaluate(el => el.setAttribute('open', '')) }
        const group = `${name.replaceAll(' ', '-').toLowerCase()}-${width}`
        const file = `${group}/state.png`
        mkdirSync(join(raw, group), { recursive: true })
        if (motion) {
          const start = await page.evaluate(() => performance.now())
          for (const time of [0, 180, 360, 1200]) {
            const remaining = start + time - await page.evaluate(() => performance.now())
            if (remaining > 0) await page.waitForTimeout(remaining)
            let bounds = await page.locator(selector).first().boundingBox()
            if (name === 'Viewer load' && revision !== 'before') bounds = await page.evaluate(() => {
              const canvas = document.querySelector('#scene'), camera = window.__activeSceneCamera?.() ?? window.__viewer?.camera
              if (!canvas || !camera || !document.querySelector('#loading')?.hasAttribute('data-dot-scene')) return null
              const box = canvas.getBoundingClientRect(), projection = camera.projectionMatrix.elements
              // The catalogue shifts the optical centre; crop the actual scene beads rather than the accessible host.
              return { x: box.x + box.width * (1 - projection[8]) / 2 - 24, y: box.y + box.height * (1 + projection[9]) / 2 - 24, width: 48, height: 48 }
            }) || bounds
            const clip = bounds && { x: Math.max(0, Math.min(width - 240, bounds.x + bounds.width / 2 - 120)), y: Math.max(0, Math.min(724, bounds.y + bounds.height / 2 - 60)), width: 240, height: 120 }
            const frame = `${group}/${time}.png`
            const at = await page.evaluate(() => performance.now())
            await page.screenshot({ path: join(raw, frame), ...(clip ? { clip } : {}) })
            motionFrames.push({ path: frame, timeMs: at - start })
            const label = `<svg width="320" height="28"><rect width="320" height="28" fill="#101319"/><text x="8" y="19" font-size="11" fill="white">${name} ${width}px +${Math.round(at - start)}ms</text></svg>`
            stripCells.push(await sharp({ create: { width: 320, height: 188, channels: 4, background: '#101319' } }).composite([{ input: await sharp(join(raw, frame)).resize(320, 160, { fit: 'contain', background: '#101319' }).toBuffer(), top: 28, left: 0 }, { input: Buffer.from(label), top: 0, left: 0 }]).png().toBuffer())
          }
        }
        await page.screenshot({ path: join(raw, file) })
        observations.push({ name, path, width, visible: !!visible, metrics, file })
        const label = `<svg width="320" height="28"><rect width="320" height="28" fill="#101319"/><text x="10" y="19" font-size="12" fill="white">${revision}: ${name} · ${width}px</text></svg>`
        const shot = await sharp(join(raw, file)).resize(320, 211, { fit: 'contain', background: '#101319' }).toBuffer()
        cells.push(await sharp({ create: { width: 320, height: 239, channels: 4, background: '#101319' } }).composite([{ input: shot, top: 28, left: 0 }, { input: Buffer.from(label), top: 0, left: 0 }]).png().toBuffer())
        console.log(`${revision}: ${name} ${width}, ${visible ? 'visible' : 'resting/absent'}`)
      } finally { release.forEach(done => done()); await context.close() }
    }
  }
  await sharp({ create: { width: 1280, height: Math.ceil(cells.length / 4) * 239, channels: 4, background: '#101319' } }).composite(cells.map((input, i) => ({ input, left: i % 4 * 320, top: Math.floor(i / 4) * 239 }))).png().toFile(join(out, 'contact-sheet.png'))
  if (stripCells.length) await sharp({ create: { width: 1280, height: Math.ceil(stripCells.length / 4) * 188, channels: 4, background: '#101319' } }).composite(stripCells.map((input, i) => ({ input, left: i % 4 * 320, top: Math.floor(i / 4) * 188 }))).png().toFile(join(out, 'frame-strip.png'))
  writeFileSync(join(out, 'metrics.json'), JSON.stringify({ source: process.env.OBPAL_DOT_BASE_SHA && revision === 'before' ? process.env.OBPAL_DOT_BASE_SHA : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dpr: 1, browser: browser.version(), playwright: JSON.parse(readFileSync('node_modules/playwright/package.json', 'utf8')).version, motion: 'no-preference', sampleMs: 2000, preparationMs: 700, loading: 'cold cache, held download; live stage may warm while held', timing: 'rAF scheduling intervals and observed page long tasks; CPU submission and GPU work not measured', device: 'desktop Chromium with viewport emulation', observations }, null, 2))
  writeFileSync(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: observations.length + motionFrames.length, frames: [...observations.map(o => ({ path: o.file })), ...motionFrames] }, null, 2))
  await distill(out)
} finally { await browser.close(); await local.close() }

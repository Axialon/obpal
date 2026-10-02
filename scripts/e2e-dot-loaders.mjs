/** Held downloads exercise real loading owners, then release into the actual completed surfaces. */
import { checkFrost, setSurface } from './lib/frost.mjs'
import sharp from 'sharp'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { rawRun } from './lib/distill.mjs'
import { execFileSync } from 'node:child_process'

async function beadContrast(page) {
  const points = await page.evaluate(() => {
    let scene = window.__viewer.holder
    while (scene.parent) scene = scene.parent
    const beads = scene.getObjectByName('dot-bead-loader'), camera = window.__activeSceneCamera(), box = document.querySelector('#scene').getBoundingClientRect()
    return Array.from({ length: 3 }, (_, i) => {
      const matrix = beads.instanceMatrix.array, point = camera.position.clone().set(matrix[i * 16 + 12], matrix[i * 16 + 13], matrix[i * 16 + 14]).applyMatrix4(beads.matrixWorld).project(camera)
      return [box.x + (point.x + 1) * box.width / 2, box.y + (1 - point.y) * box.height / 2]
    })
  })
  const { data, info } = await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const luminance = (x, y) => {
    const offset = (Math.round(y) * info.width + Math.round(x)) * 3
    return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => { const v = data[offset + i] / 255; return sum + weight * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) }, 0)
  }
  for (const [x, y] of points) {
    const background = luminance(x, y + 16)
    let ratio = 1
    // A small core window accommodates the subpixel phase between projection and compositor capture.
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const core = luminance(x + dx, y + dy); ratio = Math.max(ratio, (Math.max(core, background) + .05) / (Math.min(core, background) + .05)) }
    if (!Number.isFinite(ratio) || ratio < 3) throw new Error(`Scene bead contrast ${ratio.toFixed(2)} below 3:1`)
  }
}
export async function runDotLoaders(browser, origin, check) {
  for (const width of [1280, 390]) {
    await check(`dot loaders appear, centre and resolve at ${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'no-preference' })
      try {
        for (const [path, selector] of [['/sim/device/?d=drone', '#sim-load .dot-loader'], ['/view/', '#loading']]) {
          const page = await context.newPage()
          const releases = []
          await page.route('**/*.glb', async route => { await new Promise(done => releases.push(done)); await route.continue().catch(() => {}) })
          try {
            await page.goto(origin + path)
            await page.locator(selector).waitFor({ state: 'visible' })
            if (path.startsWith('/sim')) {
              const result = await page.locator(selector).evaluate(el => {
                const host = el.parentElement.getBoundingClientRect(), rect = el.getBoundingClientRect(), style = getComputedStyle(el)
                return { offset: Math.abs(host.x + host.width / 2 - rect.x - rect.width / 2), circles: el.children.length, color: style.color, busy: el.getAttribute('aria-busy'), label: el.getAttribute('aria-label') }
              })
              if (result.offset > 1 || result.circles !== 3 || result.busy !== 'true' || !result.label || result.color === 'rgba(0, 0, 0, 0)') throw new Error(JSON.stringify(result))
              await checkFrost(page, '#sim-load', { text: ['.dot-loader'] })
            } else {
              await page.waitForFunction(() => {
                let scene = window.__viewer?.holder
                while (scene?.parent) scene = scene.parent
                return scene?.getObjectByName('dot-bead-loader')?.visible
              })
              const result = await page.evaluate(() => {
                let scene = window.__viewer.holder
                while (scene.parent) scene = scene.parent
                const beads = scene.getObjectByName('dot-bead-loader'), camera = window.__activeSceneCamera()
                const point = beads.getWorldPosition(camera.position.clone()).project(camera), style = getComputedStyle(document.querySelector('#loading'))
                return { circles: beads.count, centre: Math.abs(point.x + camera.projectionMatrix.elements[8]), backdrop: style.backdropFilter }
              })
              if (result.circles !== 3 || result.centre > .002 || result.backdrop !== 'none') throw new Error(JSON.stringify(result))
              await beadContrast(page)
              await setSurface(page, 'light'); await beadContrast(page)
              await setSurface(page, 'carbon')
              if (await page.locator('#loading').getAttribute('aria-busy') !== 'true') throw new Error('viewer load is not accessible')
            }
            releases.forEach(done => done())
            await page.locator(path.startsWith('/sim') ? '#sim-load' : '#loading').waitFor({ state: 'hidden', timeout: 20000 })
          } finally { releases.forEach(done => done()); await page.close() }
        }
        const page = await context.newPage()
        await page.goto(origin + '/p/')
        await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(() => {}) })
        await page.getByRole('button', { name: /Scan a code/ }).first().click()
        await page.locator('.camera-logo .dot-loader').waitFor({ state: 'visible' })
        await checkFrost(page, '.camera-logo', { text: ['.dot-loader'] })
        await page.getByRole('button', { name: 'Close camera' }).click()
        await page.locator('.obpal-camera').waitFor({ state: 'detached' })
        await page.route('**/api/code', async route => { await new Promise(done => setTimeout(done, 1000)); await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no-code"}' }) })
        await page.locator('#code-in').fill('1234567890')
        await page.locator('#code-go').click()
        await page.locator('#code-go .dot-loader').waitFor({ state: 'visible' })
        await page.locator('#code-go .dot-loader').waitFor({ state: 'hidden' })
        if (!await page.locator('#code-say').textContent()) throw new Error('code failure lost its explanation')
        await page.route('**/catalogue.json', async route => { await new Promise(done => setTimeout(done, 1000)); await route.continue() })
        await page.goto(origin + '/catalogue/')
        await page.locator('#pack-status .dot-loader').waitFor({ state: 'visible' })
        await page.locator('#pack-status .dot-loader').waitFor({ state: 'hidden' })
        await page.goto(origin + '/link/desktop/')
        await page.evaluate(() => window.postMessage({ channel: 'obpal-link/desktop-guide/v1', status: 'connecting' }, location.origin))
        await page.locator('#guide-status .dot-loader').waitFor({ state: 'visible' })
        await page.evaluate(() => window.postMessage({ channel: 'obpal-link/desktop-guide/v1', status: 'ready' }, location.origin))
        await page.locator('#guide-status .dot-loader').waitFor({ state: 'hidden' })
        await page.goto(origin + '/view/')
        const qrReleases = []
        await page.route('**/*', async route => {
          if (/\/qr-[^/]+\.js/.test(route.request().url())) await new Promise(done => qrReleases.push(done))
          await route.continue().catch(() => {})
        })
        try {
          await page.reload()
          await page.locator('.obpal-chip .qr .dot-loader').waitFor({ state: 'visible' })
          qrReleases.forEach(done => done())
          await page.locator('.obpal-chip .qr svg').first().waitFor({ state: 'visible', timeout: 20000 })
          await page.locator('.obpal-chip .qr .dot-loader').waitFor({ state: 'hidden' })
        } finally { qrReleases.forEach(done => done()) }
        await page.close()
        return 'sim, viewer beads, QR, camera, code failure, catalogue and Desktop; completion and cancellation'
      } finally { await context.close() }
    })
  }
  for (const width of [1280, 390]) await check(`sharing QR dots centre and resolve at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' })
    const releases = []
    try {
      const page = await context.newPage()
      await page.route('**/*', async route => {
        if (/\/qr-[^/]+\.js/.test(route.request().url())) await new Promise(done => releases.push(done))
        await route.continue().catch(() => {})
      })
      await page.goto(origin + '/view/')
      await page.getByRole('button', { name: 'Share scene', exact: true }).click()
      const loader = page.locator('.share-qr .dot-loader')
      await loader.waitFor({ state: 'visible' })
      const box = await loader.evaluate(el => {
        const a = el.getBoundingClientRect(), b = el.parentElement.getBoundingClientRect()
        return { x: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), y: Math.abs(a.y + a.height / 2 - b.y - b.height / 2), dots: el.children.length, label: el.getAttribute('aria-label') }
      })
      if (box.x > 1 || box.y > 1 || box.dots !== 3 || !box.label) throw new Error(JSON.stringify(box))
      const proof = process.env.OBPAL_E2E_EVIDENCE_ROOT && join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'share-qr', String(width))
      const raw = proof && rawRun(proof), frames = ['carbon.png', 'light.png', 'done.png'].map(path => ({ path }))
      if (raw) await writeFile(join(proof, 'evidence-frames.json'), JSON.stringify({ expectedCount: 3, frames, viewport: { width, height: 844 }, dpr: 1, motion: 'reduce', browser: browser.version(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), scenario: 'held sharing QR module after integration; no incoming-master baseline capture' }))
      for (const theme of ['carbon', 'light']) {
        await setSurface(page, theme); await checkFrost(page, '.share-panel', { text: ['.dot-loader'] })
        if (raw) await page.locator('.share-panel').screenshot({ path: join(raw, `${theme}.png`) })
      }
      await page.getByRole('button', { name: 'Close sharing', exact: true }).click()
      if (await page.locator('.share-qr').getAttribute('aria-busy') !== 'false') throw new Error('closed sharing QR remains busy')
      await page.getByRole('button', { name: 'Share scene', exact: true }).click()
      await loader.waitFor({ state: 'visible' })
      releases.forEach(done => done())
      await page.locator('.share-qr > svg').waitFor({ state: 'visible' })
      await loader.waitFor({ state: 'hidden' })
      if (raw) await page.locator('.share-panel').screenshot({ path: join(raw, 'done.png') })
    } finally { releases.forEach(done => done()); await context.close() }
  })
  await check('reduced-motion loading dots stay still and settle without writes', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await page.goto(origin + '/link/desktop/')
      await setSurface(page, 'light')
      await page.evaluate(() => window.postMessage({ channel: 'obpal-link/desktop-guide/v1', status: 'connecting' }, location.origin))
      const loader = page.locator('#guide-status .dot-loader')
      await loader.waitFor({ state: 'visible' })
      const before = await loader.innerHTML()
      await page.waitForTimeout(300)
      if (await loader.innerHTML() !== before) throw new Error('reduced frame moved')
      await page.evaluate(() => window.postMessage({ channel: 'obpal-link/desktop-guide/v1', status: 'ready' }, location.origin))
      await loader.waitFor({ state: 'hidden' })
      await page.waitForTimeout(100)
      const writes = await page.evaluate(async () => {
        let writes = 0
        const observer = new MutationObserver(records => { writes += records.length })
        observer.observe(document.querySelector('#guide-status'), { subtree: true, childList: true, attributes: true })
        await new Promise(done => setTimeout(done, 300))
        observer.disconnect()
        return writes
      })
      if (writes) throw new Error(`settled loader made ${writes} writes`)
    } finally { await context.close() }
  })
}


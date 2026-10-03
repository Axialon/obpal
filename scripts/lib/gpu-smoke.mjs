/** Three short pairing-code fixtures share one fresh local worker and the real system GPU semaphore. */
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireGpuLease, GPU_LEASE_FILE, gpuStatus } from './gpu-lease.mjs'
import { detectE2eGpu, e2eBrowserOptions } from './browser.mjs'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(fn, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() >= end) throw new Error('GPU smoke fixture timed out'); await new Promise(r => setTimeout(r, 50)) }
}
export async function runGpuSmoke({ origin, executablePath, check, readQr }) {
  if (Number(process.env.OBPAL_E2E_GPU_SLOTS ?? 3) !== 3) throw new Error('GPU smoke requires exactly three configured slots')
  const cancelled = new AbortController(), drain = deferred(), ready = [deferred(), deferred(), deferred()]
  const records = [], prefix = `code-smoke-${process.pid}`
  let exclusive, releaseExclusive, entered = false
  const holders = ready.map((notice, i) => (async () => {
    let release, browser
    try {
      release = await acquireGpuLease({ suite: `${prefix}-${i + 1}`, signal: cancelled.signal,
        waiting: () => console.log(`  GPU smoke ${i + 1}: waiting for a shared slot`) })
      if (!release) throw new Error('GPU smoke shared slot wait expired')
      browser = await chromium.launch(e2eBrowserOptions({ executablePath, headless: true }))
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info')
        return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
      })
      if (!renderer || /swiftshader|software|llvmpipe|basic render|warp/i.test(renderer)) throw new Error(`GPU smoke lacks hardware WebGL: ${renderer}`)
      await page.goto(`${origin}/view/`)
      const url = await until(() => page.evaluate(() => window.__obpal?.pairingUrl || ''))
      const qr = page.locator('.obpal-chip .qr')
      await until(() => qr.locator('.seal-qr>svg').isVisible())
      await until(() => page.locator('.obpal-chip .card').evaluate(card => getComputedStyle(card).opacity === '1' && getComputedStyle(card).transform === 'none'))
      const decoded = await readQr(await qr.screenshot())
      if (decoded.js !== url || decoded.zx !== url) throw new Error('Concurrent code QR did not decode with both decoders')
      const record = { holder: i + 1, renderer, readyAt: Date.now(), releasedAt: null }
      records.push(record); notice.resolve(record)
      await drain.promise
      await browser.close(); browser = null
      await release(); release = null
      record.releasedAt = Date.now()
    } finally { await browser?.close(); await release?.() }
  })())
  const allHolders = Promise.all(holders)
  // Observe rejection immediately, including a holder failing before the readiness barrier.
  const failed = allHolders.then(() => { throw new Error('GPU smoke holders ended before barrier') })
  failed.catch(() => {})
  try {
    await Promise.race([Promise.all(ready.map(r => r.promise)), failed])
    await check('three concurrent short code fixtures use hardware WebGL and decode their pairing QR', async () => records.map(r => r.renderer).join('; '))
    exclusive = acquireGpuLease({ mode: 'exclusive', suite: `${prefix}-exclusive`, signal: cancelled.signal,
      waiting: () => console.log('  GPU smoke exclusive: waiting for shared holders to drain') }).then(release => { entered = true; return release })
    exclusive.catch(() => {})
    await until(async () => (await gpuStatus()).queue.some(r => r.suite === `${prefix}-exclusive`))
    await check('the exclusive request waits behind all three shared code fixtures', async () => {
      const status = await gpuStatus()
      if (entered || status.holders.filter(r => r.suite.startsWith(prefix)).length !== 3) throw new Error('Exclusive request did not wait for three holders')
      return 'three shared holders, one exclusive waiter'
    })
    drain.resolve()
    await allHolders
    releaseExclusive = await exclusive
    const exclusiveAt = Date.now()
    const exclusiveDevice = await detectE2eGpu(executablePath)
    await check('the exclusive request enters only after all three hardware browsers close and release', async () => {
      const status = await gpuStatus()
      if (status.holders.length !== 1 || status.holders[0].mode !== 'exclusive' || records.some(r => !r.releasedAt || r.releasedAt > exclusiveAt)) throw new Error('Exclusive overlap')
      return 'one exclusive holder, no shared holders'
    })
    await check('the exclusive hardware run also gets hardware WebGL', async () => {
      if (!exclusiveDevice.hardware) throw new Error(`Exclusive renderer unavailable: ${exclusiveDevice.reason}`)
      return exclusiveDevice.renderer
    })
    await writeFile(join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'gpu-smoke.json'), JSON.stringify({ records, exclusiveAt, exclusiveDevice,
      leaseFile: GPU_LEASE_FILE, ports: { worker: Number(process.env.OBPAL_E2E_WORKER_PORT) }, sharedWorker: true }, null, 2) + '\n')
  } finally {
    cancelled.abort(new Error('GPU smoke finished'))
    drain.resolve()
    await Promise.allSettled(holders)
    if (exclusive) releaseExclusive ??= await exclusive.catch(() => null)
    await releaseExclusive?.()
  }
}

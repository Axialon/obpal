/**
 * Screenshots of a page from this checkout's build (local stand-in), on a desktop and a phone, top and scrolled, with
 * any page errors. PAGE=/path (default /), SHOTS=<dir>. Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM.
 */
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
const local = await startLocal()
const b = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, args: ['--ignore-certificate-errors'] })
const out = process.env.SHOTS
for (const [name, opts] of [['desk', { viewport: { width: 1280, height: 800 } }], ['phone', { ...devices['Pixel 7'] }]]) {
  const p = await (await b.newContext({ ...opts, ignoreHTTPSErrors: true })).newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(`${local.origin}${process.env.PAGE || '/'}`)
  await p.waitForTimeout(1500)
  await p.screenshot({ path: `${out}/${name}-top.png` })
  await p.mouse.wheel(0, 900)
  await p.waitForTimeout(1200)
  if (name === 'desk') { await p.mouse.move(420, 420); await p.mouse.move(520, 380, { steps: 8 }); await p.waitForTimeout(500) }
  await p.screenshot({ path: `${out}/${name}-scroll.png` })
  console.log(name, errs.length ? errs : 'no errors')
}
await b.close(); await local.close()

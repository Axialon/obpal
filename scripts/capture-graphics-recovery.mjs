/** Requested screenshots live in ignored artifacts; the tests themselves use temporary output. */
import { distill } from './lib/distill.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'
import { failGraphics, GRAPHICS_SCENES } from './lib/graphics-failure.mjs'

const phase = process.argv[2] || 'before'
const only = process.argv[3]
const out = join('artifacts', 'graphics-recovery', phase)
await mkdir(out, { recursive: true })
const local = await startLocal()
const { path: executablePath } = await resolveChromium()
const browser = await chromium.launch({ executablePath, headless: true, args: ['--ignore-certificate-errors'] })
const summary = only ? JSON.parse(await readFile(join(out, 'summary.json'), 'utf8').catch(() => '[]')).filter(row => only === 'assets' ? row.kind === 'context' : row.kind !== only) : []
try {
  const cases = [...GRAPHICS_SCENES.map(scene => [scene, 'context']), ...['slow', 'model', 'import'].map(kind => ['drone', kind])]
  for (const [scene, kind] of cases.filter(([, kind]) => !only || (only === 'assets' ? kind !== 'context' : kind === only))) for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, ignoreHTTPSErrors: true })
    try {
      await failGraphics(context, kind)
      const page = await context.newPage()
      let errors = 0, navigations = 0
      page.on('pageerror', () => errors++)
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++ })
      await page.goto(`${local.origin}/sim/${scene}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(400)
      const prefix = join(out, `${scene}-${kind}-${width}`)
      await page.screenshot({ path: `${prefix}-initial.png` })
      await page.waitForTimeout(kind === 'context' || kind === 'import' ? 16500 : 10000)
      await page.screenshot({ path: `${prefix}-later.png` })
      const state = await page.evaluate(() => ({
        title: document.title,
        busy: !!document.querySelector('#sim-load:not([hidden])'),
        ready: document.querySelector('canvas')?.dataset.simReady === 'true',
        recovery: document.querySelector('#sim-recovery')?.textContent ?? '',
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      }))
      const row = { scene, kind, width, errors, navigations, ...state }
      summary.push(row)
      console.log(JSON.stringify(row))
      await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
    } finally { await context.close() }
  }
} finally { await browser.close(); await local.close() }

await distill(out, { keepRaw: process.argv.includes("--keep-raw") || process.env.OBPAL_KEEP_RAW === "1" })

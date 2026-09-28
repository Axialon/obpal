/** Review optical anchors through the integrated first-person view. Test evidence stays in temp. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { startLocal } from '../extension/e2e/local.mjs'

const arms = ['arm5', 'six', 'scara', 'delta', 'desk', 'so101']
const registry = await readFile('src/sim/devices/registry.ts', 'utf8')
const devices = [...registry.matchAll(/entry\(\{ spec: (\w+)_SPEC/g)].map(m => m[1].toLowerCase())
const models = new Set((await readdir('public/models')).filter(n => n.endsWith('.glb')).map(n => n.slice(0, -4)))
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',')
const names = [...arms, ...devices].filter(name => !only || only.includes(name))
const out = await mkdtemp(join(tmpdir(), 'obpal-rollout-pov-')), report = []
for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  assert(process.env[key], `${key} is required`)
  await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(Number(process.env[key]), '127.0.0.1', () => s.close(resolve)) })
}
const local = await startLocal({ dist: resolve('dist/client') })
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors'] })
  for (const name of names) for (const fallback of name === 'helicopter' ? [true, false] : [false]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const page = await context.newPage(), errors = [], arm = arms.includes(name)
    const model = ['slider', 'jib'].includes(name) ? 'film-camera' : models.has(name) ? name : null
    page.on('pageerror', error => errors.push(error.message))
    if (fallback) await page.route('**/models/*.glb', route => route.fulfill({ status: 503, body: 'Optional model unavailable' }))
    await page.goto(`${local.origin}${arm ? '/sim/arm/?kind=' : '/sim/device/?d='}${name}&quality=native&test=vr`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__presence?.experience.rides().length)
    if (model && !fallback) await page.waitForFunction(model => performance.getEntriesByName(`obpal:${model}:visible`).length, model)
    await page.getByRole('button', { name: 'First person', exact: true }).click()
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.__presence.state().mode), 'first-person')
    assert.deepEqual(errors, [])
    const id = `${name}${fallback ? '-fallback' : ''}`
    await page.screenshot({ path: join(out, `${id}.png`) })
    report.push(id); console.log(`${id}: first-person image`)
    await context.close()
  }
} finally { await browser?.close(); await local.close() }
for (let n = 0; n < report.length; n += 4) {
  const layers = await Promise.all(report.slice(n, n + 4).map(async (id, i) => ({ input: await sharp(join(out, `${id}.png`)).resize(800, 500).toBuffer(), left: i % 2 * 800, top: Math.floor(i / 2) * 500 })))
  await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#171e22' } }).composite(layers).png().toFile(join(out, `sheet-${n / 4 + 1}.png`))
}
await writeFile(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Camera anchors</title><style>body{font:16px system-ui;background:#171e22;color:#eee;margin:32px}img{max-width:100%}a{color:#c6ff34}</style><h1>Camera anchors</h1>${report.map(id => `<h2>${id}</h2><a href="${id}.png"><img src="${id}.png" alt="${id} first person"></a>`).join('')}`)
console.log(`Camera evidence: ${out}`)

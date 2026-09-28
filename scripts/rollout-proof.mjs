/** Loading, anchor and full-scene budget proof. Test output always goes to a fresh temporary folder. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

const arms = ['arm5', 'six', 'scara', 'delta', 'desk', 'so101']
const registry = await readFile('src/sim/devices/registry.ts', 'utf8')
const devices = [...registry.matchAll(/entry\(\{ spec: (\w+)_SPEC/g)].map(m => m[1].toLowerCase())
const models = new Set((await readdir('public/models')).filter(n => n.endsWith('.glb')).map(n => n.slice(0, -4)))
const modelFor = name => ['slider', 'jib'].includes(name) ? 'film-camera' : models.has(name) ? name : null
const out = await mkdtemp(join(tmpdir(), 'obpal-rollout-proof-'))
for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  assert(process.env[key], `${key} is required`)
  await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(Number(process.env[key]), '127.0.0.1', () => server.close(resolve)) })
}
const report = [], local = await startLocal({ dist: resolve('dist/client') })
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',')
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors'] })
  for (const name of [...arms, ...devices]) {
    if (only && !only.includes(name)) continue
    const arm = arms.includes(name), model = modelFor(name)
    for (const failure of model ? [true, false] : [false]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
      const page = await context.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error' && /THREE\.|mergeGeometries|WebGL.*INVALID/.test(message.text())) errors.push(message.text()) })
      let release
      const gate = new Promise(resolve => { release = resolve })
      if (model) await page.route(`**/models/${model}.glb`, async route => {
        if (failure) await route.fulfill({ status: 503, body: 'Optional model unavailable' })
        else { await gate; await route.continue() }
      })
      await page.goto(`${local.origin}${arm ? '/sim/arm/?kind=' : '/sim/device/?d='}${name}&quality=native`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__gfx?.().triangles > 0 && (window.__arm || window.__device))
      const firstPaint = await page.evaluate(() => performance.now())
      if (model) {
        assert.equal(await page.evaluate(model => performance.getEntriesByName(`obpal:${model}:visible`).length, model), 0)
        await page.waitForTimeout(350)
        if (!failure) {
          release()
          await page.waitForFunction(model => performance.getEntriesByName(`obpal:${model}:visible`).length > 0, model)
          assert(await page.evaluate(model => performance.getEntriesByName(`obpal:${model}:visible`)[0].startTime, model) > firstPaint + 300)
        }
      }
      const anchors = await page.evaluate(() => {
        if (!window.__device) return null
        const d = window.__device, anchors = []
        d.stage.scene.updateMatrixWorld(true)
        d.stage.scene.traverse(node => { if (node.name === 'pov') anchors.push({ matrix: node.matrixWorld.elements, direction: node.getWorldDirection(node.position.clone()).toArray() }) })
        return { expected: d.spec.units, anchors }
      })
      if (anchors) {
        assert.equal(anchors.anchors.length, anchors.expected, `${name}: camera count`)
        for (const anchor of anchors.anchors) {
          assert(anchor.matrix.every(Number.isFinite)); assert(Math.abs(Math.hypot(...anchor.direction) - 1) < 1e-6)
        }
      }
      if (failure) { assert.deepEqual(errors, []); await context.close(); console.log(`${name}: failed model retains renderable scene and camera anchors`); continue }
      await page.getByRole('button', { name: 'Overview', exact: true }).click()
      if (arm) {
        await page.evaluate(() => { while (window.__arm.arms().length < 4) window.__arm.addArm() })
        await page.waitForTimeout(350)
      }
      const metrics = await page.evaluate(async ({ name, arm }) => {
        const samples = [], before = window.__device ? JSON.stringify(window.__device.logic) : '', initial = window.__arm?.arms()
        let previous = performance.now()
        for (let frame = 0; frame < 150; frame++) {
          if (arm) {
            if (frame % 30 === 0) for (const [n, unit] of window.__arm.arms().entries()) {
              const keys = window.__arm.kind().keys, pose = Object.fromEntries(keys.map((key, j) => [key, initial[n].joints[j].angle + Math.sin(frame / 30 + n) * 12]))
              window.__arm.goTo(unit.id, pose, .5)
            }
          } else {
            const d = window.__device, a = Math.sin(frame / 20) * .5
            const input = n => ({ face: d.spec.controllers.includes('face.gamepad') ? 'face.gamepad' : d.spec.controllers[0], mode: 5,
              pad: { axes: [a, -.5, a, -.4], triggers: [.2, .65], buttons: 0, flags: 0, seq: frame, t: frame * 16 }, padPressed: 0,
              touching: true, drag: [a * 2, -.8], pan: [0, 0], pinch: 0, twist: a, tilt: [a, -.3], hold: [0, 0, 0, 1],
              point: { x: 0, y: 0, yaw: a * 25, pitch: 10, off: false }, spot: [a, 0],
              pose: { p: [a, 1, 0], q: [0, 0, 0, 1], tracked: true, touching: true, gen: 0 },
              held: new Set(['wii-a']), presses: frame === 0 ? [d.spec.tray[0]?.id ?? ''] : [], wheel: 0, text: '', del: 0, values: [], recentred: false })
            if (name === 'marblerun') for (const unit of d.logic.units) unit.track = Array.from({ length: 25 }, (_, i) => ({ kind: i % 2, turn: i % 4 }))
            if (name === 'studio') d.logic.hits.forEach(hits => hits.fill(.8))
            d.logic.step(Array.from({ length: d.spec.units }, (_, n) => input(n)), 1 / 60)
            d.stage.view.invalidate()
          }
          await new Promise(resolve => requestAnimationFrame(now => { samples.push({ ...window.__gfx(), frameMs: now - previous }); previous = now; resolve() }))
        }
        const values = key => samples.slice(20).map(s => s[key]).filter(Number.isFinite).sort((a, b) => a - b)
        const median = key => { const a = values(key); return a[Math.floor(a.length / 2)] }
        return { triangles: Math.max(...values('triangles')), calls: Math.max(...values('calls')), renderMs: median('renderMs'), frameMs: median('frameMs'),
          units: arm ? window.__arm.arms().length : window.__device.spec.units,
          changed: arm ? JSON.stringify(initial) !== JSON.stringify(window.__arm.arms()) : before !== JSON.stringify(window.__device.logic),
          finiteAnchors: arm || (() => { let finite = true; window.__device.stage.scene.traverse(node => { if (node.name === 'pov' && !node.matrixWorld.elements.every(Number.isFinite)) finite = false }); return finite })() }
      }, { name, arm })
      assert.deepEqual(errors, [], `${name}: browser errors`)
      assert(metrics.finiteAnchors, `${name}: moving camera frame`)
      const row = { name, model, modelBytes: model ? (await readFile(`public/models/${model}.glb`)).length : 0, ...metrics }
      report.push(row); await writeFile(join(out, 'stress.json'), JSON.stringify(report, null, 2))
      console.log(`${name}: ${row.units} units, ${row.triangles} triangles, ${row.calls} draws, ${row.frameMs.toFixed(1)} ms`)
      await context.close()
    }
  }
  const over = report.filter(row => row.triangles > 250_000 || row.calls > 150)
  assert.deepEqual(over, [], 'Full-scene render budgets')
} finally { await browser?.close(); await local.close(); console.log(`Review evidence: ${out}`) }

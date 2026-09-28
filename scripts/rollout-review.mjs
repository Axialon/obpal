/** Capture the seven appearance batches; evidence stays in the ignored review directory. */
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export const batches = [
  ['arm5', 'six', 'scara', 'delta', 'desk', 'so101'],
  ['drone', 'helicopter', 'plane', 'telescope'],
  ['rover', 'kart', 'boat', 'tank', 'forklift', 'excavator', 'slotcars', 'planetary', 'submarine'],
  ['lamp', 'smarthome', 'vacuum', 'spotlights', 'ptz', 'gimbal', 'slider', 'jib', 'painter'],
  ['claw', 'maze', 'pinball', 'airhockey', 'football', 'marblerun'],
  ['sorting', 'pendulum', 'trebuchet', 'dog'],
  ['studio'],
]
const phase = process.argv[2] || 'after', selected = Number(process.argv[3] || 0)
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',')
const base = 'artifacts/codex-rollout', out = `${base}/${phase}`
await mkdir(out, { recursive: true })
const report = JSON.parse(await readFile(`${out}/report.json`, 'utf8').catch(() => '[]'))
if (!process.argv.includes('--viewer-only')) {
  for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
    if (!process.env[key]) throw new Error(`${key} is required`)
    await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(Number(process.env[key]), '127.0.0.1', () => s.close(resolve)) })
  }
  const local = await startLocal({ dist: resolve(process.env.OBPAL_STYLE_BUILD || 'dist/client') })
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors'] })
    for (const [batch, names] of batches.entries()) {
      if (selected && selected !== batch + 1) continue
      for (const name of names) {
        if (only && !only.includes(name)) continue
        const arm = batches[0].includes(name)
        for (const [screen, width, height] of [['desktop', 1280, 800], ['phone', 390, 844], ['landscape', 844, 390]]) {
          const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
          const page = await ctx.newPage(), errors = []
          page.on('pageerror', e => errors.push(e.message))
          page.on('console', m => { if (m.type() === 'error' && /THREE\.|mergeGeometries|WebGL.*INVALID/.test(m.text())) errors.push(m.text()) })
          await page.goto(`${local.origin}${arm ? '/sim/arm/?kind=' : '/sim/device/?d='}${name}&quality=native`, { waitUntil: 'domcontentloaded' })
          await page.waitForFunction(() => window.__gfx?.().triangles > 0 && (window.__arm || window.__device))
          await page.waitForTimeout(2200)
          const pairing = page.getByRole('button', { name: 'Scan to control', exact: true })
          if (await pairing.count()) { await pairing.focus(); await pairing.press('Escape'); await pairing.evaluate(el => el.blur()); await page.mouse.move(5, 5) }
          await page.waitForTimeout(250)
          await page.screenshot({ path: `${out}/${name}-${screen}.png` })
          if (screen === 'desktop') {
            await page.getByRole('button', { name: arm ? 'Inspect arm' : 'Inspect model', exact: true }).click()
            await page.waitForTimeout(650)
            await page.screenshot({ path: `${out}/${name}-close.png` })
            const overview = page.getByRole('button', { name: 'Overview', exact: true })
            if (await overview.count()) { await overview.click(); await page.waitForTimeout(650) }
            await page.screenshot({ path: `${out}/${name}-scene.png` })
          }
          const measurements = await page.evaluate(async () => {
            const samples = []; let previous = performance.now()
            for (let n = 0; n < 90; n++) await new Promise(resolve => requestAnimationFrame(now => { samples.push({ ...window.__gfx(), interval: now - previous }); previous = now; resolve() }))
            const q = (key, p) => { const a = samples.slice(10).map(s => s[key]).filter(Number.isFinite).sort((a,b) => a-b); return a[Math.floor((a.length-1)*p)] ?? null }
            const models = performance.getEntriesByType('resource').filter(r => r.name.endsWith('.glb')).map(r => new URL(r.name).pathname.split('/').pop())
            const anchors = []; window.__device?.stage.scene.traverse(o => { if (o.name === 'pov') anchors.push({ at: o.getWorldPosition(o.position.clone()).toArray(), forward: o.getWorldDirection(o.position.clone()).toArray() }) })
            return { triangles: q('triangles', 1), calls: q('calls', 1), renderMs: q('renderMs', .5), renderP95: q('renderMs', .95), frameMs: q('interval', .5), frameP95: q('interval', .95), models: [...new Set(models)], anchors }
          })
          let modelBytes = 0
          for (const model of measurements.models) modelBytes += (await readFile(`public/models/${model}`)).length
          const old = report.findIndex(r => r.name === name && r.screen === screen)
          const row = { name, batch: batch + 1, screen, ...measurements, modelBytes, errors }
          if (old >= 0) report[old] = row; else report.push(row)
          await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2))
          console.log(name, screen, JSON.stringify({ triangles: row.triangles, calls: row.calls, frameMs: row.frameMs, errors }))
          await ctx.close()
        }
      }
    }
  } finally { await browser?.close(); await local.close() }
}
const before = JSON.parse(await readFile(`${base}/before/report.json`, 'utf8').catch(() => '[]'))
const after = JSON.parse(await readFile(`${base}/after/report.json`, 'utf8').catch(() => '[]'))
const stress = JSON.parse(await readFile(`${base}/stress.json`, 'utf8').catch(() => '[]'))
const hasPov = await readFile(`${base}/pov/index.html`, 'utf8').then(() => true, () => false)
const available = new Set((await readdir(`${base}/after`).catch(() => [])).filter(n => n.endsWith('-desktop.png')).map(n => n.replace('-desktop.png', '')))
const formats = ['desktop', 'phone', 'landscape', 'close', 'scene']
const sections = batches.map((names, i) => `<section><h2>${i+1}. ${['Arms and workbench','Flying','Vehicles','Home, camera and stage','Games','Science and industry','Music studio'][i]}</h2>${names.filter(n => available.has(n) || before.some(r => r.name === n)).map(n => `<article id="${n}"><h3>${n}</h3>${formats.map(f => `<details ${f === 'desktop' ? 'open' : ''}><summary>${f}</summary><div class="pair">${['before','after'].map(p => `<figure><figcaption>${p}</figcaption><a href="${p}/${n}-${f}.png"><img loading="lazy" src="${p}/${n}-${f}.png" alt="${n} ${p} ${f}"></a></figure>`).join('')}</div></details>`).join('')}</article>`).join('')}</section>`).join('')
const rows = after.filter(r => r.screen === 'desktop').map(r => `<tr><td><a href="#${r.name}">${r.name}</a></td><td>${r.triangles}</td><td>${r.calls}</td><td>${r.modelBytes}</td><td>${r.renderMs?.toFixed(2)}</td><td>${r.frameMs?.toFixed(2)} / ${r.frameP95?.toFixed(2)}</td></tr>`).join('')
const active = stress.length ? `<h2>Active scenes with every seat</h2><p>Four arms per arm scene; all available device seats, moving controls and filled marble boards. Peak submitted triangles and draws include shadow and inset passes. Failed and delayed GLB requests are checked separately before measuring. Model bytes count each downloaded asset once.</p><table><thead><tr><th>Sim</th><th>Seats</th><th>Triangles</th><th>Draws</th><th>Model bytes</th><th>CPU render ms</th><th>Frame ms median</th></tr></thead><tbody>${stress.map(r => `<tr><td><a href="#${r.name}">${r.name}</a></td><td>${r.units}</td><td>${r.triangles}</td><td>${r.calls}</td><td>${r.modelBytes}</td><td>${r.renderMs?.toFixed(2)}</td><td>${r.frameMs?.toFixed(2)}</td></tr>`).join('')}</tbody></table>` : ''
await writeFile(`${base}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ob.Pal rollout review</title><style>body{margin:32px;background:#171e22;color:#e9e8e0;font:15px/1.5 system-ui}h1{font-size:40px}h2{border-top:1px solid #68767d;padding-top:24px}a,summary{color:#c6ff34}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}img{width:100%;height:auto}article{margin:32px 0}td,th{padding:8px;text-align:left;border-bottom:1px solid #68767d}details{margin:12px 0}summary{cursor:pointer}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style><h1>Precise edges, smooth metal</h1><p>Seven batches. Full scene, play view and close-ups at desktop, portrait phone and landscape phone sizes. Measurements use local headless Chromium at native quality, pixel ratio 1; viewport sizes do not represent physical-phone performance.</p>${hasPov ? '<p><a href="pov/index.html">First-person camera review</a></p>' : ''}${active}<h2>Captured desktop scenes</h2><table><thead><tr><th>Sim</th><th>Triangles</th><th>Draws</th><th>Model bytes</th><th>CPU render ms</th><th>Frame ms median / p95</th></tr></thead><tbody>${rows}</tbody></table>${sections}</html>`)

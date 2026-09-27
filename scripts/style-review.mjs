/** Capture the style prototypes from a local build. Uses only the two assigned e2e ports and Playwright Chromium.
 * Capture original, round1, round2, round3 and round4 builds; outputs are ignored review artifacts.
 */
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { writeRules } from './style-rules.mjs'

const phase = process.argv[2] || 'round4'
if (!['original', 'round1', 'round2', 'round3', 'round4'].includes(phase)) throw new Error('Choose original, round1, round2, round3 or round4')
const out = new URL(`../artifacts/codex-style/${phase}/`, import.meta.url)
const buildDir = resolve(process.env.OBPAL_STYLE_BUILD || 'dist/client')
const only = process.argv.find(a => a.startsWith('--model='))?.slice(8)
if (only && !['drone', 'so101', 'rover'].includes(only)) throw new Error('Unknown model')
await mkdir(out, { recursive: true })
if (!process.argv.includes('--viewer-only')) {
for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  if (!process.env[key]) throw new Error(`${key} is required`)
  await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(Number(process.env[key]), '127.0.0.1', () => s.close(resolve)) })
}
const local = await startLocal({ dist: buildDir })
let browser
const report = only ? JSON.parse(await readFile(new URL('report.json', out), 'utf8')).report.filter(r => r.name !== only) : []
try {
  browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors'] })
  for (const name of ['drone', 'so101', 'rover']) {
    if (only && name !== only) continue
    for (const [screen, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      const page = await ctx.newPage()
      const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()) })
      await page.addInitScript(() => { const sample = () => { if (window.__gfx?.().triangles > 0) window.__styleFirstFrame = performance.now(); else requestAnimationFrame(sample) }; requestAnimationFrame(sample) })
      const path = name === 'so101' ? '/sim/arm/?kind=so101' : `/sim/device/?d=${name}`
      await page.goto(`${local.origin}${path}&quality=native`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__gfx?.().triangles > 0)
      const firstFrameMs = await page.evaluate(() => window.__styleFirstFrame ?? performance.now())
      if (['round2', 'round3', 'round4'].includes(phase)) await page.waitForFunction(name => performance.getEntriesByName(`obpal:${name}:visible`).length > 0, name)
      const load = await page.evaluate(name => Object.fromEntries(['load', 'decoded', 'visible'].map(step => [step, performance.getEntriesByName(`obpal:${name}:${step}`, 'mark')[0]?.startTime ?? null])), name)
      await page.waitForFunction(() => window.__device || window.__arm)
      await page.waitForTimeout(1800)
      const pairing = page.getByRole('button', { name: 'Scan to control', exact: true })
      // Escape closes both pinned and hover-open cards; clicking a peek would pin it.
      await pairing.focus(); await pairing.press('Escape'); await page.mouse.move(5, 5)
      await pairing.evaluate(el => el.blur()); await page.waitForTimeout(450)
      if (await pairing.getAttribute('aria-expanded') === 'true') throw new Error('Pairing card obscures the style capture')
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-${screen}.png`, out)) })
      const pageScripts = await page.evaluate(() => performance.getEntriesByType('resource').map(r => new URL(r.name).pathname).filter(p => p.startsWith('/assets/') && p.endsWith('.js')).map(p => p.slice('/assets/'.length)))
      const overview = await page.evaluate(() => window.__gfx())
      await page.getByRole('button', { name: name === 'so101' ? 'Inspect arm' : 'Inspect model', exact: true }).click()
      await page.waitForTimeout(600)
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-${screen}-close.png`, out)) })
      // Exercise live logic with the same intent stream on both revisions. Cameras follow the first device.
      await page.evaluate(name => {
        if (name === 'so101') {
          window.__arm.goTo('a1', { yaw: 35, shoulder: -30, elbow: 90, wrist: 50, roll: 65 }, .35)
          window.__styleTimer = setTimeout(() => window.__arm.goTo('a1', { yaw: 0, shoulder: -5, elbow: 95, wrist: 70, roll: 0 }, 1), 2300)
        } else {
          const d = window.__device; const old = d.logic.step.bind(d.logic); let elapsed = 0
          const input = { face: 'face.gamepad', mode: 0, pad: { axes: [0, 0, 0, 0], buttons: 0, triggers: [0, 0] }, padPressed: 0, presses: [], touching: false, drag: [0, 0], pan: [0, 0], pinch: 0, twist: 0, tilt: [0, 0], hold: null, point: null, spot: null, pose: null, recentred: false, held: new Set() }
          d.logic.step = (_inputs, dt) => {
            elapsed += dt
            if (name === 'drone') { input.presses = elapsed < dt * 1.5 || (elapsed >= 3 && elapsed - dt < 3) ? ['fly'] : []; input.pad.axes = [elapsed > 2 && elapsed < 3 ? .25 : 0, 0, 0, 0] }
            else input.pad.axes = [elapsed < 2 ? .35 : 0, elapsed < 2 ? -.18 : 0, 0, 0]
            old([input], dt)
            const r = name === 'drone' ? d.logic.drones[0] : d.logic.rovers[0]
            const p = d.stage.controls.target; const delta = { x: r.x - p.x, y: (r.y || 0) + .17 - p.y, z: r.z - p.z }
            d.stage.camera.position.x += delta.x; d.stage.camera.position.y += delta.y; d.stage.camera.position.z += delta.z
            p.set(r.x, (r.y || 0) + .17, r.z)
            d.stage.view.invalidate()
          }
        }
        window.__styleSamples = []
        let previous = performance.now()
        const sample = now => { window.__styleSamples.push({ ...window.__gfx(), interval: now - previous, pose: window.__arm?.arms()[0].joints.map(j => j.angle) }); previous = now; if (window.__styleSamples.length < 240) requestAnimationFrame(sample) }
        requestAnimationFrame(sample)
      }, name)
      if (screen === 'desktop') {
        await page.evaluate(() => {
          const canvas = document.querySelector('canvas#stage'); const stream = canvas.captureStream(30)
          window.__styleChunks = []; window.__styleRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
          window.__styleRecorder.ondataavailable = e => window.__styleChunks.push(e.data)
          window.__styleRecorder.start()
        })
      }
      await page.waitForTimeout(6500)
      if (screen === 'desktop') {
        const bytes = await page.evaluate(() => new Promise(resolve => {
          window.__styleRecorder.onstop = async () => { const b = new Blob(window.__styleChunks); resolve(Array.from(new Uint8Array(await b.arrayBuffer()))); window.__styleRecorder.stream.getTracks().forEach(t => t.stop()) }
          window.__styleRecorder.stop()
        }))
        await writeFile(new URL(`${name}-motion.webm`, out), Buffer.from(bytes))
      }
      const samples = await page.evaluate(() => window.__styleSamples)
      const quantile = (key, q) => { const a = samples.slice(15).map(s => s[key]).filter(x => typeof x === 'number').sort((a,b) => a-b); return a[Math.floor((a.length-1)*q)] ?? null }
      const jointTravel = name === 'so101' ? samples[0].pose.map((_, i) => Math.max(...samples.map(s => s.pose[i])) - Math.min(...samples.map(s => s.pose[i]))) : undefined
      report.push({ name, screen, firstFrameMs, load, pageScripts, overview, moving: { triangles: quantile('triangles', .95), calls: quantile('calls', .95), renderMs: quantile('renderMs', .5), renderP95: quantile('renderMs', .95), gpuMs: quantile('gpuMs', .5), interval: quantile('interval', .5), intervalP95: quantile('interval', .95), jointTravel }, errors })
      console.log(name, screen, JSON.stringify(report.at(-1).moving), errors)
      if (screen === 'desktop') {
        await page.evaluate(async name => {
          document.querySelectorAll('body > :not(#stage)').forEach(el => { el.style.display = 'none' })
          dispatchEvent(new Event('resize'))
          if (name === 'so101') {
            for (const a of window.__arm.arms().slice(1)) await window.__arm.removeArm(a.id)
            const s = window.__arm.stand('a1')
            window.__arm.goTo('a1', { yaw: 0, shoulder: -5, elbow: 95, wrist: 70, roll: 0 }, 1)
            window.__arm.view([s.x + .95, .8, s.z + 1.05], [s.x + .22, .30, s.z])
          } else {
            const d = window.__device, r = name === 'drone' ? d.logic.drones[0] : d.logic.rovers[0]
            d.stage.frame({ target: [r.x, (r.y || 0) + .15, r.z], wide: [r.x + .72, (r.y || 0) + .65, r.z - .9], tall: [r.x + .72, (r.y || 0) + .65, r.z - .9], radius: .4, min: .4, max: 38 })
          }
        }, name)
        await page.waitForTimeout(1600)
        await page.screenshot({ path: fileURLToPath(new URL(`${name}-detail.png`, out)), clip: { x: 80, y: 60, width: 1120, height: 680 } })
      }
      await ctx.close()
    }
  }
  const bundles = []
  for (const file of await readdir(`${buildDir}/assets`)) if (file.endsWith('.js')) { const b = await readFile(`${buildDir}/assets/${file}`); bundles.push({ file, bytes: b.length, gzip: gzipSync(b).length }) }
  const modelAssets = []
  for (const name of ['drone', 'so101', 'rover']) { const data = await readFile(`${buildDir}/models/${name}.glb`).catch(() => null); if (data) modelAssets.push({ name, bytes: data.length, gzip: gzipSync(data).length }) }
  await writeFile(new URL('report.json', out), JSON.stringify({ phase, report, bundles, modelAssets, modelAssetBytes: modelAssets.reduce((n, a) => n + a.bytes, 0) }, null, 2))
} finally { await browser?.close(); await local.close() }
}

// A portable, local viewer. Its generated markup never enters a site page.
if (phase === 'round4') {
  const phases = ['original', 'round1', 'round2', 'round3', 'round4']
  const labels = ['Original', 'Round 1 · procedural', 'Round 2 · Blender', 'Round 3 · armour', 'Round 4 · precision']
  const all = await Promise.all(phases.map(async p => JSON.parse(await readFile(new URL(`../artifacts/codex-style/${p}/report.json`, import.meta.url), 'utf8'))))
  const stress = JSON.parse(await readFile(new URL('../artifacts/codex-style/stress.json', import.meta.url), 'utf8').catch(() => '[]'))
  const kb = n => `${(n / 1000).toFixed(1)} kB`
  const row = (name, r) => r.report.find(x => x.name === name && x.screen === 'desktop')
  const pageBytes = (name, r) => {
    const chunks = r.bundles.filter(b => row(name, r).pageScripts.includes(b.file))
    return `${kb(chunks.reduce((n, b) => n + b.bytes, 0))} / ${kb(chunks.reduce((n, b) => n + b.gzip, 0))}`
  }
  const title = name => name === 'so101' ? 'SO-101' : name[0].toUpperCase() + name.slice(1)
  const sections = ['drone', 'so101', 'rover'].map(name => `<section id="${name}"><h2>${title(name)}</h2>
    <div class="compare" data-model="${name}">${phases.map((p, i) => `<figure><figcaption>${labels[i]}</figcaption><a href="${p}/${name}-desktop.png"><img src="${p}/${name}-desktop.png" alt="${title(name)}, ${labels[i]}"></a></figure>`).join('')}</div>
    <details open><summary>Surface details</summary><div class="phases">${phases.map((p, i) => `<figure><figcaption>${labels[i]}</figcaption><a href="${p}/${name}-detail.png"><img loading="lazy" src="${p}/${name}-detail.png" alt="${title(name)} surface detail, ${labels[i]}"></a></figure>`).join('')}</div></details>
    <details open><summary>Live motion · starts, movement and settling</summary><div class="phases">${phases.map((p, i) => `<figure><figcaption>${labels[i]}</figcaption><video controls loop muted playsinline preload="metadata" poster="${p}/${name}-detail.png" src="${p}/${name}-motion.webm"></video></figure>`).join('')}</div></details>
    <div class="table"><table><thead><tr><th>Desktop measurements</th>${labels.map(l => `<th>${l}</th>`).join('')}</tr></thead><tbody>
    ${[['Triangles', r => Math.max(row(name,r).overview.triangles,row(name,r).moving.triangles).toLocaleString()],['Draw calls', r => Math.max(row(name,r).overview.calls,row(name,r).moving.calls)],['CPU render median / p95', r => `${row(name,r).moving.renderMs.toFixed(2)} / ${row(name,r).moving.renderP95.toFixed(2)} ms`],['Frame interval median / p95', r => `${row(name,r).moving.interval.toFixed(1)} / ${row(name,r).moving.intervalP95.toFixed(1)} ms`],['First rendered frame',r => `${row(name,r).firstFrameMs.toFixed(0)} ms`],['Blender visible from navigation',r => row(name,r).load?.visible ? `${row(name,r).load.visible.toFixed(0)} ms` : '—'],['Blender load and decode',r => row(name,r).load?.decoded ? `${(row(name,r).load.decoded-row(name,r).load.load).toFixed(0)} ms` : '—'],['Requested JavaScript · raw / gzip',r => pageBytes(name,r)],['Model asset · raw / gzip',r => { const a=r.modelAssets?.find(a=>a.name===name);return a ? `${kb(a.bytes)} / ${kb(a.gzip)}` : '0 kB' }]].map(([label, fn]) => `<tr><th>${label}</th>${all.map(r=>`<td>${fn(r)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div><p class="note">Four active units: ${stress.find(s=>s.name===name)?.triangles.toLocaleString()} triangles, ${stress.find(s=>s.name===name)?.calls} draws. Full reports: ${phases.map(p=>`<a href="${p}/report.json">${p}</a>`).join(' · ')}.</p></section>`).join('')
  const scene = `<section id="yard"><h2>The rover yard</h2><p>Identical cameras before and after: floor modules, edge walls, ramps, gates and movable cones. Physics and course dimensions are unchanged.</p>${[['yard','Whole scene'],['yard-ramp','Ramp and deck'],['yard-gate','Gate and edge wall'],['yard-floor','Floor and markers']].map(([file,label])=>`<details open><summary>${label}</summary><div class="scene">${['round3','round4'].map((p,i)=>`<figure><figcaption>${i ? 'Round 4' : 'Before / round 3'}</figcaption><a href="${p}/${file}.png"><img loading="lazy" src="${p}/${file}.png" alt="${label}, ${p}"></a></figure>`).join('')}</div></details>`).join('')}<div class="scene">${['round3','round4'].map(p=>`<figure><figcaption>${p} / slow orbit</figcaption><video controls loop muted playsinline preload="metadata" poster="${p}/yard.png" src="${p}/yard-motion.webm"></video></figure>`).join('')}</div></section>`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ob.Pal · Blender style review</title><style>
  *{box-sizing:border-box}body{margin:0;background:#121618;color:#e9e8e0;font:15px/1.55 system-ui,sans-serif}main{max-width:2000px;margin:auto;padding:40px 28px}header{max-width:940px;margin-bottom:32px}h1{font-size:clamp(28px,4vw,54px);line-height:1.12;letter-spacing:-.04em;margin:12px 0 18px}h2{font-size:30px;letter-spacing:-.02em;margin:0 0 18px}p{color:#b6c0c1}.eyebrow{color:#c6ff34;letter-spacing:.14em;text-transform:uppercase;font-size:12px}a{color:#c6ff34}nav{display:flex;flex-wrap:wrap;gap:22px;margin:24px 0}label{display:block;margin:28px 0}select{background:#252d30;color:#f4f5ef;border:1px solid #687579;border-radius:7px;padding:9px;font:inherit;margin-left:10px}section{border-top:1px solid #394345;padding:30px 0 42px;scroll-margin-top:18px}.scene{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.compare,.phases{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px}figure{margin:0;min-width:0}figcaption{padding:10px 0;color:#d8dfdc;font-size:13px}img,video{display:block;width:100%;height:auto;background:#080c0d;border-radius:8px}video{aspect-ratio:8/5}details{margin-top:22px}summary{cursor:pointer;color:#c6ff34;margin-bottom:8px}.table{overflow:auto;margin-top:24px}table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}th,td{padding:10px 12px;border-bottom:1px solid #343e40;white-space:nowrap}thead{color:#c6ff34}tbody th{font-weight:500}.note,footer{font-size:13px;color:#97a6a8}li{margin:7px 0}footer{border-top:1px solid #394345;padding-top:20px}@media(max-width:760px){main{padding:24px 16px}.compare,.phases,.scene{grid-template-columns:1fr}select{display:block;margin:8px 0 0}h2{font-size:25px}}
  </style><main><header><div class="eyebrow">ob.Pal / owner review / round 4</div><h1>Precise edges.<br>Smooth metal.</h1><p>Five stages of the same working devices. Round four replaces repeated rounded caps with faceted component housings, metal-framed ceramic insets and narrow chamfers. The rover yard now shares their materials and construction. Every mesh is original; the existing controls and springs drive the authored joints.</p><nav><a href="#drone">Drone</a><a href="#so101">SO-101</a><a href="#rover">Rover</a><a href="#yard">Rover yard</a><a href="rules.html">Illustrated rules</a><a href="#decisions">Decisions</a></nav><label>Compare <select id="format"><option value="desktop">Desktop · 1280 × 800</option><option value="desktop-close">Desktop close-up</option><option value="phone">Phone · 390 × 844</option><option value="phone-close">Phone close-up</option></select></label></header>${sections}${scene}
  <section id="decisions"><h2>For the owner</h2><ol><li>Confirm the two chamfers: 0.5 mm Detail and 2 mm Housing, with 1.5 mm recessed seams.</li><li>Confirm faceted component housings and flush ceramic insets, replacing rounded scale-like armour.</li><li>Confirm the metal / ceramic / Carbon balance and the limited Lime slit and joint-ring locations.</li><li>Confirm the drone's machined ducts, the arm's axial covers and the rover's continuous fenders and equipment enclosure.</li><li>Confirm the rover yard's floor modules, ramps, barriers, gates and neutral markers as the environment standard.</li><li>Approve this complete language before a separate rollout to every sim, its scene area and props.</li></ol><p>All three GLBs together: ${kb(all[4].modelAssetBytes)} against the 1,500 kB ceiling. No textures. Procedural first frames and download-failure fallbacks remain functional. Catalogue previews stay procedural.</p><p class="note">Measurements use a local production build, headless Playwright Chromium, native quality, pixel ratio 1. CPU render time measures submission; GPU timing is in the JSON reports. These are local desktop measurements at desktop and phone viewport sizes, not physical-phone performance claims. Camera framing is specific to each revision. The four-unit stress figures include the complete moving scene. Asset bytes are uncompressed file size; JavaScript figures are the sum of requested chunks after gzip.</p></section><footer>Reproduce with <code>node scripts/style-review.mjs original|round1|round2|round3|round4</code>, pointing <code>OBPAL_STYLE_BUILD</code> at the matching production build. All images and clips are from ob.Pal's own sims; no reference files or renders are included.</footer></main>
  <script>document.getElementById('format').addEventListener('change',e=>{for(const panel of document.querySelectorAll('.compare')){const name=panel.dataset.model;for(const [i,phase] of ['original','round1','round2','round3','round4'].entries()){const path=phase+'/'+name+'-'+e.target.value+'.png';const figure=panel.children[i];figure.querySelector('img').src=path;figure.querySelector('a').href=path}}})</script></html>`
  await writeFile(new URL('../artifacts/codex-style/index.html', import.meta.url), html)
  await writeRules()
}



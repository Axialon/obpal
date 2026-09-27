/** Build an offline image viewer and budget table from the wave 4b capture. */
import { readFile, writeFile } from 'node:fs/promises'

const out = 'artifacts/codex-wave4b'
const budgets = JSON.parse(await readFile(`${out}/budgets.json`, 'utf8'))
const shots = JSON.parse(await readFile(`${out}/after-shots.json`, 'utf8'))
const sims = [...new Set(budgets.map(b => b.id))]
const labels = { football: 'Table football', marblerun: 'Marble run', planetary: 'Planetary rover', telescope: 'Telescope mount', pendulum: 'Pendulum lab', trebuchet: 'Trebuchet', slider: 'Camera slider', jib: 'Jib crane' }
const rows = sims.map(id => {
  const all = budgets.filter(b => b.id === id), play = all.filter(b => b.view === 'play')
  return [labels[id], Math.max(...all.map(b => b.triangles)), Math.max(...all.map(b => b.calls)), Math.min(...play.map(b => b.frameHz)), Math.max(...play.map(b => b.renderMsP95))]
})
const ordered = ['1280x800', '390x844', '844x390'].flatMap(size => [`before-catalogue-${size}`, `after-catalogue-${size}`])
ordered.push(...shots.filter(name => !ordered.includes(name)))
const title = name => name.replaceAll('-', ' ')
const figures = ordered.map(name => `<figure data-sim="${name.includes('catalogue') ? 'catalogue' : name.split('-')[0]}"><a href="${name}.png" target="_blank"><img src="${name}.png" alt="${title(name)}" loading="lazy"></a><figcaption>${title(name)}</figcaption></figure>`).join('\n')
const table = `<table><thead><tr><th>Sim</th><th>Triangles</th><th>Draws</th><th>Lowest Hz</th><th>CPU p95 ms</th></tr></thead><tbody>${rows.map(row => `<tr>${row.map((v, n) => `<${n ? 'td' : 'th'}>${v}</${n ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table>`
await writeFile(`${out}/index.html`, `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ob.Pal · Wave 4b review</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101316;color:#eef3ec}body{max-width:1440px;margin:auto;padding:28px}h1{font-size:clamp(26px,4vw,44px);letter-spacing:-.04em;margin:12px 0}p{color:#adb9af;max-width:900px;line-height:1.6}a{color:#c6ff34}small{color:#c6ff34;text-transform:uppercase;letter-spacing:.1em}nav{position:sticky;top:0;z-index:2;background:#101316ef;padding:14px 0;display:flex;align-items:center;gap:12px;border-bottom:1px solid #354139}select{padding:10px 14px;background:#212923;color:#eef3ec;border:1px solid #596b54;border-radius:8px;font:inherit}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:20px;margin-top:24px}figure{margin:0;background:#19211c;border:1px solid #344137;border-radius:12px;overflow:hidden}figure img{width:100%;height:380px;object-fit:contain;background:#090c0a;display:block}figcaption{padding:12px 16px;font-size:13px}figure[hidden]{display:none}table{border-collapse:collapse;font-variant-numeric:tabular-nums;min-width:540px}th,td{padding:9px 16px;text-align:right;border-bottom:1px solid #344137}th:first-child{text-align:left}thead{color:#c6ff34}.table{overflow:auto;margin:20px 0}footer{margin:30px 0;color:#99a69b}@media(max-width:600px){body{padding:16px}figure img{height:340px}}
</style>
<small>ob.Pal · Sims programme</small><h1>Wave 4b review</h1>
<p>The catalogue grows from 33 to 41 playable cards. Compare the original and updated catalogue at desktop, portrait and landscape sizes, then inspect all eight new scenes. Click any image for the full-resolution capture.</p>
<p>Scene screenshots use the normal play camera with the pairing card folded through its button. Every new sim also has an Inspect model close-up and an Overview. The active views are staged through pure device inputs and include ten pieces on each marble board; paired-phone e2e verifies the actual controller paths separately. All models and scenery are procedural; their named parts use the shared kit.</p>
<div class="table">${table}</div>
<p>Budgets are the largest measured scene submission across the three play views and desktop Overview and staged activity views. Limit: 250,000 triangles and 150 draws. Each play view was forced to render for 90 frames, with 10 warmup frames discarded. Hz measures browser animation frames; CPU p95 is renderer submission time. Headless Chromium on this workstation is not a measurement of physical phone GPU performance. <a href="budgets.json">Raw measurements</a> · <a href="verification.md">Checks and decisions</a></p>
<nav><label for="scene">Images</label><select id="scene"><option value="all">All ${ordered.length} images</option><option value="catalogue">Catalogue before / after</option>${sims.map(id => `<option value="${id}">${labels[id]}</option>`).join('')}</select><span id="count">${ordered.length} images</span></nav>
<main class="images">${figures}</main>
<footer>1280 × 800 · 390 × 844 · 844 × 390. Before images show the original catalogue; the eight new sims have no previous implementation.</footer>
<script>document.querySelector('#scene').onchange=e=>{let n=0;for(const f of document.querySelectorAll('figure')){f.hidden=e.target.value!=='all'&&f.dataset.sim!==e.target.value;if(!f.hidden)n++}document.querySelector('#count').textContent=n+' images'}</script></html>\n`)
await writeFile(`${out}/budget-table.md`, '| Sim | Triangles | Draws | Lowest Hz | CPU p95 ms |\n|---|---:|---:|---:|---:|\n' + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n')
console.log(`Wrote an offline viewer for ${ordered.length} images and ${rows.length} budget rows.`)

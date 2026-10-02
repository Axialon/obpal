/** Distilled icon and image comparison sheets. Run after store:art; never writes tracked evidence. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { resolveChromium } from '../../../scripts/lib/browser.mjs'
import { iconPixels, iconDifference } from './icon-compare.mjs'

const root = resolve(import.meta.dirname, '../../..')
const out = join(root, 'artifacts/link-1.8')
const image = async path => `data:image/png;base64,${(await readFile(join(root, path))).toString('base64')}`
const styles = `*{box-sizing:border-box}body{margin:0;padding:28px;background:#0b0b0c;color:#f4f4f5;font:16px/1.5 system-ui}h1{font-size:27px;margin:0 0 8px}p{color:#cbcbcf}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}figure{margin:0}img{max-width:100%}figcaption{margin:8px 0 18px}.bar{display:flex;align-items:center;gap:28px;padding:20px;min-height:90px}.light{background:#f5f5f5;color:#161616}.dark{background:#141415}.bar img{max-width:none}.normal{display:flex;gap:40px;align-items:center}.normal img{width:128px;height:128px;object-fit:contain}.normal .site{width:128px;height:128px;padding:16px}.sheet{max-width:1500px;margin:auto}.panel{border:1px solid #45464a;border-radius:16px;padding:20px;margin:20px 0}.promo img{max-width:100%}.promo{grid-template-columns:1fr 1fr}.enlarge{border:0;background:none;padding:0;color:inherit;cursor:zoom-in}dialog{border:1px solid #555;background:#0b0b0c;color:#fff;max-width:96vw;max-height:96vh}dialog img{display:block;max-width:90vw;max-height:85vh;object-fit:contain}dialog::backdrop{background:#000c}a{color:#c6ff34}@media(max-width:600px){body{padding:18px}.grid{grid-template-columns:1fr}.normal{gap:14px}.bar{gap:20px}}`
const html = (title, content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${styles}</style></head><body><main class="sheet"><h1>${title}</h1>${content}</main><dialog><button id="close">Close</button><img alt="Native-size store image"></dialog><script>const d=document.querySelector('dialog');document.querySelectorAll('.enlarge').forEach(b=>b.onclick=()=>{d.querySelector('img').src=b.querySelector('img').src;d.showModal()});document.querySelector('#close').onclick=()=>d.close();d.onclick=e=>{if(e.target===d)d.close()}</script></body></html>`
await mkdir(join(out, 'icons'), { recursive: true })
await mkdir(join(out, 'images'), { recursive: true })
const brand = await image('public/icon-192.png'), store = await image('extension/store/icon-128.png')
const toolbar = await Promise.all([16, 32, 48].map(async size => `<span><img src="${await image(`extension/dist/icons/icon-${size}.png`)}" width="${size}" height="${size}" alt="${size} px toolbar"><br>${size} px</span>`))
const promo = `<div class="grid promo"><figure><img src="${await image('extension/store/tile-440x280.png')}" alt="Small tile"><figcaption>440 × 280 tile</figcaption></figure><figure><img src="${await image('extension/store/marquee-1400x560.png')}" alt="Marquee"><figcaption>1400 × 560 marquee</figcaption></figure></div>`
await writeFile(join(out, 'icons/index.html'), html('One ob.Pal mark', `<p>Site and store art, with native-size toolbar icons. The store has 16 px transparent padding; only the 16 and 32 px stroke weights are lifted.</p><div class="normal panel"><figure><img class="site" src="${brand}" alt="Site icon"><figcaption>Site · icon-192</figcaption></figure><figure><img src="${store}" alt="Store icon"><figcaption>Store · icon-128</figcaption></figure></div><div class="bar light">${toolbar.join('')}</div><div class="bar dark">${toolbar.join('')}</div>${promo}<p><a href="https://developer.chrome.com/docs/webstore/images">Chrome image guidance</a>: 96 px square art with 16 px transparent padding; readable on light and dark backgrounds.</p>`))
const files = [...[1, 2, 3, 4, 5].map(n => `screenshot-${n}.png`), 'tile-440x280.png', 'marquee-1400x560.png', 'icon-128.png']
const rows = await Promise.all(files.map(async file => {
  const before = execFileSync('git', ['show', `a4f0ff0:extension/store/${file}`], { cwd: root, maxBuffer: 20e6 })
  const round4 = execFileSync('git', ['show', `d48810b:extension/store/${file}`], { cwd: root, maxBuffer: 20e6 })
  const frames = [
    [before, 'Before · live 1.6.2 · a4f0ff0'], [round4, 'Round 4 · d48810b'],
    [await readFile(join(root, 'extension/store', file)), 'Round 5 · current controller range'],
  ]
  return `<div class="panel"><h2>${file}</h2><div class="grid">${frames.map(([png,label]) => `<figure><button class="enlarge" aria-label="View ${file}: ${label}"><img src="data:image/png;base64,${png.toString('base64')}" alt="${label}"></button><figcaption>${label}</figcaption></figure>`).join('')}</div></div>`
}))
await writeFile(join(out, 'images/index.html'), html('Link store images · before → R4 → R5', `<p>Identical store dimensions and equal comparison scaling. Click a frame to inspect the native-size image. Current UI captured at DPR 3, with an emulated phone and staged optional PC state; appearance proof, not physical hardware validation.</p>${rows.join('')}`))
const ref = await sharp(await readFile(join(root, 'public/logo-mark.svg')), { density: 288 }).resize(96, 96).ensureAlpha().raw().toBuffer()
const measurements = []
for (const [file, pad] of [['public/icon-192.png', 4], ['public/icon-512.png', 10], ...[16, 32, 48, 128].map(n => [`extension/dist/icons/icon-${n}.png`, n === 128 ? 16 : 0]), ['extension/store/icon-128.png', 16]]) {
  measurements.push({ file, ...iconDifference(await iconPixels(join(root, file), pad), ref) })
}
await writeFile(join(out, 'icons/metrics.json'), JSON.stringify({ reference: 'public/logo-mark.svg', artSize: 96, backgrounds: [11, 245], measurements }, null, 2))
const browser = await chromium.launch({ executablePath: (await resolveChromium()).path, headless: true })
try {
  for (const folder of ['icons', 'images']) for (const width of [1500, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 })
    await page.goto(pathToFileURL(join(out, folder, 'index.html')).href)
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(i => i.hasAttribute('src')).map(i => i.decode())) })
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${folder} overflows at ${width}`)
    await page.screenshot({ path: join(out, folder, `comparison-${width}.png`), fullPage: true })
    await page.close()
  }
} finally { await browser.close() }
console.log('Comparison sheets: artifacts/link-1.8/icons/ and artifacts/link-1.8/images/')

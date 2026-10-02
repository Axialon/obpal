/** Label the guarded Link loading captures before verified distillation removes the raw TEMP frames. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import sharp from 'sharp'
import { devices } from 'playwright'
import { distill } from './lib/distill.mjs'

const out = process.argv[2], revision = process.argv[3]
const raw = JSON.parse(readFileSync(join(out, 'raw-run.json'), 'utf8')).rawRoot
const files = readdirSync(raw).filter(file => file.startsWith('dot-loaders-') && file.endsWith('.png')).sort()
const cells = []
mkdirSync(join(out, 'cases'), { recursive: true })
for (const file of files) {
  await sharp(join(raw, file)).resize(1280, 900, { fit: 'inside', withoutEnlargement: true }).webp({ lossless: true }).toFile(join(out, 'cases', file.replace('.png', '.webp')))
  const label = `<svg width="320" height="28"><rect width="320" height="28" fill="#101319"/><text x="8" y="19" font-size="11" fill="white">${revision}: ${file.replace('dot-loaders-', '').replace('.png', '')}</text></svg>`
  const shot = await sharp(join(raw, file)).resize(320, 211, { fit: 'contain', background: '#101319' }).toBuffer()
  cells.push(await sharp({ create: { width: 320, height: 239, channels: 4, background: '#101319' } }).composite([{ input: shot, top: 28, left: 0 }, { input: Buffer.from(label), top: 0, left: 0 }]).png().toBuffer())
}
if (!cells.length) throw new Error('Missing Link loading captures')
await sharp({ create: { width: 1280, height: Math.ceil(cells.length / 4) * 239, channels: 4, background: '#101319' } }).composite(cells.map((input, i) => ({ input, left: i % 4 * 320, top: Math.floor(i / 4) * 239 }))).png().toFile(join(out, 'contact-sheet.png'))
writeFileSync(join(out, 'capture-metadata.json'), JSON.stringify({ revision, source: revision === 'before' ? process.env.OBPAL_DOT_BASE_SHA : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dpr: { extension: 2, phone: devices['Pixel 7 landscape'].deviceScaleFactor }, motion: 'no-preference', device: 'Playwright pinned Chromium guarded extension; Pixel 7 landscape emulation resized to the labelled widths', playwright: JSON.parse(readFileSync('node_modules/playwright/package.json', 'utf8')).version, widths: [1280, 390], fixtures: 'reported startup, real PC approval flow, and held tab/answer acknowledgements with an inert native stub', frames: files }, null, 2))
await distill(out)

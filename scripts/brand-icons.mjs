/**
 * ob.Pal's static brand icons, from public/logo-mark.svg: the Blackboxes family cube lit in ob.Pal's lime
 * (lower faces and front edges catch the light), wrapped in ob.Pal's orbit and satellite. It matches the family
 * `mark('obpal')` in src/family/family.js; site and Link identity use the same vector asset.
 *
 *   public/favicon.svg             tab icon: bolder strokes so it reads at 16 px (small-size site variant)
 *   public/logo-mark.svg           the canonical input at normal weight
 *   public/apple-touch-icon.png    180 px on the Carbon page colour (iOS home screen; iOS rounds the corners)
 *   public/icon-192.png, -512.png  transparent, for the web app manifest
 *   public/icon-maskable-512.png   full-bleed Carbon, mark inside the maskable safe zone
 *
 * Usage: node scripts/brand-icons.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const pub = (f) => fileURLToPath(new URL(`../public/${f}`, import.meta.url))
const CARBON = { r: 11, g: 11, b: 12, alpha: 1 } // --bb page colour on the default Carbon surface

/** Small-size stroke and satellite weights; cube proportions and colours stay in the canonical source. */
const normal = await readFile(pub('logo-mark.svg'), 'utf8')
const bold = normal
  .replaceAll('stroke-width="1.3"', 'stroke-width="2.2"')
  .replaceAll('stroke-width="2.4"', 'stroke-width="3.6"')
  .replaceAll('stroke-width="3"', 'stroke-width="5"')
  .replaceAll('stroke-width="3.8"', 'stroke-width="6.5"')
  .replace('r="4.8"', 'r="7.5"')
  .replace('r="1.8"', 'r="2.8"')

/** The mark as a PNG: `size` px canvas, the mark `inner` px wide, on `background` (transparent by default). */
async function png(svg, size, inner, background = { r: 0, g: 0, b: 0, alpha: 0 }) {
  const mark = await sharp(Buffer.from(svg), { density: 72 * (inner / 100) * 4 }).resize(inner, inner).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: mark, left: Math.round((size - inner) / 2), top: Math.round((size - inner) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

await writeFile(pub('favicon.svg'), bold)
await writeFile(pub('apple-touch-icon.png'), await png(normal, 180, 150, CARBON))
await writeFile(pub('icon-192.png'), await png(normal, 192, 184))
await writeFile(pub('icon-512.png'), await png(normal, 512, 492))
// Maskable: launchers crop to a circle or squircle, keeping the central 80%.
await writeFile(pub('icon-maskable-512.png'), await png(normal, 512, 380, CARBON))
console.log('ob.Pal brand icons -> public/ (favicon.svg, apple-touch-icon.png, icon-192/512.png, icon-maskable-512.png)')

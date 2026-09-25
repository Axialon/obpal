/**
 * ob.Pal's static brand icons, from one definition of the mark: the Blackboxes family cube lit in ob.Pal's lime
 * (lower faces and front edges catch the light), wrapped in ob.Pal's orbit and satellite. It matches the family
 * `mark('obpal')` in src/family/family.js and the animated logoMark() in src/ui/icons.ts.
 *
 *   public/favicon.svg             tab icon: bolder strokes so it reads at 16 px (also the extension's icon source)
 *   public/logo-mark.svg           the mark at normal weight (landing header)
 *   public/apple-touch-icon.png    180 px on the Carbon page colour (iOS home screen; iOS rounds the corners)
 *   public/icon-192.png, -512.png  transparent, for the web app manifest
 *   public/icon-maskable-512.png   full-bleed Carbon, mark inside the maskable safe zone
 *
 * Usage: node scripts/brand-icons.mjs
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const pub = (f) => fileURLToPath(new URL(`../public/${f}`, import.meta.url))
const LIME = '#C6FF34'
const CARBON = { r: 11, g: 11, b: 12, alpha: 1 } // --bb page colour on the default Carbon surface

/** Stroke weights in a 100-unit box: `bold` for favicon sizes (16–32 px), `normal` for anything bigger. */
const WEIGHTS = {
  normal: { outline: 1.3, seam: 1.3, edge: 2.4, top: 1.3, ring: 3, arc: 3.8, sat: 4.8, core: 1.8 },
  bold: { outline: 2.2, seam: 2.2, edge: 3.6, top: 2.2, ring: 5, arc: 6.5, sat: 7.5, core: 2.8 },
}

export function obpalMark(weight = 'normal', A = LIME) {
  const w = WEIGHTS[weight]
  const cube = 'points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4"'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" shape-rendering="geometricPrecision">
  <defs>
    <linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#565656"/><stop offset=".35" stop-color="#2a2a2a"/><stop offset=".75" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient>
    <linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1d1d"/><stop offset=".45" stop-color="#0a0a0a"/><stop offset="1" stop-color="#000"/></linearGradient>
    <linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#313131"/><stop offset=".5" stop-color="#141414"/><stop offset="1" stop-color="#050505"/></linearGradient>
    <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset=".42" stop-color="${A}" stop-opacity="0"/><stop offset="1" stop-color="${A}" stop-opacity=".5"/></linearGradient>
  </defs>
  <ellipse cx="50" cy="57" rx="47" ry="15" transform="rotate(-14 50 57)" fill="none" stroke="${A}" stroke-width="${w.ring}" opacity=".32"/>
  <polygon ${cube} fill="#000"/>
  <polygon points="50,19 78,34.4 50,49.8 22,34.4" fill="url(#t)"/>
  <polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#l)"/>
  <polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#r)"/>
  <polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#s)" opacity=".7"/>
  <polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#s)"/>
  <polygon ${cube} fill="none" stroke="rgba(255,255,255,.4)" stroke-width="${w.outline}" stroke-linejoin="round"/>
  <path d="M50,49.8 L50,80.6" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="${w.seam}"/>
  <path d="M22,34.4 L50,49.8 L78,34.4" fill="none" stroke="${A}" stroke-width="${w.edge}" stroke-linejoin="round"/>
  <line x1="50" y1="19" x2="78" y2="34.4" stroke="rgba(255,255,255,.72)" stroke-width="${w.top}"/>
  <line x1="50" y1="19" x2="78" y2="34.4" stroke="${A}" stroke-width="${w.top}" opacity=".55"/>
  <path d="M95.6 45.63 A47 15 -14 0 1 4.4 68.37" fill="none" stroke="${A}" stroke-width="${w.arc}" stroke-linecap="round"/>
  <circle cx="82.1" cy="60.8" r="${w.sat}" fill="${A}"/>
  <circle cx="82.1" cy="60.8" r="${w.core}" fill="#fff"/>
</svg>
`
}

/** The mark as a PNG: `size` px canvas, the mark `inner` px wide, on `background` (transparent by default). */
async function png(svg, size, inner, background = { r: 0, g: 0, b: 0, alpha: 0 }) {
  const mark = await sharp(Buffer.from(svg), { density: 72 * (inner / 100) * 4 }).resize(inner, inner).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: mark, left: Math.round((size - inner) / 2), top: Math.round((size - inner) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

const bold = obpalMark('bold')
const normal = obpalMark('normal')
await writeFile(pub('favicon.svg'), bold)
await writeFile(pub('logo-mark.svg'), normal)
await writeFile(pub('apple-touch-icon.png'), await png(normal, 180, 150, CARBON))
await writeFile(pub('icon-192.png'), await png(normal, 192, 184))
await writeFile(pub('icon-512.png'), await png(normal, 512, 492))
// Maskable: launchers crop to a circle or squircle, keeping the central 80%.
await writeFile(pub('icon-maskable-512.png'), await png(normal, 512, 380, CARBON))
console.log('ob.Pal brand icons -> public/ (favicon.svg, logo-mark.svg, apple-touch-icon.png, icon-192/512.png, icon-maskable-512.png)')

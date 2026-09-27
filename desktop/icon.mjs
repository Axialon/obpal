/**
 * ob.Pal Desktop's icon: desktop/obpal-desktop.ico, the ob.Pal mark at the sizes Windows asks of a program (16 to
 * 256 px), from the site's own art, as the extension's icons are (extension/scripts/icons.mjs): public/favicon.svg
 * below 48 px, where its bold strokes still read, and the full mark, public/logo-mark.svg, from 48 px up. build.rs
 * embeds the icon in obpal-desktop.exe.
 *
 * Each size is drawn in Chromium at 4x and averaged down, then stored as a 32-bit bitmap with alpha, and the 256 px
 * one as PNG (what Windows reads there since Vista).
 *
 * Usage: node desktop/icon.mjs (Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
/** Entries this big are stored as PNG. */
const PNG_FROM = 256
const small = await readFile(here('../public/favicon.svg'), 'utf8')
const large = await readFile(here('../public/logo-mark.svg'), 'utf8')

/** In the page: the SVG drawn at 4x `size`, then each 4x4 block averaged (weighted by alpha), as RGBA bytes. */
async function render({ svg, size }) {
  const n = size * 4
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/<svg\b/, `<svg width="${n}" height="${n}"`))}`
  await img.decode()
  const ctx = new OffscreenCanvas(n, n).getContext('2d')
  ctx.drawImage(img, 0, 0, n, n)
  const src = ctx.getImageData(0, 0, n, n).data
  const out = new Array(size * size * 4).fill(0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0]
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const k = ((y * 4 + j) * n + x * 4 + i) * 4
          const w = src[k + 3]
          r += src[k] * w
          g += src[k + 1] * w
          b += src[k + 2] * w
          a += w
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) [out[o], out[o + 1], out[o + 2]] = [Math.round(r / a), Math.round(g / a), Math.round(b / a)]
      out[o + 3] = Math.round(a / 16)
    }
  }
  return out
}

/** An icon bitmap: BITMAPINFOHEADER (the height counts the mask too), BGRA rows bottom-up, then the 1-bit AND mask, set where fully transparent. */
function bitmap(size, rgba) {
  const pixels = size * size * 4
  const maskRow = Math.ceil(size / 32) * 4
  const b = Buffer.alloc(40 + pixels + maskRow * size)
  b.writeUInt32LE(40, 0)
  b.writeInt32LE(size, 4)
  b.writeInt32LE(size * 2, 8)
  b.writeUInt16LE(1, 12) // planes
  b.writeUInt16LE(32, 14) // bits per pixel
  b.writeUInt32LE(pixels + maskRow * size, 20) // image size (compression stays 0, BI_RGB)
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      if (rgba[s + 3] > 0) b.set([rgba[s + 2], rgba[s + 1], rgba[s], rgba[s + 3]], 40 + (row * size + x) * 4)
      else b[40 + pixels + row * maskRow + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return b
}

/** A PNG: 8-bit RGBA, no filtering, deflated. */
function png(size, rgba) {
  const chunk = (type, data) => {
    const c = Buffer.alloc(12 + data.length)
    c.writeUInt32BE(data.length, 0)
    c.write(type, 4, 'ascii')
    data.copy(c, 8)
    c.writeUInt32BE(crc32(c.subarray(4, 8 + data.length)), 8 + data.length)
    return c
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6], 8) // 8 bits, RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** The .ico file: ICONDIR, one ICONDIRENTRY per image (256 is written as 0), then the images. */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    head.set([size & 0xff, size & 0xff], e)
    head.writeUInt16LE(1, e + 4) // planes
    head.writeUInt16LE(32, e + 6) // bits per pixel
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map((i) => i.data)])
}

const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined })
try {
  const page = await browser.newPage()
  const images = []
  for (const size of SIZES) {
    const rgba = Buffer.from(await page.evaluate(render, { svg: size < 48 ? small : large, size }))
    images.push({ size, data: size >= PNG_FROM ? png(size, rgba) : bitmap(size, rgba) })
  }
  const bytes = ico(images)
  await writeFile(here('obpal-desktop.ico'), bytes)
  console.log(`ob.Pal Desktop icon (${SIZES.join(', ')} px): desktop/obpal-desktop.ico (${(bytes.length / 1024).toFixed(1)} KB)`)
} finally {
  await browser.close()
}

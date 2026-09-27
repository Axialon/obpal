// Render the ob.Pal mark (public/favicon.svg) to the PNG action icons Chrome needs.
// Used by the Vite build (extension/vite.config.ts), or on its own: node extension/scripts/icons.mjs [outDir]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { downsample } from './downsample.mjs'
import { markSVG } from './mark.mjs'

export const ICON_SIZES = [16, 32, 48, 128]
/** 16 and 32 px use the favicon's bolder mark; 48 px and up the bold mark fitted to their pixels (./mark.mjs). */
export const MARK_SVG = fileURLToPath(new URL('../../public/favicon.svg', import.meta.url))

/**
 * Draw the art at 8x and average it down as light (./downsample.mjs), which keeps the mark's lines crisp and at their
 * weight: the owner picked it over 1x and 2x (2026-09-27). (No sharpening: on the clear background it rings into a
 * pale fringe that shows on dark pages.)
 * @param {string} [svgPath] the small sizes' mark
 * @param {number[]} [sizes]
 * @returns {Promise<{ size: number, png: Buffer }[]>}
 */
export async function renderIcons(svgPath = MARK_SVG, sizes = ICON_SIZES) {
  const small = await readFile(svgPath, 'utf8')
  return Promise.all(
    sizes.map(async (size) => {
      // The 128 px icon is the store and extensions-page icon: 96 px of art inside 16 px of clear padding (Chrome
      // Web Store guideline). The small toolbar sizes use the full square.
      const pad = size >= 128 ? size / 8 : 0
      const art = size - pad * 2
      const clear = { r: 0, g: 0, b: 0, alpha: 0 }
      const sized = size >= 48 ? markSVG(art, { width: art * 8, bold: true }) : small.replace(/<svg\b/, `<svg width="${art * 8}" height="${art * 8}"`)
      const png = await (await downsample(await sharp(Buffer.from(sized)).png().toBuffer(), 8))
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: clear })
        .png({ compressionLevel: 9 })
        .toBuffer()
      return { size, png }
    }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/icons', import.meta.url)))
  await mkdir(out, { recursive: true })
  for (const { size, png } of await renderIcons()) await writeFile(resolve(out, `icon-${size}.png`), png)
  console.log(`ob.Pal Link icons (${ICON_SIZES.join(', ')} px) -> ${out}`)
}

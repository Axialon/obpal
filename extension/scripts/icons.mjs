// Render the shared ob.Pal brand mark to the PNG action icons Chrome needs.
// Used by the Vite build (extension/vite.config.ts), or on its own: node extension/scripts/icons.mjs [outDir]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { downsample } from './downsample.mjs'

export const ICON_SIZES = [16, 32, 48, 128]
/** One source for geometry, gradients and colours at every size. */
export const MARK_SVG = fileURLToPath(new URL('../../public/logo-mark.svg', import.meta.url))

/** Only stroke weights change below 48 px; no new rim, tile, geometry or colours. */
export function toolbarMark(svg, size) {
  const weights = size === 16 ? { '1.3': 2.2, '2.4': 3.6, '3': 4, '3.8': 5 } : size === 32 ? { '1.3': 1.8, '2.4': 3, '3': 3.5, '3.8': 4.4 } : {}
  return svg.replace(/stroke-width="([\d.]+)"/g, (match, width) => weights[width] ? `stroke-width="${weights[width]}"` : match)
}

/**
 * Draw the art at 8x and average it down as light (./downsample.mjs), which keeps the mark's lines crisp and at their
 * weight: the owner picked it over 1x and 2x (2026-09-27). (No sharpening: on the clear background it rings into a
 * pale fringe that shows on dark pages.)
 * @param {string} [svgPath] the brand mark
 * @param {number[]} [sizes]
 * @returns {Promise<{ size: number, png: Buffer }[]>}
 */
export async function renderIcons(svgPath = MARK_SVG, sizes = ICON_SIZES) {
  const brand = await readFile(svgPath, 'utf8')
  return Promise.all(
    sizes.map(async (size) => {
      // The 128 px icon is the store and extensions-page icon: 96 px of art inside 16 px of clear padding (Chrome
      // Web Store guideline). The small toolbar sizes use the full square.
      const pad = size >= 128 ? size / 8 : 0
      const art = size - pad * 2
      const clear = { r: 0, g: 0, b: 0, alpha: 0 }
      const sized = toolbarMark(brand, size).replace(/<svg\b/, `<svg width="${art * 8}" height="${art * 8}"`)
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

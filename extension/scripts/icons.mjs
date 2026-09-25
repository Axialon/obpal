// Render the ob.Pal mark (public/favicon.svg) to the PNG action icons Chrome needs.
// Used by the Vite build (extension/vite.config.ts), or on its own: node extension/scripts/icons.mjs [outDir]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

export const ICON_SIZES = [16, 32, 48, 128]
export const MARK_SVG = fileURLToPath(new URL('../../public/favicon.svg', import.meta.url))
/** 48 px and up use the mark at normal weight; the favicon's bolder strokes are for 16 and 32 px. */
export const MARK_SVG_LARGE = fileURLToPath(new URL('../../public/logo-mark.svg', import.meta.url))

/**
 * Rasterise at 4x the target size and downsample, which keeps the thin seams of the mark crisp at 16 px.
 * @param {string} [svgPath]
 * @param {number[]} [sizes]
 * @returns {Promise<{ size: number, png: Buffer }[]>}
 */
export async function renderIcons(svgPath = MARK_SVG, sizes = ICON_SIZES) {
  const small = await readFile(svgPath, 'utf8')
  const large = svgPath === MARK_SVG ? await readFile(MARK_SVG_LARGE, 'utf8') : small
  return Promise.all(
    sizes.map(async (size) => {
      const svg = size >= 48 ? large : small
      const big = size * 4
      // The 128 px icon is the store and extensions-page icon: 96 px of art inside 16 px of clear padding (Chrome
      // Web Store guideline). The small toolbar sizes use the full square.
      const pad = size >= 128 ? size / 8 : 0
      const clear = { r: 0, g: 0, b: 0, alpha: 0 }
      const sized = svg.replace(/<svg\b/, `<svg width="${big}" height="${big}"`)
      const png = await sharp(Buffer.from(sized))
        .resize(size - pad * 2, size - pad * 2, { fit: 'contain', background: clear })
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

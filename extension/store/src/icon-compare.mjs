/** Compare rasterised brand silhouettes and composited sRGB colours at one common art size. */
import sharp from 'sharp'

export async function iconPixels(input, padding = 0) {
  const m = await sharp(input).metadata()
  return sharp(input).extract({ left: padding, top: padding, width: m.width - 2 * padding, height: m.height - 2 * padding })
    .resize(96, 96).ensureAlpha().raw().toBuffer()
}

export function iconDifference(a, b) {
  let intersection = 0, union = 0, colour = 0
  for (let p = 0; p < a.length; p += 4) {
    const aa = a[p + 3] / 255, ba = b[p + 3] / 255
    if (aa > 0.2 && ba > 0.2) intersection++
    if (aa > 0.2 || ba > 0.2) union++
    for (const bg of [11, 245]) for (let c = 0; c < 3; c++) colour += Math.abs(a[p + c] * aa + bg * (1 - aa) - b[p + c] * ba - bg * (1 - ba))
  }
  return { silhouette: intersection / union, colourMean: colour / (96 * 96 * 6) }
}

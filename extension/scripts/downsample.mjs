// Downsampling for the icons and the store art: exact coverage antialiasing, averaged as light.
import sharp from 'sharp'

/** sRGB byte → linear light. */
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
/** Linear light → sRGB byte. */
const encode = (v) => Math.round(Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)) * 255)

/**
 * Shrink an image drawn at `factor` times its size: each pixel becomes the mean of its factor × factor block, with the
 * colour averaged as light (sRGB decoded, weighted by alpha) in full precision. That's how a line's coverage should
 * turn into its edge pixels: a bright line on a dark ground keeps its weight and its steps don't show, where averaging
 * the sRGB bytes darkens the edges and leaves the stair-steps visible. No ringing or sharpening halos, and no banding
 * in dark gradients.
 * @param {Buffer | string} input any image sharp reads, its width and height multiples of `factor`
 * @param {number} factor
 * @returns {Promise<import('sharp').Sharp>} the shrunk image, RGBA
 */
export async function downsample(input, factor) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width, w = W / factor, h = info.height / factor
  if (!Number.isInteger(w) || !Number.isInteger(h)) throw new Error(`downsample: ${W}x${info.height} is not a multiple of ${factor}`)
  const out = Buffer.alloc(w * h * 4)
  const n = factor * factor
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < factor; dy++) {
        let p = ((y * factor + dy) * W + x * factor) * 4
        for (let dx = 0; dx < factor; dx++, p += 4) {
          const al = data[p + 3] / 255
          r += LINEAR[data[p]] * al; g += LINEAR[data[p + 1]] * al; b += LINEAR[data[p + 2]] * al; a += al
        }
      }
      const o = (y * w + x) * 4
      if (a > 0) { out[o] = encode(r / a); out[o + 1] = encode(g / a); out[o + 2] = encode(b / a) }
      out[o + 3] = Math.round((a / n) * 255)
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } })
}

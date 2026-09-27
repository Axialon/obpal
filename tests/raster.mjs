/**
 * Test helper: an SVG drawn to pixels with a real SVG renderer (librsvg, through sharp), optionally inset on a
 * page background, the way a camera would see it on a screen. Plain JS, so the tests stay free of Node's types.
 */
import sharp from 'sharp'

export async function rasterize(svg, size, { background = '#ffffff', pad = 0, blur = 0 } = {}) {
  let img = sharp(Buffer.from(svg), { density: 72 * 8 }).resize(size, size)
  if (pad) img = sharp(await img.png().toBuffer()).extend({ top: pad, bottom: pad, left: pad, right: pad, background })
  img = sharp(await img.png().toBuffer()).flatten({ background })
  if (blur) img = img.blur(blur)
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height }
}

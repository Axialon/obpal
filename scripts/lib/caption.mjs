/** Draw evidence captions with the repository's credited font outlines, without a platform font renderer. */
import { readFile } from 'node:fs/promises'
import { FontLoader } from 'three/addons/loaders/FontLoader.js'

const data = JSON.parse(await readFile(new URL('../../src/landing/glyphs.json', import.meta.url), 'utf8'))
const font = new FontLoader().parse(data)

export function captionSvg(text) {
  const caption = [...text].map(c => data.glyphs[c] ? c : ' ').join('')
  const outline = font.generateShapes(caption, 12).flatMap(shape => [shape, ...shape.holes]).map(shape =>
    shape.getPoints(6).map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + 'Z').join(' ')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="450" height="36"><rect width="450" height="36" fill="#11151b"/><path transform="translate(10 24) scale(1 -1)" fill="#eef2ed" fill-rule="evenodd" d="${outline}"/></svg>`)
}

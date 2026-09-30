/** The trust page's dots are illustrations, never a seal derived from a live connection. */
import '../landing/site'
import '../styles/trust.css'
import { glyphDots } from '@obpal/core'
import { DotField } from '../ui/kit/dot-field'

const fields: DotField[] = []
const canvas = document.querySelector<HTMLCanvasElement>('#trust-field')
if (canvas) {
  const points = [0, 1, 2].flatMap((index) => glyphDots(index).map((p) => ({ x: (index * 13 + p.x * 11) / 37, y: p.y })))
  const field = new DotField(canvas, { points, maxDots: 300 })
  fields.push(field)
  field.effect('assemble')
  canvas.addEventListener('pointerenter', () => field.effect('shimmer'))
  const point = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect()
    field.pointer(event.clientX - bounds.left, event.clientY - bounds.top)
  }
  canvas.addEventListener('pointermove', point, { passive: true })
  canvas.addEventListener('pointerdown', point, { passive: true })
  for (const event of ['pointerleave', 'pointerup', 'pointercancel']) canvas.addEventListener(event, () => field.pointer(null), { passive: true })
}
for (const example of document.querySelectorAll<HTMLCanvasElement>('[data-example-glyph]')) {
  fields.push(new DotField(example, { points: glyphDots(Number(example.dataset.exampleGlyph)), maxDots: 80 }))
}
const refresh = () => fields.forEach((field) => field.refresh())
window.addEventListener('bb-theme', refresh)
window.addEventListener('pagehide', () => {
  window.removeEventListener('bb-theme', refresh)
  fields.forEach((field) => field.destroy())
}, { once: true })

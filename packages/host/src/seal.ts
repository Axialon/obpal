import { glyphDots, SEAL_GLYPHS, sealNames, type ConnectionSeal } from '@obpal/core'
import { encode } from 'uqr'
import { DotField, type DotPoint } from './dot-field'

const fields = new WeakMap<HTMLElement, DotField>()

/** Three fixed-grid silhouettes, with one grid column between them. */
export function sealPoints(seal: ConnectionSeal): DotPoint[] {
  return seal.flatMap((index, slot) => glyphDots(index).map(p => ({ x: (slot * 12 + p.x * 11) / 35, y: p.y })))
}

/** DOM-only, accessible rendering works under Trusted Types and the embed's strict CSP. */
export function sealElement(seal: ConnectionSeal): HTMLElement {
  const row = document.createElement('div')
  row.className = 'connection-seal'
  row.setAttribute('role', 'img')
  row.setAttribute('aria-label', `Connection seal: ${sealNames(seal)}`)
  row.dataset.seal = seal.join('-')
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  const labels = document.createElement('div')
  labels.className = 'seal-names'
  for (const i of seal) {
    const label = document.createElement('small')
    label.textContent = SEAL_GLYPHS[i].name
    labels.append(label)
  }
  row.append(canvas, labels)
  const field = new DotField(canvas, { points: sealPoints(seal), surface: 'transparent' })
  fields.set(row, field)
  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    field.pointer(event.clientX - rect.left, event.clientY - rect.top)
  }
  canvas.addEventListener('pointermove', point, { passive: true })
  canvas.addEventListener('pointerdown', point, { passive: true })
  for (const event of ['pointerleave', 'pointerup', 'pointercancel']) canvas.addEventListener(event, () => field.pointer(null), { passive: true })
  return row
}

/** Release a seal before its owning sheet or card removes it. */
export function destroySeal(row: HTMLElement) { fields.get(row)?.destroy(); fields.delete(row) }
/** Only callers with an already permitted motion sample can move the light. */
export function tiltSeal(row: HTMLElement, x: number, y: number) { fields.get(row)?.tilt(x, y) }
export function refreshSeal(row: HTMLElement) { fields.get(row)?.refresh() }

export const SEAL_STYLE = `
.connection-seal{display:grid;justify-items:center;color:var(--a,var(--accent,currentColor));padding:10px 0;gap:6px}
.connection-seal canvas{display:block;width:224px;max-width:100%;height:70px;touch-action:pan-y}
.seal-names{display:grid;grid-template-columns:repeat(3,1fr);width:224px;max-width:100%;text-align:center;gap:8px}
.seal-names small{font:600 11px/1.3 var(--font,system-ui);color:var(--ink,inherit)}
.seal-moment{position:fixed;bottom:max(24px,env(safe-area-inset-bottom));right:24px;width:288px;box-sizing:border-box;padding:18px;color:var(--ink);background:var(--s,var(--sheet));border:1px solid var(--line,var(--edge,#8885));border-radius:24px;box-shadow:0 16px 48px #0006;backdrop-filter:blur(28px) saturate(150%);z-index:50;pointer-events:none;font:600 13px/1.4 var(--font,system-ui);text-align:center}
.seal-moment p{margin:4px 0}.seal-moment canvas{display:block;width:250px;max-width:100%;height:80px;margin:12px auto 0}
.seal-first{font-size:11px;font-weight:500}.seal-first>span{display:block}.seal-first .trust-domain{display:flex;justify-content:center;margin-bottom:4px}
.seal-moment .seal-names{margin:6px auto 0;width:250px;opacity:0}.seal-moment[data-settled] .seal-names{opacity:1}
@media(max-width:520px){.seal-moment{right:12px;left:12px;width:auto;bottom:auto;top:calc(72px + env(safe-area-inset-top))}}
`

/** One 1.2-second sequence. The authenticated peers schedule it; it never takes focus or catches input. */
export function sealMoment(parent: HTMLElement | ShadowRoot, seal: ConnectionSeal, delayMs: number, url?: string, notice?: HTMLElement): () => void {
  const box = document.createElement('div')
  box.className = 'seal-moment'
  box.setAttribute('aria-hidden', 'true')
  const title = document.createElement('p')
  title.textContent = 'Connection seal'
  const canvas = document.createElement('canvas')
  const labels = document.createElement('div')
  labels.className = 'seal-names'
  for (const index of seal) {
    const label = document.createElement('small')
    label.textContent = SEAL_GLYPHS[index].name
    labels.append(label)
  }
  box.append(title, canvas, labels)
  if (notice) box.prepend(notice)
  parent.append(box)
  if (parent instanceof ShadowRoot) {
    const style = getComputedStyle(parent.querySelector('.wrap') ?? parent.host)
    for (const token of ['--a', '--ink', '--line', '--edge']) box.style.setProperty(token, style.getPropertyValue(token))
    box.style.setProperty('--s', style.getPropertyValue('--glass'))
  }
  const field = new DotField(canvas, { points: sealPoints(seal), surface: 'transparent', idle: false })
  if (url) {
    const qr = encode(url, { ecc: 'Q', border: 0 })
    const points: DotPoint[] = []
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.data[y][x]) points.push({ x: 0.36 + (x + 0.5) / qr.size * 0.28, y: 0.08 + (y + 0.5) / qr.size * 0.84 })
    field.setSource(points)
  }
  field.handshake(0)
  let raf = 0
  let dead = false
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  if (reduced.matches) box.style.opacity = '0'
  let fade: Animation | undefined
  const start = setTimeout(() => {
    const started = performance.now()
    box.style.removeProperty('opacity')
    box.dataset.started = String(started)
    if (reduced.matches) {
      field.handshake(1)
      box.dataset.settled = ''
      fade = box.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180 })
      return
    }
    const frame = (now: number) => {
      if (dead) return
      if (reduced.matches) { field.handshake(1); box.dataset.settled = ''; return }
      const progress = Math.min(1, (now - started) / 1200)
      field.handshake(progress)
      box.dataset.progress = progress.toFixed(3)
      if (progress >= 0.72) box.dataset.settled = ''
      if (progress < 1) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
  }, Math.max(0, delayMs))
  const cleanup = () => { dead = true; clearTimeout(start); clearTimeout(end); cancelAnimationFrame(raf); fade?.cancel(); field.destroy(); box.remove() }
  const end = setTimeout(cleanup, Math.max(0, delayMs) + 3000)
  return cleanup
}

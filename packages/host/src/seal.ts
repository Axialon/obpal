import { glyphDots, SEAL_GLYPHS, sealNames, type ConnectionSeal } from '@obpal/core'
import { dotTimeline } from './dot-tokens'
import { encode } from 'uqr'
import { DotField, dotClock, type DotPoint } from './dot-field'

const fields = new WeakMap<HTMLElement, DotField>()

/** Three fixed-grid silhouettes, with one grid column between them. */
export function sealPoints(seal: ConnectionSeal): DotPoint[] {
  return seal.flatMap((index, slot) => glyphDots(index).map(p => ({ x: (slot * 12 + p.x * 11) / 35, y: p.y })))
}

/** DOM-only, accessible rendering works under Trusted Types and the embed's strict CSP. */
export function sealElement(seal: ConnectionSeal, compact = false): HTMLElement {
  const row = document.createElement('div')
  row.className = `connection-seal${compact ? ' seal-compact' : ''}`
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
  const field = new DotField(canvas, { points: sealPoints(seal), surface: 'transparent', scale: 'seal', preservePoints: true, pixelAligned: true })
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
export function tiltSeal(row: HTMLElement, x: number, y: number) {
  fields.get(row)?.tilt(x, y)
  if (!row.classList.contains('seal-compact') || !Number.isFinite(x) || !Number.isFinite(y)) return
  // The small status seal moves as one plane; every cell keeps its place relative to the others.
  const canvas = row.querySelector('canvas')
  if (canvas) canvas.style.transform = `translate3d(${Math.max(-1, Math.min(1, x)) * 2}px,${Math.max(-1, Math.min(1, y))}px,0)`
}
export function refreshSeal(row: HTMLElement) { fields.get(row)?.refresh() }

/** A scheduled handshake lands on the existing status seal; its canvas is never removed at the end. */
export function landSeal(row: HTMLElement, delayMs: number, url?: string): () => void {
  const field = fields.get(row)
  if (!field) return () => {}
  const started = performance.now() + delayMs
  row.dataset.started = String(started)
  row.dataset.timeline = JSON.stringify(dotTimeline(Date.now() + delayMs))
  if (url) {
    const qr = encode(url, { ecc: 'Q', border: 0 })
    const points: DotPoint[] = []
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.data[y][x]) points.push({ x: 0.36 + (x + 0.5) / qr.size * 0.28, y: 0.08 + (y + 0.5) / qr.size * 0.84 })
    field.setSource(points)
  }
  field.handshake(0)
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { field.handshake(1); row.dataset.settled = ''; return () => {} }
  return dotClock(now => {
    const progress = Math.max(0, Math.min(1, (now - started) / 1200))
    field.handshake(progress)
    row.dataset.progress = progress.toFixed(3)
    if (progress === 1) row.dataset.settled = ''
    return progress < 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches
  })
}

export const SEAL_STYLE = `
.connection-seal,.seal-moment,.seal-stage{--ob-dot-active:var(--seal-ink,var(--bb-ink,var(--ink,currentColor)))}
.connection-seal{display:grid;justify-items:center;color:var(--ob-dot-active);padding:10px 0;gap:6px;background:var(--seal-plate,var(--bb-sheet,var(--sheet,#141415)));border-radius:12px}
.connection-seal canvas{display:block;width:224px;max-width:100%;height:70px;touch-action:pan-y}
.connection-seal.seal-compact{display:inline-grid;flex:none;padding:0;gap:0}
.seal-compact canvas{width:110px;height:34.6px;transition:transform 120ms var(--bb-ease,var(--ease,ease-out))}
@media(prefers-reduced-motion:reduce){.seal-compact canvas{transform:none!important;transition:none}}
.seal-compact .seal-names{display:none}
.seal-names{display:grid;grid-template-columns:repeat(3,1fr);width:224px;max-width:100%;text-align:center;gap:8px}
.seal-names small{font:600 11px/1.3 var(--font,system-ui);color:var(--ink,inherit)}
.seal-moment{position:fixed;bottom:max(88px,env(safe-area-inset-bottom));right:24px;width:288px;box-sizing:border-box;padding:18px;color:var(--ink);background:var(--s,var(--sheet));border:1px solid var(--line,var(--edge,#8885));border-radius:24px;box-shadow:var(--bb-frost-shadow,0 16px 48px #0006);backdrop-filter:var(--bb-frost-blur,blur(28px) saturate(150%));z-index:50;pointer-events:none;font:600 13px/1.4 var(--font,system-ui);text-align:center}
.seal-moment p{margin:4px 0}.seal-moment canvas{display:block;width:250px;max-width:100%;height:80px;margin:12px auto 0}
.seal-first{font-size:11px;font-weight:500}.seal-first>span{display:block}.seal-first .trust-domain{display:flex;justify-content:center;margin-bottom:4px}
.seal-moment .seal-names{margin:6px auto 0;width:250px;opacity:0}.seal-moment[data-settled] .seal-names{opacity:1}
@media(max-width:520px){.seal-moment{right:12px;left:12px;width:auto;bottom:auto;top:calc(72px + env(safe-area-inset-top))}}
`

/** One 1.2-second sequence. The authenticated peers schedule it; it never takes focus or catches input. */
export function sealMoment(parent: HTMLElement | ShadowRoot, seal: ConnectionSeal, delayMs: number, url?: string, notice?: HTMLElement): () => void {
  // Rendering or a busy event loop can delay the callback; both peers retain the caller's scheduled phase.
  const started = performance.now() + delayMs
  const timeline = dotTimeline(Date.now() + delayMs)
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
  // Stay in the chip's token scope, including later theme changes.
  const scope = parent instanceof ShadowRoot ? parent.querySelector<HTMLElement>('.wrap') ?? parent : parent
  scope.append(box)
  if (parent instanceof ShadowRoot) box.style.setProperty('--s', 'var(--glass)')
  const field = new DotField(canvas, { points: sealPoints(seal), surface: 'transparent', scale: 'seal', preservePoints: true, idle: false })
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
  box.style.visibility = 'hidden'
  const start = setTimeout(() => {
    box.dataset.timeline = JSON.stringify(timeline)
    box.style.removeProperty('visibility')
    box.dataset.started = String(started)
    if (reduced.matches || performance.now() - started >= 1200) {
      field.handshake(1)
      box.dataset.settled = ''
      if (!reduced.matches) box.dataset.progress = '1.000'
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
  }, Math.max(0, started - performance.now()))
  const cleanup = () => { dead = true; clearTimeout(start); clearTimeout(end); cancelAnimationFrame(raf); field.destroy(); box.remove() }
  const end = setTimeout(cleanup, Math.max(0, delayMs) + 3000)
  return cleanup
}

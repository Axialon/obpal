import { DOT_SIZES, DotField } from '../ui/kit/dot-field'
import { DotSpace } from '../ui/kit/dot-space'
import { constellationPoints, constellationRoutes } from './constellation-points'

export function mountConstellation() {
  const canvas = document.querySelector<HTMLCanvasElement>('#link-space')!
  const fallback = document.querySelector<HTMLCanvasElement>('#link-flat')!
  let flat: DotField | undefined, space: DotSpace | undefined
  let generation = 0
  const theme = new MutationObserver(() => flat?.refresh())
  const showFlat = () => {
    const rect = canvas.getBoundingClientRect()
    canvas.hidden = true; fallback.hidden = false
    flat?.destroy()
    flat = new DotField(fallback, { points: constellationPoints(rect.width, rect.height, DOT_SIZES.display.pitch), scale: 'display', decorative: true, surface: 'transparent', idle: false })
  }
  const mount = () => {
    generation++
    canvas.hidden = false; fallback.hidden = true; space = undefined
    const rect = canvas.getBoundingClientRect()
    const points = constellationPoints(rect.width, rect.height, DOT_SIZES.display.pitch)
    try { space = new DotSpace(canvas, { points, routes: constellationRoutes(), decorative: true, fallback: showFlat }) } catch { showFlat() }
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bb-theme', 'data-bb-accent'] })
  }
  mount()
  const pointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    space?.pointer((event.clientX - rect.left) / rect.width * 2 - 1, (event.clientY - rect.top) / rect.height * 2 - 1)
  }
  const resize = new ResizeObserver(() => {
    const rect = (flat ? fallback : canvas).getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const points = constellationPoints(rect.width, rect.height, DOT_SIZES.display.pitch)
    if (flat) flat.setPoints(points)
    else space?.setPoints(points)
  })
  resize.observe(canvas)
  resize.observe(fallback)
  canvas.addEventListener('pointermove', pointer, { passive: true })
  canvas.addEventListener('pointerleave', () => space?.pointer(0, 0), { passive: true })
  let tilt = false
  const orientation = (event: DeviceOrientationEvent) => {
    if (event.gamma === null || event.beta === null) return
    const dead = (n: number) => Math.abs(n) < 1 ? 0 : Math.max(-1, Math.min(1, n / 15))
    space?.pointer(dead(event.gamma), dead(event.beta - 30))
  }
  const button = document.querySelector<HTMLButtonElement>('#use-tilt')
  const note = document.querySelector<HTMLElement>('#tilt-note')
  button?.addEventListener('click', async () => {
    if (tilt) { window.removeEventListener('deviceorientation', orientation); tilt = false; space?.pointer(0, 0) }
    else {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { if (note) note.textContent = 'Tilt is off with reduced motion.'; return }
      if (typeof DeviceOrientationEvent === 'undefined') { if (note) note.textContent = 'Tilt is unavailable. Pointer input remains available.'; return }
      const api = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }
      const requested = generation
      try {
        if (api.requestPermission && await api.requestPermission() !== 'granted') { if (note) note.textContent = 'Tilt permission was not granted. Pointer input remains available.'; return }
        if (generation !== requested || document.hidden) return
        window.addEventListener('deviceorientation', orientation, { passive: true }); tilt = true
      } catch { if (note) note.textContent = 'Tilt is unavailable. Pointer input remains available.'; return }
    }
    button.setAttribute('aria-pressed', String(tilt)); button.textContent = tilt ? 'Turn tilt off' : 'Use tilt'
    if (note) note.textContent = tilt ? 'Tilt stays on this page. Some devices have no orientation sensor.' : ''
  })
  window.addEventListener('pagehide', () => {
    generation++; resize.disconnect(); theme.disconnect(); window.removeEventListener('deviceorientation', orientation)
    tilt = false
    if (button) { button.setAttribute('aria-pressed', 'false'); button.textContent = 'Use tilt' }
    if (note) note.textContent = ''
    space?.destroy(); flat?.destroy(); flat = undefined
  })
  window.addEventListener('pageshow', event => { if (event.persisted) { mount(); resize.observe(canvas); resize.observe(fallback) } })
  // A stable handle follows the current renderer when browser history restores this document.
  return { pointer: (x: number, y: number) => space?.pointer(x, y) }
}

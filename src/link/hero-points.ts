export type HeroState = 'idle' | 'pairing' | 'connected' | 'dropped'
export type HeroPart = 'phone' | 'browser' | 'pc' | 'link' | 'pc-link'
export interface HeroDot { x: number; y: number; part: HeroPart; screen: boolean }
export interface HeroPhase { part: HeroPart; duration: number }

/** One twelve-unit grid, with distinct screen, frame and connection samples. */
export function heroPoints(): HeroDot[] {
  const dots: HeroDot[] = []
  const add = (x: number, y: number, part: HeroPart, screen = false) => {
    if (!dots.some(dot => dot.x === x && dot.y === y)) dots.push({ x, y, part, screen })
  }
  const row = (x: number, end: number, y: number, part: HeroPart, screen = false) => {
    for (; x <= end; x += 12) add(x, y, part, screen)
  }
  const frame = (left: number, top: number, right: number, bottom: number, part: HeroPart) => {
    row(left + 12, right - 12, top, part); row(left + 12, right - 12, bottom, part)
    for (let y = top + 12; y < bottom; y += 12) { add(left, y, part); add(right, y, part) }
  }
  frame(60, 36, 132, 180, 'phone')
  row(84, 108, 48, 'phone'); row(84, 108, 168, 'phone')
  for (let y = 72; y <= 144; y += 12) row(84, 108, y, 'phone', true)
  frame(216, 60, 360, 156, 'browser')
  row(228, 348, 84, 'browser'); row(240, 264, 72, 'browser')
  for (let y = 108; y <= 132; y += 12) row(240, 336, y, 'browser', true)
  frame(432, 72, 528, 144, 'pc')
  for (let y = 96; y <= 120; y += 12) row(456, 504, y, 'pc', true)
  add(480, 156, 'pc'); add(480, 168, 'pc'); row(456, 504, 180, 'pc')
  row(144, 204, 108, 'link'); row(372, 420, 108, 'pc-link')
  return dots
}

/** A preview is finite: each device or route takes its turn, then the clock stops. */
export function heroPhases(state: HeroState, pc: boolean): HeroPhase[] {
  if (state === 'dropped') return [{ part: 'link', duration: 480 }]
  return [
    { part: 'phone', duration: 700 },
    { part: 'link', duration: state === 'pairing' ? 900 : 1800 },
    { part: 'browser', duration: 480 },
    { part: 'pc', duration: pc ? 900 : 6400 },
    ...(pc ? [{ part: 'pc-link' as const, duration: 1800 }] : []),
  ]
}

/** Transform and opacity only; the grid, sample identities and material never animate. */
export function heroFrame(dot: HeroDot, part: HeroPart | null, progress: number, state: HeroState, pc: boolean, pointerX = 0, pointerY = 0, result = { x: 0, y: 0, opacity: 1 }) {
  let x = dot.x, y = dot.y, opacity = dot.screen || (dot.part === 'pc' && !pc) ? 0.72 : 1
  if (dot.part === 'pc-link' && !pc) opacity = 0
  if (dot.part === 'link' && state === 'dropped') opacity = dot.x === 144 || dot.x === 180 || dot.x === 204 ? 1 : part === 'link' ? 1 - progress : 0
  if (dot.part !== part || progress >= 1) { result.x = x; result.y = y; result.opacity = opacity; return result }
  const envelope = Math.sin(Math.PI * progress) ** 2
  if (part === 'phone') {
    const angle = (pointerX * 1.8 + 1.2) * envelope * Math.PI / 180
    x = 96 + (dot.x - 96) * Math.cos(angle) - (dot.y - 108) * Math.sin(angle) + pointerX * 5 * envelope
    y = 108 + (dot.x - 96) * Math.sin(angle) + (dot.y - 108) * Math.cos(angle) + pointerY * 5 * envelope
    if (dot.screen) opacity += 0.28 * envelope * Math.max(0, Math.cos((dot.y / 180 - progress) * Math.PI))
  } else if (part === 'browser' && dot.screen) {
    const ripple = Math.exp(-(((dot.x - 240) / 96 - progress) ** 2) * 22) * envelope
    y -= ripple * 2.4; opacity += ripple * 0.28
  } else if (part === 'pc' && dot.screen) opacity += envelope * (pc ? 0.28 : 0.12)
  else if (part === 'link' || part === 'pc-link') {
    const start = part === 'link' ? 144 : 372
    const phase = progress * Math.PI * (state === 'pairing' ? 4 : 2) - (dot.x - start) / 12 * 0.7
    y += Math.sin(phase) * envelope * (state === 'idle' ? 1.5 : 3) * (state === 'dropped' ? 1 - progress : 1)
    if (state !== 'dropped') opacity *= 1 - envelope * 0.12 * (1 - Math.cos(phase))
  }
  result.x = x; result.y = y; result.opacity = opacity; return result
}

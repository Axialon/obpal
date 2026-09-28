/** Stroke icon set shared by the phone controller and the viewer. Names double as the protocol's standard tray icon vocabulary. */import { type Content, html, setMarkup } from './markup'

const s = (d: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`

export const ICONS: Record<string, string> = {
  rotate: s('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
  lock: s('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.6"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/><path d="M12 14.4v2" stroke-width="2.2"/>'),
  unlock: s('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.6"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.6-1.6"/><path d="M12 14.4v2" stroke-width="2.2"/>'),
  point: s('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.4"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"/>'),
  tilt: s('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M3.6 10.6h6.2M14.2 10.6h6.2M12 14.2v6.3"/>'),
  match: s('<path d="M12 3.2 19.8 7.6v8.8L12 20.8 4.2 16.4V7.6L12 3.2Z"/><path d="M4.2 7.6 12 12l7.8-4.4M12 12v8.8"/>'),
  gyro: s('<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="3.6" ry="9"/>'),
  center: s('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2"/>'),
  settings: s('<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2.2"/><circle cx="9" cy="16.5" r="2.2"/>'),
  models: s('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'),
  reset: s('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>'),
  grip: s('<path d="M12 21v-5.5"/><path d="M6.5 15.5h11"/><path d="M6.5 15.5V9.2l2.6-4.7"/><path d="M17.5 15.5V9.2l-2.6-4.7"/>'),
  frame: s('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),
  spin: s('<path d="M12 5.5c4.4 0 8 1.6 8 3.5s-3.6 3.5-8 3.5-8-1.6-8-3.5"/><path d="M4 9v5c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5V9"/><path d="M7.5 3.8 4 5.5l1.8 3.3"/>'),
  grid: s('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 3.5v17M14.5 3.5v17"/>'),
  glow: s('<path d="M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7Z"/><path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>'),
  upload: s('<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14"/>'),
  close: s('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  plus: s('<path d="M12 5.5v13M5.5 12h13"/>'),
  arrange: s('<rect x="2.8" y="8" width="5" height="8" rx="1.6"/><rect x="9.5" y="8" width="5" height="8" rx="1.6"/><rect x="16.2" y="8" width="5" height="8" rx="1.6"/>'),
  solo: s('<rect x="8" y="6.5" width="8" height="11" rx="2.2"/><path d="M3.6 9v6M20.4 9v6" stroke-dasharray="1.6 2.2"/>'),
  chevron: s('<path d="M7 10l5 5 5-5"/>'),
  left: s('<path d="M14.5 6.5 9 12l5.5 5.5"/>'),
  right: s('<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
  phone: s('<rect x="7" y="2.8" width="10" height="18.4" rx="2.8"/><path d="M10.5 18h3"/>'),
  more: s('<circle cx="5.5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor"/>'),
  open: s('<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5h4"/>'),
  orbit: s('<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(-25 12 12)"/>'),
  diamond: s('<path d="M7 4h10l4 5-9 11L3 9l4-5Z"/><path d="M3 9h18M9.5 4 8 9l4 11 4-11-1.5-5"/>'),
  matrix: s('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" stroke-width="2.6"/>'),
  cube: s('<path d="M12 3.2 19.8 7.6v8.8L12 20.8 4.2 16.4V7.6L12 3.2Z"/><path d="M4.2 7.6 12 12l7.8-4.4M12 12v8.8"/>'),
  folder: s('<path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7H9l1.9 2h7.9a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z"/><path d="M3.5 10.5h17"/>'),
  drag: s('<circle cx="9" cy="12" r="2.6"/><path d="M13.5 12h7M18 9l3 3-3 3"/>'),
  pan: s('<circle cx="6.5" cy="12" r="2.2"/><circle cx="11.5" cy="12" r="2.2"/><path d="M15.5 12h5M18 9.5l2.5 2.5-2.5 2.5"/>'),
  pinch: s('<path d="M4 4l5 5M4 4v4M4 4h4M20 20l-5-5M20 20v-4M20 20h-4"/>'),
  twist: s('<path d="M18.5 8.5A7.5 7.5 0 1 0 19.5 13"/><path d="M19.5 4.5v4h-4"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
  sun: s('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>'),
  heart: s('<path d="M12 20.2s-7.3-4.4-8.9-9A4.9 4.9 0 0 1 12 6.4a4.9 4.9 0 0 1 8.9 4.8c-1.6 4.6-8.9 9-8.9 9Z"/>'),
  palette: s('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 1.9-.8 1.9-1.7 0-1.2-1-1.6-1-2.7 0-1 .8-1.6 1.8-1.6h2.1a3.7 3.7 0 0 0 3.7-3.7C20.5 6.9 16.7 3.5 12 3.5Z"/><circle cx="7.8" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.4" r="1.1" fill="currentColor"/><circle cx="15" cy="7.6" r="1.1" fill="currentColor"/>'),
  tap: s('<circle cx="12" cy="9" r="3"/><path d="M12 14v6M7.5 6.5a6 6 0 0 1 9 0"/>'),
  // gamepad mode
  gamepad: s('<path d="M7.2 6.8h9.6c2 0 3.7 1.4 4.1 3.3l1 4.9c.4 1.9-1 3.6-2.9 3.6-.9 0-1.7-.4-2.3-1.1L15.3 16H8.7l-1.4 1.5c-.6.7-1.4 1.1-2.3 1.1-1.9 0-3.3-1.7-2.9-3.6l1-4.9c.4-1.9 2.1-3.3 4.1-3.3Z"/><path d="M7.6 9.9v3.6M5.8 11.7h3.6"/><circle cx="15.6" cy="10.6" r=".9" fill="currentColor"/><circle cx="17.5" cy="12.7" r=".9" fill="currentColor"/>'),
  view: s('<rect x="3.5" y="5.5" width="11" height="9" rx="2"/><path d="M17.5 9.5h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-.5"/>'),
  menu: s('<path d="M5 7.5h14M5 12h14M5 16.5h14"/>'),
  guide: s('<path d="M4.5 11.2 12 4.8l7.5 6.4"/><path d="M6.8 9.6v8.2A1.2 1.2 0 0 0 8 19h8a1.2 1.2 0 0 0 1.2-1.2V9.6"/><path d="M10.2 19v-4.2h3.6V19"/>'),
  // motion catalogue: routes and profiles
  plane: s('<path d="M3.5 12.2 20.2 4.4l-4.4 15.4-4.2-6.3-8.1-1.3Z"/><path d="M11.6 13.5 20.2 4.4"/>'),
  wheel: s('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3.5v5.9M4.7 15.3l5-2.3M19.3 15.3l-5-2.3"/>'),
  cursor: s('<path d="M6 4.2 18.4 12.6l-5.3 1.1 2.7 5.4-2.5 1.2-2.7-5.4L6.6 18.6Z"/>'),
  sound: s('<path d="M4.5 9.6h3.1L12 6v12l-4.4-3.6H4.5Z"/><path d="M15.2 9.3a3.8 3.8 0 0 1 0 5.4M17.8 6.8a7.4 7.4 0 0 1 0 10.4"/>'),
  mute: s('<path d="M4.5 9.6h3.1L12 6v12l-4.4-3.6H4.5Z"/><path d="M15.5 9.7l4.6 4.6M20.1 9.7l-4.6 4.6"/>'),
  'mouse-left': s('<rect x="6" y="2.8" width="12" height="18.4" rx="6"/><path d="M12 2.8v7M6 9.8h12"/><path d="M12 2.8A6 6 0 0 0 6 8.8v1h6Z" fill="currentColor"/>'),
  'mouse-right': s('<rect x="6" y="2.8" width="12" height="18.4" rx="6"/><path d="M12 2.8v7M6 9.8h12"/><path d="M12 2.8a6 6 0 0 1 6 6v1h-6Z" fill="currentColor"/>'),
  autoscroll: s('<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M9.9 8.4 12 5.9l2.1 2.5ZM9.9 15.6l2.1 2.5 2.1-2.5Z" fill="currentColor"/>'),
  'zoom-in': s('<circle cx="10.5" cy="10.5" r="6.3"/><path d="M15.1 15.1 20 20M7.8 10.5h5.4M10.5 7.8v5.4"/>'),
  'zoom-out': s('<circle cx="10.5" cy="10.5" r="6.3"/><path d="M15.1 15.1 20 20M7.8 10.5h5.4"/>'),
  mouse: s('<rect x="7" y="3.5" width="10" height="17" rx="5"/><path d="M12 3.5v6.2M7 9.7h10"/>'),
  stick: s('<circle cx="12" cy="7.8" r="3.8"/><path d="M12 11.6v4.6M5.5 19.5h13M8.2 16.2h7.6"/>'),
  stickL: s('<circle cx="12" cy="7.8" r="3.8"/><path d="M12 11.6v4.6M5.5 19.5h13M8.2 16.2h7.6"/><path d="M3.5 4.5v6h3.6" stroke-width="2"/>'),
  stickR: s('<circle cx="12" cy="7.8" r="3.8"/><path d="M12 11.6v4.6M5.5 19.5h13M8.2 16.2h7.6"/><path d="M17.2 10.5v-6h2.2a1.6 1.6 0 0 1 0 3.2h-2.2l2.8 2.8" stroke-width="2"/>'),
  fly: s('<path d="M4 15.5c2.2-1.6 5-2.5 8-2.5s5.8.9 8 2.5"/><path d="M12 13V7.5M9.5 9.2 12 6.5l2.5 2.7"/><path d="M4.5 19h15"/>'),
  // the keyboard dock (typing on the screen) and its key row
  keyboard: s('<rect x="2.6" y="5.6" width="18.8" height="12.8" rx="2.8"/><path d="M6.2 9.4h.01M9.1 9.4h.01M12 9.4h.01M14.9 9.4h.01M17.8 9.4h.01M7.65 12.2h.01M10.55 12.2h.01M13.45 12.2h.01M16.35 12.2h.01" stroke-width="2.2"/><path d="M8.4 15.2h7.2"/>'),
  'kb-hide': s('<rect x="3" y="3.2" width="18" height="11.4" rx="2.6"/><path d="M7 6.9h.01M10.3 6.9h.01M13.7 6.9h.01M17 6.9h.01" stroke-width="2.2"/><path d="M8.6 10.7h6.8"/><path d="M8.6 17.9 12 21l3.4-3.1"/>'),
  backspace: s('<path d="M9.3 5.8h9.5a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H9.3L3.4 12Z"/><path d="M11.8 9.7l4.6 4.6M16.4 9.7l-4.6 4.6"/>'),
  enter: s('<path d="M19.4 5.2v6a2.6 2.6 0 0 1-2.6 2.6H5.4"/><path d="M9.4 9.8 5.4 13.8l4 4"/>'),
  'arrow-left': s('<path d="M19 12H5.4M11 6.4 5.4 12l5.6 5.6"/>'),
  'arrow-right': s('<path d="M5 12h13.6M13 6.4l5.6 5.6-5.6 5.6"/>'),
  'arrow-up': s('<path d="M12 19V5.4M6.4 11 12 5.4l5.6 5.6"/>'),
  'arrow-down': s('<path d="M12 5v13.6M6.4 13l5.6 5.6 5.6-5.6"/>'),
  // the glass kit (./kit) and the sim catalogue's categories and controllers
  search: s('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>'),
  check: s('<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>'),
  sidebar: s('<rect x="3.5" y="4.5" width="17" height="15" rx="3.2"/><path d="M9.5 4.5v15"/><path class="ic-flip" d="m15.4 9.6-2.4 2.4 2.4 2.4"/>'),
  star: s('<path d="m12 3.8 2.45 5 5.5.8-3.98 3.88.94 5.47L12 16.37l-4.91 2.58.94-5.47L4.05 9.6l5.5-.8Z"/>'),
  arm: s('<path d="M4.5 20.5h10"/><path d="M6.8 20.5v-2.1a1.4 1.4 0 0 1 1.4-1.4h2.6a1.4 1.4 0 0 1 1.4 1.4v2.1"/><path d="m9.6 17 3.5-8.1"/><circle cx="14" cy="6.9" r="2.1"/><path d="m16 7.8 3.4 3.3"/><path d="m17.4 14.2 1.9-2.9 2.2 1.6"/>'),
  car: s('<path d="M3.8 16.2V13a1.8 1.8 0 0 1 1.3-1.7l2-.6 2.3-3.2a1.9 1.9 0 0 1 1.5-.8h2.7a1.9 1.9 0 0 1 1.5.7l2.7 3.3 1.3.4a1.8 1.8 0 0 1 1.3 1.7v3.4"/><path d="M5.3 16.2h.5M9.6 16.2h4.8M18.2 16.2h.5"/><circle cx="7.7" cy="16.4" r="1.9"/><circle cx="16.3" cy="16.4" r="1.9"/><path d="M7.3 10.8h10"/>'),
  drone: s('<rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1.4"/><path d="M9.7 9.7 7.6 7.6M14.3 9.7l2.1-2.1M9.7 14.3l-2.1 2.1M14.3 14.3l2.1 2.1"/><circle cx="5.9" cy="5.9" r="2.4"/><circle cx="18.1" cy="5.9" r="2.4"/><circle cx="5.9" cy="18.1" r="2.4"/><circle cx="18.1" cy="18.1" r="2.4"/>'),
  camera: s('<path d="M4.8 8.2h2.7l1.5-2h6l1.5 2h2.7a1.6 1.6 0 0 1 1.6 1.6v7.6a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6V9.8a1.6 1.6 0 0 1 1.6-1.6Z"/><circle cx="12" cy="13.2" r="3.3"/>'),
  factory: s('<path d="M3.5 20.5h17"/><path d="M4.6 20.5V11.2l4.8 3.1v-3.1l4.8 3.1V5.8h4v14.7"/><path d="M7.6 17.4h1.8M11.9 17.4h1.8"/>'),
  note: s('<path d="M9 17.4V6l10-2.2v11.6"/><path d="M9 9.3l10-2.2"/><circle cx="6.8" cy="17.4" r="2.3"/><circle cx="16.8" cy="15.4" r="2.3"/>'),
  piano: s('<rect x="3.5" y="5" width="17" height="14" rx="2.4"/><path d="M12 5v14M8.1 12.6V19M15.9 12.6V19"/><path d="M7 5h2.2v7.6H7ZM14.8 5H17v7.6h-2.2Z" fill="currentColor"/>'),
  drum: s('<ellipse cx="12" cy="10.2" rx="7.6" ry="2.9"/><path d="M4.4 10.2v5.6c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9v-5.6"/><path d="M7.6 12.7v5.1M12 13.1v5.6M16.4 12.7v5.1"/><path d="m9.2 3.6 3.2 4.9M18.4 4.2l-4.9 4.4"/>'),
}

export const icon = (name: string | undefined) => (name && ICONS[name]) || ''

let markSeq = 0

/**
 * The ob.Pal mark: the Blackboxes family cube (obsidian facets, hairline seams) whose lower faces and front
 * edges catch the accent light, wrapped in ob.Pal's orbit with a satellite, the "." of ob.Pal. Everything lit
 * takes the theme accent; a scan line sweeps the box on hover. Static twin: public/favicon.svg (scripts/brand-icons.mjs).
 */
/**
 * Let the logo's satellite finish `orbits` orbits (7.5 s each), then hold still. Its motion redraws the mark (and its
 * blurred glow) every frame, which a page that stays open for long, like the phone controller, shouldn't pay for.
 */
export function calmMarks(root: ParentNode, orbits = 1) {
  const marks = [...root.querySelectorAll<SVGSVGElement>('svg.mark')]
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  setTimeout(() => { for (const m of marks) m.pauseAnimations?.() }, still ? 0 : orbits * 7500)
}

/** Fill each `[data-mark]` slot with the inline logo mark (crisp at any size); a phone lets it settle after two orbits. */
export function mountMarks(root: ParentNode = document) {
  for (const slot of root.querySelectorAll<HTMLElement>('[data-mark]')) setMarkup(slot, logoMark())
  if (matchMedia('(pointer: coarse)').matches) calmMarks(root, 2)
}

export function logoMark(): Content {
  const id = `obm${++markSeq}`
  const A = 'var(--accent, #C6FF34)'
  const ring = 'M95.6 45.63 A47 15 -14 0 1 4.4 68.37'
  const orbit = 'M95.6 45.63 A47 15 -14 0 1 4.4 68.37 A47 15 -14 0 1 95.6 45.63'
  const sat = (glow: boolean) => html`<g><animateMotion dur="7.5s" repeatCount="indefinite" calcMode="linear"><mpath href="#${id}-orbit"/></animateMotion>${glow ? html`<circle r="6.5" style="fill:${A}" opacity=".45" filter="url(#${id}-soft)"/>` : ''}<circle r="3.7" style="fill:${A}"/><circle r="1.4" fill="#fff"/></g>`
  return html`<svg class="mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision">
  <defs>
    <linearGradient id="${id}-top" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4b4b4b"/><stop offset=".35" stop-color="#262626"/><stop offset=".75" stop-color="#131313"/><stop offset="1" stop-color="#050505"/></linearGradient>
    <linearGradient id="${id}-left" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1b1b"/><stop offset=".45" stop-color="#0a0a0a"/><stop offset="1" stop-color="#000"/></linearGradient>
    <linearGradient id="${id}-right" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2c2c2c"/><stop offset=".5" stop-color="#121212"/><stop offset="1" stop-color="#040404"/></linearGradient>
    <linearGradient id="${id}-ring" x1="0" y1="0" x2="1" y2="0"><stop offset="0" style="stop-color:${A};stop-opacity:.6"/><stop offset=".55" style="stop-color:${A}"/><stop offset="1" style="stop-color:var(--accent-soft, #E6FFA3)"/></linearGradient>
    <linearGradient id="${id}-spill" x1="0" y1="0" x2="0" y2="1"><stop offset=".42" style="stop-color:${A};stop-opacity:0"/><stop offset="1" style="stop-color:${A};stop-opacity:.5"/></linearGradient>
    <clipPath id="${id}-box"><polygon points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4"/></clipPath>
    <clipPath id="${id}-front"><polygon points="0,69.47 100,44.53 100,100 0,100"/></clipPath>
    <path id="${id}-orbit" d="${orbit}"/>
    <filter id="${id}-soft" filterUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140"><feGaussianBlur stdDeviation="2.4"/></filter>
  </defs>
  <ellipse cx="50" cy="57" rx="47" ry="15" transform="rotate(-14 50 57)" fill="none" style="stroke:${A}" stroke-width="1.8" opacity=".3"/>
  <g opacity=".8">${sat(false)}</g>
  <polygon points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4" fill="#000"/>
  <polygon points="50,19 78,34.4 50,49.8 22,34.4" fill="url(#${id}-top)"/>
  <polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#${id}-left)"/>
  <polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#${id}-right)"/>
  <polygon points="22,34.4 50,49.8 50,80.6 22,65.2" fill="url(#${id}-spill)" opacity=".7"/>
  <polygon points="50,49.8 78,34.4 78,65.2 50,80.6" fill="url(#${id}-spill)"/>
  <g clip-path="url(#${id}-box)"><g class="mark-scan"><line x1="0" y1="24" x2="100" y2="24" style="stroke:${A}" stroke-width="6" filter="url(#${id}-soft)" opacity=".8"/><line x1="0" y1="24" x2="100" y2="24" stroke="#fff" stroke-width="1.4"/></g></g>
  <polygon points="50,19 78,34.4 78,65.2 50,80.6 22,65.2 22,34.4" fill="none" stroke="rgba(255,255,255,.38)" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M50,49.8 L50,80.6" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.2"/>
  <path d="M22,34.4 L50,49.8 L78,34.4" fill="none" style="stroke:${A}" stroke-width="2.4" stroke-linejoin="round"/>
  <line x1="50" y1="19" x2="78" y2="34.4" stroke="rgba(255,255,255,.66)" stroke-width="1.1" stroke-linecap="round"/>
  <line x1="50" y1="19" x2="78" y2="34.4" style="stroke:${A}" stroke-width="1.3" opacity=".55" stroke-linecap="round"/>
  <path d="${ring}" fill="none" style="stroke:${A}" stroke-width="6" stroke-linecap="round" opacity=".35" filter="url(#${id}-soft)"/>
  <path d="${ring}" fill="none" stroke="url(#${id}-ring)" stroke-width="2.8" stroke-linecap="round"/>
  <g clip-path="url(#${id}-front)">${sat(true)}</g>
</svg>`
}

/** Pause the logo's SVG animations for people who prefer reduced motion (satellite rests in front). */
export function settleMotion(root: ParentNode = document) {
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) return
  root.querySelectorAll<SVGSVGElement>('svg.mark').forEach((svg) => { svg.pauseAnimations(); svg.setCurrentTime(1.4) })
}

/** Lockup: the mark with the ob.Pal wordmark (quiet "ob", accent full stop, bold "Pal"). */
export const LOGO_WORD = `<span class="word"><span class="ob">ob</span><span class="pt">.</span><b>Pal</b></span>`
export const logo = () => html`${logoMark()}${LOGO_WORD}`

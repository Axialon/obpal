/**
 * Offscreen document (reason WEB_RTC). An MV3 service worker cannot hold an RTCPeerConnection, so the ob.Pal
 * Remote lives here: the pairing QR payload, signaling, and the WebRTC link to the phone.
 * About 60 times a second it samples the phone (remote.pad and remote.consume()) and streams compact input
 * frames to the page bridges of the controlled tab over runtime ports: the controller to every frame, keys to
 * the focused frame, 3D drags to the frame with the largest canvas.
 */
import { Mode, Remote, type Layout } from '@obpal/host'
import { APP_NAME, DEFAULT_MODE, PORT_NAME, SERVICE, isTargetMode, type TargetMode } from './shared/constants'
import { parseConfig, parseFromPage, parseOffscreenRequest, type BgRequest, type ToPage } from './shared/messages'
import { buildFrame, deltaTuple, frameSignature, isActive, padTuple, recipients, tiltTuple, type FrameInfo } from './shared/route'

interface Link extends FrameInfo {
  port: chrome.runtime.Port
  tabId: number
  lastSent: number
  wasActive: boolean
  sig: string
}

const TICK_MS = 1000 / 60
const HEARTBEAT_MS = 250
const RUMBLE_GAP_MS = 50

/** What the phone offers: gamepad, tilt and point modes, plus a tray picker for what it drives in the browser. */
const layout: Layout = {
  v: 1,
  modes: [Mode.gamepad, Mode.tilt, Mode.point],
  tray: [
    {
      id: 'target', label: 'Target', type: 'select', icon: 'settings',
      options: [
        { value: 'gamepad', label: 'Controller', glyph: '✚', detail: 'Gamepad API games' },
        { value: 'viewer', label: '3D', glyph: '◆', detail: 'Rotate, pan and zoom 3D views' },
        { value: 'keys', label: 'Keys', glyph: '⌨', detail: 'Keyboard and mouse games' },
      ],
    },
  ],
}

let remote: Remote | null = null
let config: { tabId: number | null; mode: TargetMode } = { tabId: null, mode: DEFAULT_MODE }
let configured = false
const links = new Set<Link>()
let lastTargets = new Set<Link>()

const toBg = (m: BgRequest): Promise<unknown> => chrome.runtime.sendMessage(m).catch(() => undefined)

chrome.runtime.onMessage.addListener((raw: unknown, sender: chrome.runtime.MessageSender) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return
  const req = parseOffscreenRequest(raw)
  if (!req) return
  if (req.type === 'config') applyConfig(req.tabId, req.mode)
  else remote?.disconnect()
})

// Page bridges connect here directly, so 60 Hz input never has to wake the service worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return
  const tabId = port.sender?.tab?.id
  if (tabId === undefined || port.sender?.id !== chrome.runtime.id || (configured && tabId !== config.tabId)) {
    port.disconnect()
    return
  }
  const link: Link = { port, tabId, frameId: port.sender?.frameId ?? 0, focus: false, focusAt: 0, area: 0, lastSent: 0, wasActive: false, sig: '' }
  links.add(link)
  port.onMessage.addListener((raw: unknown) => onPageMessage(link, raw))
  port.onDisconnect.addListener(() => forget(link))
})

function applyConfig(tabId: number | null, mode: TargetMode) {
  const modeChanged = mode !== config.mode
  config = { tabId, mode }
  configured = true
  for (const l of [...links]) {
    if (l.tabId === tabId) continue
    forget(l)
    try { l.port.disconnect() } catch { /* gone */ }
  }
  if (modeChanged) {
    for (const l of links) l.sig = ''
    remote?.setValues({ target: mode })
  }
}

function forget(l: Link) {
  links.delete(l)
  lastTargets.delete(l)
}

function onPageMessage(link: Link, raw: unknown) {
  const m = parseFromPage(raw)
  if (!m || link.tabId !== config.tabId) return
  if (m.t === 'rep') {
    if (m.focus && !link.focus) link.focusAt = performance.now()
    link.focus = m.focus
    link.area = m.area
  } else {
    rumble(m.s, m.w, m.ms)
  }
}

// Page rumble (vibrationActuator.playEffect) goes to the phone at most every RUMBLE_GAP_MS; the latest request wins.
let rumbleAt = 0
let rumbleNext: { s: number; w: number; ms: number } | null = null
let rumbleTimer: ReturnType<typeof setTimeout> | undefined
function rumble(s: number, w: number, ms: number) {
  const wait = rumbleAt + RUMBLE_GAP_MS - performance.now()
  if (wait <= 0 && !rumbleTimer) {
    rumbleAt = performance.now()
    remote?.rumble(s, w, ms)
    return
  }
  rumbleNext = { s, w, ms }
  rumbleTimer ??= setTimeout(() => {
    rumbleTimer = undefined
    const next = rumbleNext
    rumbleNext = null
    if (!next) return
    rumbleAt = performance.now()
    remote?.rumble(next.s, next.w, next.ms)
  }, Math.max(0, wait))
}

function post(l: Link, m: ToPage) {
  try { l.port.postMessage(m) } catch { forget(l) }
}

function tick() {
  const r = remote
  if (!r) return
  const now = performance.now()
  const f = r.consume(now) // consume every tick so deltas never pile up
  const pad = r.pad
  if (config.tabId === null || !links.size) {
    lastTargets.clear()
    return
  }
  const targets = new Set(recipients([...links], config.mode))
  // The role moved (focus changed, a bigger canvas appeared, the mode changed): the old frame lets go,
  // and gets the full state straight away if the role comes back.
  for (const l of lastTargets) {
    if (targets.has(l)) continue
    post(l, { t: 'rel' })
    l.sig = ''
  }
  lastTargets = targets

  const p = padTuple(pad)
  const tl = tiltTuple(f.connected && !pad && f.mode === Mode.tilt ? f.tilt : null)
  const d = deltaTuple(f)
  const active = isActive(p, d, tl)
  const sig = frameSignature(config.mode, p, tl)
  for (const l of targets) {
    // Stream while there is input; otherwise send changes at once and a heartbeat every HEARTBEAT_MS.
    if (!active && l.sig === sig && now - l.lastSent < HEARTBEAT_MS) continue
    const dt = l.wasActive ? Math.min(50, now - l.lastSent) : TICK_MS
    post(l, buildFrame(config.mode, dt, p, d, tl))
    l.lastSent = now
    l.wasActive = active
    l.sig = sig
  }
}

function startClock() {
  const fallback = () => setInterval(tick, TICK_MS)
  try {
    const worker = new Worker(new URL('./ticker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = tick
    worker.onerror = () => {
      worker.terminate()
      fallback()
    }
  } catch {
    fallback()
  }
}

async function boot() {
  const r = await Remote.create({ appName: APP_NAME, service: SERVICE, layout })
  remote = r
  const report = () => void toBg({ to: 'bg', type: 'link', link: { status: r.status, url: r.pairingUrl, device: r.deviceName } })
  r.on('status', report)
  r.on('connect', () => {
    report()
    r.setValues({ target: config.mode })
  })
  r.on('disconnect', report)
  // The phone's tray picker switches the target mode; the service worker stores it and pushes it back as config.
  r.on('value', ({ id, v }) => {
    if (id === 'target' && isTargetMode(v)) void toBg({ to: 'bg', type: 'mode', mode: v })
  })
  report()
  const cfg = parseConfig(await toBg({ to: 'bg', type: 'offscreen-ready' }))
  if (cfg && !configured) applyConfig(cfg.tabId, cfg.mode)
  startClock()
}

boot().catch((e: unknown) => {
  console.error('[ob.Pal Link] could not start the phone link', e)
  void toBg({ to: 'bg', type: 'link', link: { status: 'offline', url: '', device: null } })
})

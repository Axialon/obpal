import { family } from '../family'
import '../styles/base.css'
import '../styles/controller.css'
import {
  DeviceLink, emptyState, encodeState, Flag, Mode, OneEuro, parsePairing, qIdentity, qScale, relativeInView,
  STATE_BYTES, Tier, viewFrameAt,
  type Caps, type HostMsg, type Layout, type LinkStatus, type ModeId, type Quat, type TierId, type TrayControl,
} from '@obpal/core'
import { Motion, motionSupported, requestMotionPermission, screenAngle } from './motion'
import { Trackpad } from './trackpad'
import { hapticsKind, tick } from './haptics'
import { GyroSmoother, playerSpaceRates, TiltStick } from './gyro'
import { GamepadMode } from './gamepad'
import { WiiPointer } from './pointing'
import { icon, ICONS, logo, logoMark } from '../ui/icons'
import { dismissHint, hint, repositionHints } from '../ui/hints'
import { applyTheme, initialTheme, swatch, THEMES, themeById } from '../ui/themes'

const app = document.getElementById('app')!
const isApple = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const safeImage = (u?: string) => (u && /^https:\/\//.test(u) ? u : undefined)

applyTheme(initialTheme())
document.body.insertAdjacentHTML('afterbegin', '<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>')
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('touchmove', (e) => { if ((e.target as Element | null)?.closest?.('.pad, .dock')) e.preventDefault() }, { passive: false })

/** The pairing secret arrives in the URL fragment; keep it for reloads in this tab only, and clear the address bar. */
function takePairing() {
  const fromHash = parsePairing(location.hash)
  if (fromHash) {
    try { sessionStorage.setItem('obpal.pair', location.hash.slice(1)) } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname)
    return fromHash
  }
  try {
    const s = sessionStorage.getItem('obpal.pair')
    return s ? parsePairing(s) : null
  } catch {
    return null
  }
}

async function deviceName(): Promise<string> {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad'
  const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ model?: string }> } }).userAgentData
  try {
    const { model } = (await uad?.getHighEntropyValues?.(['model'])) ?? {}
    if (model) return model
  } catch { /* not available */ }
  return /Android/.test(ua) ? 'Android phone' : 'Browser'
}

function screenMessage(opts: { title: string; body: string; spinner?: boolean; art?: string; action?: { label: string; run: () => void } }) {
  document.documentElement.classList.remove('gp-mode') // full-screen messages keep the background and hints alive
  app.innerHTML = `
    <main class="msg">
      <div class="logo">${logo()}</div>
      <div class="msg-card glass">
        ${opts.spinner ? '<div class="spinner" aria-hidden="true"></div>' : opts.art ? `<div class="msg-art">${opts.art}</div>` : ''}
        <h1>${esc(opts.title)}</h1>
        <p>${opts.body}</p>
        ${opts.action ? `<button class="btn primary" id="act">${esc(opts.action.label)}</button>` : ''}
      </div>
    </main>`
  if (opts.action) document.getElementById('act')!.onclick = opts.action.run
}

// Scanning a new code while this tab is open only changes the fragment; re-pair with a clean load.
addEventListener('hashchange', () => {
  if (!parsePairing(location.hash)) return
  try { sessionStorage.setItem('obpal.pair', location.hash.slice(1)) } catch { /* ignore */ }
  location.replace(location.pathname)
})

const pairing = takePairing()
if (!pairing) {
  screenMessage({
    title: 'Scan the code on your screen',
    art: ICONS.phone,
    body: `Open <b>${esc(location.host)}/view</b> on the screen you want to control, then point your camera at the code.`,
  })
} else {
  void boot(pairing)
}

/** Mark the current surface and accent in the settings sheet, if it is open. */
function syncThemeRows() {
  document.querySelectorAll<HTMLElement>('.theme-row .theme-opt').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.theme === document.documentElement.dataset.theme)))
  document.querySelectorAll<HTMLElement>('.accent-row .bb-accent').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.accent === family.getAccent())))
}

type Tab = 'rotate' | 'point' | 'gamepad'
type Style = 'game' | 'match'

async function boot(p: NonNullable<ReturnType<typeof parsePairing>>) {
  const settings = {
    gain: Number(store.get('obpal.gain') ?? 1) || 1,
    smooth: Number(store.get('obpal.smooth') ?? 0.5),
    left: store.get('obpal.left') === '1',
    style: (store.get('obpal.style') === 'match' ? 'match' : 'game') as Style,
  }
  const motion = new Motion()
  const smoother = new GyroSmoother()
  const tilt = new TiltStick()
  const qf = [0, 1, 2, 3].map(() => new OneEuro())
  const st = emptyState()
  const buf = new ArrayBuffer(STATE_BYTES)
  const t0 = performance.now()
  const aim: [number, number] = [0, 0]
  // Point mode is Wii-style: absolute pointing from the phone's orientation (./pointing.ts).
  const wii = new WiiPointer()
  let wiiLast: [number, number] = [0, 0]
  const values: Record<string, number | boolean | string> = {}
  let tier: TierId = Tier.touch
  let tab: Tab = 'rotate'
  let lastTab: Exclude<Tab, 'gamepad'> = 'rotate' // where Leave returns from gamepad mode
  let gyroOn = false
  let grab = 0
  let q0: Quat | null = null
  let R: Quat | null = null
  let lastRel: Quat | null = null
  let started = false
  let surface: HTMLElement | null = null
  let pad: Trackpad | null = null
  let hostName = 'Screen'
  let layout: Layout = { v: 1, tray: [] }
  let lastSend = 0
  let wasLevel = true
  let tilted = false

  const hostModes = () => layout.modes ?? [Mode.hold, Mode.point]
  const styleAvailable = (s: Style) => hostModes().includes(s === 'game' ? Mode.tilt : Mode.hold)
  const currentMode = (): ModeId => {
    if (tab === 'gamepad') return Mode.gamepad
    if (tab === 'point') return Mode.point
    if (settings.style === 'game' && styleAvailable('game')) return Mode.tilt
    return Mode.hold
  }
  let mode: ModeId = currentMode()

  const applySmooth = () => {
    // Quaternion filter for 1:1 match: light by default (the OS already fuses orientation).
    for (const f of qf) { f.minCutoff = 6 - 5 * settings.smooth; f.beta = 3 }
    smoother.smoothBelow = 4 + 8 * settings.smooth
    wii.setSteadiness(settings.smooth)
  }
  applySmooth()

  const caps = (): Caps => ({ tier, sensorApi: motionSupported() ? 'events' : 'none', haptics: hapticsKind(), platform: navigator.platform || 'unknown' })
  const link = new DeviceLink({ service: location.origin, pairing: p, caps, name: await deviceName() })
  // Gamepad mode: Xbox-style controller streaming PAD packets (./gamepad.ts).
  const gamepad = new GamepadMode({ motion, settings, t0, send: (b) => link.sendState(b), toast, openSettings, fullscreen: goFullscreen, exit: () => { tab = lastTab; setMode() } })

  screenMessage({ title: 'Connecting', body: 'Finding your screen…', spinner: true })
  link.on('status', onStatus)
  link.on('message', onHost)
  link.on('stats', ({ path, rttMs }) => {
    const sig = document.getElementById('sig')
    if (!sig) return
    sig.dataset.q = path === 'relay' ? 'relay' : 'direct'
    sig.title = `${path === 'relay' ? 'Relayed' : 'Direct'} connection${rttMs != null ? `, ${rttMs} ms` : ''}`
    sig.querySelector('b')!.textContent = rttMs != null ? `${rttMs}` : ''
  })
  void link.start()

  const permission = motionSupported() ? await requestMotionPermission() : 'denied'
  if (permission === 'prompt') showGate()
  else begin()

  function showGate() {
    app.insertAdjacentHTML('beforeend', `
      <div class="gate" id="gate">
        <div class="gate-card glass">
          <div class="gate-art" aria-hidden="true">${ICONS.gyro}</div>
          <h1>Tap to start</h1>
          <p>Your phone's motion steers the view. Nothing is recorded.</p>
          <button class="btn primary big" id="start">Start</button>
        </div>
      </div>`)
    document.getElementById('start')!.onclick = () => {
      const pending = requestMotionPermission() // synchronous start, inside the gesture
      goFullscreen()
      tick()
      void pending.then(() => { document.getElementById('gate')?.remove(); begin() })
    }
  }

  function goFullscreen() {
    if (isApple || !document.fullscreenEnabled || document.fullscreenElement) return
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => { /* optional */ })
  }

  async function keepAwake() {
    try { await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<unknown> } }).wakeLock?.request('screen') } catch { /* optional */ }
  }

  function begin() {
    started = true
    motion.start()
    motion.onSample = (dt) => pump(dt)
    setInterval(() => { if (!motion.flowing) pump(16.7) }, 16)
    void keepAwake()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void keepAwake()
      else setGyro(false)
    })
    // Sensors can start late (slow devices, permission granted later), so keep checking until the gyro shows up.
    const tierTimer = setInterval(() => { detectTier(); if (tier === Tier.gyro) clearInterval(tierTimer) }, 700)
    if (link.status === 'connected') showSurface()
  }

  function detectTier() {
    const next: TierId = motion.hasGyro && motion.q ? Tier.gyro : motion.q ? Tier.compass : Tier.touch
    if (next === tier) return
    tier = next
    render()
    if (tier !== Tier.touch) hint('gyro', () => document.getElementById('gyro'), 'Tap to steer with your phone’s motion', { place: 'top', delay: 600 })
  }

  function onStatus(s: LinkStatus) {
    if (s === 'connected') {
      banner(null)
      if (started) showSurface()
      return
    }
    if (s === 'taken-over') {
      surface = null
      return screenMessage({ title: 'Another phone took over', art: ICONS.phone, body: 'One phone controls a screen at a time.', action: { label: 'Take back control', run: () => location.reload() } })
    }
    if (s === 'host-mismatch') {
      surface = null
      return screenMessage({ title: "Couldn't verify this screen", art: ICONS.close, body: 'Scan the code on your screen again.' })
    }
    const text = s === 'waiting-host' ? 'Waiting for the screen' : 'Reconnecting…'
    if (surface) banner(text)
    else if (started || s === 'waiting-host') screenMessage({ title: s === 'waiting-host' ? 'Waiting for the screen' : 'Connecting', body: s === 'waiting-host' ? 'Keep the page with the code open.' : 'Securing the connection…', spinner: true })
  }

  function onHost(m: HostMsg) {
    if (m.t === 'rumble') return gamepad.rumble(m.strong, m.weak, m.ms)
    if (m.t === 'welcome') { hostName = m.name; layout = m.layout }
    else if (m.t === 'layout') layout = m.layout
    else if (m.t === 'state') {
      Object.assign(values, m.values)
      if (typeof m.values.theme === 'string') { applyTheme(themeById(m.values.theme)); syncThemeRows() }
      if (typeof m.values.accent === 'string') { family.setAccent(m.values.accent); syncThemeRows() }
    }
    else if (m.t === 'feedback') {
      if (m.toast) toast(m.toast)
      if (m.haptic && hapticsKind() === 'vibrate') navigator.vibrate(m.haptic === 'bump' ? 20 : 9)
    }
    if (surface && m.t !== 'pong' && m.t !== 'feedback') { renderTray(); setMode() }
  }

  // ---- gyro toggle and modes -------------------------------------------------

  /** Anchor 1:1 matching and the tilt level at the phone's current pose. */
  function anchor() {
    grab = (grab + 1) & 0xff
    if (motion.q) tilt.capture(motion.up())
    q0 = motion.q
    R = q0 ? viewFrameAt(q0) : null
    lastRel = null
    qf.forEach((f) => f.reset())
  }

  function setGyro(on: boolean) {
    if (on && !motion.q) { toast('Motion is off on this phone'); return }
    if (on === gyroOn) return
    gyroOn = on
    smoother.reset()
    if (on) {
      anchor()
      dismissHint('gyro')
      if (mode === Mode.tilt) hint('level', () => document.getElementById('level'), 'Tilt to spin · level to stop', { place: 'bottom', delay: 500 })
      if (mode === Mode.point) hint('point', () => document.getElementById('pad'), 'Aim to move · tap to focus', { place: 'top', delay: 500 })
    }
    render()
  }

  function setMode() {
    const next = currentMode()
    if (next === mode) return render()
    mode = next
    if (gyroOn && (mode === Mode.hold || mode === Mode.tilt)) anchor()
    smoother.reset()
    link.sendCtl({ t: 'mode', m: mode })
    if (mode === Mode.point) {
      recenterPointer()
      hint('point', () => document.getElementById('wii-home'), 'Point the top of your phone at the screen · press ⌂ to centre', { place: 'top', delay: 400 })
    }
    render()
  }

  /** Aim here = the centre of the screen: resets the phone's pointing reference and the host's cursor. */
  function recenterPointer() {
    if (motion.q) wii.recenter(motion.q)
    wiiLast = [wii.acc[0], wii.acc[1]]
    link.sendCtl({ t: 'recenter' })
  }

  // ---- surface -----------------------------------------------------------

  function showSurface() {
    if (surface && document.body.contains(surface)) return
    app.innerHTML = `
      <div class="surface${settings.left ? ' left' : ''}" id="surface">
        <header class="bar">
          <span class="host-ic">${logoMark()}</span>
          <span class="host-name"></span>
          <span class="sig" id="sig" data-q="direct" title="Connection"><i></i><i></i><i></i><b></b></span>
          <button class="icon-btn glass" id="gear" aria-label="Settings">${ICONS.settings}</button>
        </header>
        <div class="banner glass" id="banner" hidden></div>
        <div class="modes glass" role="tablist" aria-label="Control mode">
          <button role="tab" data-tab="rotate" aria-label="Rotate" title="Rotate">${ICONS.rotate}<span>Rotate</span></button>
          <button role="tab" data-tab="point" aria-label="Point" title="Point">${ICONS.point}<span>Point</span></button>
          <button role="tab" data-tab="gamepad" aria-label="Gamepad" title="Gamepad" hidden>${ICONS.gamepad}<span>Gamepad</span></button>
        </div>
        <div class="styles" id="styles" role="radiogroup" aria-label="Rotation style">
          <button role="radio" data-style="game">${ICONS.tilt}<span>Tilt</span></button>
          <button role="radio" data-style="match">${ICONS.match}<span>1:1</span></button>
        </div>
        <div class="pad glass" id="pad" aria-label="Trackpad">
          <div class="pad-part glass" id="pad-part" hidden><span class="pp-dot"></span><span class="pp-name"></span><span class="pp-tag"></span><button class="pp-x" aria-label="Release part">${ICONS.close}</button></div>
          <div class="gestures" id="gestures" aria-hidden="true"></div>
          <div class="level" id="level" aria-hidden="true"><div class="level-ring"></div><div class="level-dot" id="level-dot"></div></div>
        </div>
        <div class="wii" id="wii" hidden>
          <div class="wii-part" id="wii-part" hidden><span class="pp-dot"></span><span class="wii-part-name"></span><span class="wii-part-value"></span></div>
          <button class="wii-a" id="wii-a" aria-label="A: select">A</button>
          <div class="wii-row">
            <button class="wii-round" id="wii-minus" aria-label="Zoom out">−</button>
            <button class="wii-round home" id="wii-home" aria-label="Centre the pointer">${ICONS.center}</button>
            <button class="wii-round" id="wii-plus" aria-label="Zoom in">+</button>
          </div>
          <button class="wii-b" id="wii-b" aria-label="B: hold to grab"><b>B</b><span>hold to grab</span></button>
        </div>
        <div class="tray" id="tray"></div>
        <div class="dock">
          <button class="gyro glass" id="gyro" aria-pressed="false"><span class="gyro-ic">${ICONS.gyro}</span><span class="gyro-label">Gyro</span><span class="gyro-state"></span></button>
          <button class="icon-btn square glass" id="center" aria-label="Recenter">${ICONS.center}</button>
        </div>
      </div>
      <div class="toast glass" id="toast" role="status" aria-live="polite"></div>`
    surface = document.getElementById('surface')!
    gamepad.mount(surface)
    pad = new Trackpad(document.getElementById('pad')!)
    pad.onTap = (kind) => { link.sendCtl({ t: 'btn', id: 'pad', ev: kind }); tick(kind !== 'tap'); if (mode === Mode.point) dismissHint('point') }
    pad.onTouchChange = (touching) => { document.getElementById('pad')!.classList.toggle('active', touching); goFullscreen() }
    document.getElementById('gyro')!.addEventListener('click', () => { tick(); setGyro(!gyroOn) })
    document.getElementById('center')!.addEventListener('click', () => {
      tick()
      smoother.reset()
      if (mode === Mode.tilt) { if (motion.q) tilt.capture(motion.up()); toast('Level set') }
      else link.sendCtl({ t: 'recenter' })
    })
    surface.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => {
      b.onclick = () => { tick(); if (tab !== 'gamepad') lastTab = tab; tab = b.dataset.tab as Tab; setMode() }
    })
    surface.querySelectorAll<HTMLButtonElement>('.styles button').forEach((b) => {
      b.onclick = () => { tick(); settings.style = b.dataset.style as Style; store.set('obpal.style', settings.style); setMode() }
    })
    document.getElementById('gear')!.onclick = openSettings
    const tapBtn = (el: string, id: string) => {
      document.getElementById(el)!.addEventListener('click', () => { tick(); link.sendCtl({ t: 'btn', id, ev: 'tap' }); dismissHint('point') })
    }
    tapBtn('wii-a', 'wii-a')
    tapBtn('wii-plus', 'wii-plus')
    tapBtn('wii-minus', 'wii-minus')
    document.getElementById('wii-home')!.addEventListener('click', () => { tick(); recenterPointer(); dismissHint('point') })
    const bBtn = document.getElementById('wii-b')!
    let bDown = false
    const b = (down: boolean) => {
      if (down === bDown) return
      bDown = down
      bBtn.classList.toggle('down', down)
      if (down) tick(true)
      link.sendCtl({ t: 'btn', id: 'wii-b', ev: down ? 'down' : 'up' })
    }
    bBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      try { bBtn.setPointerCapture(e.pointerId) } catch { /* not a live pointer */ }
      b(true)
    })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) bBtn.addEventListener(ev, () => b(false))
    bBtn.addEventListener('contextmenu', (e) => e.preventDefault())
    const ppx = document.querySelector<HTMLButtonElement>('#pad-part .pp-x')!
    ppx.addEventListener('pointerdown', (e) => e.stopPropagation())
    ppx.addEventListener('click', (e) => { e.stopPropagation(); tick(); link.sendCtl({ t: 'btn', id: 'part-release', ev: 'tap' }) })
    renderTray()
    render()
    link.sendCtl({ t: 'mode', m: mode })
    hint('models', () => document.querySelector('.tray-btn.select'), 'Browse the catalogue', { place: 'top', delay: 9000 })
  }

  function render() {
    if (!surface) return
    surface.dataset.mode = String(mode)
    surface.classList.toggle('no-motion', tier === Tier.touch)
    surface.classList.toggle('gyro-on', gyroOn)
    surface.querySelector('.host-name')!.textContent = hostName
    surface.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
    const styles = document.getElementById('styles')!
    styles.hidden = tab !== 'rotate' || !(styleAvailable('game') && styleAvailable('match'))
    styles.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === settings.style)))
    const pointing = mode === Mode.point && tier !== Tier.touch
    document.getElementById('wii')!.hidden = !pointing
    document.getElementById('pad')!.hidden = pointing
    document.getElementById('gyro')!.hidden = pointing
    const center = document.getElementById('center')!
    center.hidden = pointing || (mode !== Mode.point && !(mode === Mode.tilt && gyroOn))
    requestAnimationFrame(repositionHints)
    center.setAttribute('aria-label', mode === Mode.tilt ? 'Set level here' : 'Recenter pointer')
    document.getElementById('level')!.hidden = !(mode === Mode.tilt && gyroOn)

    const gyro = document.getElementById('gyro')!
    const noMotion = tier === Tier.touch
    gyro.setAttribute('aria-pressed', String(gyroOn))
    gyro.classList.toggle('on', gyroOn)
    gyro.querySelector('.gyro-state')!.textContent = noMotion ? 'Unavailable' : gyroOn ? 'On' : 'Off'

    // Part under the pointer / selected part (sent by the host as state values).
    const part = String(values.part ?? '')
    const hov = mode === Mode.point ? String(values.hoverPart ?? '') : ''
    const wiiPart = document.getElementById('wii-part')
    if (wiiPart) {
      wiiPart.hidden = !part && !hov
      wiiPart.classList.toggle('sel', !!part)
      wiiPart.querySelector('.wii-part-name')!.textContent = part || hov
      wiiPart.querySelector('.wii-part-value')!.textContent = part && values.partLive === true ? String(values.partValue ?? '') : ''
    }
    const chip = document.getElementById('pad-part')!
    chip.hidden = !part && !hov
    chip.classList.toggle('sel', !!part)
    chip.querySelector('.pp-name')!.textContent = part || hov
    const live = !!part && values.partLive === true
    chip.querySelector('.pp-tag')!.textContent = part ? (live ? String(values.partValue ?? '') : '') : 'tap'
    if (hov && !part) hint('parts-phone', () => document.getElementById('pad-part'), 'Tap to select, then drag, pinch or twist it', { place: 'bottom', delay: 300 })

    // Visual gesture legend instead of instructions.
    const g = (name: string, word: string) => `<span>${icon(name)}<b>${word}</b></span>`
    document.getElementById('gestures')!.innerHTML = live
      ? g('drag', 'value') + g('tilt', 'sweep') + g('tap', '2× reset')
      : part
      ? g('drag', 'move') + g('pinch', 'scale') + g('twist', 'turn') + g('tap', '2× reset')
      : mode === Mode.point
      ? (gyroOn ? g('point', 'aim') : g('drag', 'move')) + g('tap', 'focus') + g('pan', 'pan') + g('pinch', 'zoom')
      : g('drag', 'orbit') + g('pan', 'pan') + g('pinch', 'zoom') + g('twist', 'roll')
    gamepad.sync({ active: mode === Mode.gamepad, offered: hostModes().includes(Mode.gamepad) })
  }

  function thumb(o: { image?: string; glyph?: string; color?: string; label: string }) {
    const img = safeImage(o.image)
    return img
      ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">`
      : `<span style="color:${/^#[0-9a-f]{3,8}$/i.test(o.color ?? '') ? o.color : 'var(--accent)'}">${esc(o.glyph ?? o.label.slice(0, 1))}</span>`
  }

  function renderTray() {
    const tray = document.getElementById('tray')
    if (!tray) return
    tray.innerHTML = ''
    for (const c of layout.tray) {
      const b = document.createElement('button')
      b.className = c.type === 'select' ? 'tray-btn select glass' : 'tray-btn glass'
      b.setAttribute('aria-label', c.label)
      if (c.type === 'select') {
        const cur = c.options?.find((o) => o.value === values[c.id])
        b.innerHTML = `<span class="sel-thumb">${cur ? thumb(cur) : icon(c.icon)}</span><span class="sel-v"></span>${ICONS.chevron}`
        b.querySelector('.sel-v')!.textContent = cur?.label ?? c.label
        b.setAttribute('aria-haspopup', 'dialog')
      } else {
        b.innerHTML = `${icon(c.icon)}<span class="tray-label"></span>`
        b.querySelector('.tray-label')!.textContent = c.label
        if (!icon(c.icon)) b.classList.add('text')
        else b.title = c.label
      }
      if (c.type === 'toggle') b.setAttribute('aria-pressed', String(!!values[c.id]))
      b.addEventListener('pointerdown', () => tick())
      b.onclick = () => {
        if (c.type === 'select') { dismissHint('models'); openPicker(c); return }
        if (c.type === 'toggle') {
          values[c.id] = !values[c.id]
          b.setAttribute('aria-pressed', String(values[c.id]))
          link.sendCtl({ t: 'value', id: c.id, v: !!values[c.id] })
        } else link.sendCtl({ t: 'btn', id: c.id, ev: 'tap' })
      }
      tray.appendChild(b)
    }
    tray.hidden = layout.tray.length === 0
  }

  /** Bottom sheet for 'select' tray controls: thumbnails grouped by collection. */
  function openPicker(c: TrayControl) {
    const wrap = document.createElement('div')
    wrap.className = 'sheet-wrap'
    wrap.innerHTML = `<div class="sheet picker glass" role="dialog"><div class="grip" aria-hidden="true"></div><div class="picker-head"><h2></h2><button class="icon-btn glass" id="pick-close" aria-label="Close">${ICONS.close}</button></div><div class="picker-list"></div></div>`
    wrap.querySelector('h2')!.textContent = c.label
    wrap.querySelector('.sheet')!.setAttribute('aria-label', c.label)
    const list = wrap.querySelector('.picker-list')!
    let group: string | undefined
    let grid: HTMLElement | null = null
    for (const o of c.options ?? []) {
      if (!grid || (o.group && o.group !== group)) {
        group = o.group
        if (group) {
          const h = document.createElement('h3')
          h.textContent = group
          list.appendChild(h)
        }
        grid = document.createElement('div')
        grid.className = 'pick-grid'
        list.appendChild(grid)
      }
      const cell = document.createElement('button')
      cell.className = 'pick'
      cell.setAttribute('aria-selected', String(values[c.id] === o.value))
      cell.innerHTML = `<span class="pick-art">${thumb(o)}</span><span class="pick-name"></span>`
      cell.querySelector('.pick-name')!.textContent = o.label
      cell.title = o.detail ?? o.label
      cell.onclick = () => {
        tick()
        values[c.id] = o.value
        link.sendCtl({ t: 'value', id: c.id, v: o.value })
        renderTray()
        close()
      }
      // Hosts that compose scenes take an option alongside the current one: the + adds instead of replacing.
      if (c.add) {
        const add = document.createElement('span')
        add.className = 'pick-add'
        add.setAttribute('role', 'button')
        add.setAttribute('aria-label', `Add ${o.label}`)
        add.innerHTML = ICONS.plus
        add.onclick = (e) => {
          e.stopPropagation()
          tick()
          values[c.id] = o.value
          link.sendCtl({ t: 'value', id: c.id, v: o.value, add: true })
          renderTray()
          close()
          toast(`Added ${o.label}`)
        }
        cell.appendChild(add)
      }
      grid.appendChild(cell)
    }
    const close = () => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200) }
    wrap.onclick = (e) => { if (e.target === wrap) close() }
    wrap.querySelector<HTMLButtonElement>('#pick-close')!.onclick = close
    document.body.appendChild(wrap)
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' })
  }

  function banner(text: string | null) {
    const b = document.getElementById('banner')
    if (!b) return
    b.hidden = !text
    b.textContent = text ?? ''
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined
  function toast(text: string) {
    const t = document.getElementById('toast')
    if (!t) return
    t.textContent = text
    t.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600)
  }

  function openSettings() {
    const sheet = document.createElement('div')
    sheet.className = 'sheet-wrap'
    sheet.innerHTML = `
      <div class="sheet glass" role="dialog" aria-label="Settings">
        <div class="grip" aria-hidden="true"></div>
        <label class="bb-field"><span>Sensitivity</span><output id="gv"></output><input class="bb-range" type="range" id="gain" min="0.5" max="3" step="0.1"></label>
        <label class="bb-field"><span>Steadiness</span><output id="sv"></output><input class="bb-range" type="range" id="smooth" min="0" max="1" step="0.05"></label>
        <div class="theme-row" role="radiogroup" aria-label="Surface">${THEMES.map((t) => `<button class="theme-opt" role="radio" data-theme="${t.id}" aria-checked="${document.documentElement.dataset.theme === t.id}">${swatch(t)}<span>${t.name}</span></button>`).join('')}</div>
        <div class="accent-row" role="radiogroup" aria-label="Accent">${family.ACCENTS.map((a) => `<button class="bb-accent${a.id === 'product' ? ' product' : ''}" role="radio" data-accent="${a.id}" aria-checked="${family.getAccent() === a.id}" aria-label="${a.id === 'product' ? 'ob.Pal lime (default)' : a.name}" style="--sw:${a.color ?? '#c6ff34'}">${family.icons.check}</button>`).join('')}</div>
        <label class="row"><input type="checkbox" id="left"> Left-handed</label>
        <a class="support-link" href="/sponsor/" target="_blank" rel="noopener">${ICONS.heart}<span>Support ob.Pal</span></a>
        <div class="row gap"><button class="btn" id="disc">Disconnect</button><button class="btn primary" id="done">Done</button></div>
      </div>`
    document.body.appendChild(sheet)
    const gain = sheet.querySelector<HTMLInputElement>('#gain')!
    const smooth = sheet.querySelector<HTMLInputElement>('#smooth')!
    const left = sheet.querySelector<HTMLInputElement>('#left')!
    const show = () => {
      sheet.querySelector('#gv')!.textContent = `${Number(gain.value).toFixed(1)}×`
      sheet.querySelector('#sv')!.textContent = `${Math.round(Number(smooth.value) * 100)}%`
    }
    gain.value = String(settings.gain)
    smooth.value = String(settings.smooth)
    family.syncRanges(sheet)
    left.checked = settings.left
    show()
    gain.oninput = () => { settings.gain = Number(gain.value); store.set('obpal.gain', gain.value); show() }
    smooth.oninput = () => { settings.smooth = Number(smooth.value); store.set('obpal.smooth', smooth.value); applySmooth(); show() }
    left.onchange = () => { settings.left = left.checked; store.set('obpal.left', left.checked ? '1' : '0'); surface?.classList.toggle('left', left.checked) }
    sheet.querySelectorAll<HTMLButtonElement>('.theme-opt').forEach((b) => {
      b.onclick = () => {
        tick()
        const t = themeById(b.dataset.theme)
        applyTheme(t)
        link.sendCtl({ t: 'value', id: 'theme', v: t.id })
        syncThemeRows()
      }
    })
    sheet.querySelectorAll<HTMLButtonElement>('.accent-row .bb-accent').forEach((b) => {
      b.onclick = () => {
        tick()
        family.setAccent(b.dataset.accent!)
        link.sendCtl({ t: 'value', id: 'accent', v: b.dataset.accent! })
        syncThemeRows()
      }
    })
    const close = () => { sheet.classList.add('out'); setTimeout(() => sheet.remove(), 200) }
    sheet.querySelector<HTMLButtonElement>('#done')!.onclick = close
    sheet.onclick = (e) => { if (e.target === sheet) close() }
    sheet.querySelector<HTMLButtonElement>('#disc')!.onclick = () => {
      link.close()
      try { sessionStorage.removeItem('obpal.pair') } catch { /* ignore */ }
      surface = null
      screenMessage({ title: 'Disconnected', art: ICONS.phone, body: 'Scan the code again to reconnect.' })
    }
  }

  // ---- state pump ----------------------------------------------------------

  function pump(dt: number) {
    if (!link.ready) return
    if (mode === Mode.gamepad && gamepad.pump()) return // gamepad mode sends PAD packets instead of STATE
    const now = performance.now()
    const touches = pad?.touches ?? 0
    const pointing = mode === Mode.point && !!motion.q // Wii-style pointing is always live
    if (!gyroOn && !pointing && touches === 0 && now - lastSend < 66) return // 15 Hz when idle
    const q = motion.q
    const s = dt / 1000
    st.seq = (st.seq + 1) & 0xffff
    st.t = Math.round((now - t0) * 1000) >>> 0
    st.mode = mode
    st.tier = tier
    st.grab = grab
    st.screen = Math.round(screenAngle() / 90) & 3
    st.touches = touches
    st.flags = (q ? Flag.quatValid | Flag.gravValid : 0) | (motion.hasGyro ? Flag.gyroValid : 0) | (gyroOn ? Flag.clutch : 0) | (touches ? Flag.touching : 0)
    st.qAbs = q ?? qIdentity()
    st.gyro = motion.gyro
    st.grav = motion.up()

    st.qRel = qIdentity()
    if (gyroOn && mode === Mode.hold && q && q0 && R) {
      let rel = relativeInView(q0, q, R)
      if (lastRel && rel[0] * lastRel[0] + rel[1] * lastRel[1] + rel[2] * lastRel[2] + rel[3] * lastRel[3] < 0) rel = rel.map((c) => -c) as Quat
      lastRel = rel
      const f = rel.map((c, i) => qf[i].filter(c, s)) as Quat
      const l = Math.hypot(f[0], f[1], f[2], f[3]) || 1
      st.qRel = qScale([f[0] / l, f[1] / l, f[2] / l, f[3] / l], settings.gain)
    }

    if (mode === Mode.point && q) {
      const a = wii.update(q, s)
      aim[0] += a[0] - wiiLast[0]
      aim[1] += a[1] - wiiLast[1]
      wiiLast = [a[0], a[1]]
    } else if (gyroOn && mode === Mode.orbit && motion.hasGyro) {
      const [yaw, pitch] = smoother.apply(...playerSpaceRates(motion.gyro, motion.up()))
      aim[0] += yaw * s * settings.gain
      aim[1] += pitch * s * settings.gain
    }
    st.aim = [aim[0], aim[1]]
    st.tilt = [0, 0]
    if (gyroOn && mode === Mode.tilt && q) {
      st.tilt = tilt.stick(motion.up(), settings.gain)
      const level = st.tilt[0] === 0 && st.tilt[1] === 0
      if (!level) tilted = true
      if (level && !wasLevel) {
        if (hapticsKind() === 'vibrate') navigator.vibrate(6) // back to balance
        if (tilted) dismissHint('level')
      }
      wasLevel = level
      const [a, b] = tilt.angles(motion.up())
      const dot = document.getElementById('level-dot')
      if (dot) dot.style.transform = `translate(${Math.max(-1, Math.min(1, a / tilt.sat)) * 46}px, ${Math.max(-1, Math.min(1, -b / tilt.sat)) * 46}px)`
    }
    if (pad) {
      st.pad1 = [pad.pad1[0], pad.pad1[1]]
      st.pad2 = [pad.pad2[0], pad.pad2[1]]
      st.zoom = pad.zoom
      st.twist = pad.twist
    }
    st.buttons = gyroOn ? 1 : 0
    if (link.sendState(encodeState(st, buf))) lastSend = now
  }
}

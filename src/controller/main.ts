import { family } from '../family'
import '../styles/base.css'
import '../styles/controller.css'
import {
  b64url, Controller, CONTROLLERS, DeviceLink, emptyState, PadButton, encodeState, Flag, forgetAllPairs, getPair, isControllerId, listPairs,
  loadCertificate, Mode, OneEuro, parsePairingCode, qIdentity, qScale, relativeInView, STATE_BYTES, Tier, TossDetector, viewFrameAt,
  type Caps, type ControllerId, type HostMsg, type Layout, type LinkStatus, type ModeId, type PairingCode, type Quat, type SceneNode,
  type ScenePerson, type TierId, type TrayControl,
} from '@obpal/core'
import { Motion, motionSupported, requestMotionPermission, screenAngle } from './motion'
import { Trackpad } from './trackpad'
import { hapticsKind, tick } from './haptics'
import { GyroSmoother, playerSpaceRates, TiltStick } from './gyro'
import { GamepadMode } from './gamepad'
import { WiiPointer } from './pointing'
import { MouseFace } from './mouseface'
import { ScrollWheel } from './wheel'
import { KeyboardDock } from './keyboard'
import { sheetExits } from './sheet'
import { calmMarks, icon, ICONS, logo, logoMark } from '../ui/icons'
import { dismissHint, hint, repositionHints, setHintFrame } from '../ui/hints'
import { HardwareButtons, type HwAction, type HwSource } from './hardware'
import { Tracker } from './track'
import { EARTH_TO_POSE, ImuTracker, toPoseFrame } from './imu3d'
import { encodePose, POSE_BYTES, PoseFlag, qMul } from '@obpal/core'
import { OrientationLock } from './lock'
import { uiRect, uiRotation, uiSize } from './uiframe'
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

/**
 * The code (an online pairing secret, or a direct LAN code) arrives in the URL fragment; keep it for reloads in
 * this tab only, and clear the address bar.
 */
function takePairing(): PairingCode | null {
  const fromHash = parsePairingCode(location.hash)
  if (fromHash) {
    try { sessionStorage.setItem('obpal.pair', location.hash.slice(1)) } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname)
    return fromHash
  }
  try {
    const s = sessionStorage.getItem('obpal.pair')
    return s ? parsePairingCode(s) : null
  } catch {
    return null
  }
}

// The controller keeps working with no internet after one visit: a service worker caches this page and its assets.
// Registered once the link has had a head start, so it never competes with connecting.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  setTimeout(() => navigator.serviceWorker.register('/p/sw.js', { scope: '/p/' }).catch(() => { /* optional */ }), 2500)
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
  calmMarks(app, 2)
  if (opts.action) document.getElementById('act')!.onclick = opts.action.run
}

// Scanning a new code while this tab is open only changes the fragment; re-pair with a clean load.
addEventListener('hashchange', () => {
  if (!parsePairingCode(location.hash)) return
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

type Tab = 'rotate' | 'point' | 'gamepad' | 'track'
type Style = 'game' | 'match'

/** The tab each catalogue controller is today (CATALOGUE §9.1); the keyboard is the tray's, beside any tab. */
const TAB_OF: Partial<Record<ControllerId, Tab>> = {
  [Controller.gamepad]: 'gamepad', [Controller.wheel]: 'gamepad', [Controller.wii]: 'point', [Controller.mouse]: 'point',
  [Controller.trackpad]: 'rotate', [Controller.hand]: 'track',
}

async function boot(code: PairingCode) {
  // This phone's own DTLS identity, kept across sessions so a screen can pin it and reconnect over the LAN.
  // It loads while the link starts signaling; the peer connection waits for it.
  const own = loadCertificate('device').then((c) => c.cert, () => null)
  // A direct code only works for a screen this phone paired with online before (that is where the key came from).
  const pair = code.v === 2 ? await getPair(b64url(code.lan.id)) : null
  if (code.v === 2 && !pair) {
    return screenMessage({
      title: 'Pair online once first',
      art: ICONS.phone,
      body: 'Scan the regular code on your screen while both are online. From then on, the direct code works without internet.',
    })
  }
  const settings = {
    gain: Number(store.get('obpal.gain') ?? 1) || 1,
    smooth: Number(store.get('obpal.smooth') ?? 0.5),
    left: store.get('obpal.left') === '1',
    style: (store.get('obpal.style') === 'match' ? 'match' : 'game') as Style,
    /** Lock the screen's rotation while the gyro is on, so turning the phone never re-lays out the controls. */
    lockWithGyro: store.get('obpal.lockgyro') !== '0',
    headset: false,
    /** What 3D follows: the phone's own sensors (the default, Wii-style), its camera (Android WebXR) or a glow for the screen's camera. */
    track3d: (['motion', 'xr', 'glow'].includes(store.get('obpal.track3d') ?? '') ? store.get('obpal.track3d') : 'motion') as 'motion' | 'xr' | 'glow',
  }
  // ---- screen lock (while steering with motion) and hardware buttons ----
  const lock = new OrientationLock()
  /** Whether the lock came from turning the gyro on (and so goes with it). */
  let lockFromGyro = false
  setHintFrame({ rect: uiRect, size: () => { const s = uiSize(); return { w: s.w, h: s.h } } })
  lock.onChange = (reanchor) => {
    applyLayout()
    requestAnimationFrame(applyLayout)
    if (reanchor && gyroOn) anchor()
    renderLock()
    requestAnimationFrame(repositionHints)
  }
  /** The compact landscape layout follows the UI's own shape, not the screen's, so a locked phone keeps its layout. */
  function applyLayout() {
    const { w, h } = uiSize()
    document.documentElement.classList.toggle('land', w > h && h <= 520)
  }
  addEventListener('resize', applyLayout)
  screen.orientation?.addEventListener?.('change', applyLayout)
  applyLayout()
  async function setLock(on: boolean, fromGyro = false) {
    if (on) {
      await lock.lock()
      lockFromGyro = fromGyro
      if (fromGyro) hint('lock', () => document.getElementById('lock'), 'Rotation is locked while the gyro is on · tap to unlock', { place: 'bottom', delay: 400 })
    } else {
      lock.unlock()
      lockFromGyro = false
    }
    renderLock()
  }
  function renderLock() {
    const b = document.getElementById('lock')
    if (!b) return
    b.setAttribute('aria-pressed', String(lock.locked))
    b.setAttribute('aria-label', lock.locked ? 'Unlock screen rotation' : 'Lock screen rotation')
    b.innerHTML = lock.locked ? ICONS.lock : ICONS.unlock
  }
  // ---- 3D tracking (mode 6): WebXR follows the phone through space; each pose goes out in a POSE packet ----
  const tracker = new Tracker()
  let trackOk = false
  /** Glowing for the computer's camera (no WebXR on this phone). */
  let glowing = false
  /** 3D from the phone's own sensors (the default): the gyro and an arm model, pushes from the accelerometer. */
  const imu = new ImuTracker()
  let imuHeld = false
  /** How 3D follows the phone here: the chosen way, if this phone can do it. */
  function trackWay(): 'motion' | 'xr' | 'glow' {
    if (settings.track3d === 'xr' && trackOk) return 'xr'
    // The arm model needs only the phone's orientation (a gyro makes it smoother); no sensors at all: glow.
    if (settings.track3d === 'glow' || tier === Tier.touch) return 'glow'
    return 'motion'
  }
  let poseSeq = 0
  const poseBuf = new ArrayBuffer(POSE_BYTES)
  void Tracker.supported().then((ok) => { trackOk = ok; render() })
  tracker.onPose = (p, q, tracked) => {
    if (!link.ready) return
    poseSeq = (poseSeq + 1) & 0xffff
    link.sendState(encodePose({ flags: (tracked ? PoseFlag.tracked : 0) | ((pad?.touches ?? 0) > 0 ? PoseFlag.touching : 0), seq: poseSeq, t: Math.round((performance.now() - t0) * 1000) >>> 0, p, q, gen: tracker.gen }, poseBuf))
  }
  tracker.onEnd = () => { toast('3D tracking ended'); render() }

  const hw = new HardwareButtons()
  const HW_HELP: Record<HwSource, string> = {
    volume: 'Volume keys work here: up = A · down = B',
    keys: 'Keys work here: Enter = A · Esc = B · arrows = next / previous',
    headset: 'Headset buttons work here: press = A · next / previous',
  }
  const hwAnnounced = new Set<HwSource>()
  /** Point's face on a PC (Layout.point 'mouse'): Left, Right and a wheel instead of A and B. */
  const mouseFace = new MouseFace({
    send: (m) => link.sendCtl(m),
    feel: (kind) => {
      if (kind === 'press') tick()
      else if (hapticsKind() === 'vibrate') navigator.vibrate(kind === 'notch' ? 3 : 5)
    },
    recenter: () => { recenterPointer(); dismissHint('point') },
  })
  const mouseOn = () => layout.point === 'mouse'
  /** Typing on the screen: the phone's own keyboard in a dock, from a `keyboard` tray control or the Type prompt. */
  const keyboard = new KeyboardDock({
    send: (m) => link.sendCtl(m),
    feel: () => tick(),
    changed: (open) => {
      // Typing holds the phone still: the gyro stops (a tilt would steer, or press keys on a PC), and a UI turned
      // against the screen turns back, so the dock and the phone's keyboard meet.
      if (open && gyroOn) setGyro(false)
      if (open && lock.kind === 'virtual' && uiRotation()) void setLock(false)
      renderTray()
      render()
    },
  })
  addEventListener('resize', () => requestAnimationFrame(placeTyping))
  let padWheel: ScrollWheel | null = null
  /** Set when the surface is built: the Wii face's A and B, held or released. */
  let wiiA: (down: boolean) => void = () => {}
  let wiiB: (down: boolean) => void = () => {}
  /** A tray button the screen bound this hardware button to (Layout.keys), outside gamepad mode. */
  const boundTo = (action: HwAction) => {
    const id = mode === Mode.gamepad ? undefined : layout.keys?.[action]
    return id ? layout.tray.find((c) => c.id === id && (c.type ?? 'button') === 'button') : undefined
  }
  function hwHelp(source: HwSource) {
    if (mode === Mode.point && mouseOn()) return { volume: 'Volume keys work here: up = click · down = hold the wheel', keys: 'Keys work here: Enter = click · Esc = hold the wheel · arrows = zoom', headset: 'Headset buttons work here: press = click' }[source]
    const [a, b] = [boundTo('primary'), boundTo('secondary')]
    if (!a && !b) return HW_HELP[source]
    const names = { volume: ['Volume up', 'Volume down'], keys: ['Enter', 'Esc'], headset: ['Press', 'Next'] }[source]
    return [a && `${names[0]} = ${a.label}`, b && source !== 'headset' && `${names[1]} = ${b.label}`].filter(Boolean).join(' · ')
  }
  hw.onAction = (action: HwAction, down: boolean, source: HwSource) => {
    if (!surface) return
    if (down && !hwAnnounced.has(source)) { hwAnnounced.add(source); toast(hwHelp(source)) }
    const bound = boundTo(action)
    if (bound) {
      if (!down) return
      tick()
      link.sendCtl({ t: 'btn', id: bound.id, ev: 'tap' })
      return
    }
    if (mode === Mode.gamepad) {
      gamepad.hardware(action === 'primary' ? PadButton.A : action === 'secondary' ? PadButton.B : action === 'next' ? PadButton.Right : PadButton.Left, down)
      return
    }
    if (mode === Mode.point && mouseOn()) {
      // The mouse face: volume up / Enter is Left, volume down / Esc holds the wheel, next and previous zoom.
      if (action === 'primary') return mouseFace.button('left', down)
      if (action === 'secondary') return mouseFace.hold(down)
      if (!down) return
      tick()
      link.sendCtl({ t: 'btn', id: action === 'next' ? 'wii-plus' : 'wii-minus', ev: 'tap' })
      return
    }
    if (mode === Mode.point) {
      if (action === 'secondary') return wiiB(down)
      if (action === 'primary') wiiA(down)
      if (!down) return
      tick()
      link.sendCtl({ t: 'btn', id: action === 'primary' ? 'wii-a' : action === 'next' ? 'wii-plus' : 'wii-minus', ev: 'tap' })
      return
    }
    // Rotate: the primary button switches the gyro (the 1:1 grab), the secondary sets the level or recentres.
    if (!down) return
    tick()
    if (action === 'primary') setGyro(!gyroOn)
    else if (action === 'secondary') recenterHere()
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
  // Keeping the phone cool (see keepAwake below): the screen's wake lock, whether the sensors run, and resting.
  let wake: { release(): Promise<void> } | null = null
  let motionOn = false
  /** Once the gyro is known, sensors can rest when nothing reads them (before that they're how we find out). */
  let tierSettled = false
  /** The sensors just woke: anchor (or recentre the pointer) on their first fresh sample, not a stale one. */
  let anchorOnSample = false
  let recenterOnSample = false
  let resting = false
  let lastTouch = performance.now()
  let grab = 0
  let q0: Quat | null = null
  let R: Quat | null = null
  let lastRel: Quat | null = null
  let started = false
  /** The person disconnected: nothing reconnects or covers the Disconnected screen. */
  let hungUp = false
  let surface: HTMLElement | null = null
  let pad: Trackpad | null = null
  let hostName = 'Screen'
  let layout: Layout = { v: 1, tray: [] }
  /** In a shared scene (CATALOGUE §5): this device's colour, who's in the scene, what can be claimed and who holds what. */
  let seatColor = ''
  /** The part chip's current content and the part last shown as held, to animate changes of control. */
  let chipKey = ''
  let chipTimer: ReturnType<typeof setTimeout> | undefined
  let heldShown = ''
  let scene: { you: string; people: ScenePerson[]; nodes: SceneNode[]; held: Record<string, string> } | null = null
  let lastSend = 0
  let wasLevel = true
  let tilted = false

  const hostModes = () => layout.modes ?? [Mode.hold, Mode.point]
  const styleAvailable = (s: Style) => hostModes().includes(s === 'game' ? Mode.tilt : Mode.hold)
  const currentMode = (): ModeId => {
    if (tab === 'gamepad') return Mode.gamepad
    if (tab === 'point') return Mode.point
    if (tab === 'track') return Mode.track
    if (styleAvailable('game') && (settings.style === 'game' || !styleAvailable('match'))) return Mode.tilt
    return Mode.hold
  }
  let mode: ModeId = currentMode()
  /**
   * The catalogue controller this phone uses now (CATALOGUE §9.1), which `mode{c}` tells the screen. The gamepad with
   * the Driving profile is the steering wheel.
   */
  const controllerNow = (): ControllerId => {
    if (tab === 'gamepad') return gamepad.profileInUse === 'driving' ? Controller.wheel : Controller.gamepad
    if (tab === 'point') return mouseOn() ? Controller.mouse : Controller.wii
    return tab === 'track' ? Controller.hand : Controller.trackpad
  }
  /** The screen's first suggested controller opens once, on the first welcome; after that the person's choice stands. */
  let suggestionTaken = false
  /** The tab of the first controller the screen suggests (layout.controllers) that its modes let this phone show. */
  function suggestedTab(): Tab | null {
    const hm = hostModes()
    for (const c of Array.isArray(layout.controllers) ? layout.controllers : []) {
      const t = isControllerId(c) ? TAB_OF[c] : undefined
      if (t && CONTROLLERS[c as ControllerId].modes.some((m) => hm.includes(m))) return t
    }
    return null
  }

  const applySmooth = () => {
    // Quaternion filter for 1:1 match: light by default (the OS already fuses orientation).
    for (const f of qf) { f.minCutoff = 6 - 5 * settings.smooth; f.beta = 3 }
    smoother.smoothBelow = 4 + 8 * settings.smooth
    wii.setSteadiness(settings.smooth)
  }
  applySmooth()

  const caps = (): Caps => ({ tier, sensorApi: motionSupported() ? 'events' : 'none', haptics: hapticsKind(), platform: navigator.platform || 'unknown' })
  const name = deviceName()
  const link = code.v === 2
    ? new DeviceLink({ lan: code.lan, pair: pair!, cert: own, caps, name })
    : new DeviceLink({ service: location.origin, pairing: code.pairing, remember: true, cert: own, caps, name })
  // Gamepad mode: Xbox-style controller streaming PAD packets (./gamepad.ts).
  const gamepad = new GamepadMode({
    motion, settings, t0, send: (b) => link.sendState(b), toast, openSettings, fullscreen: goFullscreen, exit: () => { tab = lastTab; setMode() },
    // A new profile on the gamepad tells the screen, as mode{p}.
    profile: () => { if (surface && mode === Mode.gamepad) sendMode() },
  })

  screenMessage({ title: 'Connecting', body: code.v === 2 ? 'Reaching your screen over Wi-Fi…' : 'Finding your screen…', spinner: true })
  link.on('status', onStatus)
  link.on('message', onHost)
  link.on('pair', () => toast('Remembered · works without internet next time'))
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
    if (resting || wake) return
    try {
      const w = await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release(): Promise<void>; addEventListener(t: 'release', f: () => void): void }> } }).wakeLock?.request('screen')
      if (w) { wake = w; w.addEventListener('release', () => { if (wake === w) wake = null }) }
    } catch { /* optional */ }
  }

  // ---- keeping the phone cool (a phone left connected should do next to nothing) ----
  // The motion sensors run only while something reads them; the input loop ticks every frame only while something
  // is driven; and after two minutes untouched the screen rests (black, and free to sleep) until a touch.
  function motionWanted() {
    // A screen that takes tosses listens for a flick in any mode, gyro on or not.
    return document.visibilityState === 'visible' && !resting && (!tierSettled || gyroOn || mode === Mode.point || mode === Mode.track || mode === Mode.gamepad || !!layout.toss)
  }
  /** Start or stop the sensors to match what's needed; true if they just started. */
  function syncMotion(): boolean {
    const want = motionWanted()
    if (want === motionOn) return false
    motionOn = want
    if (want) motion.start()
    else motion.stop()
    return want
  }
  function busy() { return gyroOn || mode === Mode.point || mode === Mode.track || mode === Mode.gamepad || (pad?.touches ?? 0) > 0 }
  function rest(on: boolean) {
    if (on === resting) return
    resting = on
    document.body.classList.toggle('resting', on)
    if (on) { const w = wake; wake = null; void w?.release().catch(() => {}) } else { lastTouch = performance.now(); void keepAwake() }
    syncMotion()
  }

  function begin() {
    started = true
    syncMotion()
    // A host that bounces things (the home page's marbles) asks for tosses: the phone flicked upward, screen level.
    const tosses = new TossDetector()
    motion.onSample = (dt) => {
      if (anchorOnSample) { anchorOnSample = false; anchor() }
      if (recenterOnSample) { recenterOnSample = false; recenterPointer() }
      pump(dt)
      const a = motion.accel
      if (!layout.toss || !a || !motion.q || !link.ready) return
      const up = motion.up()
      const v = tosses.sample(a[0] * up[0] + a[1] * up[1] + a[2] * up[2], dt / 1000)
      if (v !== null) link.sendCtl({ t: 'toss', v: Math.round(v * 100) / 100 })
    }
    // Every frame while something is driven; otherwise a 15 Hz keep-alive.
    const loop = () => { if (!motion.flowing) pump(16.7); setTimeout(loop, busy() ? 16 : 66) }
    loop()
    void keepAwake()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void keepAwake()
      else setGyro(false)
      syncMotion()
    })
    // Any touch counts as use, and wakes a resting screen.
    addEventListener('pointerdown', () => { lastTouch = performance.now(); if (resting) rest(false) }, { capture: true })
    // Typing on the phone's keyboard touches nothing here: an open keyboard dock keeps the screen awake.
    setInterval(() => { if (!resting && !busy() && !keyboard.open && performance.now() - lastTouch > 120_000) rest(true) }, 5000)
    // Sensors can start late (slow devices, permission granted later), so keep checking until the gyro shows up.
    const tierTimer = setInterval(() => {
      detectTier()
      if (tier === Tier.gyro) { clearInterval(tierTimer); tierSettled = true; syncMotion() }
    }, 700)
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
    // Left on purpose: the link closing says nothing more (the Disconnected screen stays).
    if (hungUp) return
    if (s === 'connected') {
      banner(null)
      if (started) showSurface()
      return
    }
    // Whatever had the focus on the screen, it says so again once it's back.
    values.textField = false
    keyboard.setField(false)
    if (s === 'taken-over') {
      surface = null
      return screenMessage({ title: 'Another phone took over', art: ICONS.phone, body: 'One phone controls a screen at a time.', action: { label: 'Take back control', run: () => location.reload() } })
    }
    if (s === 'removed') {
      surface = null
      return screenMessage({ title: 'You left the scene', art: ICONS.close, body: 'The screen removed this device. Scan its code again if they invite you back.' })
    }
    if (s === 'full') {
      surface = null
      return screenMessage({ title: 'This scene is full', art: ICONS.phone, body: 'Up to 8 devices can join at once.', action: { label: 'Try again', run: () => location.reload() } })
    }
    if (s === 'host-mismatch') {
      surface = null
      return screenMessage({ title: "Couldn't verify this screen", art: ICONS.close, body: 'Scan the code on your screen again.' })
    }
    if (s === 'lan-failed') {
      surface = null
      return screenMessage({ title: "Couldn't reach the screen", art: ICONS.close, body: 'Both need the same Wi-Fi. Scan the direct code on the screen again: each one works once.' })
    }
    if (s === 'lan-unsupported') {
      surface = null
      return screenMessage({ title: 'Not in this browser', art: ICONS.close, body: 'This browser blocks the direct Wi-Fi link. Use the regular code when online, or another browser.' })
    }
    if (s === 'unreachable') {
      surface = null
      return screenMessage({ title: 'ob.Pal is out of reach', body: 'Still trying. If the screen shows a direct code, scan that one instead.', spinner: true })
    }
    const text = s === 'waiting-host' ? 'Waiting for the screen' : 'Reconnecting…'
    if (surface) banner(text)
    else if (started || s === 'waiting-host') screenMessage({ title: s === 'waiting-host' ? 'Waiting for the screen' : 'Connecting', body: s === 'waiting-host' ? 'Keep the page with the code open.' : 'Securing the connection…', spinner: true })
  }

  function onHost(m: HostMsg) {
    if (m.t === 'rumble') return gamepad.rumble(m.strong, m.weak, m.ms)
    if (m.t === 'welcome') {
      hostName = m.name
      layout = m.layout
      // The first controller the screen suggests opens (CATALOGUE §9.2), once: a reconnect keeps what the person chose.
      const first = suggestionTaken ? null : suggestedTab()
      suggestionTaken = true
      if (first) { tab = first; if (first !== 'gamepad') lastTab = first }
      syncMotion()
    }
    else if (m.t === 'layout') { layout = m.layout; syncMotion() }
    // The catalogue side of the layout: which motion utilities the host takes, and the profile it suggests for what it controls.
    if (m.t === 'welcome' || m.t === 'layout') {
      gamepad.setHost({ name: hostName, profile: layout.profile, utilities: layout.utilities })
      keyboard.offered(layout.tray.some((c) => c.type === 'keyboard'))
    } else if (m.t === 'state') {
      Object.assign(values, m.values)
      // A text or password field has the focus on the screen (textField 'text' or 'secret'): the Type prompt.
      if ('textField' in m.values) keyboard.setField(m.values.textField)
      if (typeof m.values.theme === 'string') { applyTheme(themeById(m.values.theme)); syncThemeRows() }
      // A shared scene gives this device a colour of its own: wear it as the accent for this session, not as a preference.
      if (typeof m.values.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.values.color)) {
        seatColor = m.values.color.toLowerCase()
        const a = family.ACCENTS.find((x) => x.color?.toLowerCase() === seatColor)
        if (a) { family.applyAccent(a.id); syncThemeRows() }
      }
      if (typeof m.values.accent === 'string' && !seatColor) { family.setAccent(m.values.accent); syncThemeRows() }
    }
    else if (m.t === 'scene' && typeof m.you === 'string' && Array.isArray(m.people) && m.held && typeof m.held === 'object') {
      scene = { you: m.you, people: m.people.slice(0, 16), nodes: Array.isArray(m.nodes) ? m.nodes.slice(0, 64) : scene?.nodes ?? [], held: m.held }
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

  /** The centre button: set the tilt level here, or recentre (Point: aim here = the middle of the screen). */
  function recenterHere() {
    smoother.reset()
    if (mode === Mode.tilt) { if (motion.q) tilt.capture(motion.up()); toast('Level set') }
    else if (mode === Mode.point) recenterPointer()
    else link.sendCtl({ t: 'recenter' })
  }

  function setGyro(on: boolean) {
    if (on && !motion.q) { toast('Motion is off on this phone'); return }
    if (on === gyroOn) return
    gyroOn = on
    smoother.reset()
    const woke = syncMotion()
    // Steering with motion: the screen stops rotating until the gyro is off again (or the lock is tapped).
    if (on && settings.lockWithGyro && !lock.locked) void setLock(true, true)
    else if (!on && lockFromGyro) void setLock(false)
    if (on) {
      if (woke) anchorOnSample = true
      else anchor()
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
    if (mode !== Mode.track && tracker.active) void tracker.stop()
    const woke = syncMotion()
    if (gyroOn && (mode === Mode.hold || mode === Mode.tilt)) { if (woke) anchorOnSample = true; else anchor() }
    smoother.reset()
    sendMode()
    if (mode === Mode.track && trackWay() === 'motion') hint('track', () => document.getElementById('pad'), 'Hold here and move your phone: what you hold follows', { place: 'top', delay: 400 })
    if (mode === Mode.point) {
      if (woke) recenterOnSample = true
      else recenterPointer()
      if (mouseOn()) hint('point', () => document.getElementById('mouse-home'), 'Point the top of your phone at the screen · hold the wheel and aim to scroll', { place: 'bottom', delay: 400 })
      else hint('point', () => document.getElementById('wii-home'), 'Point the top of your phone at the screen · press ⌂ to centre', { place: 'top', delay: 400 })
    }
    render()
  }

  /** Tell the screen the mode, with the controller in use and, on the gamepad, the profile it applies (mode{m, c, p}). */
  function sendMode() {
    link.sendCtl({ t: 'mode', m: mode, c: controllerNow(), ...(mode === Mode.gamepad ? { p: gamepad.profileInUse } : {}) })
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
          <button class="icon-btn glass lock-btn" id="lock" aria-label="Lock screen rotation" aria-pressed="false">${ICONS.unlock}</button>
          <button class="icon-btn glass" id="gear" aria-label="Settings">${ICONS.settings}</button>
        </header>
        <div class="banner glass" id="banner" hidden></div>
        <div class="modes glass" role="tablist" aria-label="Control mode">
          <button role="tab" data-tab="rotate" aria-label="Rotate" title="Rotate">${ICONS.rotate}<span>Rotate</span></button>
          <button role="tab" data-tab="point" aria-label="Point" title="Point">${ICONS.point}<span>Point</span></button>
          <button role="tab" data-tab="track" aria-label="3D: the phone's movement in space" title="3D" hidden>${ICONS.cube}<span>3D</span></button>
          <button role="tab" data-tab="gamepad" aria-label="Gamepad" title="Gamepad" hidden>${ICONS.gamepad}<span>Gamepad</span></button>
        </div>
        <div class="styles" id="styles" role="radiogroup" aria-label="Rotation style">
          <button role="radio" data-style="game">${ICONS.tilt}<span>Tilt</span></button>
          <button role="radio" data-style="match">${ICONS.match}<span>1:1</span></button>
        </div>
        <div class="pad glass" id="pad" aria-label="Trackpad">
          <div class="pad-part glass" id="pad-part" hidden><span class="pp-dot"></span><span class="pp-name"></span><span class="pp-tag"></span><button class="pp-x" aria-label="Release part">${ICONS.close}</button></div>
          <div class="gestures" id="gestures" aria-hidden="true"></div>
          <div class="pad-wheel" id="pad-wheel" role="button" aria-label="Scroll wheel · turn it to scroll" hidden></div>
          <div class="level" id="level" aria-hidden="true"><div class="level-ring"></div><div class="level-dot" id="level-dot"></div></div>
          <button class="track-start glass" id="track-start" hidden>${ICONS.cube}<b>Start 3D</b><small></small></button>
          <button class="glow-end" id="glow-end" hidden aria-label="Stop glowing">${ICONS.close}</button>
          <button class="glow-stop" id="glow-stop" hidden>Stop</button>
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
        <div class="mouse" id="mouse" hidden>${mouseFace.html()}</div>
        <div class="tray" id="tray"></div>
        <div class="dock">
          <button class="gyro glass" id="gyro" aria-pressed="false"><span class="gyro-ic">${ICONS.gyro}</span><span class="gyro-label">Gyro</span><span class="gyro-state"></span></button>
          <button class="icon-btn square glass" id="center" aria-label="Recenter">${ICONS.center}</button>
        </div>
      </div>
      ${keyboard.html()}
      <div class="toast glass" id="toast" role="status" aria-live="polite"></div>
      <div class="rest" id="rest" aria-hidden="true"><span>Resting to keep your phone cool · touch to wake</span></div>`
    surface = document.getElementById('surface')!
    document.body.classList.add('live')
    calmMarks(surface)
    gamepad.mount(surface)
    mouseFace.bind(document.getElementById('mouse')!)
    keyboard.bind(app)
    // The trackpad's scroll wheel along its edge, for a screen that drives a mouse pointer (Layout.wheel).
    padWheel = new ScrollWheel(document.getElementById('pad-wheel')!, {
      turn: (v) => link.sendCtl({ t: 'value', id: 'mouse-wheel', v }),
      notch: () => { if (hapticsKind() === 'vibrate') navigator.vibrate(3) },
    })
    pad = new Trackpad(document.getElementById('pad')!)
    pad.onTap = (kind) => {
      // In 3D the thumb rests on the pad as the deadman: a long or double press there means nothing.
      if (mode === Mode.track && kind !== 'tap') return
      link.sendCtl({ t: 'btn', id: 'pad', ev: kind })
      tick(kind !== 'tap')
      if (mode === Mode.point) dismissHint('point')
    }
    pad.onTouchChange = (touching) => { document.getElementById('pad')!.classList.toggle('active', touching); goFullscreen(); if (touching) pump(16.7) }
    document.getElementById('gyro')!.addEventListener('click', () => { tick(); setGyro(!gyroOn) })
    document.getElementById('center')!.addEventListener('click', () => { tick(); recenterHere() })
    // The button sits on the trackpad, which captures every pointer: keep this one for the button.
    document.getElementById('track-start')!.addEventListener('pointerdown', (e) => e.stopPropagation())
    document.getElementById('glow-end')!.addEventListener('pointerdown', (e) => e.stopPropagation())
    document.getElementById('glow-end')!.addEventListener('click', () => { tick(); glowing = false; render() })
    // The host's safety stop stays within reach while the screen glows.
    document.getElementById('glow-stop')!.addEventListener('pointerdown', (e) => e.stopPropagation())
    document.getElementById('glow-stop')!.addEventListener('click', () => {
      const stop = layout.tray.find((c) => c.tone === 'stop')
      if (stop) { tick(); link.sendCtl({ t: 'btn', id: stop.id, ev: 'tap' }) }
    })
    document.getElementById('track-start')!.addEventListener('click', async () => {
      tick()
      // Glow for the computer's camera (chosen in settings, or no WebXR for the camera way).
      if (trackWay() === 'glow') {
        glowing = true
        void keepAwake()
        toast('Hold the screen toward the computer’s camera · touch it to move')
        render()
        return
      }
      try {
        await tracker.start(surface!)
        toast('Hold the pad and move your phone')
      } catch {
        toast('3D tracking didn’t start: it needs Android with Google Play Services for AR')
      }
      render()
    })
    document.getElementById('lock')!.addEventListener('click', () => { tick(); dismissHint('lock'); void setLock(!lock.locked) })
    renderLock()
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
    // A also reports going down and up, for hosts that act on a hold (the PC: hold A to right-click, press and aim to drag).
    const aBtn = document.getElementById('wii-a')!
    let aDown = false
    wiiA = (down: boolean) => {
      if (down === aDown) return
      aDown = down
      link.sendCtl({ t: 'btn', id: 'wii-a', ev: down ? 'down' : 'up' })
    }
    aBtn.addEventListener('pointerdown', (e) => {
      try { aBtn.setPointerCapture(e.pointerId) } catch { /* not a live pointer */ }
      wiiA(true)
    })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) aBtn.addEventListener(ev, () => wiiA(false))
    aBtn.addEventListener('contextmenu', (e) => e.preventDefault())
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
    wiiB = b
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
    // The screen's suggestion may have picked another controller before there was a surface: switch to it now.
    if (currentMode() !== mode) setMode()
    else { render(); sendMode() }
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
    const mouseFaceEl = document.getElementById('mouse')!
    if (!mouseFaceEl.hidden && !(pointing && mouseOn())) mouseFace.reset()
    mouseFaceEl.hidden = !(pointing && mouseOn())
    document.getElementById('wii')!.hidden = !pointing || mouseOn()
    const wheelEl = document.getElementById('pad-wheel')!
    const wheelOn = !!layout.wheel && !pointing && mode !== Mode.track
    if (!wheelEl.hidden && !wheelOn) padWheel?.reset()
    wheelEl.hidden = !wheelOn
    document.getElementById('pad')!.hidden = pointing
    document.getElementById('gyro')!.hidden = pointing || mode === Mode.track
    // 3D: offered where the host takes it and this phone can track itself.
    const trackTab = surface.querySelector<HTMLElement>('.modes [data-tab=track]')!
    trackTab.hidden = !hostModes().includes(Mode.track)
    if (tab === 'track' && trackTab.hidden) { tab = 'rotate'; queueMicrotask(setMode) }
    // Only the modes this screen takes: a screen that only takes pointing (the home page's try-out) opens in Point.
    const rotateTab = surface.querySelector<HTMLElement>('.modes [data-tab=rotate]')!
    const pointTab = surface.querySelector<HTMLElement>('.modes [data-tab=point]')!
    const hm = hostModes()
    rotateTab.hidden = !(hm.includes(Mode.hold) || hm.includes(Mode.tilt))
    pointTab.hidden = !hm.includes(Mode.point)
    if ((tab === 'rotate' && rotateTab.hidden) || (tab === 'point' && pointTab.hidden)) {
      const next: Tab = !pointTab.hidden ? 'point' : !rotateTab.hidden ? 'rotate' : tab
      if (next !== tab) { tab = next; queueMicrotask(setMode) }
    }
    if (mode !== Mode.track) glowing = false
    const start = document.getElementById('track-start')!
    // The phone's own sensors need no start: hold the pad and move. The camera ways start from a tap.
    const way = trackWay()
    start.hidden = !(mode === Mode.track && way !== 'motion' && !tracker.active && !glowing)
    start.querySelector('small')!.textContent = way === 'xr' ? 'The camera follows the phone through space' : 'The screen glows for the computer’s camera to follow'
    // Glowing: the whole screen is the phone's colour, and a touch anywhere is the deadman.
    surface.classList.toggle('glow', glowing)
    surface.style.setProperty('--glow', seatColor || 'var(--accent)')
    document.getElementById('glow-end')!.hidden = !glowing
    document.getElementById('glow-stop')!.hidden = !glowing || !layout.tray.some((c) => c.tone === 'stop')
    surface.classList.toggle('tracking', tracker.active)
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
    const live = !!part && values.partLive === true
    const key = part ? `sel:${part}` : hov ? `hov:${hov}` : ''
    if (key !== chipKey) {
      const wasHeld = chipKey.startsWith('sel:')
      chipKey = key
      clearTimeout(chipTimer)
      chip.classList.remove('flash', 'leaving')
      void chip.offsetWidth
      // Taking or letting go of something flashes the chip; when nothing is left it flashes and fades instead of vanishing.
      if (key) { chip.hidden = false; if (part || wasHeld) chip.classList.add('flash') }
      else if (!chip.hidden) {
        chip.classList.add('leaving')
        chipTimer = setTimeout(() => { if (!chipKey) chip.hidden = true; chip.classList.remove('leaving') }, 560)
      }
    }
    if (key) {
      chip.classList.toggle('sel', !!part)
      chip.querySelector('.pp-name')!.textContent = part || hov
      chip.querySelector('.pp-tag')!.textContent = part ? (live ? String(values.partValue ?? '') : '') : 'tap'
    }
    // A change of control (taken, handed over, taken back) flashes the whole control area in this device's colour.
    if (part !== heldShown) {
      heldShown = part
      const area = document.getElementById('pad')
      if (area) { area.classList.remove('ctl-flash'); void area.offsetWidth; area.classList.add('ctl-flash') }
    }
    // 1:1 turns what you hold (the whole model only when you hold nothing): say so once.
    if (part && mode === Mode.hold) hint('hold-part', () => document.getElementById('pad-part'), `1:1 turns ${part} · × to turn the whole model`, { place: 'bottom', delay: 300 })
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
    placeTyping()
  }

  /**
   * The Type prompt floats over the work area, in reach of the thumb and clear of every control: low on the trackpad
   * (its legend steps back) or on the mouse; on the Wii face, between its row and B, or beside A when they sit tight.
   * The gamepad fills the screen: there it takes the gap in the middle, or the cue to turn the phone sideways.
   */
  function placeTyping() {
    if (!surface || glowing) return keyboard.place(null)
    if (!keyboard.prompting) return
    const { w, h } = uiSize()
    const shown = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetHeight > 0
    const PROMPT_H = 54
    const PROMPT_W = 170
    const around = (x: number, y: number) => keyboard.place({ x, bottom: h - y - PROMPT_H / 2 })
    if (mode === Mode.gamepad) {
      const cue = surface.querySelector('.gp-cue')
      const above = surface.querySelector('.gp-center')
      const below = surface.querySelector('.gp-motion')
      if (shown(cue)) { const r = uiRect(cue); return around(r.left + r.width / 2, r.top + r.height / 2) }
      if (shown(above) && shown(below)) { const a = uiRect(above); return around(w / 2, (a.top + a.height + uiRect(below).top) / 2) }
      return around(w / 2, h / 2)
    }
    const pad = document.getElementById('pad')
    const shell = surface.querySelector('#mouse .mouse-shell')
    const wii = document.getElementById('wii')
    if (shown(pad)) { const r = uiRect(pad); return keyboard.place({ x: r.left + r.width / 2, bottom: h - (r.top + r.height) + 16 }) }
    if (shown(shell)) { const r = uiRect(shell); return keyboard.place({ x: r.left + r.width / 2, bottom: Math.max(0, h - (r.top + r.height)) + 20 }) }
    if (shown(wii)) {
      const face = uiRect(wii)
      const row = uiRect(wii.querySelector('.wii-row')!)
      const b = uiRect(wii.querySelector('.wii-b')!)
      const a = uiRect(wii.querySelector('.wii-a')!)
      const rowEnd = row.top + row.height
      if (b.top - rowEnd >= PROMPT_H + 12) return around(face.left + face.width / 2, (rowEnd + b.top) / 2)
      const right = face.left + face.width
      if (right - (a.left + a.width) >= PROMPT_W + 16) return around((a.left + a.width + right) / 2, a.top + a.height / 2)
    }
    keyboard.place({ x: w / 2, bottom: 120 })
  }

  function thumb(o: { image?: string; glyph?: string; color?: string; label: string }) {
    const img = safeImage(o.image)
    return img
      ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">`
      : `<span style="color:${/^#[0-9a-f]{3,8}$/i.test(o.color ?? '') ? o.color : 'var(--accent)'}">${esc(o.glyph ?? o.label.slice(0, 1))}</span>`
  }

  /** Who controls a node, as this device should read it: its holder, or whoever holds the node it is part of. */
  function holderOf(node: string): ScenePerson | null {
    for (let n: string | undefined = node, depth = 0; n && depth < 8; n = scene?.nodes.find((x) => x.id === n)?.parent, depth++) {
      const id = scene?.held[n]
      if (id) return scene!.people.find((p) => p.id === id) ?? null
    }
    return null
  }

  /** The scene list as a picker: each node with who holds it; picking one claims it, picking yours lets it go. */
  function sceneControl(): TrayControl {
    const mine = Object.entries(scene?.held ?? {}).find(([, who]) => who === scene?.you)?.[0]
    return {
      id: '__scene', label: 'Scene', type: 'select',
      options: (scene?.nodes ?? []).map((n) => {
        const by = holderOf(n.id)
        const via = by && !scene?.held[n.id] ? scene?.nodes.find((x) => x.id === n.parent)?.name : undefined
        return {
          value: n.id, label: n.name, group: n.group || undefined,
          detail: n.id === mine ? 'Yours: tap to let go' : by?.id === scene?.you ? `Yours, with ${via}` : by ? (via ? `${by.name} has ${via}` : `${by.name} has it`) : 'Free',
          glyph: by ? initialsOf(by.name) : n.kind === 'object' ? '◆' : '•', color: by?.color,
        }
      }),
    }
  }

  const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '•'

  function renderTray() {
    const tray = document.getElementById('tray')
    if (!tray) return
    tray.innerHTML = ''
    // In a shared scene, what you hold (or the scene list, to claim something) comes first.
    if (scene && scene.nodes.length) {
      const c = sceneControl()
      const mine = Object.entries(scene.held).find(([, who]) => who === scene!.you)?.[0]
      const node = scene.nodes.find((n) => n.id === mine)
      const b = document.createElement('button')
      b.className = 'tray-btn select glass scene-btn'
      b.setAttribute('aria-label', node ? `Holding ${node.name}. Open the scene list` : 'Open the scene list')
      b.setAttribute('aria-haspopup', 'dialog')
      b.innerHTML = `<span class="sel-thumb"><span class="seat-dot"></span></span><span class="sel-v"></span>${ICONS.chevron}`
      b.querySelector('.sel-v')!.textContent = node?.name ?? `Scene · ${scene.people.length}`
      b.addEventListener('pointerdown', () => tick())
      b.onclick = () => openPicker({ ...c, label: `Scene · ${scene!.people.length} here` }, (v) => {
        link.sendCtl({ t: 'claim', node: v === mine ? null : v })
      }, mine)
      tray.appendChild(b)
    }
    for (const c of layout.tray) {
      const b = document.createElement('button')
      b.className = c.type === 'select' ? 'tray-btn select glass' : c.tone === 'stop' ? 'tray-btn glass text stop' : 'tray-btn glass'
      b.setAttribute('aria-label', c.label)
      if (c.type === 'select') {
        const cur = c.options?.find((o) => o.value === values[c.id])
        b.innerHTML = `<span class="sel-thumb">${cur ? thumb(cur) : icon(c.icon)}</span><span class="sel-v"></span>${ICONS.chevron}`
        b.querySelector('.sel-v')!.textContent = cur?.label ?? c.label
        b.setAttribute('aria-haspopup', 'dialog')
      } else if (c.tone === 'stop') {
        b.innerHTML = '<span class="tray-label"></span>'
        b.querySelector('.tray-label')!.textContent = c.label
      } else {
        // A keyboard control without an icon of its own gets the keyboard.
        const ic = icon(c.icon ?? (c.type === 'keyboard' ? 'keyboard' : undefined))
        b.innerHTML = `${ic}<span class="tray-label"></span>`
        b.querySelector('.tray-label')!.textContent = c.label
        if (!ic) b.classList.add('text')
        else b.title = c.label
      }
      if (c.type === 'toggle') b.setAttribute('aria-pressed', String(!!values[c.id]))
      if (c.type === 'keyboard') b.setAttribute('aria-expanded', String(keyboard.open))
      b.addEventListener('pointerdown', () => tick())
      b.onclick = () => {
        if (c.type === 'select') { dismissHint('models'); openPicker(c); return }
        // The dock's field takes the focus inside this tap: that is what brings up the phone's keyboard (iOS needs the tap).
        if (c.type === 'keyboard') { keyboard.show('tray'); return }
        if (c.type === 'toggle') {
          values[c.id] = !values[c.id]
          b.setAttribute('aria-pressed', String(values[c.id]))
          link.sendCtl({ t: 'value', id: c.id, v: !!values[c.id] })
        } else link.sendCtl({ t: 'btn', id: c.id, ev: 'tap' })
      }
      tray.appendChild(b)
    }
    tray.hidden = layout.tray.length === 0 && !(scene && scene.nodes.length)
  }

  /**
   * Bottom sheet for 'select' tray controls: thumbnails grouped by collection. `onPick` replaces sending the value
   * (the scene list claims nodes), and `current` marks the chosen option when it isn't a host value.
   */
  function openPicker(c: TrayControl, onPick?: (value: string) => void, current?: string) {
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
      cell.setAttribute('aria-selected', String((current ?? values[c.id]) === o.value))
      cell.innerHTML = `<span class="pick-art">${thumb(o)}</span><span class="pick-name"></span>`
      cell.querySelector('.pick-name')!.textContent = o.label
      cell.title = o.detail ?? o.label
      cell.onclick = () => {
        tick()
        if (onPick) { onPick(o.value); close(); return }
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
    let exits = () => {}
    const close = () => { exits(); wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200) }
    wrap.querySelector<HTMLButtonElement>('#pick-close')!.onclick = close
    document.body.appendChild(wrap)
    exits = sheetExits(wrap, close)
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
      <div class="sheet settings glass" role="dialog" aria-label="Settings">
        <div class="sheet-head"><div class="grip" aria-hidden="true"></div><button class="icon-btn glass sheet-x" id="set-close" aria-label="Close">${ICONS.close}</button></div>
        <label class="bb-field"><span>Sensitivity</span><output id="gv"></output><input class="bb-range" type="range" id="gain" min="0.5" max="3" step="0.1"></label>
        <label class="bb-field"><span>Steadiness</span><output id="sv"></output><input class="bb-range" type="range" id="smooth" min="0" max="1" step="0.05"></label>
        <p class="sheet-k">Surface</p>
        <div class="theme-row" role="radiogroup" aria-label="Surface">${THEMES.map((t) => `<button class="theme-opt" role="radio" data-theme="${t.id}" aria-checked="${document.documentElement.dataset.theme === t.id}">${swatch(t)}<span>${t.name}</span></button>`).join('')}</div>
        <p class="sheet-k">Colour${seatColor ? '<small> · yours in this scene</small>' : ''}</p>
        <div class="accent-row" role="radiogroup" aria-label="Colour">${family.ACCENTS.map((a) => `<button class="bb-accent${a.id === 'product' ? ' product' : ''}" role="radio" data-accent="${a.id}" aria-checked="${family.getAccent() === a.id}" aria-label="${a.id === 'product' ? 'ob.Pal lime (default)' : a.name}" style="--sw:${a.color ?? '#c6ff34'}">${family.icons.check}</button>`).join('')}</div>
        <label class="row"><input type="checkbox" id="left"> Left-handed</label>
        <label class="row"><input type="checkbox" id="lockgyro"> Lock rotation while the gyro is on</label>
        <div class="row track3d" role="radiogroup" aria-label="3D follows"><span>3D follows</span>${(['motion', 'xr', 'glow'] as const).map((w) => `<button class="way-opt" role="radio" data-way="${w}" aria-checked="${settings.track3d === w}"><span>${{ motion: 'The phone’s motion', xr: 'Its camera (Android)', glow: 'A glow for the screen’s camera' }[w]}</span></button>`).join('')}</div>
        <label class="row"><input type="checkbox" id="headset"> <span>Headset buttons<small>Earbud presses act as A, next and previous. Plays silent audio, which pauses music.</small></span></label>
        <p class="hw-note" id="hw-note" hidden></p>
        <a class="support-link" href="/sponsor/" target="_blank" rel="noopener">${ICONS.heart}<span>Support ob.Pal</span></a>
        <button class="btn" id="forget" hidden>${ICONS.close}<span>Forget remembered screens</span></button>
        <div class="actions"><button class="btn" id="disc">Disconnect</button><button class="btn primary" id="done">Done</button></div>
      </div>`
    document.body.appendChild(sheet)
    // Screens this phone can reach with a direct code; forgetting them means pairing online again.
    const forget = sheet.querySelector<HTMLButtonElement>('#forget')!
    void listPairs().then((ps) => { forget.hidden = ps.length === 0 })
    forget.onclick = () => { tick(); void forgetAllPairs().then(() => { forget.hidden = true; toast('Forgotten') }) }
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
    const lockgyro = sheet.querySelector<HTMLInputElement>('#lockgyro')!
    lockgyro.checked = settings.lockWithGyro
    lockgyro.onchange = () => { settings.lockWithGyro = lockgyro.checked; store.set('obpal.lockgyro', lockgyro.checked ? '1' : '0') }
    sheet.querySelectorAll<HTMLButtonElement>('.track3d [data-way]').forEach((b) => {
      b.onclick = () => {
        settings.track3d = b.dataset.way as 'motion' | 'xr' | 'glow'
        store.set('obpal.track3d', settings.track3d)
        sheet.querySelectorAll('.track3d [data-way]').forEach((x) => x.setAttribute('aria-checked', String(x === b)))
        if (tracker.active) void tracker.stop()
        glowing = false
        render()
      }
    })
    const headset = sheet.querySelector<HTMLInputElement>('#headset')!
    headset.checked = settings.headset
    headset.onchange = async () => {
      settings.headset = headset.checked
      if (headset.checked) {
        if (!(await hw.enableHeadset(hostName))) { headset.checked = settings.headset = false; toast('Headset buttons aren’t available in this browser') }
        else toast('Press your headset button to try it')
      } else hw.disableHeadset()
    }
    const note = sheet.querySelector<HTMLElement>('#hw-note')!
    const seen = [...hw.seen].map((s) => ({ volume: 'volume keys', keys: 'keys', headset: 'headset buttons' })[s])
    note.hidden = !seen.length
    note.textContent = seen.length ? `Working here: ${seen.join(', ')}` : ''
    sheet.querySelectorAll<HTMLButtonElement>('.theme-opt').forEach((b) => {
      b.onclick = () => {
        tick()
        const t = themeById(b.dataset.theme)
        applyTheme(t, true)
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
    let exits = () => {}
    const close = () => { exits(); sheet.classList.add('out'); setTimeout(() => sheet.remove(), 200) }
    sheet.querySelector<HTMLButtonElement>('#done')!.onclick = close
    sheet.querySelector<HTMLButtonElement>('#set-close')!.onclick = close
    exits = sheetExits(sheet, close)
    // Disconnect asks once (a tap by mistake costs nothing), then says it's done, with the way back.
    const disc = sheet.querySelector<HTMLButtonElement>('#disc')!
    let armed = 0
    disc.onclick = () => {
      if (!armed) {
        tick()
        disc.classList.add('armed')
        disc.textContent = 'Tap again to disconnect'
        armed = window.setTimeout(() => { armed = 0; disc.classList.remove('armed'); disc.textContent = 'Disconnect' }, 3000)
        return
      }
      clearTimeout(armed)
      tick(true)
      close()
      hungUp = true
      link.close()
      surface = null
      screenMessage({
        title: 'Disconnected',
        art: ICONS.phone,
        body: hostName ? `You left <b>${esc(hostName)}</b>. Reconnect, or scan another code.` : 'Reconnect, or scan another code.',
        action: { label: 'Reconnect', run: () => location.reload() },
      })
    }
  }

  // ---- state pump ----------------------------------------------------------

  function pump(dt: number) {
    if (!link.ready) return
    if (mode === Mode.gamepad && gamepad.pump(dt)) return // gamepad mode sends PAD (and POINTER) packets instead of STATE
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
    // 3D from the phone's own sensors: while the thumb is down, each sample is a pose (the host reads Frame.pose).
    if (mode === Mode.track && trackWay() === 'motion' && q) {
      const held = touches > 0
      if (held) {
        const qp = qMul(EARTH_TO_POSE, q)
        if (!imuHeld) imu.anchor(qp)
        const p = imu.step(qp, motion.accel ? toPoseFrame(q, motion.accel) : null, motion.hasGyro ? toPoseFrame(q, motion.gyro) : null, s)
        poseSeq = (poseSeq + 1) & 0xffff
        link.sendState(encodePose({ flags: PoseFlag.tracked | PoseFlag.touching, seq: poseSeq, t: st.t, p, q: qp, gen: imu.gen }, poseBuf))
      } else if (imuHeld) imu.release()
      imuHeld = held
    }
    if (link.sendState(encodeState(st, buf))) lastSend = now
  }
}

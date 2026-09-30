import { showPackArrival } from './packs'
import { controllerWorkerURL, type Content, insertMarkup, html, setMarkup } from '../ui/markup'
import { family } from '../family'
import '../styles/base.css'
import '../styles/controller.css'
import {
  Controller, CONTROLLERS, emptyState, PadButton, encodeState, Flag, isControllerId,
  loadCertificate, Mode, OrientationReference, OrientationSmoother, parsePairingCode, qIdentity, STATE_BYTES, Tier, TossDetector,
  type Caps, type ControllerId, type HostMsg, type Layout, type LinkStatus, type ModeId, type PairingCode, type SceneNode,
  type ScenePerson, type TierId, type TrayControl,
} from '@obpal/core'
import { formatCode, lookupCode, normalizeCode, splitCode } from '@obpal/core'
import { Motion, motionSupported, requestMotionPermission, screenAngle } from './motion'
import { Trackpad } from './trackpad'
import { feedbackEnabled, setFeedbackEnabled, hapticsKind, tick } from './haptics'
import { GyroSmoother, playerSpaceRates, TiltStick } from './gyro'
import { GamepadMode } from './gamepad'
import { Drums } from './drums'
import { Keys } from './keys'
import { MusicWire } from './music'
import { CalibratedControl } from './control-space'
import { CONTROL_SPACES } from '../control-space'
import { WiiPointer } from './pointing'
import { MouseFace } from './mouseface'
import { ScrollWheel } from './wheel'
import { KeyboardDock } from './keyboard'
import { LinkBadge } from './linkbadge'
import { sheetExits } from './sheet'
import { Connections, type Connection, type Join } from './connections'
import { ConnectionSheet } from './connection-sheet'
import { pendingPhase, STILL_CONNECTING } from './pairing-recovery'
import { CameraView } from '../ui/camera'
import { HandTracker } from './hand-tracker'
import { BodyTracker } from './body-tracker'
import '../styles/connections.css'
import { calmMarks, icon, ICONS, logo, logoMark } from '../ui/icons'
import { dismissHint, hint, repositionHints, setHintFrame } from '../ui/hints'
import { enhanceSelects } from '../ui/kit/select'
import { iconAction, SIM_ACTION_ICONS, statefulIconAction } from '../ui/kit/action'
import { fitControlInk } from '../ui/kit/ink'
import { Segmented } from '../ui/kit/segmented'
import { setPopoverFrame } from '../ui/kit/place'
import { PhysicalInputs } from './inputs'
import { Buttons, BUTTONS_GLYPH, sourceStack } from './buttons'
import { Tracker } from './track'
import { EARTH_TO_POSE, ImuTracker, toPoseFrame } from './imu3d'
import { encodePose, POSE_BYTES, PoseFlag, qAxisAngle, qMul } from '@obpal/core'
import { OrientationLock } from './lock'
import { uiRect, uiRotation, uiSize } from './uiframe'
import { applyTheme, initialTheme, swatch, THEMES, themeById } from '../ui/themes'
import { barSlots, byFit, choiceFor, CONTROLLER_ICON, controllerOn, FACE_OF, fallback, rateControllers, type Face, type Rating } from './ratings'
import { Switcher } from './switcher'
import { NodeStrip } from './strip'

const app = document.getElementById('app')!
const isApple = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const safeImage = (u?: string) => (u && /^https:\/\//.test(u) ? u : undefined)
/** Where the 3D hand can follow the phone with its camera (WebXR's immersive AR). */
const CAMERA_3D_NEEDS = 'The camera follows the phone on Android with Google Play Services for AR'
let connectTo: (join: Join) => Promise<void> = async () => {}
let openConnections: (scan?: boolean) => void = () => {}
let entryGeneration = 0
const arrival = new URLSearchParams(location.search)
const scannedDigits = /^#code=[1-9][0-9]{9}$/.test(location.hash) ? location.hash.slice(6) : ''
const typedArrival = arrival.get('type') === '1' || !!scannedDigits
const scanArrival = arrival.get('scan') === '1'
const cameraTest = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && arrival.get('camera-test') === '1'
for (const key of ['code', 'type', 'scan']) arrival.delete(key)
if (typedArrival || scanArrival) history.replaceState(null, '', `${location.pathname}${arrival.size ? `?${arrival}` : ''}${scannedDigits ? '' : location.hash}`)

applyTheme(initialTheme())
insertMarkup(document.body, 'afterbegin', html`<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>`)
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
  setTimeout(() => navigator.serviceWorker.register(controllerWorkerURL(), { scope: '/p/' }).catch(() => { /* optional */ }), 2500)
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

function screenMessage(opts: { title: string; body: Content; spinner?: boolean; art?: string; action?: { label: string; run: () => void } }) {
  document.documentElement.classList.remove('gp-mode') // full-screen messages keep the background and hints alive
  setMarkup(app, html`
    <main class="msg">
      <div class="logo">${logo()}</div>
      <div class="msg-card glass">
        ${opts.spinner ? html`<div class="spinner" aria-hidden="true"></div>` : opts.art ? html`<div class="msg-art">${opts.art}</div>` : ''}
        <h1>${opts.title}</h1>
        <p>${opts.body}</p>
        ${opts.action ? html`<button class="btn primary" id="act">${opts.action.label}</button>` : ''}
      </div>
    </main>`)
  calmMarks(app, 2)
  if (opts.action) document.getElementById('act')!.onclick = opts.action.run
  const actions = document.createElement('div')
  actions.className = 'connection-actions'
  for (const [text, scan] of [['Scan a code', true], ['Connections', false]] as const) {
    const button = document.createElement('button')
    button.className = 'btn'
    button.textContent = text
    button.onclick = () => openConnections(scan)
    actions.append(button)
  }
  app.querySelector('.msg-card')!.append(actions)
}

// A camera-app scan into this tab joins beside its existing connections.
addEventListener('hashchange', () => {
  const code = parsePairingCode(location.hash)
  if (!code) return
  history.replaceState(null, '', location.pathname)
  void connectTo(code).catch(() => openConnections())
})

/** How the phone came: a code from the URL (scanned), or a short code typed on the start page (PROTOCOL §2b). */
const pairing = takePairing()
void boot(pairing ?? undefined)

/**
 * The start page, when the phone came with no code: scan the one on the screen, or type the short code beside it.
 * Typing is forgiving: spaces, dashes and pasted text are fine, O and I read as 0 and 1, and a whole code (ten digits;
 * no code is the start of another) goes by itself.
 */
function startPage() {
  ++entryGeneration
  screenMessage({ title: 'Scan the code on your screen', art: ICONS.phone, body: 'Or type the code shown beside it.' })
  const card = app.querySelector('.msg-card')!
  card.classList.add('start')
  insertMarkup(card, 'beforeend', html`
    <form class="code-form" id="code-form" novalidate>
      <label class="sr" for="code-in">Code from your screen</label>
      <input class="code-in" id="code-in" type="text" inputmode="numeric" autocomplete="off" autocorrect="off" autocapitalize="characters"
        spellcheck="false" enterkeyhint="go" placeholder="000 000 0000" maxlength="24" aria-describedby="code-say" />
      <button class="btn primary big" id="code-go" type="submit" disabled>Connect</button>
      <p class="code-say" id="code-say" role="status"></p>
    </form>
    <p id="pack-arrival" class="start-foot" role="status" hidden></p>
    <p class="start-foot">Nothing on the screen yet? Open <b>${location.host}/view</b> there.</p>`)
  showPackArrival()
  const form = document.getElementById('code-form') as HTMLFormElement
  const input = document.getElementById('code-in') as HTMLInputElement
  const go = document.getElementById('code-go') as HTMLButtonElement
  const say = document.getElementById('code-say')!
  /** Digits only: every character that isn't one (or a lookalike letter) is left out. */
  const clean = (s: string) => [...s].map((ch) => normalizeCode(ch) ?? '').join('').slice(0, 10)
  let busy = false
  let blockedUntil = 0
  const tell = (text: string, bad = false) => { say.textContent = text; say.classList.toggle('bad', bad) }
  const ready = () => { go.disabled = busy || clean(input.value).length < 10 || Date.now() < blockedUntil }

  // Group as people read it (482 193 7056), keeping the caret after the same digit.
  function regroup() {
    const caret = input.selectionStart ?? input.value.length
    const before = clean(input.value.slice(0, caret)).length
    const next = formatCode(clean(input.value))
    if (next === input.value) return
    input.value = next
    let at = 0
    for (let seen = 0; at < next.length && seen < before; at++) if (next[at] !== ' ') seen++
    input.setSelectionRange(at, at)
  }

  input.addEventListener('input', () => {
    regroup()
    tell('')
    input.removeAttribute('aria-invalid')
    ready()
    // Every code is ten digits, so the tenth completes one: it goes at once, typed or pasted.
    if (clean(input.value).length === 10) void submit()
  })
  form.addEventListener('submit', (e) => { e.preventDefault(); void submit() })

  async function submit() {
    const digits = clean(input.value)
    const parts = splitCode(digits)
    if (!parts) return tell(digits.startsWith('0') ? 'Codes start with 1 to 9: check the first digit.' : 'A code has ten digits.', true)
    if (busy || Date.now() < blockedUntil) return
    busy = true
    const generation = ++entryGeneration
    input.readOnly = true
    go.textContent = 'Connecting…'
    tell('Finding your screen…')
    ready()
    const r = await lookupCode(location.origin, parts.handle)
    busy = false
    input.readOnly = false
    go.textContent = 'Connect'
    if (!form.isConnected) return
    if (generation !== entryGeneration) {
      input.value = ''
      tell('Enter the screen’s current code.')
      ready()
      return
    }
    if ('room' in r) {
      tell('Connecting… Keep the screen’s ob.Pal page open.')
      return void connectTo({ v: 'code', code: { ...parts, room: r.room, ticket: r.ticket } }).catch(() => {
        if (!form.isConnected) return
        tell('Could not connect. Enter the screen’s current code.', true)
        input.value = ''
        ready()
        input.focus()
      })
    }
    input.setAttribute('aria-invalid', 'true')
    if (r.error === 'no-code') tell('No screen shows that code. Check it: each code works once.', true)
    else if (r.error === 'slow-down') {
      blockedUntil = Date.now() + (r.retry ?? 60) * 1000
      tell(`Too many tries. Try again in ${r.retry ?? 60} s.`, true)
      setTimeout(() => { tell(''); ready() }, (r.retry ?? 60) * 1000)
    } else tell('Can’t reach ob.Pal. Check your connection.', true)
    ready()
    input.focus()
    input.select()
  }
  input.focus()
  if (scannedDigits) { input.value = scannedDigits; input.dispatchEvent(new Event('input')) }
}

/** Mark the current surface and accent in the settings sheet, if it is open. */
function syncThemeRows() {
  document.querySelectorAll<HTMLElement>('.theme-row .theme-opt').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.theme === document.documentElement.dataset.theme)))
  document.querySelectorAll<HTMLElement>('.accent-row .bb-accent').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.accent === family.getAccent())))
}

/** The face on screen (./ratings.ts): each catalogue controller is drawn on one; the keyboard types beside any. */
type Tab = Face
type Style = 'game' | 'match'

async function boot(code?: Join) {
  // This phone's own DTLS identity, kept across sessions so a screen can pin it and reconnect over the LAN.
  // It loads while the link starts signaling; the peer connection waits for it.
  const own = loadCertificate('device').then((c) => c.cert, () => null)
  // A direct code only works for a screen this phone paired with online before (that is where the key came from).
  const settings = {
    gain: Number(store.get('obpal.gain') ?? 1) || 1,
    smooth: Number(store.get('obpal.smooth') ?? 0.5),
    left: store.get('obpal.left') === '1',
    style: (store.get('obpal.style') === 'match' ? 'match' : 'game') as Style,
    /** Lock the screen's rotation while the gyro is on, so turning the phone never re-lays out the controls. */
    lockWithGyro: store.get('obpal.lockgyro') !== '0',
    /** What 3D follows: the phone's own sensors (the default, Wii-style), its camera (Android WebXR) or a glow for the screen's camera. */
    track3d: (['motion', 'xr', 'glow'].includes(store.get('obpal.track3d') ?? '') ? store.get('obpal.track3d') : 'motion') as 'motion' | 'xr' | 'glow',
  }
  // ---- screen lock (while steering with motion) and hardware buttons ----
  const lock = new OrientationLock()
  /** Whether the lock came from turning the gyro on (and so goes with it). */
  let lockFromGyro = false
  setHintFrame({ rect: uiRect, size: () => { const s = uiSize(); return { w: s.w, h: s.h } } })
  // The glass selects' lists open in the UI's own frame too, and every select on the phone is one.
  setPopoverFrame({ rect: uiRect, size: () => { const s = uiSize(); return { width: s.w, height: s.h } } })
  enhanceSelects()
  lock.onChange = (reanchor) => {
    motion.refreshScreen()
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
    setMarkup(b, lock.locked ? ICONS['rotation-lock'] : ICONS['rotation-free'])
  }
  // ---- 3D tracking (mode 6): WebXR follows the phone through space; each pose goes out in a POSE packet ----
  // Camera sessions/recenters and motion grabs share origins, even when the tracking method changes.
  let poseGen = 0
  const nextPoseGen = () => ++poseGen
  const tracker = new Tracker(nextPoseGen)
  let trackOk = false
  /** Glowing for the computer's camera (no WebXR on this phone). */
  let glowing = false
  /** 3D from the phone's own sensors (the default): the gyro and an arm model, pushes from the accelerometer. */
  const imu = new ImuTracker(nextPoseGen)
  let imuHeld = false
  let imuScreen = 0
  /** The way Settings shows as chosen: the camera only where this phone can follow with it (else Motion, in its place). */
  const shownWay = () => (settings.track3d === 'xr' && !trackOk ? 'motion' : settings.track3d)
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
    link.sendState(encodePose({ flags: (tracked ? PoseFlag.tracked : 0) | ((pad?.touches ?? 0) > 0 || buttonHold ? PoseFlag.touching : 0), seq: poseSeq, t: Math.round((performance.now() - t0) * 1000) >>> 0, p, q, gen: tracker.gen, source: 'camera' }, poseBuf))
  }
  tracker.onEnd = () => { toast('3D tracking ended'); render() }

  /** Point's face on a PC (Layout.point 'mouse'): Left, Right and a wheel instead of A and B. */
  const mouseFace = new MouseFace({
    send: (m) => link.sendCtl(m),
    feel: (kind) => {
      if (kind === 'press') tick()
      else if (hapticsKind() === 'vibrate') navigator.vibrate(kind === 'notch' ? 3 : 5)
    },
    recenter: () => { recenterPointer(); dismissHint('point') },
  })
  /** Point's face is the air mouse: the person picked it, or the screen drives a mouse pointer (Layout.point 'mouse'). */
  const mouseOn = () => (pointFace ?? (layout.point === 'mouse' ? 'mouse' : 'wii')) === 'mouse'
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
  // ---- physical buttons: keys, headset, pads and Back, each pressing what it's bound to (./buttons.ts) ----
  const inputs = new PhysicalInputs()
  /** A button held as the 3D hand's deadman (its `hold` control): as a thumb on the pad. */
  let buttonHold = false
  const buttons = new Buttons({
    inputs,
    controller: () => controllerNow(),
    // Profiles tune the gamepad today (CATALOGUE §3); the other controllers keep theirs under the default.
    profile: () => (tab === 'gamepad' ? gamepad.profileInUse : 'default'),
    layout: () => layout,
    press: (target, down, tap) => press(target, down, tap),
    canSwitch: () => shownSlots().length > 1,
    typing: () => keyboard.open,
    hostName: () => hostName,
    feel: () => tick(),
    toast: (text) => toast(text),
  })
  inputs.onInput = (id, down) => {
    // Back caught while a sheet or the keyboard is open closes that first, as Back does (their history step).
    if (id === 'back' && !buttons.sheetOpen && (document.querySelector('.sheet-wrap') || keyboard.open)) { if (down) history.back(); return true }
    return (surface && link.ready) || buttons.sheetOpen ? buttons.input(id, down) : false
  }
  /** A control's PAD button, on the gamepad and the steering wheel. */
  const PAD_OF: Record<string, number> = {
    a: PadButton.A, b: PadButton.B, x: PadButton.X, y: PadButton.Y, lb: PadButton.LB, rb: PadButton.RB, lt: PadButton.LT, rt: PadButton.RT,
    view: PadButton.View, menu: PadButton.Menu, ls: PadButton.L3, rs: PadButton.R3, up: PadButton.Up, down: PadButton.Down,
    left: PadButton.Left, right: PadButton.Right, guide: PadButton.Guide,
  }
  /**
   * Press or let go of what a physical input is bound to, exactly as a thumb would (CATALOGUE §1): a control of the
   * controller in use, a key on the screen, a tray button, or the phone's own action. `tap`: the input has no release of
   * its own (a headset press, Back), so a PAD button is clicked rather than held.
   */
  function press(target: string, down: boolean, tap: boolean) {
    if (!surface) return
    const once = (f: () => void) => { if (down) { tick(); f() } }
    const send = (id: string) => link.sendCtl({ t: 'btn', id, ev: 'tap' })
    if (target.startsWith('tray:')) return once(() => send(target.slice(5)))
    if (target.startsWith('key-')) return once(() => send(target))
    if (target.startsWith('app:')) return once(() => appAction(target.slice(4)))
    const c = controllerNow()
    if (c === Controller.drums) return drums.hardware(target, down)
    if (c === Controller.keys) return keys.hardware(target, down, tap)
    if (c === Controller.gamepad || c === Controller.wheel) {
      const b = PAD_OF[target]
      if (b === undefined) return
      if (!tap) gamepad.hardware(b, down)
      else if (down) gamepad.tap(b)
      return
    }
    if (c === Controller.wii) {
      if (target === 'a') { wiiA(down); return once(() => send('wii-a')) }
      if (target === 'b') return wiiB(down)
      if (target === 'minus' || target === 'plus') return once(() => send(`wii-${target}`))
      if (target === 'home') return once(recenterPointer)
      return
    }
    if (c === Controller.mouse) {
      if (target === 'left' || target === 'right') return mouseFace.button(target, down)
      if (target === 'wheel') return mouseFace.hold(down)
      if (target === 'middle') return once(() => send('mouse-middle'))
      if (target === 'minus' || target === 'plus') return once(() => send(`wii-${target}`))
      if (target === 'home') return once(recenterPointer)
      return
    }
    if (c === Controller.hand) {
      if (target === 'hold') {
        buttonHold = down
        document.getElementById('pad')?.classList.toggle('active', down)
        pump(16.7)
        return
      }
      if (target === 'recentre') return once(recenterHere)
      return
    }
    // The trackpad: its grab switches the gyro (the 1:1 grab), its level sets the level or recentres.
    if (target === 'grab') return once(() => setGyro(!gyroOn))
    if (target === 'level') return once(recenterHere)
  }
  /** The phone's own actions a button can press (app:…). */
  function appAction(a: string) {
    if (a === 'gyro') setGyro(!gyroOn)
    else if (a === 'recentre') recenterHere()
    else if (a === 'keyboard') { if (layout.tray.some((c) => c.type === 'keyboard')) keyboard.show('tray') }
    else if (a === 'next' || a === 'prev') {
      // The controller bar's next or previous slot, round and round.
      const slots = shownSlots()
      const i = slots.findIndex((b) => b.dataset.tab === tab)
      const next = slots[(i + (a === 'next' ? 1 : slots.length - 1)) % slots.length]
      if (!next || next.dataset.tab === tab) return
      pick(next.dataset.c as ControllerId)
    }
  }
  /** The controller bar's slots now, in its order. */
  const shownSlots = () => [...(surface?.querySelectorAll<HTMLElement>('.modes [data-tab]') ?? [])].filter((b) => !b.hidden)
  const motion = new Motion()
  const control = new CalibratedControl(motion)
  let controlSent = 0
  let controlActive = false
  const smoother = new GyroSmoother()
  const tilt = new TiltStick()
  const orientation = new OrientationReference()
  const qf = new OrientationSmoother()
  const st = emptyState()
  const buf = new ArrayBuffer(STATE_BYTES)
  let stateSent = false
  const t0 = performance.now()
  const aim: [number, number] = [0, 0]
  // Point mode is Wii-style: absolute pointing from the phone's orientation (./pointing.ts).
  const wii = new WiiPointer()
  let wiiLast: [number, number] = [0, 0]
  const values: Record<string, number | boolean | string> = {}
  /** The banner's two sources (see banner()): the link's own trouble, and the screen's `notice`. */
  let linkLine: string | null = null
  let hostNotice = ''
  let tier: TierId = Tier.touch
  let tab: Tab = 'rotate'
  let lastTab: Exclude<Tab, 'gamepad'> = 'rotate' // where Leave returns from gamepad mode
  /** The pointing face the person picked (the Wii remote or the air mouse); null: the screen's (`layout.point`). */
  let pointFace: 'wii' | 'mouse' | null = null
  /** The screen's ratings of every controller, best first (./ratings.ts), and what they were worked out from. */
  let ratings: Rating[] = []
  let ratedFrom = ''
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
  let started = false
  let permissionReady = false
  let motionPrompt = false
  /** The person disconnected: nothing reconnects or covers the Disconnected screen. */
  let hungUp = false
  let surface: HTMLElement | null = null
  let inkTray: HTMLElement | null = null, releaseTrayInk: (() => void) | undefined
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
  /** The face last shown, so a switch animates the new one in. */
  let faceShown = ''
  /** Tilt or 1:1, in the dock (the glass kit's segmented control), once the surface is up. */
  let styleSeg: Segmented | null = null
  let lastSend = 0
  let wasLevel = true
  let tilted = false

  const hostModes = () => layout.modes ?? [Mode.hold, Mode.point]
  const styleAvailable = (s: Style) => hostModes().includes(s === 'game' ? Mode.tilt : Mode.hold)
  const currentMode = (): ModeId => {
    if (tab === 'drums' || tab === 'keys') return Mode.pad
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
  const controllerNow = (): ControllerId => controllerOn(tab, { point: mouseOn() ? 'mouse' : 'wii', wheel: gamepad.wheelInUse })
  /** The screen's first suggested controller opens once, on the first welcome; after that the person's choice stands. */
  let suggestionTaken = false
  /** The face of the first controller the screen suggests (layout.controllers) that its modes let this phone show. */
  function suggestedTab(): Tab | null {
    const hm = hostModes()
    for (const c of Array.isArray(layout.controllers) ? layout.controllers : []) {
      const t = isControllerId(c) ? FACE_OF[c] : null
      if (t && CONTROLLERS[c as ControllerId].modes.some((m) => hm.includes(m))) return t
    }
    return null
  }
  /** The name the screen goes by here: what this phone calls it, else what it calls itself. */
  const screenName = () => link.active?.row.name ?? hostName
  /** Every controller rated for this screen and this phone, best first; worked out again only when either changes. */
  function rated(): Rating[] {
    const motion = tier !== Tier.touch
    const from = JSON.stringify([layout.modes, layout.controllers, layout.utilities, layout.point, layout.profile, layout.tray.some((c) => c.type === 'keyboard'), motion, screenName()])
    if (from !== ratedFrom) { ratedFrom = from; ratings = byFit(rateControllers(layout, { motion }, screenName()), layout) }
    return ratings
  }
  /**
   * Switch to a controller: one tap on the bar or in the catalogue (CATALOGUE §9.4). Its face comes up and, on a shared
   * face, its variant: the Wii remote or the air mouse, the gamepad or the steering wheel (the Driving profile, kept for
   * this screen as a profile pick is). The keyboard opens its dock beside whatever is in use.
   */
  function pick(id: ControllerId) {
    if (id === Controller.keyboard) {
      if (layout.tray.some((c) => c.type === 'keyboard')) keyboard.show('tray')
      return
    }
    const c = choiceFor(id)
    if (!c) return
    if (c.point) pointFace = c.point
    if (c.wheel !== undefined) gamepad.setWheel(c.wheel)
    if (c.face !== tab) { if (tab !== 'gamepad') lastTab = tab; tab = c.face }
    setMode()
  }

  const applySmooth = () => {
    // 1:1 follows the OS-fused orientation directly. Steadiness applies to pointing and rate controls.
    qf.seconds = 0
    smoother.smoothBelow = 4 + 8 * settings.smooth
    wii.setSteadiness(settings.smooth)
  }
  applySmooth()

  const caps = (): Caps => ({ tier, sensorApi: motionSupported() ? 'events' : 'none', haptics: hapticsKind(), platform: navigator.platform || 'unknown' })
  const name = deviceName()
  const link = new Connections({ service: location.origin, cert: own, caps, name, beforeSwitch: releaseControls, switched: switchSurface,
    status: onStatus, message: onHost, stats: (s) => linkBadge.update(s), seal: (s) => linkBadge.reveal(s), notice: (text) => toast(text), attempt: showAttempt })
  const musicWire = new MusicWire(m => { if (link.ready) link.sendCtl(m) })
  const drums = new Drums(musicWire, motion, control)
  const keys = new Keys(musicWire, motion, control, recenterHere)
  let sentController = ''
  let musicActive = false
  // Gamepad mode: Xbox-style controller streaming PAD packets (./gamepad.ts).
  const gamepad = new GamepadMode({
    motion, settings, t0, send: (b) => link.sendState(b), toast, openSettings, fullscreen: goFullscreen, exit: () => { tab = lastTab; setMode() },
    // A new profile on the gamepad tells the screen, as mode{p}.
    profile: () => { buttons.changed(); if (surface && mode === Mode.gamepad) sendMode() },
    mapping: () => buttons.changed(),
    modePack: (id, version) => { if (link.ready) link.sendCtl({ t: 'value', id: 'pack-mode', v: `${id}@${version}` }) },
    position: () => control.recenter(),
    recenter: recenterHere, scope: toggleControlScope,
    controllers: () => switcher.open(),
  })
  /** The controller bar and the catalogue (./switcher.ts). */
  const switcher = new Switcher({ pick, hand: openHands, body: openBody, feel: (strong) => tick(strong), toast: (text) => toast(text) })
  /** The node strip along the trackpad's edge: which part of what you hold the pad drives (./strip.ts). */
  const strip = new NodeStrip({ send: (id, v) => { if (link.ready) link.sendCtl({ t: 'value', id, v }) }, feel: (strong) => tick(strong), changed: () => render() })

  // The top bar's connection badge: encrypted, how the screen was verified, the path and the round trip (./linkbadge.ts).
  const linkBadge = new LinkBadge(() => {
    hungUp = true
    releaseControls()
    stopHands(); stopBody()
    link.close()
    linkBadge.down()
    surface = null
    screenMessage({ title: 'Disconnected', art: ICONS.phone, body: 'Reconnect, or scan another code.', action: { label: 'Reconnect', run: () => location.reload() } })
  })
  const connections = new ConnectionSheet(link)
  function showAttempt(c: Connection | null) {
    // A different active screen stays usable; the Connections sheet presents the pending choice beside it.
    if (link.ready) return
    if (!c) { if (!link.active && !link.attempt) startPage(); return }
    if (c.failure || !pendingPhase(c.link.status)) return
    const card = app.querySelector<HTMLElement>('.msg-card')
    if (!card) return
    if (c.stillConnecting) {
      card.querySelector('h1')!.textContent = 'Still connecting'
      card.querySelector('p')!.textContent = c.link.status === 'unreachable' ? `ob.Pal is out of reach. ${STILL_CONNECTING}` : STILL_CONNECTING
    }
    if (card.querySelector('.pairing-recovery')) return
    const tools = document.createElement('div')
    tools.className = 'connection-actions pairing-recovery'
    for (const [text, run] of [
      ['Cancel attempt', () => {
        if (!link.cancel(c.row.id)) return
        startPage()
        document.getElementById('code-say')!.textContent = 'Attempt cancelled. Your saved screens are kept.'
      }],
      ['Enter current code', () => connections.enterCode(c.row.id)],
    ] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'btn'
      button.textContent = text
      button.onclick = run
      tools.append(button)
    }
    card.querySelector('p')!.setAttribute('role', 'status')
    card.append(tools)
  }
  let handCamera: CameraView | null = null
  let handTracker: HandTracker | null = null
  let handHold = false
  let handSeq = 0
  let handGen = 0
  let bodyCamera: CameraView | null = null
  let bodyTracker: BodyTracker | null = null
  let bodySeq = 0, bodyGen = 0
  function stopBody() {
    bodyTracker?.stop(); bodyTracker = null
    const camera = bodyCamera; bodyCamera = null
    camera?.close()
  }
  function openBody() {
    if (!link.ready || !layout.utilities?.includes('camera.body')) return
    releaseControls()
    keyboard.close(true)
    const camera = new CameraView({ mode: 'body', measurements: cameraTest,
      typed: stopBody,
      reset: () => { bodyTracker?.stop(); bodyTracker = null },
      fingers: layout.utilities?.includes('camera.hand') ? enabled => bodyTracker?.setFingers(enabled) : undefined,
      close: () => { bodyTracker?.stop(); bodyTracker = null; bodyCamera = null; syncMotion(); render(); lastSend = 0; pump(16.7) },
      ready: (video, overlay) => {
        if (bodyCamera !== camera) return
        bodyTracker?.stop()
        const tracker = new BodyTracker(video, overlay, {
          send: packet => link.sendState(packet), timeOrigin: t0,
          sequence: () => (bodySeq = (bodySeq + 1) & 65535), generation: () => (bodyGen = (bodyGen + 1) & 255),
          hand: layout.utilities?.includes('camera.hand') ? { send: packet => link.sendState(packet), sequence: () => (handSeq = (handSeq + 1) & 65535), generation: () => (handGen = (handGen + 1) & 255) } : undefined,
          say: text => camera.say(text), loading: p => camera.loading(p), error: text => camera.unavailable(text), fingersOff: () => camera.fingersOff(),
          metrics: m => { if (cameraTest) camera.setMetrics(`${m.trackingFps.toFixed(0)} fps · ${m.latencyP95Ms.toFixed(0)} ms`) },
        })
        bodyTracker = tracker
        void camera.prepareBody(() => { if (bodyTracker === tracker && bodyCamera === camera) tracker.start() })
      },
    })
    bodyCamera = camera
    render(); syncMotion(); camera.open()
    void keepAwake()
  }
  if (cameraTest) Object.assign(window, { __cameraBody: {
    stats: () => bodyTracker?.stats ?? null,
    inject: (...args: Parameters<BodyTracker['injectForTest']>) => bodyTracker?.injectForTest(...args),
  } })
  function stopHands() {
    handHold = false
    handTracker?.stop(); handTracker = null
    const camera = handCamera; handCamera = null
    camera?.close()
  }
  function openHands() {
    if (!link.ready || !layout.utilities?.includes('camera.hand')) return
    releaseControls()
    keyboard.close(true)
    const stop = layout.tray.find(c => c.tone === 'stop')
    const camera = new CameraView({ mode: 'hand', measurements: cameraTest,
      typed: () => stopHands(),
      close: () => { handTracker?.stop(); handTracker = null; handCamera = null; handHold = false; syncMotion(); render(); lastSend = 0; pump(16.7) },
      hold: stop ? active => { handHold = active; lastSend = 0; pump(16.7) } : undefined,
      stop: stop ? () => { handHold = false; lastSend = 0; pump(16.7); link.sendCtl({ t: 'btn', id: stop.id, ev: 'tap' }) } : undefined,
      ready: (video, overlay) => {
        if (handCamera !== camera) return
        handTracker?.stop()
        handTracker = new HandTracker(video, overlay, {
          send: b => link.sendState(b), timeOrigin: t0,
          loading: p => camera.loading(p), error: text => camera.unavailable(text), hand: (g, side, palm) => camera.handState(g, side, palm),
          sequence: () => (handSeq = (handSeq + 1) & 0xffff), generation: () => (handGen = (handGen + 1) & 0xff),
          say: text => camera.say(text), metrics: m => {
            camera.setMetrics(`${m.trackingFps.toFixed(0)} fps · ${m.latencyMs.toFixed(0)} ms`)
            const meter = document.querySelector<HTMLOutputElement>('[data-camera-metrics]')
            if (meter) meter.dataset.measurements = JSON.stringify(m)
          },
        })
        const tracker = handTracker
        void camera.prepareHands(() => { if (handTracker === tracker) tracker.start() })
      },
    })
    handCamera = camera
    render()
    syncMotion()
    camera.open()
    void keepAwake()
  }
  // Local automation can replace the model result, but still crosses camera timing, filtering, HAND and WebRTC.
  if (cameraTest) Object.assign(window, { __cameraHand: {
    stats: () => handTracker?.stats ?? null,
    inject: (result: Parameters<HandTracker['injectForTest']>[0]) => handTracker?.injectForTest(result),
  } })
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopHands(); stopBody() } })
  // The keyboard's dock hands its Back step to the sheet that opens over it (./sheet.ts).
  openConnections = (scan = false) => { ++entryGeneration; keyboard.close(true); tick(); connections.open(scan) }
  connectTo = async (join) => { hungUp = false; await link.connect(join) }
  link.setLimit(Number(store.get('obpal.connections.limit') ?? 3))
  addEventListener('pagehide', () => { stopHands(); stopBody(); connections.close(); link.destroy() })
  if (code) {
    screenMessage({ title: 'Connecting', body: code.v === 2 ? 'Reaching your screen over Wi-Fi…' : 'Finding your screen…', spinner: true })
    void connectTo(code).catch((e: Error) => screenMessage({ title: 'Scan again', body: e.message, art: ICONS.phone }))
  } else {
    startPage()
    // A scan deep link opens the choices; camera activation still needs the phone's own tap.
    if (scanArrival) openConnections()
    void link.settled().then(() => {
      if (typedArrival || scanArrival) return
      let id = ''
      try { id = sessionStorage.getItem('obpal.active') ?? '' } catch { /* private mode */ }
      if (id && link.rows.get(id)?.invite) void link.use(id)
    })
  }

  function releaseControls() {
    stopHands()
    stopBody()
    buttons.releaseAll()
    buttonHold = false
    wiiA(false); wiiB(false)
    mouseFace.reset()
    padWheel?.reset()
    pad?.reset()
    keyboard.close()
    keys.reset()
    drums.release()
    if (control.sim) link.sendCtl({ t: 'value', id: 'control.aim', v: JSON.stringify({ aim: [0, 0], tilt: [0, 0], active: false }) })
    controlActive = false
    if (musicActive) musicWire.event('stop')
    musicWire.use(false)
    musicActive = false
    gamepad.releaseConnection()
    if (gyroOn) setGyro(false)
    if (tracker.active) void tracker.stop()
    glowing = false
    const neutral = emptyState()
    st.seq = (st.seq + 1) & 0xffff
    neutral.seq = st.seq
    neutral.t = Math.round((performance.now() - t0) * 1000) >>> 0
    link.sendState(encodeState(neutral))
    stateSent = false
  }

  function switchSurface(next: Connection | null) {
    musicWire.resetClock()
    control.sim = ''; control.scope = 'object'; control.defer(); controlSent = 0
    gamepad.setControlReach(null)
    hungUp = false
    surface = null
    pad = null
    for (const k of Object.keys(values)) delete values[k]
    hostNotice = ''; linkLine = null; seatColor = ''; scene = null; chipKey = ''; heldShown = ''
    clearTimeout(chipTimer)
    layout = { v: 1, tray: [] }
    hostName = 'Screen'
    suggestionTaken = false
    sentController = ''
    tab = 'rotate'; lastTab = 'rotate'; mode = Mode.hold
    pointFace = null; ratedFrom = ''; faceShown = ''
    switcher.close()
    strip.reset()
    linkBadge.down()
    keyboard.setField(false)
    if (!next?.welcome) { syncMotion(); startPage(); return }
    onHost(next.welcome)
    onHost({ t: 'state', values: next.values })
    if (next.scene) onHost(next.scene)
    if (started) showSurface()
    else startControls()
    tick()
    toast(`Controlling ${next.row.name}`)
  }

  const permission = motionSupported() ? await requestMotionPermission() : 'denied'
  permissionReady = true
  motionPrompt = permission === 'prompt'
  startControls()

  function startControls() {
    if (!permissionReady || !link.active || started) return
    if (motionPrompt) showGate()
    else begin()
  }

  function showGate() {
    if (document.getElementById('gate')) return
    insertMarkup(app, 'beforeend', html`
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
    return !!link.active && !handCamera && !bodyCamera && document.visibilityState === 'visible' && !resting && (!tierSettled || gyroOn || mode === Mode.point || mode === Mode.track || mode === Mode.gamepad || tab === 'drums' || tab === 'keys' || !!layout.toss)
  }
  /** Start or stop the sensors to match what's needed; true if they just started. */
  function syncMotion(): boolean {
    const want = motionWanted()
    if (want === motionOn) return false
    motionOn = want
    if (want) motion.start()
    else motion.stop()
    control.defer()
    return want
  }
  function busy() { return !!handCamera || !!bodyCamera || gyroOn || mode === Mode.point || mode === Mode.track || mode === Mode.gamepad || (pad?.touches ?? 0) > 0 || buttonHold }
  function rest(on: boolean) {
    if (on === resting) return
    resting = on
    document.body.classList.toggle('resting', on)
    if (on) { const w = wake; wake = null; void w?.release().catch(() => {}) } else { lastTouch = performance.now(); void keepAwake() }
    syncMotion()
  }

  function begin() {
    if (started) return
    started = true
    syncMotion()
    // A host that bounces things (the home page's marbles) asks for tosses: the phone flicked upward, screen level.
    const tosses = new TossDetector()
    motion.onSample = (dt) => {
      if (permissionReady && motion.q) { const up = motion.up(); linkBadge.tilt(up[0], up[1]) }
      if (anchorOnSample) { anchorOnSample = false; anchor(); control.recenter() }
      if (recenterOnSample) { recenterOnSample = false; recenterPointer() }
      drums.sample()
      keys.sample()
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
    if (s !== 'connected') linkBadge.down()
    if (s === 'connected') {
      banner(null)
      if (started) showSurface()
      return
    }
    // Whatever had the focus on the screen, or held this phone up there, it says so again once it's back.
    values.textField = false
    keys.reset()
    musicWire.use(false)
    musicActive = false
    keyboard.setField(false)
    hostNotice = ''
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
    if (s === 'code-wrong') {
      surface = null
      return screenMessage({
        title: 'That code didn’t match', art: ICONS.close, body: 'Each code works once. Type the new one your screen shows now.',
        action: { label: 'Type it', run: () => location.replace(location.pathname) },
      })
    }
    if (s === 'invite-used') {
      // The screen showed a new code once a phone paired with this one (ob.Pal Link does): only that phone gets back in
      // with it. A code typed just as it moved on meets the same.
      surface = null
      try { sessionStorage.removeItem('obpal.pair') } catch { /* private mode */ }
      return code?.v === 'code'
        ? screenMessage({ title: 'That code was just used', art: ICONS.close, body: 'Type the new one your screen shows now.', action: { label: 'Type it', run: () => location.replace(location.pathname) } })
        : screenMessage({ title: 'This code was used', art: ICONS.phone, body: 'Once a phone pairs, the screen shows a new code. Scan the one it shows now.' })
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
    else screenMessage({ title: s === 'waiting-host' ? 'Waiting for the screen' : 'Connecting', body: s === 'waiting-host' ? 'Keep the page with the code open.' : 'Securing the connection…', spinner: true })
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
      gamepad.setHost({ name: hostName, profile: layout.profile, utilities: layout.utilities, modePacks: layout.modePacks, rig: layout.rig })
      keyboard.offered(layout.tray.some((c) => c.type === 'keyboard'))
    } else if (m.t === 'state') {
      if ('music.sync' in m.values) musicWire.reply(m.values['music.sync'])
      if (typeof m.values['control.sim'] === 'string' && CONTROL_SPACES[m.values['control.sim']]) {
        if (control.sim !== m.values['control.sim']) control.recenter()
        control.sim = m.values['control.sim']
        gamepad.setControlReach(CONTROL_SPACES[control.sim].reach)
      }
      if (m.values['control.scope'] === 'object' || m.values['control.scope'] === 'scene') {
        if (control.scope !== m.values['control.scope']) { drums.release(); keys.reset() }
        control.scope = m.values['control.scope']
      }
      if ('control.position' in m.values && values['control.position'] !== m.values['control.position']) recenterHere(false)
      Object.assign(values, m.values)
      // A text or password field has the focus on the screen (textField 'text' or 'secret'): the Type prompt.
      if ('textField' in m.values) keyboard.setField(m.values.textField)
      // What holds this phone's input up on the screen's side, if anything: shown until it clears.
      if ('notice' in m.values) {
        hostNotice = typeof m.values.notice === 'string' ? m.values.notice.slice(0, 120) : ''
        banner(linkLine)
      }
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
    if (surface && m.t === 'state' && Object.keys(m.values).every(k => k.startsWith('action.'))) {
      for (const action of ['record', 'grip'] as const) {
        const button = document.querySelector<HTMLButtonElement>(`#tray [data-id="${action}"]`)
        if (button && control.sim) statefulIconAction(button, action, values[`action.${action}`] === true)
      }
    } else if (surface && m.t !== 'pong' && m.t !== 'feedback') { renderTray(); setMode() }
    if (surface && m.t === 'welcome') pump(16.7)
    if (m.t === 'welcome' || m.t === 'layout') buttons.changed()
  }

  // ---- gyro toggle and modes -------------------------------------------------

  /** Anchor 1:1 matching and the tilt level at the phone's current pose. */
  function anchor() {
    grab = (grab + 1) & 0xff
    if (motion.q) tilt.capture(motion.up())
    if (motion.q) orientation.capture(motion.q, screenAngle())
    else orientation.reset()
    qf.reset()
  }

  /** The centre button: set the tilt level here, or recentre (Point: aim here = the middle of the screen). */
  function recenterHere(notify = true) {
    smoother.reset()
    anchor()
    control.recenter()
    drums.release(); keys.recenter(); gamepad.setPosition()
    imuHeld = false; imu.release()
    if (tracker.active) tracker.recenter()
    if (motion.q) wii.recenter(motion.q)
    wiiLast = [wii.acc[0], wii.acc[1]]
    if (control.sim) link.sendCtl({ t: 'value', id: 'control.aim', v: JSON.stringify({ aim: [0, 0], tilt: [0, 0], active: false }) })
    link.sendCtl({ t: 'recenter' })
    controlSent = 0
    if (notify) toast('Position set')
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
      control.recenter()
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
    if (next === mode && sentController === controllerNow()) return render()
    if (musicActive) { keys.reset(); musicWire.event('stop') }
    // Whatever a physical button held on the old controller lets go first.
    buttons.releaseAll()
    buttonHold = false
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
    sentController = controllerNow()
    link.sendCtl({ t: 'mode', m: mode, c: controllerNow(), ...(mode === Mode.gamepad ? { p: gamepad.profileInUse } : {}) })
  }

  /** Aim here = the centre of the screen: resets the phone's pointing reference and the host's cursor. */
  function recenterPointer() {
    control.recenter()
    if (motion.q) wii.recenter(motion.q)
    wiiLast = [wii.acc[0], wii.acc[1]]
    link.sendCtl({ t: 'recenter' })
  }

  // ---- surface -----------------------------------------------------------

  function showSurface() {
    if (surface && document.body.contains(surface)) return
    setMarkup(app, html`
      <div class="surface${settings.left ? ' left' : ''}" id="surface">
        <header class="bar">
          <span class="host-ic">${logoMark()}</span>
          <button class="host-name connection-title" aria-label="Connections"><span class="host-t"></span>${ICONS.chevron}</button>
          <span id="link-badge"></span>
          <button class="bar-btn lock-btn" id="lock" aria-label="Lock screen rotation" aria-pressed="false">${ICONS['rotation-free']}</button>
          <button class="bar-btn" id="gear" aria-label="Settings">${ICONS.settings}</button>
        </header>
        <div class="banner glass" id="banner" hidden></div>
        ${switcher.html()}
        <div class="pad glass" id="pad" aria-label="Trackpad">
          <div class="pad-part glass" id="pad-part" hidden><span class="pp-dot"></span><span class="pp-name"></span><span class="pp-tag"></span><button class="pp-x" aria-label="Release part">${ICONS.close}</button></div>
          <div class="gestures" id="gestures" aria-hidden="true"></div>
          <div class="pad-wheel" id="pad-wheel" role="button" aria-label="Scroll wheel · turn it to scroll" hidden></div>
          <div class="level" id="level" aria-hidden="true"><div class="level-ring"></div><div class="level-dot" id="level-dot"></div></div>
          <div class="hold-spot" id="hold-spot" aria-hidden="true" hidden><i>${ICONS.hand}</i></div>
          <button class="track-start glass" id="track-start" hidden>${ICONS.cube}<b>Start 3D</b><small></small></button>
          <button class="glow-end" id="glow-end" hidden aria-label="Stop glowing">${ICONS.close}</button>
          <button class="glow-stop" id="glow-stop" hidden>Stop</button>
          ${strip.html()}
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
          <button class="gyro glass" id="gyro" aria-pressed="false"><span class="gyro-ic">${ICONS.gyro}</span><span class="gyro-label">Motion</span><span class="gyro-sw" aria-hidden="true"><i></i></span></button>
          <span id="styles-slot"></span>
          <button class="icon-btn square glass" id="center" aria-label="Recenter">${ICONS.center}<span class="center-t">Set position</span></button>
        </div>
      </div>
      ${keyboard.html()}
      <div class="toast glass" id="toast" role="status" aria-live="polite"></div>
      <div class="rest" id="rest" aria-hidden="true"><span>Resting to keep your phone cool · touch to wake</span></div>`)
    surface = document.getElementById('surface')!
    switcher.mount(surface)
    strip.mount(surface)
    linkBadge.mount(document.getElementById('link-badge')!)
    document.querySelector<HTMLButtonElement>('.connection-title')!.onclick = () => openConnections()
    document.body.classList.add('live')
    calmMarks(surface)
    gamepad.mount(surface)
    drums.mount(surface)
    keys.mount(surface)
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
    pad.onTouchChange = (touching) => {
      document.getElementById('pad')!.classList.toggle('active', touching)
      // Releasing controls before a camera dialog must not put a late fullscreen layer over it.
      if (touching) { goFullscreen(); pump(16.7) }
    }
    document.getElementById('gyro')!.addEventListener('click', () => { tick(); setGyro(!gyroOn) })
    document.getElementById('center')!.addEventListener('click', () => { tick(); recenterHere() })
    // The button sits on the trackpad, which captures every pointer: keep this one for the button.
    document.getElementById('track-start')!.addEventListener('pointerdown', (e) => e.stopPropagation())
    document.getElementById('glow-end')!.addEventListener('pointerdown', (e) => e.stopPropagation())
    document.getElementById('glow-end')!.addEventListener('click', () => { tick(); glowing = false; render() })
    // The host's Stop button stays within reach while the screen glows.
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
    // What motion steers by, Tilt or 1:1: the kit's segmented control, in the dock beside the motion switch.
    styleSeg = new Segmented({
      label: 'Motion steers by', value: settings.style, className: 'styles',
      items: [{ value: 'game', label: 'Tilt', icon: ICONS.tilt }, { value: 'match', label: '1:1', icon: ICONS.match }],
      onChange: (v) => { tick(); settings.style = v as Style; store.set('obpal.style', settings.style); setMode() },
    })
    styleSeg.el.id = 'styles'
    // Pages, tests and hints name the two by their style (game, match).
    styleSeg.el.querySelectorAll<HTMLElement>('[data-value]').forEach((b) => { b.dataset.style = b.dataset.value })
    document.getElementById('styles-slot')!.replaceWith(styleSeg.el)
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
    pump(16.7)
    hint('models', () => document.querySelector('.tray-btn.select'), 'Browse the catalogue', { place: 'top', delay: 9000 })
    hint('more', () => document.getElementById('ctl-more'), 'Every controller, rated for this screen', { place: 'bottom', delay: 12000 })
  }

  function render() {
    if (!surface) return
    // Only what this screen takes (./ratings.ts): a controller it stops taking gives way to the best one it does take.
    const sorted = rated()
    const was = controllerNow()
    const next = fallback(sorted, was)
    if (next && next !== was) {
      const c = choiceFor(next)!
      if (c.point) pointFace = c.point
      if (c.wheel !== undefined && c.wheel !== gamepad.wheelInUse) gamepad.setWheel(c.wheel, false)
      if (c.face !== tab) { if (tab !== 'gamepad') lastTab = tab; tab = c.face }
      // Said when the screen changed what it takes under a controller it had been told about, not on first joining.
      if (sentController === was) toast(`${CONTROLLERS[was].name} isn’t on ${screenName()} now`)
      queueMicrotask(setMode)
    }
    switcher.render(sorted, controllerNow(), screenName(), keyboard.open, !!layout.utilities?.includes('camera.hand'), !!handCamera, !!layout.utilities?.includes('camera.body'), !!bodyCamera)
    const isMusic = tab === 'drums' || tab === 'keys'
    if (isMusic !== musicActive) { musicActive = isMusic; musicWire.use(isMusic) }
    surface.classList.toggle('music-on', isMusic)
    drums.sync(tab === 'drums', String(values.part ?? ''))
    keys.sync(tab === 'keys', String(values.part ?? ''))
    surface.dataset.mode = String(mode)
    surface.classList.toggle('no-motion', tier === Tier.touch)
    surface.classList.toggle('gyro-on', gyroOn)
    surface.querySelector('.host-t')!.textContent = screenName()
    if (styleSeg) {
      styleSeg.el.hidden = tab !== 'rotate' || !(styleAvailable('game') && styleAvailable('match'))
      styleSeg.value = settings.style
    }
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
    center.hidden = pointing || !((mode === Mode.tilt || mode === Mode.hold) && gyroOn || mode === Mode.track)
    requestAnimationFrame(repositionHints)
    center.setAttribute('aria-label', mode === Mode.tilt ? 'Set level here' : 'Set position here')
    document.getElementById('level')!.hidden = !(mode === Mode.tilt && gyroOn)

    const gyro = document.getElementById('gyro')!
    const noMotion = tier === Tier.touch
    gyro.setAttribute('aria-pressed', String(gyroOn))
    gyro.setAttribute('aria-disabled', String(noMotion))
    gyro.title = noMotion ? 'Motion is off on this phone' : ''
    gyro.classList.toggle('on', gyroOn)
    // The 3D hand from the phone's own sensors: a spot to hold while the phone moves.
    document.getElementById('hold-spot')!.hidden = !(mode === Mode.track && trackWay() === 'motion' && !glowing)
    // The face in use came up: it rises in (the controller bar's switch is one tap and one movement).
    const face = mode === Mode.gamepad ? 'gp' : isMusic ? tab : pointing ? (mouseOn() ? 'mouse' : 'wii') : `pad:${tab}`
    if (face !== faceShown) {
      const first = !faceShown
      faceShown = face
      const el = mode === Mode.gamepad ? null : isMusic ? surface.querySelector<HTMLElement>(`.${tab}-face`) : document.getElementById(pointing ? (mouseOn() ? 'mouse' : 'wii') : 'pad')
      if (el && !first) { el.classList.remove('face-in'); void el.offsetWidth; el.classList.add('face-in') }
    }

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

    // The node strip: which part of what you hold the pad drives (a part, a set, or all of it), on the trackpad.
    const mine = scene ? Object.entries(scene.held).find(([, who]) => who === scene!.you)?.[0] : undefined
    strip.sync(mine ? scene!.nodes.find((n) => n.id === mine) ?? null : null, values, tab === 'rotate' && !pointing && !glowing)
    const moves = strip.legend()

    // Visual gesture legend instead of instructions.
    const g = (name: string, word: string) => html`<span>${icon(name)}<b>${word}</b></span>`
    setMarkup(document.getElementById('gestures')!, moves.length
      ? moves.map((m) => g(m.gesture, m.name))
      : live
      ? [g('drag', 'value'), g('tilt', 'sweep'), g('tap', '2? reset')]
      : part
      ? [g('drag', 'move'), g('pinch', 'scale'), g('twist', 'turn'), g('tap', '2? reset')]
      : mode === Mode.point
      ? [gyroOn ? g('point', 'aim') : g('drag', 'move'), g('tap', 'focus'), g('pan', 'pan'), g('pinch', 'zoom')]
      : mode === Mode.track
      ? [g('tap', 'hold'), g('phone', 'move'), g('hand', 'follows')]
      : [g('drag', 'orbit'), g('pan', 'pan'), g('pinch', 'zoom'), g('twist', 'roll')])
    gamepad.sync({ active: mode === Mode.gamepad })
    // The gamepad's way back, drawn as where it goes: the controller it came from, else the best other one this screen
    // takes (a screen that opened on the gamepad); a screen with nothing else has no way back.
    let back: ControllerId | null = controllerOn(lastTab, { point: mouseOn() ? 'mouse' : 'wii', wheel: false })
    if (!sorted.some((r) => r.id === back && r.fit > 0)) {
      const other = barSlots(sorted, controllerNow()).find((s) => s.face !== 'gamepad')
      if (other) lastTab = other.face as Exclude<Tab, 'gamepad'>
      back = other?.id ?? null
    }
    gamepad.setBack(back && ICONS[CONTROLLER_ICON[back]], back && CONTROLLERS[back].name)
    gamepad.setControlScope(control.scope, String(values['control.target'] ?? ''))
    placeTyping()
    // The controller may have changed: Back's arming follows its bindings, and the badges go on what's shown.
    buttons.syncBack()
    buttons.paint()
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
      ? html`<img src="${img}" alt="" loading="lazy" decoding="async">`
      : html`<span style="color:${/^#[0-9a-f]{3,8}$/i.test(o.color ?? '') ? o.color : 'var(--accent)'}">${o.glyph ?? o.label.slice(0, 1)}</span>`
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

  function toggleControlScope() {
    const next = control.scope === 'object' ? 'scene' : 'object'
    drums.release(); keys.reset(); control.scope = next
    link.sendCtl({ t: 'value', id: 'control.scope', v: next }); renderTray(); render()
  }

  function renderTray() {
    const tray = document.getElementById('tray')
    if (!tray) return
    if (tray !== inkTray) { releaseTrayInk?.(); inkTray = tray; releaseTrayInk = fitControlInk(tray) }
    tray.replaceChildren()
    if (control.sim) {
      /** A tool of the calibrated sim space: an icon and a word, with its full name for the ear. */
      const tool = (id: string, label: string, glyph: string, word: string) => {
        const b = document.createElement('button')
        b.type = 'button'; b.className = 'tray-btn glass'; b.dataset.id = id
        b.setAttribute('aria-label', label); b.title = label
        setMarkup(b, html`${icon(glyph)}<span class="tray-label"></span>`)
        b.querySelector('.tray-label')!.textContent = word
        return b
      }
      const position = tool('control.position', 'Set position', 'position', 'Position')
      iconAction(position, 'position', 'Set position')
      position.onclick = () => { void requestMotionPermission(); tick(); recenterHere() }
      // Object or scene scope: one toggle, lit for the scene, drawn as what it reaches.
      const wide = control.scope === 'scene'
      const scope = tool('control.scope', 'Scene scope', wide ? 'scene' : 'cube', wide ? 'Scene' : 'Object')
      scope.setAttribute('aria-pressed', String(wide))
      scope.onclick = toggleControlScope
      tray.append(position, scope)
      if (wide && !['studio', 'airhockey', 'football', 'pinball', 'slotcars', 'arena'].includes(control.sim)) {
        const take = tool('control.take', `Take ${values['control.target'] || 'aimed object'}`, 'take', 'Take')
        take.onclick = () => link.sendCtl({ t: 'btn', id: 'control.take', ev: 'tap' })
        tray.append(take)
      }
    }
    // In a shared scene, what you hold (or the scene list, to claim something) comes first.
    if (scene && scene.nodes.length) {
      const c = sceneControl()
      const mine = Object.entries(scene.held).find(([, who]) => who === scene!.you)?.[0]
      const node = scene.nodes.find((n) => n.id === mine)
      const b = document.createElement('button')
      b.className = 'tray-btn select glass scene-btn'
      b.setAttribute('aria-label', node ? `Holding ${node.name}. Open the scene list` : 'Open the scene list')
      b.setAttribute('aria-haspopup', 'dialog')
      setMarkup(b, html`<span class="sel-thumb"><span class="seat-dot"></span></span><span class="sel-v"></span>${ICONS.chevron}`)
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
      b.dataset.id = c.id
      b.setAttribute('aria-label', c.label)
      if (c.type === 'select') {
        const cur = c.options?.find((o) => o.value === values[c.id])
        setMarkup(b, html`<span class="sel-thumb">${cur ? thumb(cur) : icon(c.icon)}</span><span class="sel-v"></span>${ICONS.chevron}`)
        b.querySelector('.sel-v')!.textContent = cur?.label ?? c.label
        b.setAttribute('aria-haspopup', 'dialog')
      } else if (c.tone === 'stop') {
        setMarkup(b, html`<span class="tray-label"></span>`)
        b.querySelector('.tray-label')!.textContent = c.label
      } else {
        // A keyboard control without an icon of its own gets the keyboard.
        const ic = icon(c.icon ?? (c.type === 'keyboard' ? 'keyboard' : undefined))
        setMarkup(b, html`${ic}<span class="tray-label"></span>`)
        b.querySelector('.tray-label')!.textContent = c.label
        if (!ic) b.classList.add('text')
        else b.title = c.label
        if (control.sim && SIM_ACTION_ICONS[c.label]) iconAction(b, SIM_ACTION_ICONS[c.label], c.label)
        if (control.sim && (c.id === 'record' || c.id === 'grip')) statefulIconAction(b, c.id, values[`action.${c.id}`] === true)
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
    tray.hidden = !control.sim && layout.tray.length === 0 && !(scene && scene.nodes.length)
    tray.onscroll = trayEdge
    requestAnimationFrame(trayEdge)
  }

  /** The tray fades out at its far edge while there's more of it to scroll to (sideways, or down in landscape). */
  function trayEdge() {
    const t = document.getElementById('tray')
    if (!t) return
    const more = document.documentElement.classList.contains('land') ? t.scrollHeight - t.clientHeight - t.scrollTop > 2 : t.scrollWidth - t.clientWidth - t.scrollLeft > 2
    t.classList.toggle('more', more)
  }
  addEventListener('resize', () => requestAnimationFrame(trayEdge))

  /**
   * Bottom sheet for 'select' tray controls: thumbnails grouped by collection. `onPick` replaces sending the value
   * (the scene list claims nodes), and `current` marks the chosen option when it isn't a host value.
   */
  function openPicker(c: TrayControl, onPick?: (value: string) => void, current?: string) {
    const wrap = document.createElement('div')
    wrap.className = 'sheet-wrap'
    setMarkup(wrap, html`<div class="sheet picker glass" role="dialog"><div class="grip" aria-hidden="true"></div><div class="picker-head"><h2></h2><button class="icon-btn glass" id="pick-close" aria-label="Close">${ICONS.close}</button></div><div class="picker-list"></div></div>`)
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
      setMarkup(cell, html`<span class="pick-art">${thumb(o)}</span><span class="pick-name"></span>`)
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
        setMarkup(add, ICONS.plus)
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

  /**
   * The line over the controls: the link's own trouble (reconnecting, waiting for the screen), else what the screen says
   * holds this phone's input up on its side (the host value `notice`: ob.Pal Link waiting for an answer on the PC).
   */
  function banner(text: string | null) {
    linkLine = text
    const b = document.getElementById('banner')
    if (!b) return
    const line = text ?? (hostNotice || null)
    b.hidden = !line
    b.textContent = line ?? ''
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined
  function toast(text: string) {
    const t = document.getElementById('toast')
    if (!t) return
    // The screen repeats its notice as a toast for phones from before notices: here the banner says it already.
    if (text === hostNotice) return
    t.textContent = text
    t.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600)
  }

  function openSettings() {
    const sheet = document.createElement('div')
    sheet.className = 'sheet-wrap'
    setMarkup(sheet, html`
      <div class="sheet settings glass" role="dialog" aria-label="Settings">
        <div class="sheet-head"><div class="grip" aria-hidden="true"></div><button class="icon-btn glass sheet-x" id="set-close" aria-label="Close">${ICONS.close}</button></div>
        <button class="set-row set-cam glass" id="scan-open">${ICONS.camera}<span>Scan a code<small>Connect another screen</small></span>${ICONS.right}</button>
        ${layout.utilities?.includes('camera.hand') ? html`<button class="set-row glass" id="hand-settings">${ICONS.hand}<span>Hand camera<small>Control with your other hand</small></span>${ICONS.right}</button>` : ''}
        ${layout.utilities?.includes('camera.body') ? html`<button class="set-row glass" id="body-settings">${ICONS.camera}<span>Body camera<small>Prop the phone facing you</small></span>${ICONS.right}</button>` : ''}
        <p class="sheet-k"><b>01</b>Feel</p>
        <label class="bb-field"><span>Sensitivity</span><output id="gv"></output><input class="bb-range" type="range" id="gain" min="0.5" max="3" step="0.1"></label>
        <label class="bb-field"><span>Steadiness</span><output id="sv"></output><input class="bb-range" type="range" id="smooth" min="0" max="1" step="0.05"></label>
        <p class="meta">These adjust tilt and aiming. 1:1 turn follows your phone exactly.</p>
        <label class="row sw-row"><span>Feedback on phone and gamepad</span><input type="checkbox" class="kit-switch" role="switch" id="feedback"></label>
        <p class="sheet-k"><b>02</b>Surface</p>
        <div class="theme-row" role="radiogroup" aria-label="Surface">${THEMES.map((t) => html`<button class="theme-opt" role="radio" data-theme="${t.id}" aria-checked="${document.documentElement.dataset.theme === t.id}">${swatch(t)}<span>${t.name}</span></button>`)}</div>
        <p class="sheet-k"><b>03</b>Colour${seatColor ? html`<small> · yours in this scene</small>` : ''}</p>
        <div class="accent-row" role="radiogroup" aria-label="Colour">${family.ACCENTS.map((a) => html`<button class="bb-accent${a.id === 'product' ? ' product' : ''}" role="radio" data-accent="${a.id}" aria-checked="${family.getAccent() === a.id}" aria-label="${a.id === 'product' ? 'ob.Pal lime (default)' : a.name}" style="--sw:${a.color ?? '#c6ff34'}">${family.icons.check}</button>`)}</div>
        <p class="sheet-k"><b>04</b>Holding it</p>
        <label class="row sw-row"><span>Left-handed</span><input type="checkbox" class="kit-switch" role="switch" id="left"></label>
        <label class="row sw-row"><span>Lock rotation while motion steers</span><input type="checkbox" class="kit-switch" role="switch" id="lockgyro"></label>
        <div class="row track3d" role="radiogroup" aria-label="3D position comes from"><span>3D position comes from</span>${(['motion', 'xr', 'glow'] as const).map((w) => html`<button class="way-opt" role="radio" data-way="${w}" aria-checked="${shownWay() === w}" aria-disabled="${w === 'xr' && !trackOk}" title="${{ motion: 'Estimated from the phone’s own motion', xr: 'Its camera, through space (Android)', glow: 'A glow for the screen’s camera' }[w]}">${ICONS[{ motion: 'gyro', xr: 'camera', glow: 'glow' }[w]]}<span>${{ motion: 'Motion', xr: 'Camera', glow: 'Glow' }[w]}</span></button>`)}${trackOk ? '' : html`<small class="way-why">${CAMERA_3D_NEEDS}</small>`}</div>
        <p class="sheet-k"><b>05</b>More</p>
        <button class="set-row glass" id="buttons-open">${BUTTONS_GLYPH}<span>Buttons<small>Headset, remote, clicker, pad</small></span><span class="set-srcs">${sourceStack(inputs)}</span>${ICONS.right}</button>
        <button class="set-row glass" id="connections-open">${ICONS.phone}<span>Connections<small>Switch, rename or forget a screen</small></span>${ICONS.right}</button>
        <button class="set-row glass" id="connection-details">${ICONS.lock}<span>Connection details<small>Compare the seal and see what this shares</small></span>${ICONS.right}</button>
        <a class="support-link" href="/sponsor/" target="_blank" rel="noopener">${ICONS.heart}<span>Support ob.Pal</span></a>
        <div class="actions"><button class="btn" id="disc">Disconnect</button><button class="btn primary" id="done">Done</button></div>
      </div>`)
    document.body.appendChild(sheet)
    // The camera, Connections and Buttons open in the same tap, over Settings as it slides away: the camera starts
    // inside the tap (browsers that tie a camera to a gesture keep it), and each takes over Settings' Back step.
    sheet.querySelector<HTMLButtonElement>('#connections-open')!.onclick = () => { close(true); openConnections() }
    sheet.querySelector<HTMLButtonElement>('#connection-details')!.onclick = () => { close(true); linkBadge.el.click() }
    sheet.querySelector<HTMLButtonElement>('#scan-open')!.onclick = () => { close(true); openConnections(true) }
    const handSettings = sheet.querySelector<HTMLButtonElement>('#hand-settings')
    if (handSettings) handSettings.onclick = () => { close(true); openHands() }
    const bodySettings = sheet.querySelector<HTMLButtonElement>('#body-settings')
    if (bodySettings) bodySettings.onclick = () => { close(true); openBody() }
    const gain = sheet.querySelector<HTMLInputElement>('#gain')!
    const smooth = sheet.querySelector<HTMLInputElement>('#smooth')!
    const left = sheet.querySelector<HTMLInputElement>('#left')!
    const feedback = sheet.querySelector<HTMLInputElement>('#feedback')!
    feedback.checked = feedbackEnabled()
    feedback.onchange = () => setFeedbackEnabled(feedback.checked)
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
        // The camera way only where the phone can follow itself with its camera: elsewhere it says so, and stays off.
        if (b.dataset.way === 'xr' && !trackOk) { tick(true); toast(CAMERA_3D_NEEDS); return }
        settings.track3d = b.dataset.way as 'motion' | 'xr' | 'glow'
        store.set('obpal.track3d', settings.track3d)
        sheet.querySelectorAll('.track3d [data-way]').forEach((x) => x.setAttribute('aria-checked', String(x === b)))
        if (tracker.active) void tracker.stop()
        glowing = false
        render()
      }
    })
    // Buttons: its sheet opens as Settings closes.
    sheet.querySelector<HTMLButtonElement>('#buttons-open')!.onclick = () => { tick(); close(true); buttons.open() }
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
    let exits: (handOver?: boolean) => void = () => {}
    /** `handOver`: another layer opens in this tap and takes Settings' Back step (./sheet.ts). */
    const close = (handOver = false) => { exits(handOver); sheet.classList.add('out'); setTimeout(() => sheet.remove(), 200) }
    sheet.querySelector<HTMLButtonElement>('#done')!.onclick = () => close()
    sheet.querySelector<HTMLButtonElement>('#set-close')!.onclick = () => close()
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
        body: hostName ? html`You left <b>${hostName}</b>. Reconnect, or scan another code.` : 'Reconnect, or scan another code.',
        action: { label: 'Reconnect', run: () => location.reload() },
      })
    }
  }

  // ---- state pump ----------------------------------------------------------

  function pump(dt: number) {
    if (!surface || !link.ready) return
    if (handCamera || bodyCamera) {
      const now = performance.now()
      if (now - lastSend < 66) return
      const neutral = emptyState()
      neutral.seq = st.seq = (st.seq + 1) & 0xffff
      neutral.t = Math.round((now - t0) * 1000) >>> 0
      neutral.flags = handHold ? Flag.touching : 0
      neutral.touches = handHold ? 1 : 0
      if (link.sendState(encodeState(neutral))) lastSend = now
      return
    }
    if (control.sim && performance.now() - controlSent >= 33) {
      const state = control.sample(dt / 1000)
      const active = state.active && !document.hidden && (gyroOn || mode === Mode.point || mode === Mode.track && trackWay() === 'motion' || drums.aiming || keys.aiming || mode === Mode.gamepad && gamepad.spatialActive)
      if (active || controlActive) link.sendCtl({ t: 'value', id: 'control.aim', v: JSON.stringify({
        aim: state.aim.map(n => Math.round(n * 10000) / 10000), tilt: state.tilt.map(n => Math.round(n * 10000) / 10000), active, pointer: mode === Mode.gamepad && gamepad.spatialPointer,
      }) })
      controlActive = active; controlSent = performance.now()
    }
    // Older screens need a STATE to establish the mode after joining or resuming. Retry until the channel takes it,
    // even if the gamepad's usual hand-off window elapsed while the page or data channel was starting.
    if (mode === Mode.gamepad && gamepad.pump(dt) && stateSent) return
    const now = performance.now()
    const touches = pad?.touches ?? 0
    const pointing = mode === Mode.point && !!motion.q // Wii-style pointing is always live
    if (stateSent && !gyroOn && !pointing && touches === 0 && now - lastSend < 66) return // 15 Hz when idle
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
    if (gyroOn && mode === Mode.hold && q) {
      st.qRel = qf.filter(orientation.relative(q, screenAngle()), s)
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
      if (dot) dot.style.transform = `translate(${Math.max(-1, Math.min(1, a / tilt.sat)) * 46}px, ${Math.max(-1, Math.min(1, b / tilt.sat)) * 46}px)`
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
      const held = touches > 0 || buttonHold
      if (held) {
        if (!imuHeld) imuScreen = screenAngle()
        // Keep the pose's device axes fixed for this grab when an unlocked viewport changes orientation.
        const qp = qMul(qMul(EARTH_TO_POSE, q), qAxisAngle(0, 0, 1, (screenAngle() - imuScreen) * Math.PI / 180))
        if (!imuHeld) imu.anchor(qp)
        const p = imu.step(qp, motion.accel ? toPoseFrame(q, motion.accel) : null, motion.hasGyro ? toPoseFrame(q, motion.gyro) : null, s)
        poseSeq = (poseSeq + 1) & 0xffff
        link.sendState(encodePose({ flags: PoseFlag.tracked | PoseFlag.touching, seq: poseSeq, t: st.t, p, q: qp, gen: imu.gen, source: 'model' }, poseBuf))
      } else if (imuHeld) imu.release()
      imuHeld = held
    }
    if (link.sendState(encodeState(st, buf))) { lastSend = now; stateSent = true }
  }
}

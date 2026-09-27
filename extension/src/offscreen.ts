/**
 * Offscreen document (reason WEB_RTC). An MV3 service worker cannot hold an RTCPeerConnection, so the ob.Pal
 * Remote lives here: the pairing QR payload, signaling, and the WebRTC link to the phone. It keeps a persistent
 * DTLS certificate and remembers paired phones, so when the room service is unreachable it publishes a direct
 * LAN code instead (see the popup), and a remembered phone connects with no server at all.
 * About 60 times a second, and immediately when a packet arrives, it samples the phone (remote.pad and
 * remote.consume()) and streams compact input frames to the page bridges of the controlled tab over runtime
 * ports: the controller to every frame, keys to the focused frame, 3D drags to the frame with the largest canvas.
 * For the PC target the frames (and the phone's typing, in order with them) go to the service worker instead, and
 * only for a phone the person at the PC allowed (shared/access.ts): the service worker says which, and until it has,
 * nothing goes. The invite moves on each time a phone pairs through it (rotateInvite), so a photo of the popup's QR
 * code pairs nothing later.
 */
import { Mode, PointerFlag, pointerDelta, Remote, type Frame, type Layout, type PointerState, type ProfileId } from '@obpal/host'
import type { PadState } from '@obpal/core'
import { isPcAccess, noticeFor, phoneKeyOf, type PcAccess, type Phone } from './shared/access'
import { APP_NAME, DEFAULT_MODE, PORT_NAME, SERVICE, isTargetMode } from './shared/constants'
import { KeyMapper, pcKeys } from './shared/keys'
import type { PadInput } from './shared/math'
import { parseConfig, parseFromPage, parseOffscreenRequest, type BgRequest, type LinkConfig, type LinkFacts, type LinkState, type PadTuple, type ToPage } from './shared/messages'
import {
  buildNativeFrame, HeldState, heldSignature, isIdleFrame, NATIVE_HEARTBEAT_MS, NATIVE_PORT_NAME, parseNativeText, typingToast, type TextField,
} from './shared/native'
import { isModifier, PcGestures } from './shared/pcgestures'
import {
  buildFrame, deltaTuple, electFrame, frameSignature, isActive, padTuple, pointerTuple, recipients, tiltTuple, withoutClickButtons, withRelativeAim,
  type FrameInfo,
} from './shared/route'
import { suggestForFrames } from './shared/sites'

interface Link extends FrameInfo {
  port: chrome.runtime.Port
  tabId: number
  /** The frame's host name, for the site's suggested profile. */
  host: string
  lock: boolean
  lastSent: number
  wasActive: boolean
  sig: string
}

const TICK_MS = 1000 / 60
/** A clock tick this soon after a packet-driven one is skipped: packets set the pace while input flows. */
const TICK_MIN_GAP_MS = 6
const HEARTBEAT_MS = 250
const RUMBLE_GAP_MS = 50

/**
 * The PC option's line in the target picker: the whole PC while the config says so. That flag counts only while the
 * PC is the target, so from another target the line has to hold whichever way the whole PC is set.
 */
const PC_WHOLE = 'Your whole PC: mouse, keyboard and typing'
const PC_OTHERWISE = 'Mouse and keyboard for programs you allow, or your whole PC'

/** The tray picker for what the phone drives. */
const targetPicker = (wholePc: boolean): Layout['tray'][number] => ({
  id: 'target', label: 'Target', type: 'select', icon: 'settings',
  options: [
    { value: 'gamepad', label: 'Controller', glyph: '✚', detail: 'Gamepad API games' },
    { value: 'viewer', label: '3D', glyph: '◆', detail: 'Rotate, pan and zoom 3D views' },
    { value: 'keys', label: 'Keys', glyph: '⌨', detail: 'Keyboard and mouse games' },
    { value: 'pc', label: 'PC', glyph: '▭', detail: wholePc ? PC_WHOLE : PC_OTHERWISE },
  ],
})
/** The phone's own keyboard, for the PC: typing arrives as text, its key row (Esc, Tab, arrows, ⌫, ↵) as key-<code> taps. */
const KEYBOARD: Layout['tray'][number] = { id: 'keyboard', label: 'Keyboard', type: 'keyboard', icon: 'keyboard' }

/**
 * What the phone offers: gamepad, tilt and point modes, the target picker, and the site's suggested catalogue profile
 * (CATALOGUE §3) when the table has one. The PC target gets the mouse face in Point (Left, Right and a wheel instead
 * of A and B), a scroll wheel on the trackpad, and the keyboard.
 */
const layoutFor = (profile: ProfileId | null): Layout => {
  const pcTarget = config.mode === 'pc'
  const picker = targetPicker(config.desktop)
  return {
    v: 1,
    modes: [Mode.gamepad, Mode.tilt, Mode.point],
    tray: pcTarget ? [picker, KEYBOARD] : [picker],
    ...(profile ? { profile } : {}),
    ...(pcTarget ? { point: 'mouse' as const, wheel: true } : {}),
  }
}

let remote: Remote | null = null
let config: LinkConfig = { tabId: null, mode: DEFAULT_MODE, desktop: false }
let configured = false
const links = new Set<Link>()
let lastTargets = new Set<Link>()
let suggested: ProfileId | null = null
/** A text or password field on the PC would take typing (the service worker says so, from ob.Pal Desktop). */
let textField: TextField | null = null
let fieldShown: TextField | false | null = null

/** The phone connected now (null: none), and where it stands on this PC (null: not known yet, so nothing goes). */
let phone: Phone | null = null
let access: PcAccess | null = null
let noticeShown: string | false | null = null

/** The PC takes this phone's input: the PC is the target, and the person at the PC allowed the phone. */
const onPc = () => config.mode === 'pc' && access === 'allow'

/** The phone's `textField` value: the field while the PC takes its input, else false. Sent when it changes, and to every phone that connects. */
function publishField(always = false) {
  const v = onPc() && textField ? textField : false
  if (v === fieldShown && !always) return
  fieldShown = v
  remote?.setValues({ textField: v })
}

/**
 * The phone's `notice` (PROTOCOL §3), a line it shows until it clears: while the PC is the target and hasn't let the
 * phone in, whether it waits for an answer there or was refused. Phones from before `notice` get it as a toast.
 */
function publishNotice(always = false) {
  const v = phone ? noticeFor(config.mode, access) : false
  if (v === noticeShown && !always) return
  noticeShown = v
  remote?.setValues({ notice: v })
  if (v) remote?.feedback({ toast: v })
}

/**
 * Who is connected now (the device in control), told to the service worker, which answers where it stands on this
 * PC. A new phone gets nothing through to the PC meanwhile: what the last one held is let go. `always`: tell the worker
 * again (a worker that has just started over).
 */
async function reportPhone(always = false) {
  const lead = remote?.participants.find((p) => p.lead)
  const key = lead ? phoneKeyOf(lead) : null
  const next: Phone | null = lead && key ? { key, name: lead.name } : null
  if (next?.key === phone?.key && next?.name === phone?.name && !always) return
  if (next?.key !== phone?.key) setAccess(null)
  phone = next
  const answered = accessSeq
  const r = await toBg({ to: 'bg', type: 'phone', phone: next })
  // Another phone since, or an answer pushed meanwhile (newer than this reply): this reply says nothing new.
  if (phone !== next || accessSeq !== answered) return
  const a = typeof r === 'object' && r !== null ? (r as { access?: unknown }).access : null
  setAccess(isPcAccess(a) ? a : null)
}
/** Counts the answers the service worker pushes (an 'access' request): a reply from before one is stale. */
let accessSeq = 0

/** Where the phone connected now stands on this PC: it gets through only once allowed, and hears how it went. */
function setAccess(next: PcAccess | null) {
  const was = access
  access = next
  if (next !== 'allow') pcLetGo()
  publishNotice()
  publishField()
  if (config.mode === 'pc' && was === 'ask' && next === 'allow') remote?.feedback({ toast: 'Allowed on this PC' })
  // Refused while it waited: said once, where no notice says it (the phone went back to the target it had).
  if (was === 'ask' && next === 'deny' && !noticeFor(config.mode, next)) remote?.feedback({ toast: 'Not allowed on this PC' })
}

/**
 * The connected phone's link, as its own statistics say (Remote.links()), for the popup's badge: read when the popup
 * asks (it does every few seconds while it's open), so nothing runs for it while nobody looks. Null: no phone, or not
 * encrypted yet.
 */
async function linkFacts(): Promise<LinkFacts | null> {
  const r = remote
  const lead = r?.participants.find((p) => p.lead)
  const l = r && lead ? (await r.links().catch(() => [])).find((x) => x.id === lead.id) : undefined
  if (!l?.link.secure) return null
  return {
    verified: l.verified, path: l.link.path, ...(l.link.relayProtocol ? { relay: l.link.relayProtocol } : {}),
    ...(l.link.rttMs !== undefined ? { rttMs: l.link.rttMs } : {}), ...(l.link.dtls ? { dtls: l.link.dtls } : {}), ...(l.link.cipher ? { cipher: l.link.cipher } : {}),
  }
}

// Input for the PC from a phone it hasn't let in: the phone says why, at most every TYPING_TOAST_MS.
let heldBackAt = -Infinity
function heldBack() {
  const now = performance.now()
  const notice = noticeFor(config.mode, access)
  if (!notice || now - heldBackAt < TYPING_TOAST_MS) return
  heldBackAt = now
  remote?.feedback({ toast: notice })
}

// Typing that didn't get through: the phone says why, at most every TYPING_TOAST_MS.
const TYPING_TOAST_MS = 2500
let typingToastAt = -Infinity
function typingRefused(toast: string) {
  const now = performance.now()
  if (now - typingToastAt < TYPING_TOAST_MS) return
  typingToastAt = now
  remote?.feedback({ toast })
}

const hostOf = (url: string | undefined) => { try { return url ? new URL(url).hostname : '' } catch { return '' } }

/** The controlled tab's frames changed: suggest the profile the site table has for them, if it differs. */
function syncSuggestion() {
  const next = suggestForFrames([...links].filter((l) => l.tabId === config.tabId).map((l) => ({ frameId: l.frameId, host: l.host })))
  if (next === suggested) return
  suggested = next
  remote?.setLayout(layoutFor(next))
}

const toBg = (m: BgRequest): Promise<unknown> => chrome.runtime.sendMessage(m).catch(() => undefined)

chrome.runtime.onMessage.addListener((raw: unknown, sender: chrome.runtime.MessageSender, respond: (r: unknown) => void) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return
  const req = parseOffscreenRequest(raw)
  if (!req) return
  switch (req.type) {
    // Answered once applied: the worker arms ob.Pal Desktop only after this has the mapping for it (NativeBridge).
    case 'config': applyConfig(req); respond(true); break
    case 'unpair': remote?.disconnect(); break
    case 'forget': void remote?.forget(req.id); break
    case 'lan': remote?.selectLan(req.id); break
    case 'diag': respond(remote?.diag() ?? null); return true
    case 'facts': void linkFacts().then(respond, () => respond(null)); return true
    case 'text-field': textField = req.field; publishField(); break
    case 'typing': if (onPc()) typingRefused(typingToast(req.refused)); break
    // The person at the PC answered for the phone connected now.
    case 'access': if (req.key === phone?.key) { accessSeq++; setAccess(req.access) } break
  }
})

// Page bridges connect here directly, so 60 Hz input never has to wake the service worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return
  const tabId = port.sender?.tab?.id
  if (tabId === undefined || port.sender?.id !== chrome.runtime.id || (configured && tabId !== config.tabId)) {
    port.disconnect()
    return
  }
  const link: Link = {
    port, tabId, frameId: port.sender?.frameId ?? 0, host: hostOf(port.sender?.url), lock: false,
    focus: false, focusAt: 0, area: 0, lastSent: 0, wasActive: false, sig: '',
  }
  links.add(link)
  port.onMessage.addListener((raw: unknown) => onPageMessage(link, raw))
  port.onDisconnect.addListener(() => forget(link))
  syncSuggestion()
})

function applyConfig({ tabId, mode, desktop }: LinkConfig) {
  const modeChanged = mode !== config.mode
  const wholeChanged = desktop !== config.desktop
  config = { tabId, mode, desktop }
  configured = true
  // The whole PC gets a desktop controller (no letters typed into whatever has focus); a program, the game keys.
  const keys = pcKeys(desktop)
  if (pc.mapper.cfg !== keys) { pc.held.apply(pc.mapper.releaseAll()); pc.mapper.cfg = keys }
  for (const l of [...links]) {
    if (l.tabId === tabId) continue
    forget(l)
    try { l.port.disconnect() } catch { /* gone */ }
  }
  if (modeChanged) {
    for (const l of links) l.sig = ''
    if (mode !== 'pc') pcLetGo()
    remote?.setValues({ target: mode })
    // Into or out of the PC: Point's face changes with it, the keyboard comes or goes, and so does a focused field,
    // and what the phone waits for there.
    remote?.setLayout(layoutFor(suggested))
    publishField()
    publishNotice()
  } else if (wholeChanged) {
    // Whole PC on or off: the target picker's PC line says which.
    remote?.setLayout(layoutFor(suggested))
  }
  syncSuggestion()
}

// ---- PC target: phone state -> keyboard/mouse actions -> the service worker -> ob.Pal Desktop ------------
// The Keys mapping (shared/keys.ts) decides what is held and how the pointer moves; the PC gestures
// (shared/pcgestures.ts) add clicks, drags, scrolling and zoom from the trackpad and the Point face. The frame
// carries that whole desired state plus this tick's motion, so the helper (which enforces the scope) can never
// be left with a stuck key or button.

const pc = {
  mapper: new KeyMapper(),
  held: new HeldState(),
  gestures: new PcGestures(),
  port: null as chrome.runtime.Port | null,
  lastTick: 0,
  lastSent: 0,
  /** What the last frame sent held: a change goes out at once, so a release never waits for the heartbeat. */
  lastSig: '',
  retryAt: 0,
  retryMs: 250,
}
const CTRL = ['ControlLeft']
/** A hold that became a right-click buzzes the phone this briefly. */
const BUZZ = { strong: 0.5, weak: 0.3, ms: 45 }

function pcPort(): chrome.runtime.Port | null {
  if (pc.port) return pc.port
  const now = performance.now()
  if (now < pc.retryAt) return null
  let port: chrome.runtime.Port
  try {
    port = chrome.runtime.connect({ name: NATIVE_PORT_NAME }) // wakes the service worker if it idled out
  } catch {
    pc.retryAt = now + pc.retryMs
    pc.retryMs = Math.min(pc.retryMs * 2, 5000)
    return null
  }
  pc.port = port
  pc.retryMs = 250
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    if (pc.port === port) pc.port = null
    pc.retryAt = performance.now() + pc.retryMs
    pc.retryMs = Math.min(pc.retryMs * 2, 5000)
  })
  return port
}

const tupleToPad = (p: PadTuple | null): PadInput | null => (p ? { buttons: p[0], axes: [p[1], p[2], p[3], p[4]], triggers: [p[5], p[6]] } : null)

function pcTick(f: Frame, pad: PadState | null, ptr: PointerState | null, now: number) {
  const dt = pc.lastTick ? Math.min(50, now - pc.lastTick) : TICK_MS
  pc.lastTick = now
  // Aim routed to the mouse (a relative pointer, CATALOGUE §2) lands on the right stick here, as it does on a page
  // without pointer lock: the Keys mapping then turns the stick into relative mouse motion.
  const relative = !!ptr && (ptr.flags & PointerFlag.relative) !== 0
  const padIn: PadInput | null = relative && pad ? tupleToPad(withRelativeAim(padTuple(pad), relativeRate(ptr, now))) : pad
  const tilt = f.connected && !pad && f.mode === Mode.tilt ? f.tilt : null
  const out = pc.mapper.update({ pad: padIn, tilt, aim: f.aim, pad1: f.pad1, dtMs: dt })
  pc.held.apply(out)
  const mods = [...pc.held.keys].some(isModifier)
  const g = pc.gestures.tick({ now, connected: f.connected, touching: f.touching, move: out.move, pan: f.pad2, pinch: f.zoom, mods })
  if (g.buzz) remote?.rumble(BUZZ.strong, BUZZ.weak, BUZZ.ms)
  const frame = buildNativeFrame(pc.held, g.move, [g.wheel[0] + out.wheel[0], g.wheel[1] + out.wheel[1]], { buttons: g.buttons, keys: [...(g.ctrl ? CTRL : []), ...g.keys] })
  const sig = heldSignature(frame)
  const repeat = isIdleFrame(frame) && sig === pc.lastSig && now - pc.lastSent < NATIVE_HEARTBEAT_MS
  if (repeat && !g.text.length) return
  const port = pcPort()
  if (!port) return
  try {
    if (!repeat) {
      port.postMessage(frame)
      pc.lastSent = now
      pc.lastSig = sig
    }
    // Typing right after a frame that holds no modifier and no key from the row (PcGestures waits for one).
    for (const t of g.text) port.postMessage(t)
  } catch {
    pc.port = null
  }
}

/** Leaving the PC target: nothing stays held, and the worker closes the helper port (which releases too). */
function pcLetGo() {
  pc.mapper.releaseAll()
  pc.held.clear()
  pc.gestures.reset()
  pc.lastTick = 0
  pc.lastSig = ''
  const port = pc.port
  pc.port = null
  if (!port) return
  try { port.postMessage(buildNativeFrame(pc.held, [0, 0])) } catch { /* gone */ }
  try { port.disconnect() } catch { /* gone */ }
}

function forget(l: Link) {
  links.delete(l)
  lastTargets.delete(l)
  syncSuggestion()
}

function onPageMessage(link: Link, raw: unknown) {
  const m = parseFromPage(raw)
  if (!m || link.tabId !== config.tabId) return
  if (m.t === 'rep') {
    if (m.focus && !link.focus) link.focusAt = performance.now()
    link.focus = m.focus
    link.area = m.area
    link.lock = m.lock === true
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

let lastTick = 0

// A relative pointer (Aim routed to the mouse) as a turn rate: the change between packets over the device's own clock.
let lastPtr: PointerState | null = null
let relRate: [number, number] = [0, 0]
let relAt = 0
function relativeRate(ptr: PointerState | null, now: number): [number, number] {
  if (!ptr || !(ptr.flags & PointerFlag.relative)) { lastPtr = ptr; relRate = [0, 0]; return relRate }
  if (ptr !== lastPtr) {
    if (lastPtr && lastPtr.flags & PointerFlag.relative) {
      const [dy, dp] = pointerDelta(ptr, lastPtr)
      const dtMs = Math.min(100, Math.max(8, ((ptr.t - lastPtr.t) >>> 0) / 1000))
      relRate = [(dy * 1000) / dtMs, (dp * 1000) / dtMs]
    }
    lastPtr = ptr
    relAt = now
  } else if (now - relAt > 150) relRate = [0, 0]
  return relRate
}

function tick() {
  const r = remote
  if (!r) return
  const now = performance.now()
  lastTick = now
  const f = r.consume(now) // consume every tick so deltas never pile up
  const pad = r.pad
  const ptr = r.pointer
  // The PC only for a phone it let in; one it hasn't hears why, when it tries.
  if (onPc()) pcTick(f, pad, ptr, now)
  else if (config.mode === 'pc' && (f.touching || !!pad?.buttons)) heldBack()
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
  if (config.mode === 'pc') return // no page frames: the PC target goes through the helper

  // The pointer (CATALOGUE §4): one frame draws the cursor (a pointer-locked frame, else the one with the game's
  // canvas). While the Wii cursor is up, A and B click at it, so they leave the pad. A relative pointer with no
  // pointer lock becomes the right stick here; other targets take pointer changes as aim deltas.
  const gamepad = config.mode === 'gamepad'
  const relative = !!ptr && (ptr.flags & PointerFlag.relative) !== 0
  const ptFrame = ptr ? electFrame([...links], 'pointer') : null
  const rate = relativeRate(ptr, now)
  let p = padTuple(pad)
  if (gamepad && relative && !ptFrame?.lock) p = withRelativeAim(p, rate)
  if (gamepad && ptr && !relative) p = withoutClickButtons(p)
  const pt = ptr && (!gamepad || !relative || ptFrame?.lock) ? pointerTuple(ptr, pad?.buttons ?? 0) : null
  const tl = tiltTuple(f.connected && !pad && f.mode === Mode.tilt ? f.tilt : null)
  const d = deltaTuple(f)
  const active = isActive(p, d, tl, pt)
  const mode = config.mode
  const sig = frameSignature(mode, p, tl)
  for (const l of targets) {
    // Stream while there is input; otherwise send changes at once and a heartbeat every HEARTBEAT_MS.
    if (!active && l.sig === sig && now - l.lastSent < HEARTBEAT_MS) continue
    const dt = l.wasActive ? Math.min(50, now - l.lastSent) : TICK_MS
    post(l, buildFrame(mode, dt, p, d, tl, gamepad && l !== ptFrame ? null : pt))
    l.lastSent = now
    l.wasActive = active
    l.sig = sig
  }
}

/** Clock ticks keep heartbeats and rate inputs going; a packet from the phone is sampled the moment it lands. */
function clockTick() {
  if (performance.now() - lastTick < TICK_MIN_GAP_MS) return
  tick()
}

function startClock() {
  const fallback = () => setInterval(clockTick, TICK_MS)
  try {
    const worker = new Worker(new URL('./ticker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = clockTick
    worker.onerror = () => {
      worker.terminate()
      fallback()
    }
  } catch {
    fallback()
  }
}

async function boot() {
  const r = await Remote.create({ appName: APP_NAME, service: SERVICE, layout: layoutFor(suggested), remember: true, rotateInvite: true })
  remote = r
  const state = (): LinkState => ({ status: r.status, url: r.pairingUrl, device: r.deviceName, lan: r.lanUrl, lanFor: r.lanFor, pairs: r.remembered })
  const report = () => void toBg({ to: 'bg', type: 'link', link: state() })
  r.on('status', report)
  r.on('lan', report)
  // The invite moved on (a phone paired through it): the popup shows the new QR code.
  r.on('invite', report)
  r.on('connect', () => {
    // First who it is: a phone that takes over from an allowed one gets nothing of the PC's until it's allowed too.
    void reportPhone()
    report()
    r.setValues({ target: config.mode })
    publishField(true)
    publishNotice(true)
  })
  r.on('disconnect', () => {
    pc.gestures.reset()
    report()
  })
  // Who is in control changes with each phone that connects (one takes over from the one before) or leaves.
  r.on('join', () => void reportPhone())
  r.on('leave', () => void reportPhone())
  // Taps, holds and the Point face's buttons: clicks and more on the PC, at once rather than on the next clock tick.
  // The keyboard's key row too: allowlisted key taps.
  r.on('button', ({ id, ev }) => {
    if (config.mode !== 'pc') return
    if (!onPc()) return heldBack()
    pc.gestures.button(id, ev, performance.now())
    tick()
  })
  // Typing on the phone's keyboard, for the PC: in order with the key taps, on the same port as the frames.
  r.on('text', ({ s, del }) => {
    if (config.mode !== 'pc') return
    if (!onPc()) return heldBack()
    const t = parseNativeText({ t: 'text', s, del })
    if (!t) return typingRefused(typingToast('bad-text'))
    pc.gestures.text(t.s, t.del)
    tick()
  })
  r.on('input', tick)
  // The phone's tray picker switches the target mode; the service worker stores it and pushes it back as config. It
  // turns the PC down for a phone this PC said no to: the phone's picker goes back to the target there is.
  r.on('value', ({ id, v }) => {
    if (id === 'target' && isTargetMode(v)) {
      void toBg({ to: 'bg', type: 'mode', mode: v }).then((res) => {
        if ((res as { refused?: unknown } | undefined)?.refused !== 'deny') return
        r.setValues({ target: config.mode })
        r.feedback({ toast: 'Not allowed on this PC' })
      })
    }
    // The mouse face's wheel, turned by a finger.
    else if (id === 'mouse-wheel' && typeof v === 'number' && config.mode === 'pc') {
      if (!onPc()) return heldBack()
      pc.gestures.wheel(v)
      tick()
    }
  })
  report()
  // The whole config, whole PC included: a link document started again while the whole PC is controlled keeps the
  // desktop controller rather than the game keys. Then who is connected, if anyone yet (the worker starts this
  // document with nobody).
  const cfg = parseConfig(await toBg({ to: 'bg', type: 'offscreen-ready' }))
  if (cfg && !configured) applyConfig(cfg)
  void reportPhone(true)
  startClock()
}

boot().catch((e: unknown) => {
  console.error('[ob.Pal Link] could not start the phone link', e)
  void toBg({ to: 'bg', type: 'link', link: { status: 'offline', url: '', device: null, lan: '', lanFor: null, pairs: [] } })
})

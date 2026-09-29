/** The same local camera surface for pairing and hand tracking. The caller owns what a recognised hand does. */
import '../styles/camera.css'
import { Scanner, type CodeCorner } from '../controller/scanner'
import { readScan, scanDestination } from '../controller/scan-code'
import { dismissHint, hint } from './hints'
import { ICONS } from './icons'
import { setMarkup } from './markup'
import { coverPoint } from './camera-space'
import { constrainedDownload, handAssetsCached } from '../controller/hand-assets'
import type { Vec3 } from '@obpal/core'

type CameraOptions = {
  mode: 'scan' | 'hand'
  found?: (text: string) => void
  typed: () => void
  close?: (reason: 'close' | 'type' | 'found') => void
  ready?: (video: HTMLVideoElement, overlay: HTMLCanvasElement) => void
  hold?: (active: boolean) => void
  stop?: () => void
  measurements?: boolean
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = text
  return el
}

let current: CameraView | null = null
let pairActionsMounted = false

export class CameraView {
  private readonly dialog = element('dialog', 'obpal-camera')
  private readonly video = element('video', 'camera-video')
  private readonly overlay = element('canvas', 'camera-overlay')
  private readonly status = element('p', 'camera-status')
  private readonly metrics = element('output', 'camera-metrics')
  private readonly guide = element('div', 'camera-guide')
  private readonly island = element('div', 'camera-island')
  private readonly chips = element('div', 'camera-chips')
  private rejectedTimer: ReturnType<typeof setTimeout> | undefined
  private hintOrbit = 0
  private hintPinched = false
  private hintPalm: Vec3 | null = null
  private readonly scanner: Scanner
  private readonly exit: HTMLButtonElement
  private returnFocus: HTMLElement | null = null
  private opened = false
  private locked = false
  private lockTimer: ReturnType<typeof setTimeout> | undefined
  private holdButton: HTMLButtonElement | null = null
  private held = false
  private pointer: number | null = null
  private preparation = 0
  private readonly onHidden = () => { if (document.hidden) this.close() }
  private readonly onExit = () => this.close()
  private readonly onBlur = () => this.hold(false)

  constructor(private options: CameraOptions) {
    const hand = options.mode === 'hand'
    this.dialog.dataset.mode = options.mode
    this.dialog.dataset.state = 'opening'
    this.dialog.setAttribute('aria-label', hand ? 'Hand camera' : 'Scan an ob.Pal code')
    this.dialog.setAttribute('aria-modal', 'true')
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close() })
    this.video.setAttribute('aria-label', 'Camera preview')
    this.video.setAttribute('playsinline', '')
    this.overlay.setAttribute('aria-hidden', 'true')
    const shade = element('div', 'camera-shade')
    shade.setAttribute('aria-hidden', 'true')
    const head = element('header', 'camera-head')
    const brand = element('div', 'camera-brand')
    const logo = element('span', 'camera-logo')
    const mark = element('img')
    mark.src = '/favicon.svg'
    mark.alt = ''
    const word = element('span', '', 'ob.Pal')
    logo.append(mark)
    brand.append(logo, word)
    this.exit = this.control('Close camera', 'close', () => this.close())
    this.exit.dataset.cameraClose = ''
    const headTools = element('div', 'camera-head-tools')
    const flip = this.control('Flip camera', 'rotate', () => { this.hold(false); void this.scanner.flip() })
    flip.dataset.cameraFlip = ''; flip.hidden = true
    headTools.append(flip, this.exit)
    head.append(brand, headTools)
    this.guide.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 4; i++) this.guide.append(element('i'))
    const found = element('span', 'camera-lock')
    setMarkup(found, ICONS.check)
    this.guide.append(found)
    this.guide.hidden = hand
    const foot = element('footer', 'camera-foot')
    const privacy = element('span', 'camera-privacy')
    const lock = element('span', 'camera-privacy-lock')
    lock.setAttribute('role', 'img'); lock.setAttribute('aria-label', 'Camera stays on this phone')
    setMarkup(lock, ICONS.lock)
    privacy.append(lock)
    try {
      if (!sessionStorage.getItem('obpal.camera.privacy')) {
        privacy.append(element('small', '', 'On this phone only'))
        sessionStorage.setItem('obpal.camera.privacy', '1')
      }
    } catch { /* a lock still says where the camera stays */ }
    const words = element('div', 'camera-words')
    words.append(privacy, this.status)
    this.island.append(words)
    this.status.dataset.cameraStatus = ''
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.metrics.dataset.cameraMetrics = ''
    this.metrics.hidden = true
    const tools = element('div', 'camera-tools')
    const torch = this.control('Toggle torch', 'sun', () => {})
    torch.dataset.cameraTorch = ''
    const zoom = this.control('Change camera zoom', '', () => {})
    zoom.textContent = '1×'
    zoom.dataset.cameraZoom = ''
    const typed = element('button', 'camera-type glass', hand ? 'Use phone motion' : 'Enter a code')
    typed.type = 'button'
    typed.dataset.cameraType = ''
    typed.dataset.tip = hand ? 'Close the camera and use the phone sensors' : 'Type the ten digits shown on your screen'
    typed.onclick = () => { this.close('type'); options.typed() }
    headTools.prepend(torch, zoom)
    if (hand) {
      tools.append(typed)
      const labels = options.hold ? [['hand', 'Tool'], ['pinch', 'Gripper']] : [['hand', 'Hover'], ['grip', 'Orbit'], ['pinch', 'Grab']]
      for (const [icon, label] of labels) {
        const chip = element('span', 'camera-chip')
        chip.dataset.gesture = icon; chip.dataset.tip = label
        chip.setAttribute('role', 'img'); chip.setAttribute('aria-label', label)
        setMarkup(chip, ICONS[icon]); this.chips.append(chip)
      }
      this.chips.dataset.lost = 'true'
      this.island.append(this.chips)
    } else this.island.append(typed)
    const deadman = element('div', 'camera-deadman')
    this.dialog.dataset.arm = String(!!options.hold)
    if (hand && options.stop) {
      const stop = element('button', 'camera-stop', 'Stop')
      stop.type = 'button'
      stop.dataset.cameraStop = ''
      stop.dataset.tip = 'Stop the robot arm'
      stop.onclick = () => { this.pointer = null; this.hold(false); options.stop?.() }
      deadman.append(stop)
    }
    if (hand && options.hold) {
      const hold = element('button', 'camera-hold', 'Hold to move')
      this.holdButton = hold
      hold.type = 'button'
      hold.dataset.cameraHold = ''
      hold.dataset.tip = 'Keep held to move an approved robot arm'
      hold.setAttribute('aria-pressed', 'false')
      hold.onpointerdown = (e) => {
        if (this.pointer !== null || e.button !== 0) return
        e.preventDefault()
        this.pointer = e.pointerId
        hold.setPointerCapture(e.pointerId)
        this.hold(true)
      }
      const release = (e: PointerEvent) => { if (this.pointer === e.pointerId) { this.pointer = null; this.hold(false) } }
      hold.onpointerup = release
      hold.onpointercancel = release
      hold.onlostpointercapture = release
      hold.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.hold(true) } }
      hold.onkeyup = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.hold(false) } }
      hold.onblur = () => this.hold(false)
      deadman.prepend(hold)
    }
    foot.append(deadman, tools, this.island)
    this.dialog.append(this.video, this.overlay, shade, head, this.guide, foot, this.metrics)
    this.scanner = new Scanner(this.video, torch, (text) => this.say(text), (text, corners) => this.found(text, corners), {
      scan: !hand, zoom,
      facing: (mirrored, canFlip) => { this.dialog.dataset.mirrored = String(mirrored); flip.hidden = !canFlip },
      state: (state) => {
        if (!this.locked) this.dialog.dataset.state = state === 'ready' ? (hand ? 'tracking' : 'scanning') : state
      },
      ready: (video) => {
        if (!this.opened) return
        const reveal = () => { if (this.opened) this.video.classList.add('has-frame') }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(reveal)
        else reveal()
        options.ready?.(video, this.overlay)
        if (!hand) hint('camera.scan', () => this.opened ? this.guide : null,
          'Fit the screen’s code inside the corners. Or type its ten digits.',
          { place: 'bottom', delay: 350, mount: this.dialog })
      },
    })
  }

  /** Mount and request the camera in the same tap; no navigation or import comes before permission. */
  open() {
    if (this.opened) return
    current?.close()
    current = this
    this.returnFocus = document.activeElement as HTMLElement | null
    this.opened = true
    this.locked = false
    this.overlay.width = this.overlay.height = 0
    document.body.append(this.dialog)
    this.dialog.showModal()
    document.addEventListener('visibilitychange', this.onHidden)
    addEventListener('pagehide', this.onExit)
    addEventListener('popstate', this.onExit)
    addEventListener('blur', this.onBlur)
    void this.scanner.start()
    this.exit.focus({ preventScroll: true })
  }

  close(reason: 'close' | 'type' | 'found' = 'close') {
    if (!this.opened) return
    this.opened = false
    this.preparation++
    if (current === this) current = null
    clearTimeout(this.lockTimer)
    clearTimeout(this.rejectedTimer)
    this.pointer = null
    this.hold(false)
    this.scanner.stop()
    this.overlay.width = this.overlay.height = 0
    dismissHint(`camera.${this.options.mode}`)
    document.removeEventListener('visibilitychange', this.onHidden)
    removeEventListener('pagehide', this.onExit)
    removeEventListener('popstate', this.onExit)
    removeEventListener('blur', this.onBlur)
    this.dialog.close()
    this.dialog.remove()
    this.options.close?.(reason)
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true })
  }

  say(text: string) { if (this.status.textContent !== text) this.status.textContent = text }
  unavailable(text: string) { this.dialog.dataset.state = 'unavailable'; this.hold(false); dismissHint('camera.hand'); this.say(text) }
  setMetrics(text: string) { this.metrics.textContent = text; this.metrics.hidden = !this.options.measurements || !text }

  loading(progress: number | null) {
    this.dialog.dataset.state = progress === null ? 'tracking' : 'loading'
    this.dialog.style.setProperty('--camera-progress', String(progress ?? 1))
    this.say(progress === null ? 'Show your hand' : '')
    if (progress === null) hint('camera.hand', () => this.opened ? this.island : null,
      this.options.hold ? 'Hold to move · pinch for the gripper' : 'Fist to turn · pinch to grab',
      { place: 'top', delay: 350, mount: this.dialog, gap: 4 })
  }

  /** Consent precedes model/WASM traffic unless a connection is known to be unmetered. */
  async prepareHands(start: () => void) {
    const preparation = ++this.preparation
    this.dialog.querySelector('[data-camera-download]')?.remove()
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection
    const ask = constrainedDownload(connection) && !await handAssetsCached()
    if (!this.opened || preparation !== this.preparation) return
    if (ask) {
      const confirm = element('button', 'camera-download glass', 'Download hand controls · 19.5 MB')
      confirm.type = 'button'; confirm.dataset.cameraDownload = ''
      confirm.append(element('small', '', 'Saved on this phone for next time'))
      this.island.before(confirm)
      this.say('Ready when you are')
      confirm.onclick = () => { confirm.remove(); if (this.opened) start() }
    } else start()
  }

  handState(gestures: number, handedness: string, palm: Vec3 | null) {
    const lost = palm === null
    this.chips.dataset.lost = String(lost)
    this.dialog.dataset.hand = lost ? 'lost' : gestures & 2 ? 'grip' : gestures & 1 ? 'pinch' : gestures & 4 ? 'point' : 'hand'
    if (!lost) this.dialog.dataset.handedness = handedness
    const active = lost || gestures & 4 ? '' : gestures & 2 && !this.options.hold ? 'grip' : gestures & 1 ? 'pinch' : 'hand'
    this.chips.querySelectorAll<HTMLElement>('[data-gesture]').forEach(el => el.dataset.active = String(el.dataset.gesture === active))
    if (palm && this.hintPalm && gestures & 2) this.hintOrbit += Math.hypot(palm[0] - this.hintPalm[0], palm[1] - this.hintPalm[1]) * 7
    this.hintPalm = palm && gestures & 2 ? [...palm] : null
    if (!lost && gestures & 1) this.hintPinched = true
    if (this.hintOrbit >= Math.PI / 18 && this.hintPinched) dismissHint('camera.hand')
  }

  private hold(active: boolean) {
    if (active === this.held) return
    this.held = active
    this.holdButton?.setAttribute('aria-pressed', String(active))
    this.options.hold?.(active)
  }

  private control(label: string, icon: string, run: () => void) {
    const button = element('button', 'camera-control glass')
    button.type = 'button'
    button.setAttribute('aria-label', label)
    button.dataset.tip = label
    if (icon) setMarkup(button, ICONS[icon])
    button.onclick = run
    return button
  }

  private found(text: string, corners?: CodeCorner[]) {
    if (!this.opened || this.locked || this.options.mode !== 'scan') return
    if (!readScan(text, location.origin)) {
      this.say('Not an ob.Pal code'); this.dialog.dataset.state = 'rejected'
      clearTimeout(this.rejectedTimer)
      this.rejectedTimer = setTimeout(() => { if (this.opened && !this.locked) this.dialog.dataset.state = 'scanning' }, 600)
      return
    }
    this.dialog.dataset.state = 'locked'
    if (corners?.length === 4) {
      const box = this.guide.getBoundingClientRect()
      const mirrored = this.video.dataset.mirrored === 'true'
      const ordered = mirrored ? [corners[1], corners[0], corners[3], corners[2]] : corners
      const mapped = ordered.map(p => coverPoint(p.x * this.video.videoWidth, p.y * this.video.videoHeight, this.video.videoWidth, this.video.videoHeight, this.dialog.clientWidth, this.dialog.clientHeight, mirrored))
      Object.assign(this.guide.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, transform: 'none' })
      void this.guide.offsetWidth
      const left = Math.min(...mapped.map(p => p.x)), top = Math.min(...mapped.map(p => p.y))
      Object.assign(this.guide.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(...mapped.map(p => p.x)) - left}px`, height: `${Math.max(...mapped.map(p => p.y)) - top}px` })
      this.guide.querySelectorAll<HTMLElement>('i').forEach((el, i) => {
        const p = mapped[i]
        el.style.left = `${p.x - left}px`; el.style.top = `${p.y - top}px`
        el.style.right = el.style.bottom = 'auto'
        el.style.translate = `${i === 1 || i === 2 ? '-100%' : '0'} ${i >= 2 ? '-100%' : '0'}`
      })
      this.guide.dataset.corners = JSON.stringify(mapped)
    }
    this.locked = true
    // Hold the recognised frame briefly while the camera and decoder are already being released.
    this.overlay.width = this.video.videoWidth
    this.overlay.height = this.video.videoHeight
    if (this.overlay.width && this.overlay.height) this.overlay.getContext('2d')?.drawImage(this.video, 0, 0)
    this.scanner.stop()
    dismissHint('camera.scan')
    this.dialog.dataset.state = 'locked'
    this.say('Code found. Connecting…')
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate?.(24)
    this.lockTimer = setTimeout(() => {
      if (!this.opened) return
      this.close('found')
      this.options.found?.(text)
    }, 360)
  }
}

/** Phones open their camera; larger touch screens can still serve as the screen being controlled. */
export function phoneCamera() {
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600
}

/** Site-owned invite buttons and the public pairing chip all scan from a phone, including the embed demo. */
export function mountPairCameraActions() {
  if (pairActionsMounted || !phoneCamera()) return
  pairActionsMounted = true
  const invite = document.getElementById('chip-invite')
  if (invite) {
    invite.setAttribute('aria-label', 'Scan a code')
    invite.title = 'Scan a code'
    invite.dataset.tip = 'Scan a code'
  }
  document.addEventListener('click', (event) => {
    const path = event.composedPath()
    const invite = path.some((el) => el instanceof Element && el.id === 'chip-invite')
    const pill = path.some((el) => el instanceof Element && el.matches('button.pill')) &&
      path.some((el) => el instanceof Element && el.classList.contains('obpal-chip'))
    if (!invite && !pill) return
    event.preventDefault()
    event.stopImmediatePropagation()
    openPairCamera()
  }, true)
}

/** Site pairing always lands on our controller, reconstructed from validated data. */
export function openPairCamera() {
  const camera = new CameraView({ mode: 'scan', typed: () => { location.href = '/p/?type=1' }, found: (text) => {
    const destination = scanDestination(text, location.origin)
    if (destination) location.href = destination
  } })
  camera.open()
}

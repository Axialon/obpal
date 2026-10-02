/**
 * Real Chromium camera capture, QR pairing and the local hand pipeline against this checkout's worker.
 * All fixtures, screenshots and measurements go to a fresh temporary folder, printed at the end.
 * Requires explicit OBPAL_E2E_PORT and OBPAL_E2E_WORKER_PORT; never uses production or loads Link.
 * Synthetic hand results still cross real camera timing, filtering, HAND encoding and WebRTC.
 */
import { tempScope } from './lib/temp.mjs'
import { open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { encode } from 'uqr'
import { cspCheck } from './csp-watch.mjs'
import { setSurface } from './lib/frost.mjs'
import { startWorker } from './local-worker.mjs'
import { cameraDesign } from './e2e-camera-design.mjs'
import { cameraBody } from './e2e-body.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'

const temps = tempScope()
try {

const headed = process.argv.includes('--headed')
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const args = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
const mobile = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const need = (value, message) => { if (!value) throw new Error(message) }
async function until(name, read, timeout = 12000) {
  const end = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await sleep(100)
  } while (Date.now() < end)
  throw new Error(`Timed out: ${name}`)
}

function port(name) {
  const value = Number(process.env[name])
  if (!Number.isInteger(value) || value < 1024 || value > 65535 || [3000, 3001, 3002, 3003, 5173, 5174, 5175, 8080].includes(value)) throw new Error(`Set ${name} to this task's permitted port`)
  return value
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Port ${port} is in use`)) })
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error) })
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error(`Could not check port ${port}`)) })
  })
}

/** A portrait QR frame keeps its quiet zone inside the phone's cover crop. Chromium loops the Y4M at its declared cadence. */
async function videoFixture(file, text) {
  const qr = encode(text, { ecc: 'M', border: 4 }), width = 640, height = 960
  const unit = Math.floor(420 / qr.size), left = Math.floor((width - qr.size * unit) / 2), top = Math.floor((height - qr.size * unit) / 2)
  need(unit >= 3, 'The QR fixture is too dense for the capture size')
  const y = Buffer.alloc(width * height, 235)
  for (let row = 0; row < qr.size; row++) for (let col = 0; col < qr.size; col++) if (qr.data[row][col]) {
    for (let dy = 0; dy < unit; dy++) y.fill(16, (top + row * unit + dy) * width + left + col * unit, (top + row * unit + dy) * width + left + (col + 1) * unit)
  }
  const uv = Buffer.alloc(width * height / 2, 128)
  await writeFile(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F60:1 Ip A1:1 C420jpeg\nFRAME\n`), y, uv]))
  return { width, height, fps: 60, modules: qr.size, pixelsPerModule: unit }
}

/** RGB to limited-range BT.601 YUV420, with chroma averaged across each block of four pixels. */
function yuv420(rgb, width, height) {
  const plane = width * height, out = Buffer.allocUnsafe(plane * 3 / 2)
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    let red = 0, green = 0, blue = 0
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const pixel = (y + dy) * width + x + dx, at = pixel * 3
      const r = rgb[at], g = rgb[at + 1], b = rgb[at + 2]
      out[pixel] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16
      red += r; green += g; blue += b
    }
    const chroma = y / 2 * width / 2 + x / 2
    out[plane + chroma] = ((-38 * red / 4 - 74 * green / 4 + 112 * blue / 4 + 128) >> 8) + 128
    out[plane * 5 / 4 + chroma] = ((112 * red / 4 - 94 * green / 4 - 18 * blue / 4 + 128) >> 8) + 128
  }
  return out
}

/** A gently moving original hand image, letterboxed to capture size. Every frame still goes through the real model. */
async function handVideoFixture(file) {
  const input = await readFile(fileURLToPath(new URL('../tests/fixtures/camera-hand.png', import.meta.url)))
  const width = 640, height = 480, frames = 120, fps = 60, background = { r: 195, g: 199, b: 200 }
  const output = await open(file, 'w')
  try {
    await output.write(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`)
    for (let i = 0; i < frames; i++) {
      const phase = i * Math.PI * 2 / frames
      const w = Math.round(276 * (1 + .025 * Math.sin(phase))) * 2, h = Math.round(w * 3 / 8) * 2
      const resized = await sharp(input).resize(w, h, { fit: 'contain', background }).flatten({ background }).removeAlpha().toColourspace('srgb').raw().toBuffer()
      const left = Math.round((width - w) / 2 + 26 * Math.sin(phase)), top = Math.round((height - h) / 2 + 8 * Math.cos(phase))
      const rgb = await sharp({ create: { width, height, channels: 3, background } }).composite([{ input: resized, raw: { width: w, height: h, channels: 3 }, left, top }]).removeAlpha().raw().toBuffer()
      await output.write(Buffer.concat([Buffer.from('FRAME\n'), yuv420(rgb, width, height)]))
    }
  } finally { await output.close() }
  return { source: 'tests/fixtures/camera-hand.png', width, height, frames, fps, seconds: frames / fps, motion: '±26 px horizontal, ±8 px vertical, ±2.5% scale; looping', origin: 'Original AI-generated anonymous hand fixture, not a real person' }
}

/** Observe actual streams and workers without replacing capture or decoding. Counts survive QR navigation. */
function probeCamera() {
  Object.defineProperty(navigator, 'connection', { configurable: true, value: { type: 'wifi', saveData: false } })
  const key = 'obpal.e2e.camera'
  const read = () => { try { return JSON.parse(sessionStorage.getItem(key) || '{}') } catch { return {} } }
  const add = (name, value = 1) => { const data = read(); data[name] = (data[name] || 0) + value; sessionStorage.setItem(key, JSON.stringify(data)) }
  window.__cameraTracks = []
  window.__cameraProbe = read
  Object.defineProperty(globalThis, 'BarcodeDetector', { configurable: true, value: undefined })
  Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { add('shareCalls') } })
  const get = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices)
  if (get) navigator.mediaDevices.getUserMedia = async constraints => {
    add('requests'); if (navigator.userActivation.isActive) add('requestsInTap')
    const stream = await get(constraints)
    for (const track of stream.getTracks()) {
      window.__cameraTracks.push(track); add('tracks')
      const stop = track.stop.bind(track)
      track.stop = () => { stop(); add('stops'); if (track.readyState === 'ended') add('ended') }
    }
    return stream
  }
  const NativeWorker = Worker
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options)
      if (/qr-worker/.test(String(url))) {
        add('qrWorkers')
        this.addEventListener('message', event => { if (typeof event.data?.text === 'string' && event.data.text) add('decoded') })
      }
    }
  }
}

function handResult({ x = .5, y = .55, scale = 2.2, pinch = false, grip = false, point = false, side = 'Right', turn = 0 } = {}) {
  const world = [
    [0, -.05, 0], [.022, -.04, 0], [.044, -.02, 0], [.06, 0, 0], [.08, .03, 0],
    [.035, .01, 0], [.038, .04, 0], [.04, .08, 0], [.041, .12, 0],
    [0, .04, 0], [0, .07, 0], [0, .11, 0], [0, .145, 0],
    [-.018, .025, 0], [-.018, .06, 0], [-.018, .10, 0], [-.018, .13, 0],
    [-.035, .01, 0], [-.04, .045, 0], [-.04, .08, 0], [-.04, .11, 0],
  ]
  if (pinch) world[4] = [world[8][0] + .003, world[8][1], 0]
  if (grip || point) for (const i of [5, 9, 13, 17]) {
    if (point && i === 5) continue
    const tip = world[i].map((n, axis) => world[0][axis] + (n - world[0][axis]) * 1.1)
    world[i + 2] = tip.map((n, axis) => (n + world[i][axis]) / 2)
    world[i + 3] = tip
  }
  const rotated = world.map(([a, b, c]) => [a * Math.cos(turn) - b * Math.sin(turn), a * Math.sin(turn) + b * Math.cos(turn), c])
  return {
    worldLandmarks: [rotated.map(([a, b, c]) => ({ x: a, y: -b, z: -c }))],
    landmarks: [rotated.map(([a, b, c]) => ({ x: x + a * scale, y: y - b * scale * 4 / 3, z: -c }))],
    handedness: [[{ categoryName: side, displayName: side, score: .98, index: 0 }]],
  }
}

const emptyHand = { worldLandmarks: [], landmarks: [], handedness: [] }
const results = [], errors = [], modelRequests = [], browsers = []
const report = { environment: headed ? 'PC headed Chromium' : 'PC headless Chromium', warning: 'PC fixture measurements are not phone camera or mobile inference evidence.', results, measurements: {} }
let directory, worker, phone, screen, origin
async function check(name, run) {
  if (process.env.OBPAL_E2E_CAMERA_ONLY && !new RegExp(process.env.OBPAL_E2E_CAMERA_ONLY).test(name)) return
  try {
    const detail = await run()
    results.push({ name, ok: true, detail: detail ?? '' })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, error: error?.message ?? String(error) })
    console.log(`  ✗ ${name}: ${error?.message ?? error}`)
  }
}
function watch(context, name) {
  context.on('page', page => page.on('pageerror', error => errors.push(`${name}: ${error.message}`)))
  context.on('request', request => {
    if (/hand_landmarker|vision_wasm|\.wasm(?:\?|$)|\.task(?:\?|$)/.test(request.url())) modelRequests.push(request.url())
  })
}
async function cameraBrowser(file, fakePermission = true) {
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath, headless: !headed, args: [...args, '--use-fake-device-for-media-stream=fps=60', ...(fakePermission ? ['--use-fake-ui-for-media-stream'] : []), `--use-file-for-fake-video-capture=${file}`] }))
  browsers.push(browser)
  return browser
}
async function openScan(page) {
  await page.locator('.quick-tab').click()
  await page.locator('.quick-tray [data-quick="scan"]').click()
}
const inject = async result => {
  need(phone, 'The paired phone is not ready')
  await phone.evaluate(result => { if (!window.__cameraHand) throw new Error('Missing local hand test seam'); window.__cameraHand.inject(result) }, result)
}
const remoteHand = () => screen.evaluate(() => {
  const remote = window.__obpal, participant = remote.participants.find(p => p.lead)
  return participant ? remote.consumeOf(participant.id, performance.now()).hand : null
})
const viewer = () => screen.evaluate(() => {
  const { controls, holder } = window.__viewer
  return { azimuth: controls.azimuthAngle, polar: controls.polarAngle, distance: controls.distance, position: holder.position.toArray(), quaternion: holder.quaternion.toArray() }
})
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]))

try {
  const standIn = port('OBPAL_E2E_PORT'), localWorker = port('OBPAL_E2E_WORKER_PORT')
  need(standIn !== localWorker, 'The two test ports must differ')
  need(!process.env.OBPAL_E2E_UPSTREAM && !process.env.OBPAL_E2E_ORIGIN, 'This suite requires its own local worker')
  await Promise.all([free(standIn), free(localWorker)])
  directory = await temps.make(join(tmpdir(), 'obpal-camera-'))
  console.log('ob.Pal camera e2e')
  console.log('This suite loads neither Link nor Desktop')
  worker = await startWorker({ port: localWorker }); origin = worker.origin
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath, headless: !headed, args }))
  browsers.push(browser)
  const screenContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  watch(screenContext, 'Viewer')
  await screenContext.addInitScript(() => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('obpal.view.model', 'cube')
  })
  screen = await screenContext.newPage()
  await screen.goto(`${origin}/view/`)
  const invite = await until('Viewer invite and code', () => screen.evaluate(() => window.__viewer && window.__obpal?.pairingUrl && window.__obpal?.code ? { url: window.__obpal.pairingUrl, code: window.__obpal.code } : null), 30000)
  need(new URL(invite.url).origin === origin && /^\d{10}$/.test(invite.code), 'The host did not make a local invite and ten-digit code')
  const qrFile = join(directory, 'pairing.y4m'), rejectedFile = join(directory, 'foreign-code.y4m')
  report.fixture = await videoFixture(qrFile, invite.url)
  await videoFixture(rejectedFile, `https://example.invalid/p/${new URL(invite.url).hash}`)

  await check('landing Quick phone opens real capture in the tap and the Worker QR fallback pairs with Viewer', async () => {
    const camera = await cameraBrowser(qrFile)
    const context = await camera.newContext(mobile); watch(context, 'paired phone')
    await context.addInitScript(probeCamera)
    phone = await context.newPage()
    await phone.goto(origin)
    await openScan(phone)
    await phone.waitForURL(url => url.pathname === '/p/' && !!url.hash, { timeout: 20000 })
    await phone.locator('.modes').waitFor({ timeout: 25000 })
    await until('one phone at Viewer', () => screen.evaluate(() => window.__obpal.participants.length === 1))
    const p = await phone.evaluate(() => window.__cameraProbe())
    need(p.requestsInTap >= 1 && p.qrWorkers >= 1 && p.decoded >= 1, `Capture or QR worker missing: ${JSON.stringify(p)}`)
    need(!p.shareCalls, 'Quick phone called navigator.share')
    need(p.stops >= 1 && p.ended >= 1, 'The scanning stream was not stopped before pairing navigation')
    report.measurements.pairing = { cameraRequestsInTap: p.requestsInTap, qrWorkers: p.qrWorkers, decodedFrames: p.decoded, endedTracks: p.ended }
    return 'real Y4M capture → jsQR Worker → validated /p/# invite → WebRTC'
  })

  await check('a foreign pairing QR stays in the scanner; both phone sizes retain the glass controls in carbon and light', async () => {
    const camera = await cameraBrowser(rejectedFile), context = await camera.newContext(mobile)
    watch(context, 'scanner layouts'); await context.addInitScript(probeCamera)
    const page = await context.newPage()
    try {
      await page.goto(origin); await openScan(page)
      await until('foreign QR rejected', () => page.locator('[data-camera-status]').textContent().then(text => /not an ob.Pal code/i.test(text)))
      need(new URL(page.url()).pathname === '/', 'A foreign QR navigated away')
      await page.screenshot({ path: join(directory, 'scan-site-palette.png') })
      await page.locator('[data-camera-close]').click()
      need(await page.evaluate(() => window.__cameraTracks.every(track => track.readyState === 'ended')), 'The site scanner left a track live')
      // Site pages deliberately keep their signature palette. The controller wears the visitor's chosen surface.
      await page.goto(`${origin}/p/`)
      await page.getByRole('button', { name: 'Scan a code', exact: true }).click()
      await until('foreign QR rejected in controller', () => page.locator('[data-camera-status]').textContent().then(text => /not an ob.Pal code/i.test(text)))
      const surfaces = new Set()
      for (const size of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
        await page.setViewportSize(size)
        for (const theme of ['carbon', 'light']) {
          await setSurface(page, theme)
          surfaces.add(await page.locator('[data-camera-type]').evaluate(button => getComputedStyle(button).color))
          const layout = await page.locator('.obpal-camera').evaluate(dialog => {
            const visible = [...dialog.querySelectorAll('button')].filter(button => !button.hidden)
            return { overflow: document.documentElement.scrollWidth - innerWidth, video: dialog.querySelector('video').videoWidth,
              bad: visible.map(button => { const r = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label') || button.textContent, x: r.x, y: r.y, w: r.width, h: r.height } }).filter(r => r.w < 44 || r.h < 44 || r.x < -1 || r.y < -1 || r.x + r.w > innerWidth + 1 || r.y + r.h > innerHeight + 1) }
          })
          need(layout.video > 0 && layout.overflow <= 1 && !layout.bad.length, `Invalid camera layout: ${JSON.stringify(layout)}`)
          await page.screenshot({ path: join(directory, `scan-${theme}-${size.width}x${size.height}.png`) })
        }
      }
      need(surfaces.size === 1, 'Camera chrome must remain dark on both family surfaces')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const animations = await page.locator('.obpal-camera').evaluate(dialog => dialog.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)
      need(animations === 0, `${animations} camera animations run with reduced motion`)
      await page.screenshot({ path: join(directory, 'scan-reduced-motion.png') })
      await page.locator('[data-camera-close]').click()
      need(await page.evaluate(() => window.__cameraTracks.length > 0 && window.__cameraTracks.every(track => track.readyState === 'ended')), 'Closing left a scanner camera track live')
      return '4 layouts, foreign-origin rejection, reduced motion, real tracks ended'
    } finally { await context.close() }
  })

  await check('denied camera permission offers a working typed-code fallback', async () => {
    const before = await screen.evaluate(() => window.__obpal.participants.length)
    const camera = await cameraBrowser(rejectedFile, false), context = await camera.newContext(mobile)
    watch(context, 'denied camera'); await context.addInitScript(probeCamera)
    const page = await context.newPage(), cdp = await context.newCDPSession(page)
    let permission = 'Chromium denied permission'
    try {
      try {
        const target = await cdp.send('Target.getTargetInfo')
        await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin, browserContextId: target.targetInfo.browserContextId })
      } catch {
        permission = 'NotAllowedError fallback fixture'
        await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Camera denied for this fixture', 'NotAllowedError') } })
      }
      await page.goto(origin); await openScan(page)
      await page.locator('.obpal-camera[data-state="unavailable"]').waitFor()
      need(/Camera access is off/.test(await page.locator('[data-camera-status]').textContent()), 'Permission denial has no useful camera message')
      await page.screenshot({ path: join(directory, 'scan-camera-denied.png') })
      await page.locator('[data-camera-type]').click()
      await page.getByRole('textbox', { name: 'Code from your screen' }).waitFor({ timeout: 15000 })
      need(new URL(page.url()).pathname === '/p/', 'Typed fallback did not reach the controller')
      // Pairing the first phone closes the chip and retires its short code. Show a fresh one as a person would.
      const pill = screen.locator('.obpal-chip .pill')
      if (await pill.getAttribute('aria-expanded') !== 'true') await pill.click()
      const code = await until('fresh host code', () => screen.evaluate(() => window.__obpal.code || ''))
      await page.getByRole('textbox', { name: 'Code from your screen' }).fill(code)
      await page.locator('.modes').waitFor({ timeout: 20000 })
      await until('typed phone joined the Viewer', () => screen.evaluate(before => window.__obpal.participants.length > before, before))
      report.measurements.denied = { method: permission }
      return `${permission}; typed code paired successfully`
    } finally { await context.close() }
  })

  await check('the real hand model detects the moving hand fixture, sends HAND and moves the Viewer cursor', async () => {
    need(phone, 'QR pairing did not make a phone')
    need(await phone.evaluate(() => !document.querySelector('.obpal-camera') && window.__cameraTracks.every(track => track.readyState === 'ended')), 'The scanner is still using the video fixture')
    // The QR camera has stopped. Opening it again reads the same file as a hand clip from frame zero.
    report.handFixture = await handVideoFixture(qrFile)
    const url = new URL(phone.url()); url.searchParams.set('camera-test', '1')
    await phone.goto(url.href); await phone.locator('[data-tab="camera-hand"]').waitFor({ timeout: 25000 })
    await phone.locator('[data-tab="camera-hand"]').click()
    await phone.locator('.obpal-camera[data-mode="hand"]').waitFor()
    need(await phone.evaluate(() => !document.fullscreenElement), 'Opening the hand camera unexpectedly requested fullscreen')
    await until('real HandLandmarker inference', () => phone.evaluate(() => {
      const m = window.__cameraHand?.stats()
      return m && ['GPU', 'CPU'].includes(m.delegate) && m.frames >= 12 && m.trackingFps > 0 ? { ...m } : null
    }), 60000)
    const firstHand = await until('real model hand at Viewer', async () => {
      const h = await remoteHand()
      return h?.tracked && h.confidence >= .6 && h.landmarks.length === 21 && h.gestures === 0 ? h : null
    }, 20000)
    const before = await viewer()
    await until('real hand cursor at Viewer', () => screen.locator('[data-camera-cursor="hover"]').count())
    await sleep(1500)
    const after = await viewer()
    need(Math.abs(after.azimuth - before.azimuth) < .001 && Math.abs(after.distance - before.distance) < .001, 'An open palm moved the camera')
    // Let shader warm-up leave the rolling 240-frame latency sample before recording steady-state performance.
    await sleep(6000)
    const metrics = await phone.evaluate(() => ({ ...window.__cameraHand.stats() }))
    const graphics = await phone.evaluate(() => {
      const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      if (!gl) return { renderer: 'Unavailable', software: null }
      try {
        const debug = gl.getExtension('WEBGL_debug_renderer_info')
        const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
        return { renderer, vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          version: gl.getParameter(gl.VERSION), shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          software: /SwiftShader|llvmpipe|software|Microsoft Basic Render/i.test(renderer) }
      } finally { gl.getExtension('WEBGL_lose_context')?.loseContext() }
    })
    need(metrics.cameraFps > 0 && metrics.trackingFps > 0 && Number.isFinite(metrics.latencyP95Ms), `No valid inference measurements: ${JSON.stringify(metrics)}`)
    need(['GPU', 'CPU'].includes(metrics.delegate), 'Real hand measurements unexpectedly used the synthetic seam')
    report.graphics = graphics
    report.measurements.realHand = { workload: 'Actual MediaPipe inference on moving original hand-image video; real camera timing, filtering, HAND and WebRTC', ...metrics, graphics, confidence: firstHand.confidence, handedness: firstHand.handedness, before, after }
    const cameraUi = await phone.locator('.obpal-camera').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect(), style = getComputedStyle(dialog)
      return { modal: dialog.matches(':modal'), top: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.obpal-camera') === dialog,
        rect: rect.toJSON(), display: style.display, visibility: style.visibility, opacity: style.opacity }
    })
    report.measurements.cameraUi = cameraUi
    need(cameraUi.modal && cameraUi.top, `The hand camera is not the visible top surface: ${JSON.stringify(cameraUi)}`)
    await phone.screenshot({ path: join(directory, 'hand-model-real-inference.png') })
    const hint = phone.locator('.obpal-camera .hint-x')
    if (await hint.count()) { await hint.click(); await sleep(280) }
    for (const size of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
      await phone.setViewportSize(size)
      for (const theme of ['carbon', 'light']) {
        await setSurface(phone, theme)
        await phone.screenshot({ path: join(directory, `hand-${theme}-${size.width}x${size.height}.png`) })
      }
    }
    await phone.setViewportSize(mobile.viewport)
    await setSurface(phone, 'carbon')
    await screen.screenshot({ path: join(directory, 'viewer-real-hand-orbit.png') })
    return `${metrics.delegate}, camera ${metrics.cameraFps.toFixed(1)} fps, inference ${metrics.trackingFps.toFixed(1)} fps, mean ${metrics.latencyMs.toFixed(1)} ms, p95 ${metrics.latencyP95Ms.toFixed(1)} ms; WebGL: ${graphics.renderer}${graphics.software ? ' (software rendering)' : ''}; actual hand detection on PC fixture`
  })

  await check('camera-timed synthetic landmarks reach real HAND packets and orbit plus depth-zoom the Viewer', async () => {
    await inject(emptyHand)
    await until('loss before deterministic hand', async () => (await remoteHand())?.tracked === false)
    await inject(handResult({ grip: true }))
    await until('tracked HAND at Viewer', async () => { const h = await remoteHand(); return h?.tracked && h.landmarks.length === 21 && h.gestures === 2 })
    await sleep(400)
    const before = await viewer()
    await inject(handResult({ x: .64, y: .49, scale: 3, grip: true }))
    const after = await until('Viewer hand orbit and zoom', async () => {
      const next = await viewer()
      return Math.abs(next.azimuth - before.azimuth) > .025 && Math.abs(next.polar - before.polar) > .01 && Math.abs(next.distance - before.distance) > .05 ? next : null
    })
    report.measurements.orbit = { before, after }
    return 'fist clutch changed orbit and camera distance through HAND/WebRTC'
  })

  await check('pinch moves and turns the model; loss and identity changes hold it without a jump', async () => {
    await inject(emptyHand); await sleep(350)
    const hit = await screen.evaluate(() => {
      const { seats, parts } = window.__viewer, seat = [...seats.values()].find(s => s.who.lead)
      for (let y = .3; y <= .7; y += .025) for (let x = .3; x <= .7; x += .025) {
        parts.hover(x * innerWidth, y * innerHeight, seat.hand)
        if (seat.hand.hovered?.movable && !parts.live_(seat.hand.hovered)) return { x, y }
      }
      return null
    })
    need(hit, 'No movable part under the cursor search')
    const position = { x: 1 - (.12 + hit.x * .76) + .0036 * 2.2, y: .12 + hit.y * .76 + .007 * 2.2 * 4 / 3 }
    await inject(handResult(position)); await sleep(500)
    await inject(handResult({ ...position, pinch: true }))
    await until('pinch HAND', async () => !!((await remoteHand())?.gestures & 1))
    await sleep(400)
    const grabbed = () => screen.evaluate(() => {
      const part = [...window.__viewer.seats.values()].find(s => s.who.lead)?.hand.selected
      return part ? { position: part.object.position.toArray(), quaternion: part.object.quaternion.toArray() } : null
    })
    const before = await grabbed()
    need(before, 'Pinch did not take the part under the palm cursor')
    await inject(handResult({ ...position, x: position.x + .05, pinch: true, turn: .2 }))
    const after = await until('grabbed model movement', async () => {
      const next = await grabbed()
      return distance(before.position, next.position) > .025 && distance(before.quaternion, next.quaternion) > .02 ? next : null
    })
    await inject(emptyHand)
    await until('explicit tracking loss', async () => (await remoteHand())?.tracked === false)
    await sleep(350)
    const held = await grabbed()
    await inject(handResult({ x: .2, y: .6, scale: 3, pinch: true, side: 'Left' }))
    await until('new tracking identity', async () => (await remoteHand())?.handedness === 'right')
    await sleep(450)
    const anchored = await grabbed()
    need(distance(held.position, anchored.position) < .005 && distance(held.quaternion, anchored.quaternion) < .005, 'Reacquiring a different hand jumped the model')
    report.measurements.grab = { before, after, held, anchored }
    await screen.screenshot({ path: join(directory, 'viewer-hand-grab.png') })
    await phone.screenshot({ path: join(directory, 'hand-landmarks-synthetic.png') })
    return 'pinch translation and landmark rotation, then hold and re-anchor'
  })

  await check('finite but degenerate palm landmarks cannot move the Viewer', async () => {
    const invalid = handResult({ side: 'Left', pinch: true })
    invalid.worldLandmarks[0] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }))
    await inject(emptyHand)
    await until('loss before invalid palm', async () => (await remoteHand())?.tracked === false)
    const before = await viewer()
    await inject(invalid)
    await until('degenerate HAND reached host', async () => { const h = await remoteHand(); return h?.tracked && h.landmarks.every(p => p.every(v => v === 0)) })
    await sleep(400)
    const after = await viewer()
    need(distance(before.position, after.position) < .005 && distance(before.quaternion, after.quaternion) < .005, 'A degenerate palm moved the model')
    return 'invalid palm basis holds despite a well-formed packet'
  })

  await check('synthetic cadence is measured separately and camera close ends tracks and expires HAND', async () => {
    await inject(handResult({ side: 'Left' })); await sleep(2500)
    const metrics = await phone.evaluate(() => ({ ...window.__cameraHand.stats() }))
    need(metrics.delegate === 'synthetic' && metrics.trackingFps >= 10 && metrics.sentFps >= 10, `Synthetic camera cadence too low: ${JSON.stringify(metrics)}`)
    need(metrics.bytesPerSecond <= 18288, `HAND exceeded its payload budget: ${metrics.bytesPerSecond}`)
    report.measurements.synthetic = { workload: 'Injected landmarks at actual camera frame cadence; includes filtering, packing and send, excludes model inference', ...metrics }
    await phone.locator('[data-camera-close]').click()
    need(await phone.evaluate(() => window.__cameraTracks.length > 0 && window.__cameraTracks.every(track => track.readyState === 'ended')), 'Closing hand camera left a track live')
    const began = Date.now()
    await until('HAND expires after close', async () => (await remoteHand()) === null, 3000)
    const expiryMs = Date.now() - began
    need(expiryMs < 1500, `HAND persisted ${expiryMs} ms after close`)
    report.measurements.close = { expiryMs, allTracksEnded: true }
    return `${metrics.trackingFps.toFixed(1)} fps, ${metrics.sentFps.toFixed(1)} HAND/s, ${metrics.bytesPerSecond.toFixed(0)} B/s; expired after ${expiryMs} ms`
  })

  await cameraDesign({ check, need, until, sleep, directory, origin, screen, phone, cameraBrowser, mobile, probeCamera, handResult, emptyHand, qrFile, report })
  await cameraBody({ check, need, until, sleep, directory, origin, screen, phone, cameraBrowser, mobile, probeCamera, handResult, report, yuv420, watch, qrFile })

  await check('all hand model and WASM requests stay on this origin and pages have no script errors', async () => {
    need(modelRequests.some(url => url.includes('hand_landmarker.task')), 'The real model was never requested')
    need(modelRequests.some(url => /\.wasm(?:\?|$)/.test(url)), 'The local WASM runtime was never requested')
    need(modelRequests.every(url => new URL(url).origin === origin), `Off-origin model request: ${modelRequests.find(url => new URL(url).origin !== origin)}`)
    need(!errors.length, errors.slice(0, 4).join(' | '))
    report.modelAssets = [...new Set(modelRequests.map(url => new URL(url).pathname))]
    return `${report.modelAssets.length} local model/runtime assets`
  })
  await check('Content Security Policy', cspCheck)
} catch (error) {
  results.push({ name: 'camera suite setup', ok: false, error: error?.message ?? String(error) })
  if (screen && directory) {
    report.setup = await screen.evaluate(() => ({ ready: document.readyState, viewer: !!window.__viewer, remote: !!window.__obpal, text: document.body.innerText.slice(-2000) })).catch(() => null)
    await screen.screenshot({ path: join(directory, 'setup-failure.png') }).catch(() => {})
  }
  console.error(error?.stack ?? error)
} finally {
  report.pageErrors = errors
  for (const browser of browsers.reverse()) await browser.close().catch(() => {})
  await worker?.close()
  if (directory) {
    await writeFile(join(directory, 'camera-results.json'), JSON.stringify(report, null, 2))
    console.log(`Camera evidence: ${directory}`)
  }
}
const failed = results.filter(result => !result.ok).length
console.log(failed ? `FAILED ${failed}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exitCode = failed ? 1 : 0

} finally { await temps.cleanup() }

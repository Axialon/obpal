/** BODY over real WebRTC, and opt-in local webcam inference without a transport. Evidence stays in a temp folder. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

function pose() {
  return {
    worldLandmarks: [Array.from({ length: 33 }, (_, i) => ({ x: (i % 2 ? -1 : 1) * .2, y: (i - 23) * .04, z: -.1, visibility: .95 }))],
    landmarks: [Array.from({ length: 33 }, (_, i) => ({ x: i % 2 ? .4 : .6, y: .1 + i * .025, z: -.1, visibility: .95 }))],
  }
}

/** Observe writes and outbound messages in memory; no capture data is persisted by the probe itself. */
function privacyProbe() {
  const events = { storage: [], network: [], rtc: [], workers: 0, terminated: 0 }
  window.__bodyPrivacy = events
  for (const method of ['setItem']) {
    const call = Storage.prototype[method]
    Storage.prototype[method] = function(...args) { events.storage.push(args); return call.apply(this, args) }
  }
  for (const method of ['add', 'put']) {
    const call = IDBObjectStore.prototype[method]
    IDBObjectStore.prototype[method] = function(...args) { events.storage.push(args.map(v => typeof v === 'string' ? v : JSON.stringify(v))); return call.apply(this, args) }
  }
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function(value) { events.network.push(typeof value === 'string' ? value : '[binary]'); return send.call(this, value) }
  const data = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function(value) { events.rtc.push(typeof value === 'string' ? value : value.byteLength); return data.call(this, value) }
  const Native = Worker
  window.Worker = class extends Native {
    constructor(...args) { super(...args); events.workers++; const stop = this.terminate.bind(this); this.terminate = () => { events.terminated++; stop() } }
  }
}

export async function cameraBody(o) {
  const { check, need, until, sleep, directory, origin, screen, phone, cameraBrowser, mobile, probeCamera, handResult, report, yuv420, watch, qrFile } = o
  const file = join(directory, 'body.y4m')
  const rgb = await sharp(await readFile(new URL('../tests/fixtures/camera-body.png', import.meta.url))).resize(640, 480, { fit: 'contain' }).removeAlpha().raw().toBuffer()
  const video = Buffer.concat([Buffer.from('YUV4MPEG2 W640 H480 F30:1 Ip A1:1 C420jpeg\nFRAME\n'), yuv420(rgb, 640, 480)])
  await writeFile(file, video); await writeFile(qrFile, video)
  const remote = () => screen.evaluate(() => {
    const r = window.__obpal, p = r.participants.find(p => p.lead)
    if (!p) return null
    const f = r.consumeOf(p.id, performance.now())
    return { body: f.body, hand: f.hand }
  })
  const inject = (body, hand) => phone.evaluate(({ body, hand }) => window.__cameraBody.inject(body, hand), { body, hand })
  const openPhone = async () => {
    await phone.locator('[data-tab="camera-body"]').click()
    await until('phone body model ready', () => phone.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraBody?.stats()?.delegate)), 60000)
  }

  await check('phone Body sends BODY only, with optional fingers explicitly enabled and no legacy gestures', async () => {
    await openPhone()
    need(!await phone.locator('[data-camera-fingers]').isChecked(), 'Fingers enabled by default')
    await until('real Lite BODY at Viewer', async () => (await remote())?.body?.tracked, 30000)
    await phone.screenshot({ path: join(directory, 'body-phone-real.png') })
    await inject(pose(), handResult({ side: 'Left', pinch: true }))
    await until('BODY at Viewer', async () => (await remote())?.body?.tracked)
    await sleep(1200)
    const bodyOnly = await phone.evaluate(() => ({ ...window.__cameraBody.stats() }))
    need(bodyOnly.handPackets === 0, 'Body mode sent a HAND before opt-in')
    need((await remote()).body.landmarks.length === 33, 'BODY lacks its 33 points')
    await phone.screenshot({ path: join(directory, 'body-phone-default.png') })
    await phone.locator('[data-camera-fingers]').check()
    await until('optional HAND at Viewer', async () => (await remote())?.hand?.tracked)
    const combined = await remote()
    need(combined.hand.gestures === 0, 'Fingers invoked legacy grab/orbit gestures')
    await sleep(1500)
    const fingers = await phone.evaluate(() => ({ ...window.__cameraBody.stats() }))
    need(fingers.bytesPerSecond <= 18552, `BODY + HAND exceeded budget: ${fingers.bytesPerSecond}`)
    await phone.locator('[data-camera-fingers]').uncheck()
    await until('fingers loss', async () => !(await remote())?.hand?.tracked)
    report.bodyPhone = { workload: 'Synthetic landmarks at fake-camera cadence over real WebRTC; not phone performance', bodyOnly, fingers }
    return '33 points; zero HAND before opt-in; shared allowance; optional HAND has no gestures'
  })

  await check('phone BODY confidence gates partial bodies, reacquires identity and stops on tab release', async () => {
    const first = (await remote()).body.gen, partial = pose()
    partial.landmarks[0][27].y = 1.2
    await inject(partial)
    await until('feet out of view', async () => { const b = (await remote())?.body; return b?.tracked && b.presence[27] === 0 })
    partial.landmarks[0][23].visibility = .1
    await inject(partial)
    await until('hips lost', async () => (await remote())?.body?.tracked === false)
    await inject(pose())
    await until('new body generation', async () => { const b = (await remote())?.body; return b?.tracked && b.gen > first })
    await phone.evaluate(() => dispatchEvent(new Event('blur')))
    await until('body expires', async () => !(await remote())?.body)
    need(await phone.evaluate(() => window.__cameraTracks.every(t => t.readyState === 'ended') && !document.querySelector('.obpal-camera')), 'Blur left camera alive')
    await sleep(350)
    need(await phone.evaluate(() => window.__cameraBody.stats() === null), 'Camera restarted itself')
    await openPhone(); await inject(pose())
    await until('fresh session body', async () => (await remote())?.body?.tracked)
    need(!await phone.locator('[data-camera-fingers]').isChecked(), 'Fingers preference was persisted')
    const beforeFlip = (await remote()).body.gen
    await phone.locator('[data-camera-flip]').evaluate(button => button.click())
    await until('body tracker after flip', () => phone.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraBody?.stats()?.delegate)), 60000)
    await inject(pose())
    await until('body identity after flip', async () => { const b = (await remote())?.body; return b?.tracked && b.gen > beforeFlip })
    await phone.locator('[data-camera-close]').click()
    await until('body close expires', async () => !(await remote())?.body)
    await phone.locator('[data-tab="camera-hand"]').click()
    need(await phone.locator('.obpal-camera[data-mode="hand"]').count(), 'Existing Hand mode unavailable')
    await phone.locator('[data-camera-close]').click()
    return 'partial body confidence, lost torso, fresh generation, ended tracks, no automatic resume, Hand mode retained'
  })

  const browser = await cameraBrowser(file)
  const openLocal = async page => {
    const button = page.locator('[data-body-capture]')
    if (await button.isVisible()) await button.click()
    else { await page.locator('.quick-tab').click(); await page.locator('[data-quick="body"]').click() }
  }
  report.bodyLocal = []
  for (const path of ['/view/', '/sim/arm/']) await check(`local Body camera ${path} runs real Lite, stays private offline, and stops on hide`, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watch(context, `local body ${path}`)
    await context.addInitScript(probeCamera); await context.addInitScript(privacyProbe)
    const page = await context.newPage(), traffic = []
    context.on('request', r => traffic.push({ url: r.url(), method: r.method(), bytes: r.postDataBuffer()?.length ?? 0, kind: r.resourceType() }))
    try {
      await page.goto(`${origin}${path}?test=camera`)
      await page.locator('[data-body-capture]').waitFor({ state: 'attached', timeout: 30000 })
      await sleep(800)
      need(await page.evaluate(() => window.__cameraTracks.length === 0), 'Webcam started without a tap')
      await page.screenshot({ path: join(directory, `body-${path.includes('arm') ? 'sim' : 'viewer'}-before.png`) })
      const start = traffic.length
      await page.evaluate(() => { window.__bodyPrivacy.storage.length = window.__bodyPrivacy.network.length = window.__bodyPrivacy.rtc.length = 0 })
      await openLocal(page)
      await until('real Pose Lite detection', () => page.evaluate(() => {
        const b = window.__cameraBody?.read(), m = window.__cameraBody?.stats()
        return b?.tracked && b.landmarks.length === 33 && ['GPU', 'CPU'].includes(m?.delegate) && m.frames > 12
      }), 90000)
      need((await page.locator('.camera-privacy').innerText()).includes('Camera frames stay on this device.'), 'Privacy line missing')
      await sleep(2500)
      const metrics = await page.evaluate(() => ({ ...window.__cameraBody.stats() }))
      const requests = traffic.slice(start)
      need(requests.every(r => r.bytes === 0 && r.method === 'GET'), `Capture posted data: ${JSON.stringify(requests)}`)
      need(requests.filter(r => /\.task|vision_wasm/.test(r.url)).every(r => new URL(r.url).origin === origin), 'Model came from another origin')
      need(requests.some(r => r.url.endsWith('pose_landmarker_lite.task')), 'Lite model not requested')
      need(!requests.some(r => /pose_landmarker_(full|heavy)|hand_landmarker/.test(r.url)), 'Local webcam loaded another model')
      const online = await page.evaluate(() => ({ ...window.__bodyPrivacy }))
      need(online.rtc.length === 0 && online.network.every(v => !/landmarks|worldLandmarks|data:image|\[binary\]/.test(v)), 'Local capture sent data while online')
      need(online.storage.every(args => args[0] === 'obpal.e2e.camera' || (args[0] === 'obpal.hint.quick.shortcuts' && args[1] === '1')), 'Local capture wrote data while online')
      await page.screenshot({ path: join(directory, `body-${path.includes('arm') ? 'sim' : 'viewer'}-local.png`) })
      await page.evaluate(() => { window.__bodyPrivacy.storage.length = window.__bodyPrivacy.network.length = window.__bodyPrivacy.rtc.length = 0 })
      const offlineStart = traffic.length
      await context.setOffline(true)
      const count = metrics.frames
      await until('local inference while offline', () => page.evaluate(n => window.__cameraBody.stats()?.frames > n + 12 && window.__cameraBody.read()?.tracked, count), 30000)
      const proof = await page.evaluate(async () => {
        const cached = []
        for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) cached.push({ name, path: new URL(req.url).pathname })
        return { ...window.__bodyPrivacy, cached }
      })
      need(proof.rtc.length === 0, 'Local webcam sent RTC messages')
      need(proof.network.every(v => typeof v === 'string' && !/landmarks|worldLandmarks|data:image|\[binary\]/.test(v)), 'Local camera sent websocket capture data')
      need(proof.storage.every(args => args[0] === 'obpal.e2e.camera'), `Capture wrote storage: ${JSON.stringify(proof.storage).slice(0, 400)}`)
      need(proof.cached.filter(v => v.name.startsWith('obpal-body-')).every(v => /^\/models\/(pose_landmarker_lite\.task|vision_wasm_(?:nosimd_)?internal\.wasm|vision-1\.0\.1\/vision_wasm_(?:nosimd_)?internal\.js)$/.test(v.path)), 'Capture entered asset cache')
      need(traffic.slice(offlineStart).every(r => r.bytes === 0 && !/data:image|landmarks/.test(r.url)), 'Offline capture attempted upload')
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
      await until('camera hidden cleanup', () => page.evaluate(() => !document.querySelector('.obpal-camera') && window.__cameraTracks.every(t => t.readyState === 'ended') && window.__cameraBody.read() === null))
      const stopped = await page.evaluate(() => ({ workers: window.__bodyPrivacy.workers, terminated: window.__bodyPrivacy.terminated }))
      need(stopped.terminated >= 1, 'Body worker was not terminated')
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
      await sleep(400); need(await page.evaluate(() => window.__cameraBody.stats() === null), 'Showing page restarted capture')
      await openLocal(page)
      await until('warm offline capture restart', () => page.evaluate(() => window.__cameraBody.read()?.tracked), 60000)
      await page.locator('[data-camera-close]').click()
      report.bodyLocal.push({ path, workload: 'Real Pose Lite over a synthetic 640x480 still image, PC Chromium; no phone or physical latency claim', metrics, requests, offlineRequests: traffic.slice(offlineStart), online, proof, stopped, offlineRestart: true })
      return `${metrics.trackingFps.toFixed(1)} processed fps on PC fixture; zero RTC capture, no data writes/uploads; offline capture and hide cleanup`
    } finally { await context.close() }
  })
  await browser.close()

  await check('local webcam permission denial stops cleanly and remains opt-in', async () => {
    const browser = await cameraBrowser(file, false), context = await browser.newContext(mobile)
    await context.addInitScript(probeCamera)
    const page = await context.newPage()
    try {
      const cdp = await context.newCDPSession(page), target = await cdp.send('Target.getTargetInfo')
      await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin, browserContextId: target.targetInfo.browserContextId })
      await page.goto(`${origin}/view/?test=camera`)
      await openLocal(page)
      await page.locator('.obpal-camera[data-state="unavailable"]').waitFor()
      need(await page.evaluate(() => window.__cameraTracks.length === 0 && window.__cameraBody.read() === null), 'Denied camera created input')
      await page.locator('[data-camera-close]').click()
      return 'denied permission: no tracks or BODY'
    } finally { await context.close(); await browser.close() }
  })
}

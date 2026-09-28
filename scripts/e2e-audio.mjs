/** Real audio, physics and addressed controller feedback. Captures are written only to a temporary directory. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

const args = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors', '--autoplay-policy=user-gesture-required']
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function record(page) {
  await page.evaluate(() => {
    const sound = window.__simAudio
    const video = document.querySelector('#stage').captureStream(20)
    const stream = new MediaStream([...video.getVideoTracks(), ...sound.capture.stream.getAudioTracks()])
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1400000 })
    const chunks = []
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    window.__audioRecording = { recorder, video, result: new Promise(resolve => { recorder.onstop = async () => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }))
    } }) }
    recorder.start(200)
  })
}
async function saveRecording(page, path) {
  const base64 = await page.evaluate(async () => { const r = window.__audioRecording; r.recorder.stop(); const result = await r.result; r.video.getTracks().forEach(t => t.stop()); return result })
  await writeFile(path, Buffer.from(base64, 'base64'))
}

export async function runAudio(local, check) {
  const out = await mkdtemp(join(tmpdir(), 'obpal-audio3d-'))
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, args })
  const measurements = []
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
  await context.addInitScript(() => { try { localStorage.removeItem('obpal.sim.muted'); localStorage.removeItem('obpal.sim.reduced') } catch {} })
  const errors = []
  context.on('page', page => page.on('pageerror', e => errors.push(e.message)))
  async function screen(id, failOpus = false) {
    const page = await context.newPage(), cdp = await context.newCDPSession(page)
    const samplesRequested = []
    page.on('request', request => { if (/\.(webm|mp3)(\?|$)/.test(request.url())) samplesRequested.push(request.url()) })
    if (failOpus) {
      await page.route('**/*.webm*', route => route.abort('failed'))
      await page.addInitScript(() => { AudioParam.prototype.cancelAndHoldAtTime = undefined })
    }
    let audioId = null, nodes = 0
    cdp.on('WebAudio.contextCreated', ({ context }) => { audioId = context.contextId })
    cdp.on('WebAudio.audioNodeCreated', () => nodes++)
    cdp.on('WebAudio.audioNodeWillBeDestroyed', () => nodes--)
    await cdp.send('WebAudio.enable')
    await page.goto(local.origin + (id === 'arm' ? '/sim/arm/' : `/sim/device/?d=${id}`))
    await page.waitForFunction(() => window.__simAudio && window.__obpal?.pairingUrl)
    assert.equal(await page.evaluate(() => window.__simAudio.context), null, 'no context before a gesture')
    assert.equal(samplesRequested.length, 0, 'no sample download before a gesture')
    await page.locator('#sim-sound').click()
    await page.waitForFunction(() => window.__simAudio.running)
    const stats = async () => {
      const graph = await page.evaluate(() => {
        const s = window.__simAudio, samples = new Float32Array(s.analyser.fftSize); s.analyser.getFloatTimeDomainData(samples)
        return { active: s.budget.active, motors: s.budget.slots.filter(v => v.active && v.key.endsWith(':motor')).length, scheduled: s.scheduled, stolen: s.budget.stolen, contacts: s.contacts, haptics: s.haptics, updateMs: s.updateMs, peak: Math.max(...samples.map(Math.abs)), sampleRate: s.context.sampleRate }
      })
      const realtime = audioId ? await cdp.send('WebAudio.getRealtimeData', { contextId: audioId }).then(r => r.realtimeData).catch(() => null) : null
      return { ...graph, nodes, realtime }
    }
    return { page, stats }
  }
  async function phone(invite) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    await ctx.addInitScript(() => {
      window.__rumble = []; window.__vibration = []; window.__padFeedback = []
      navigator.vibrate = pattern => { window.__vibration.push({ at: performance.now(), pattern }); return true }
      Object.defineProperty(navigator, 'getGamepads', { value: () => [{ connected: true, axes: [0, 0, 0, 0], buttons: [], index: 0, id: 'Audio test pad', mapping: 'standard', timestamp: 0, vibrationActuator: {
        playEffect: async (type, effect) => { window.__padFeedback.push({ type, ...effect }); return 'complete' }, reset: async () => 'complete',
      } }] })
      const Native = RTCPeerConnection
      const watch = channel => channel.addEventListener('message', e => { try { const m = JSON.parse(e.data); if (m.t === 'rumble') window.__rumble.push({ ...m, at: performance.now() }) } catch {} })
      window.RTCPeerConnection = class extends Native {
        constructor(...a) { super(...a); this.addEventListener('datachannel', e => watch(e.channel)) }
        createDataChannel(...a) { const channel = super.createDataChannel(...a); watch(channel); return channel }
      }
    })
    const page = await ctx.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(invite)
    await page.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
    const cdp = await ctx.newCDPSession(page)
    const touches = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
    const drive = async (selector, dx, dy, ms) => {
      await page.evaluate(() => document.querySelectorAll('.hint').forEach(e => e.remove()))
      const b = await page.locator(selector).first().boundingBox()
      assert.ok(b, `visible ${selector}`)
      const x = b.x + b.width / 2, y = b.y + b.height / 2
      await touches('touchStart', x, y)
      for (let i = 0; i < ms / 40; i++) { await touches('touchMove', x + dx + i % 2, y + dy); await sleep(40) }
      await touches('touchEnd')
    }
    return { page, drive, close: () => ctx.close() }
  }
  try {
    await check('3D audio: a failed Opus request decodes the portable sample fallback', async () => {
      const { page } = await screen('vacuum', true)
      const loaded = await page.evaluate(async () => { const s = window.__simAudio; await s.samplesReady; return !!s.samples.get('suction') && !!s.samples.get('latch') })
      assert.ok(loaded, 'MP3 suction and latch decoded after failed Opus requests')
      const envelopes = await page.evaluate(() => {
        const s = window.__simAudio
        s.bus.emit({ kind: 'motor', source: 'portable', at: [0, 0, 0], strength: 0.7, rpm: 0.7, load: 0.5 })
        const active = s.budget.active; s.stop()
        return active > 0 && s.budget.active === 0
      })
      assert.ok(envelopes, 'legacy gain scheduling starts and releases the decoded loop')
      await page.close()
    })
    await check('3D audio: phone-driven rover contact produces spatial sound and matching phone/gamepad feedback', async () => {
      const { page, stats } = await screen('rover')
      const p = await phone(await page.evaluate(() => window.__obpal.pairingUrl))
      await page.waitForFunction(() => window.__sim.claims.holder('rover1'))
      await page.evaluate(() => {
        const remote = window.__obpal, send = remote.rumble.bind(remote)
        window.__sentRumble = []
        remote.rumble = (strong, weak, ms, who) => { window.__sentRumble.push({ strong, weak, ms, who, at: performance.now() }); send(strong, weak, ms, who) }
        Object.assign(window.__device.logic.rovers[0], { x: 0, z: 0.65, h: 0, v: 0 })
      })
      await record(page)
      const moving = []
      await Promise.all([
        p.drive('.gp-trig[data-trig="1"]', 0, 0, 2100),
        (async () => { for (let i = 0; i < 10; i++) { await sleep(150); moving.push(await stats()) } })(),
      ])
      await sleep(300)
      const hits = await p.page.evaluate(() => ({ messages: window.__rumble, pads: window.__padFeedback, vibrations: window.__vibration }))
      assert.ok(hits.messages.some(m => m.strong > 0.15), 'collision message reached phone')
      assert.ok(hits.pads.some(m => m.strongMagnitude > 0.15), 'matching collision reached gamepad')
      assert.ok(hits.vibrations.length > 0, 'phone vibrated')
      const collision = hits.messages.find(m => m.strong > 0.15)
      assert.ok(hits.pads.some(m => m.strongMagnitude === collision.strong && m.duration === collision.ms))
      const before = await stats(); assert.ok(before.contacts > 0 && before.scheduled > 2)
      assert.ok(moving.some(s => s.peak > 0.00001), 'non-silent post-limiter output during movement')
      const samples = []
      // Four independent phones, each owning one moving body. The first collision above was driven on the phone.
      const peers = [p]
      for (let i = 0; i < 3; i++) peers.push(await phone(await page.evaluate(() => window.__obpal.pairingUrl)))
      await page.waitForFunction(() => window.__obpal.participants.length === 4)
      // Give every chassis clear runway; the first driver just reached the far fence during the contact check.
      await page.evaluate(() => window.__device.logic.rovers.forEach((r, n) => Object.assign(r, { x: -3 + n * 2, z: 3.5, h: 0, v: 0 })))
      const drives = peers.map(peer => peer.drive('.gp-trig[data-trig="1"]', 0, 0, 3500))
      for (let i = 0; i < 10; i++) { await sleep(300); samples.push(await stats()) }
      await Promise.all(drives)
      assert.ok(samples.some(s => s.motors === 4), 'all four motors rendered together')
      await saveRecording(page, join(out, 'rover.webm'))
      await page.screenshot({ path: join(out, 'after-rover.png') })
      measurements.push({ sim: 'rover', players: 4, motionPeak: Math.max(...moving.map(s => s.peak)), samples })
      // Stress the production event path, checking send timing independently of network jitter.
      const stressMs = await page.evaluate(async () => {
        const who = window.__sim.claims.holder('rover1'); window.__sentRumble = []
        const start = performance.now()
        for (let i = 0; i < 100; i++) { window.__simAudio.bus.emit({ kind: 'contact', source: 'stress', at: [0, 0, 0], strength: 0.8, who }); await new Promise(r => setTimeout(r, 5)) }
        return performance.now() - start
      })
      const sent = await page.evaluate(() => window.__sentRumble.filter(m => m.who === window.__sim.claims.holder('rover1')))
      // At most one rumble per 100 ms for the participant, however long the loop took on a loaded machine.
      assert.ok(sent.length > 0 && sent.length <= Math.ceil(stressMs / 100) + 1, `${sent.length} rumbles in ${Math.round(stressMs)} ms`)
      for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 99, '100 ms participant rate limit')
      await p.page.evaluate(() => { localStorage.setItem('obpal.feedback', '0'); window.__vibration = []; window.__padFeedback = []; window.__rumble = [] })
      await sleep(150)
      await page.evaluate(() => window.__simAudio.bus.emit({ kind: 'contact', source: 'preference', at: [0, 0, 0], strength: 1, who: window.__sim.claims.holder('rover1') }))
      await p.page.waitForFunction(() => window.__rumble.length > 0)
      assert.deepEqual(await p.page.evaluate(() => [window.__vibration.length, window.__padFeedback.length]), [0, 0])
      const resumed = await page.evaluate(() => {
        const s = window.__simAudio, event = { kind: 'motor', source: 'watchdog', at: [0, 0, 0], strength: 0.5 }
        s.bus.emit(event)
        const old = s.budget.slots.findIndex(v => v.active && v.key === 'watchdog:motor')
        s.strips[old].until = 0; s.tick(performance.now() + 100)
        // A new movement while the old source fades must not reuse its already scheduled stop.
        s.bus.emit(event)
        return s.budget.slots.some((v, n) => n !== old && v.active && v.key === 'watchdog:motor' && s.strips[n].loop)
      })
      assert.ok(resumed, 'resuming movement gets a fresh loop during watchdog release')
      for (const peer of peers) await peer.close()
      await page.close()
      return 'four players; collision addressed; feedback preference and rate limit verified'
    })

    for (const id of ['drone', 'dog', 'vacuum', 'kart', 'pinball', 'submarine']) await check(`3D audio: ${id} gesture, motion and action sources`, async () => {
      const { page, stats } = await screen(id)
      const p = await phone(await page.evaluate(() => window.__obpal.pairingUrl))
      await page.waitForFunction(id => window.__sim.claims.holder(`${id}1`), id)
      await record(page)
      if (id === 'drone') {
        await page.getByRole('button', { name: 'Overview', exact: true }).click()
        await p.drive('.gp-f[data-k="a"]', 0, 0, 160)
        await sleep(1200)
        await p.drive('.gp-stick[data-stick="1"]', 45, -40, 2200)
      } else if (id === 'dog') {
        await p.drive('.gp-stick[data-stick="0"]', 10, -50, 3200)
        assert.ok(await page.evaluate(() => window.__simAudio.haptics > 0), 'gait and servo feedback reached the owned dog')
      } else if (id === 'vacuum') {
        await page.evaluate(() => { const u = window.__device.logic.units[0]; u.clean = true; u.docked = false })
        await p.page.locator('[data-tab="rotate"]').click()
        await p.drive('#pad', 10, -50, 3200)
        const recording = await page.evaluate(async () => { const s = window.__simAudio; await s.samplesReady; return { loaded: !!s.samples.get('suction'), bytes: s.samples.bytes } })
        assert.ok(recording.loaded && recording.bytes < 150000, 'suction recording loaded only for this sim')
      } else if (id === 'pinball') { await p.drive('.gp-trig[data-trig="1"]', 0, 0, 900); await sleep(2800) }
      else if (id === 'kart') await p.drive('.gp-trig[data-trig="1"]', 0, 0, 3200)
      else { await p.drive('.gp-stick[data-stick="0"]', 25, -55, 2200); await p.page.keyboard.press('Space'); await sleep(1000) }
      const s = await stats()
      assert.ok(s.scheduled >= (id === 'drone' ? 2 : 3), `${id} generated sources: ${s.scheduled}`)
      if (id === 'drone') assert.ok(s.motors > 0, 'rotor spool-up replaces the old artificial launch impact')
      assert.ok(s.active <= 32)
      const spatial = await page.evaluate(() => {
        const s = window.__simAudio, c = window.__device.stage.camera, l = s.context.listener
        return { hrtf: s.strips.every(v => v.pan.panningModel === 'HRTF'), distance: Math.hypot(l.positionX.value - c.position.x, l.positionY.value - c.position.y, l.positionZ.value - c.position.z) }
      })
      assert.ok(spatial.hrtf && spatial.distance < 2, 'listener follows active camera and all strips use HRTF')
      await saveRecording(page, join(out, `${id}.webm`))
      await page.screenshot({ path: join(out, `after-${id}.png`) })
      measurements.push({ sim: id, players: 1, samples: [s] })
      // Muting releases loops; reduced sound is separate from reduced motion.
      await page.locator('#sim-sound').click()
      assert.equal(await page.evaluate(() => window.__simAudio.muted), true)
      assert.equal(await page.evaluate(() => window.__simAudio.budget.active), 0)
      await page.getByLabel('Reduced sound', { exact: true }).check()
      assert.equal(await page.evaluate(() => window.__simAudio.reduced), true)
      await p.close(); await page.close()
    })

    await check('3D audio: dominant servo voices share HRTF positions without cutting each other off', async () => {
      const { page } = await screen('arm')
      await page.evaluate(() => window.__simAudio.setMuted(true))
      await page.waitForFunction(() => window.__simAudio.groups.size === 0)
      const graph = await page.evaluate(() => {
        const s = window.__simAudio; s.setMuted(false)
        for (let i = 0; i < 8; i++) s.bus.emit({ kind: 'motor', source: `group-test-${i}`, spatialGroup: i < 4 ? 'left-arm' : 'right-arm', at: [i < 4 ? -1 : 1, i * 0.05, 0], strength: 0.6, rpm: 0.2 + i * 0.08, load: 0.5 })
        const voices = s.strips.filter(v => v.source && v.group)
        return { voices: voices.length, groups: s.groups.size, rates: new Set(voices.map(v => v.feeds[0].rate)).size, hrtf: [...s.groups.values()].every(g => g.pan.panningModel === 'HRTF') }
      })
      assert.deepEqual(graph, { voices: 6, groups: 2, rates: 6, hrtf: true })
      assert.ok(await page.evaluate(() => {
        const s = window.__simAudio
        s.bus.emit({ kind: 'motor', source: 'owned-quiet', spatialGroup: 'left-arm', at: [-1, 0, 0], who: 'host', strength: 0.05, rpm: 0.05, load: 0.1 })
        return s.budget.slots.some(v => v.active && v.key === 'owned-quiet:motor')
      }), 'an owned quiet joint outranks unowned machinery in the same arm')
      await page.evaluate(() => {
        const s = window.__simAudio, index = s.budget.slots.findIndex(v => v.key === 'group-test-1:motor')
        s.strips[index].until = 0; s.tick(performance.now() + 100)
      })
      await page.waitForFunction(() => window.__simAudio.groups.get('left-arm')?.strips.size === 2)
      assert.equal(await page.evaluate(() => window.__simAudio.groups.get('right-arm')?.strips.size), 3)
      await page.evaluate(() => window.__simAudio.setMuted(true))
      await page.waitForFunction(() => window.__simAudio.groups.size === 0)
      await page.close()
    })

    await check('3D audio: arm servos and a falling block use the same spatial engine', async () => {
      const { page, stats } = await screen('arm')
      await page.waitForFunction(() => !!window.__arm)
      await record(page)
      const at = await page.evaluate(() => { const s = window.__arm.stand('a1'); return { x: s.x * 0.5, z: s.z * 0.5 } })
      await page.evaluate(({ x, z }) => window.__arm.placeBlock(0, x, z, 25), at)
      const go = async (h, open, ms) => {
        await page.evaluate(({ x, z, h, open }) => { const pose = window.__arm.solve('a1', x, z, h); if (!pose) throw Error('unreachable'); window.__arm.goTo('a1', pose, open) }, { ...at, h, open })
        await sleep(ms)
      }
      await go(0.22, 1, 2500)
      for (let h = 0.2; h >= 0.035; h -= 0.015) await go(h, 1, 150)
      await go(0.035, 1, 600); await go(0.035, 0, 1500)
      assert.equal(await page.evaluate(() => window.__arm.blocks()[0]), 'a1')
      for (let h = 0.05; h <= 0.25; h += 0.03) await go(h, 0, 120)
      await sleep(1200); await go(0.25, 1, 1600)
      const s = await stats(); assert.ok(s.contacts > 0 && s.scheduled > 3)
      measurements.push({ sim: 'arm', players: 0, samples: [s] })
      await saveRecording(page, join(out, 'arm.webm')); await page.screenshot({ path: join(out, 'after-arm.png') })
      await page.close()
    })
    await check('3D audio: no browser errors', async () => assert.deepEqual(errors, []))
  } finally {
    await browser.close()
    await writeFile(join(out, 'measurements.json'), JSON.stringify(measurements, null, 2))
    console.log(`  Audio evidence: ${out}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const port of [process.env.OBPAL_E2E_PORT, process.env.OBPAL_E2E_WORKER_PORT]) {
    assert.ok(port, 'assigned ports required')
    await new Promise((ok, no) => { const s = createServer(); s.once('error', no); s.listen(Number(port), '127.0.0.1', () => s.close(ok)) })
  }
  const local = await startLocal(); let failures = 0
  try { await runAudio(local, async (name, fn) => { try { console.log(`PASS ${name}: ${await fn() ?? ''}`) } catch (e) { failures++; console.error(`FAIL ${name}`, e) } }) }
  finally { await local.close() }
  process.exitCode = failures ? 1 : 0
}

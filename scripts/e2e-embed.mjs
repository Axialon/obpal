/**
 * The embed end to end (PLAN §10 step 3): the /embed/ demo (a plain three.js scene with <obpal-remote>) from this
 * checkout's build, served by the local stand-in, and emulated phones. The stand-in's room service is this checkout's
 * worker (scripts/local-worker.mjs, `wrangler dev` on OBPAL_E2E_WORKER_PORT, 5189 by default), for the short code.
 *   - The demo: a phone pairs through the element's code; the page hears obpal-connect and obpal-join, gives it a shape,
 *     and a drag on the phone moves it. The phone says which controller it uses (mode{c}); its tray button is an
 *     obpal-button; its scene list claims another shape; the gyro turns what it holds 1:1; leaving is an obpal-leave.
 *   - Another site: embed.js and its lazy parts load cross-origin (with the CORS headers public/_headers sends) under a
 *     strict Content Security Policy that also enforces Trusted Types, beside hostile page CSS. Nothing loads before a
 *     person is there; two elements pair separately; nothing is blocked, nothing leaks into the page's styles, a phone
 *     opens the controller the page suggests first, and another joins the second element by typing its short code.
 *   - Without WebRTC the element says so (unsupported) and the scene runs on.
 * Port 5180 (OBPAL_E2E_PORT to change it). Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>.
 * --headed to watch. OBPAL_SHOTS=<dir> saves screenshots of the demo and the phone.
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { chromium, devices } from 'playwright'
import { cspCheck } from './csp-watch.mjs'
import { startLocal } from '../extension/e2e/local.mjs'
import { startWorker } from './local-worker.mjs'

const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.OBPAL_SHOTS || ''
const PORT = Number(process.env.OBPAL_E2E_PORT) || 5180
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
// Several browsers on one machine: real host candidates instead of mDNS names, so WebRTC connects over loopback. The
// other site is a public origin reaching the stand-in on loopback, which Chrome's Local Network Access checks would stop
// (in production both are public): off for this run.
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks', '--ignore-certificate-errors']
/** The other site: served by the test itself, so it has an origin of its own. */
const SITE = 'https://another-site.test'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, fn, timeout = 10000, every = 100) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}

const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  ✗ ${name}: ${e?.message ?? e}`)
  }
}

const worker = await startWorker({ port: Number(process.env.OBPAL_E2E_WORKER_PORT) || 5189 })
const local = await startLocal({ port: PORT, upstream: worker.origin })
const browser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
let exitCode = 0
try {
  console.log(`ob.Pal embed e2e (${local.origin})`)

  /** An emulated phone that opens a pairing link and waits for its controls. */
  async function phoneFor(invite) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(invite)
    await page.locator('.modes').waitFor({ timeout: 25000 }).catch(async (e) => {
      const says = await page.evaluate(() => document.querySelector('.msg')?.textContent?.trim() ?? document.body.innerText.slice(0, 200)).catch(() => '')
      await ctx.close()
      throw new Error(`the phone didn't connect: “${says}” (${e.message.split('\n')[0]})`)
    })
    await page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    return { ctx, page, cdp: await ctx.newCDPSession(page) }
  }
  /** A one-finger drag across the phone's trackpad. */
  async function drag(phone, dx, dy = 0) {
    const box = await phone.page.locator('#pad').boundingBox()
    const x = box.x + box.width / 2 - dx / 2
    const y = box.y + box.height / 2 - dy / 2
    await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    for (let i = 1; i <= 12; i++) {
      await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 12, y: y + (dy * i) / 12, id: 1 }] })
      await sleep(24)
    }
    await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(300)
  }
  /** Open the phone's scene list and pick a node by name. */
  async function pick(phone, name) {
    await phone.page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    await phone.page.locator('.scene-btn').click()
    const cell = phone.page.locator('.pick', { hasText: name }).first()
    await cell.waitFor({ timeout: 5000 })
    await cell.click()
    await sleep(400)
  }

  // ---- the demo, on ob.Pal's own site ----

  const screenErrors = []
  const screenCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
  const screen = await screenCtx.newPage()
  screen.on('pageerror', (e) => screenErrors.push(e.message))
  await screen.goto(`${local.origin}/embed/`)
  const demo = (fn, arg) => screen.evaluate(fn, arg)
  /** Where each shape is, who holds it, and who is here, as the page sees them. */
  const state = () => demo(() => {
    const { pal, shapes, events } = window.__demo
    return {
      shapes: Object.fromEntries(shapes.map((s) => [s.id, { x: s.pos.x, y: s.pos.y, q: s.obj.quaternion.toArray(), holder: pal.holder(s.id) }])),
      people: pal.participants.map((p) => ({ id: p.id, name: p.name, controller: p.controller ?? null })),
      events: [...events],
      open: pal.open,
    }
  })

  let invite = ''
  await check('the demo starts its remote (open), and the code sits in the element’s shadow root', async () => {
    invite = await until('the pairing link', () => demo(async () => (await document.querySelector('obpal-remote').ready)?.pairingUrl ?? ''), 20000)
    const qr = await until('the QR code', () => demo(() => {
      const chip = document.querySelector('obpal-remote').shadowRoot.querySelector('.obpal-chip')
      const svg = chip?.shadowRoot.querySelector('.qr svg')
      return svg ? { w: svg.parentElement.offsetWidth, inDocument: !!document.querySelector('.qr, .obpal-card, svg path[fill=black]') } : null
    }), 8000)
    if (qr.inDocument) throw new Error('the code is in the page’s own DOM')
    if (new URL(invite).origin !== local.origin) throw new Error(`pairs through ${new URL(invite).origin}`)
    if (SHOTS) { await sleep(900); await screen.screenshot({ path: join(SHOTS, 'embed-demo.png') }) }
    return `${qr.w}px code; ${new URL(invite).pathname}`
  })

  let phone
  await check('a phone pairs through the element: obpal-connect, obpal-join, and the page gives it a shape', async () => {
    phone = await phoneFor(invite)
    const s = await until('the phone holds a shape', async () => { const v = await state(); return v.people.length && v.shapes.cube.holder ? v : null }, 20000)
    for (const e of ['obpal-connect', 'obpal-join']) if (!s.events.includes(e)) throw new Error(`the page heard ${s.events.join(', ')}`)
    if (s.shapes.cube.holder !== s.people[0].id) throw new Error(`cube held by ${s.shapes.cube.holder}`)
    await until('the QR footprint keeps its matching seal once the phone is in', async () => {
      const seal = screen.locator('.seal-stage .connection-seal').first()
      if (!(await state()).open || !(await seal.isVisible())) return false
      return await seal.getAttribute('data-seal') === await phone.page.locator('.link-badge .connection-seal').getAttribute('data-seal')
    }, 5000)
    await until('the phone shows what it holds', () => phone.page.evaluate(() => document.querySelector('#pad-part .pp-name')?.textContent === 'Cube'), 8000)
    return `${s.people[0].name} holds the cube; the QR footprint keeps its matching seal`
  })

  await check('the phone says which controller it uses (mode{c}): the trackpad, then the Wii remote', async () => {
    const who = () => state().then((v) => v.people[0]?.controller)
    await until('face.trackpad', async () => (await who()) === 'face.trackpad', 5000)
    await phone.page.locator('.modes [data-tab=point]').click()
    await until('face.wii', async () => (await who()) === 'face.wii', 5000)
    await phone.page.locator('.modes [data-tab=rotate]').click()
    await until('face.trackpad again', async () => (await who()) === 'face.trackpad', 5000)
    const modes = (await state()).events.filter((e) => e === 'obpal-mode').length
    return `obpal-mode ×${modes}`
  })

  await check('a drag on the phone (no motion sensors here) moves the shape it holds, and only that one', async () => {
    const before = (await state()).shapes
    await drag(phone, 150)
    const after = await until('the cube moved', async () => { const v = (await state()).shapes; return v.cube.x - before.cube.x > 0.5 ? v : null }, 5000)
    for (const id of ['knot', 'orb']) if (Math.abs(after[id].x - before[id].x) > 1e-6) throw new Error(`${id} moved too`)
    if (SHOTS) { await sleep(500); await screen.screenshot({ path: join(SHOTS, 'embed-demo-held.png') }); await phone.page.screenshot({ path: join(SHOTS, 'embed-phone.png') }) }
    return `cube x ${before.cube.x.toFixed(2)} → ${after.cube.x.toFixed(2)}`
  })

  await check('the tray button the page added fires obpal-button, and Reset puts the shape back', async () => {
    await phone.page.locator('.tray-btn[aria-label="Reset"]').click()
    const s = await until('reset', async () => { const v = await state(); return Math.abs(v.shapes.cube.x + 2) < 1e-3 ? v : null }, 5000)
    if (!s.events.includes('obpal-button')) throw new Error(`no obpal-button in ${s.events.join(', ')}`)
    return 'cube back at x −2'
  })

  await check('picking another shape from the phone’s scene list claims it (obpal-claim); the drag moves that one', async () => {
    await pick(phone, 'Knot')
    const s = await until('the knot held', async () => { const v = await state(); return v.shapes.knot.holder ? v : null }, 5000)
    if (s.shapes.cube.holder) throw new Error('the cube is still held')
    if (!s.events.includes('obpal-claim')) throw new Error('no obpal-claim')
    const before = s.shapes.knot.x
    await drag(phone, -150)
    const after = await until('the knot moved', async () => { const v = (await state()).shapes; return before - v.knot.x > 0.5 ? v : null }, 5000)
    return `knot x ${before.toFixed(2)} → ${after.knot.x.toFixed(2)}`
  })

  await check('with motion, the gyro turns what the phone holds 1:1', async () => {
    // The phone's sensors come alive (dispatched as a real phone's would be), then its gyro goes on.
    await phone.page.evaluate(() => {
      const m = (window.__m = { alpha: 0, beta: 50, gamma: 0 })
      setInterval(() => {
        dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: m.alpha, beta: m.beta, gamma: m.gamma, absolute: false }))
        dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 7.5, z: 6.3 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }))
      }, 16)
    })
    await sleep(1500)
    await phone.page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    await phone.page.locator('#gyro').click()
    await until('the gyro on', () => phone.page.evaluate(() => document.getElementById('gyro').getAttribute('aria-pressed') === 'true'), 5000)
    await sleep(400)
    const q0 = (await state()).shapes.knot.q
    await phone.page.evaluate(() => { window.__m.alpha = 40 })
    const turned = await until('the knot turned', async () => {
      const q = (await state()).shapes.knot.q
      const dot = Math.abs(q.reduce((s, v, i) => s + v * q0[i], 0))
      const deg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
      return deg > 20 ? deg : null
    }, 6000)
    await phone.page.locator('#gyro').click()
    return `a 40° turn of the phone turned the knot ${turned.toFixed(0)}°`
  })

  await check('the phone leaving is an obpal-leave, and frees what it held', async () => {
    await phone.ctx.close()
    const s = await until('the phone gone', async () => { const v = await state(); return v.people.length === 0 ? v : null }, 20000)
    if (!s.events.includes('obpal-leave')) throw new Error('no obpal-leave')
    if (Object.values(s.shapes).some((x) => x.holder)) throw new Error('a shape is still held')
    return 'nothing held'
  })

  await check('no page errors in the demo', async () => { if (screenErrors.length) throw new Error(screenErrors.join(' | ')) })

  if (SHOTS) {
    const small = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true })
    const p = await small.newPage()
    await p.goto(`${local.origin}/embed/`)
    // A touch is a person here: the chip comes.
    await p.touchscreen.tap(200, 300)
    await sleep(2500)
    await p.screenshot({ path: join(SHOTS, 'embed-demo-narrow.png') })
    await small.close()
  }

  // ---- another site: cross-origin, a strict CSP, hostile CSS, two elements ----

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-e2e' ${local.origin}`,
    "style-src 'nonce-e2e'",
    `connect-src ${local.origin} ${local.origin.replace('https', 'wss')}`,
    "img-src 'none'",
    "base-uri 'none'",
    // No markup may be parsed from strings: the chip builds its elements and its QR code.
    "require-trusted-types-for 'script'",
  ].join('; ')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Another site</title>
<style nonce="e2e">
  *, *::before, *::after { box-sizing: content-box !important; font: 31px/3 "Comic Sans MS", cursive !important; color: #f0f !important; letter-spacing: 4px !important; }
  div, button, span, a, svg, p { background: yellow !important; border: 6px dotted red !important; padding: 18px !important; margin: 9px !important; }
</style>
<script nonce="e2e">
  window.__site = { violations: [], events: [] }
  addEventListener('securitypolicyviolation', (e) => window.__site.violations.push(e.violatedDirective + ' ' + e.blockedURI))
  for (const t of ['obpal-status', 'obpal-join', 'obpal-connect']) addEventListener(t, (e) => window.__site.events.push(e.target.id + ' ' + t + ' ' + (e.detail.status ?? e.detail.participant?.controller ?? '')))
</script>
<script type="module" src="${local.origin}/embed.js"></script>
</head><body><h1>Another site</h1><p>Some text.</p>
<obpal-remote id="left" app="Left" modes="face.wii face.trackpad"></obpal-remote>
<obpal-remote id="right" app="Right" corner="bottom-left" accent="#38bdf8" scheme="light"></obpal-remote>
</body></html>`
  const siteErrors = []
  const site = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage()
  site.on('pageerror', (e) => siteErrors.push(e.message))
  const requests = []
  site.on('request', (r) => requests.push(r.url()))
  await site.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': csp }, body: html }))
  // What public/_headers sends for the embed on obpal.blackboxes.net: the stand-in only serves files.
  await site.route((url) => url.origin === local.origin && (url.pathname === '/embed.js' || url.pathname.startsWith('/assets/embed/')), async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } })
  })
  const headBefore = await (async () => { await site.goto(`${SITE}/`); return site.evaluate(() => document.head.children.length) })()

  await check('on another site nothing but embed.js loads until a person is there', async () => {
    await sleep(1200)
    const early = requests.filter((u) => u.startsWith(local.origin))
    if (early.some((u) => u.includes('/assets/embed/'))) throw new Error(`loaded early: ${early.join(', ')}`)
    if (!early.some((u) => u.endsWith('/embed.js'))) throw new Error('embed.js did not load')
    const status = await site.evaluate(() => [...document.querySelectorAll('obpal-remote')].map((e) => e.status))
    if (status.some((s) => s !== 'idle')) throw new Error(`already ${status.join(', ')}`)
    return `${early.length} request (embed.js), both idle`
  })

  let leftInvite = ''
  await check('a mouse move starts both, each with its own code, in its own shadow root', async () => {
    await site.mouse.move(400, 300)
    await site.mouse.move(420, 310)
    const urls = await until('both ready', () => site.evaluate(() => {
      const els = [...document.querySelectorAll('obpal-remote')]
      return els.every((e) => e.pairingUrl) ? els.map((e) => e.pairingUrl) : null
    }), 20000)
    if (urls[0] === urls[1]) throw new Error('the two elements share a code')
    leftInvite = urls[0]
    const chunks = requests.filter((u) => u.includes('/assets/embed/'))
    await site.evaluate(() => { document.getElementById('right').open = true })
    await until('the right one’s code', () => site.evaluate(() => !!document.getElementById('right').shadowRoot.querySelector('.obpal-chip').shadowRoot.querySelector('.qr svg')), 8000)
    return `${new Set(chunks).size} lazy chunk(s) for two elements`
  })

  await check('under a strict CSP nothing is blocked, and the page’s styles gain nothing', async () => {
    // Both reach the room service (connect-src lets the script's own origin through), so both wait for a phone.
    await until('both ready', () => site.evaluate(() => [...document.querySelectorAll('obpal-remote')].every((e) => e.status === 'ready')), 10000)
    const v = await site.evaluate(() => ({
      violations: window.__site.violations,
      head: document.head.children.length,
      sheets: document.adoptedStyleSheets.length,
      styles: document.querySelectorAll('style').length,
    }))
    if (v.violations.length) throw new Error(`CSP violations: ${v.violations.join(' | ')}`)
    if (v.head !== headBefore || v.sheets || v.styles !== 1) throw new Error(`the page changed: ${JSON.stringify(v)} (head had ${headBefore})`)
    if (siteErrors.length) throw new Error(siteErrors.join(' | '))
    return 'no violations; head, sheets and styles untouched'
  })

  await check('the hostile page CSS doesn’t reach the chips', async () => {
    const look = await site.evaluate(() => [...document.querySelectorAll('obpal-remote')].map((e) => {
      const root = e.shadowRoot.querySelector('.obpal-chip').shadowRoot
      const chip = root.querySelector('.pill')
      const cs = getComputedStyle(chip)
      const qr = root.querySelector('.qr')
      const r = chip.getBoundingClientRect()
      return { h: Math.round(r.height), bottom: Math.round(innerHeight - r.bottom), size: cs.fontSize, bg: cs.backgroundColor, color: cs.color, spacing: cs.letterSpacing, qr: qr.offsetWidth }
    }))
    for (const l of look) {
      if (l.h !== 44 || l.size !== '14px' || l.color === 'rgb(255, 0, 255)' || l.bg === 'rgb(255, 255, 0)' || l.spacing !== 'normal') throw new Error(JSON.stringify(look))
    }
    // The code's plate at its laid-out size (the card may still be growing in).
    if (look[1].qr !== 168) throw new Error(`the right chip’s code is ${look[1].qr}px`)
    // In front, so it draws frames and the opened card finishes coming in.
    if (SHOTS) { await site.bringToFront(); await sleep(500); await site.screenshot({ path: join(SHOTS, 'embed-another-site.png') }) }
    return look.map((l) => `${l.h}px chip, ${l.size}, ${l.bottom}px from the bottom`).join('; ')
  })

  await check('a phone pairs cross-origin with one of them, and opens the controller that page suggests first', async () => {
    const p = await phoneFor(leftInvite)
    const joined = await until('left joined', () => site.evaluate(() => document.getElementById('left').participants.map((x) => x.controller)), 20000, 200)
    const tab = await until('Point open', () => p.page.evaluate(() => document.querySelector('.modes [aria-selected=true]')?.dataset.tab === 'point' ? 'point' : null), 8000)
    const who = await until('face.wii', () => site.evaluate(() => document.getElementById('left').participants[0]?.controller === 'face.wii'), 5000)
    const right = await site.evaluate(() => document.getElementById('right').participants.length)
    if (right) throw new Error('the phone joined the other element too')
    await p.ctx.close()
    return `the phone opened ${tab} (${joined.join(', ') || '…'} → face.wii: ${who})`
  })

  await check('the second element shows a short code under Trusted Types, and a phone that types it joins that element', async () => {
    const shown = await until('its code', () => site.evaluate(() => {
      const root = document.getElementById('right').shadowRoot.querySelector('.obpal-chip').shadowRoot
      const box = root.querySelector('.code-box')
      return box && !box.hidden && !box.hasAttribute('data-wait') ? { code: root.querySelector('.code').textContent, at: root.querySelector('.site').textContent } : null
    }), 10000)
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/p/`)
    await page.locator('#code-in').pressSequentially(shown.code, { delay: 20 })
    await page.locator('.modes').waitFor({ timeout: 25000 })
    const joined = await until('the right element joined', () => site.evaluate(() => document.getElementById('right').participants.length), 10000)
    const v = await site.evaluate(() => window.__site.violations)
    await ctx.close()
    if (v.length) throw new Error(`CSP or Trusted Types violations: ${v.join(' | ')}`)
    if (siteErrors.length) throw new Error(siteErrors.join(' | '))
    return `typed ${shown.code} at ${shown.at}; ${joined} on the right element; no violations`
  })

  await check('removing an element ends its remote; one moved in the page keeps it', async () => {
    const r = await site.evaluate(async () => {
      const left = document.getElementById('left')
      const url = left.pairingUrl
      document.body.prepend(left)
      await new Promise((res) => setTimeout(res, 50))
      const kept = left.pairingUrl === url && left.status !== 'idle'
      left.remove()
      await new Promise((res) => setTimeout(res, 50))
      return { kept, after: left.status, remote: left.remote }
    })
    if (!r.kept) throw new Error('moving it restarted it')
    if (r.after !== 'idle' || r.remote) throw new Error(`still ${r.after}`)
    return 'moved: kept; removed: idle'
  })

  await check('an element loaded before a deploy gets the new lazy chunk on first input', async () => {
    const entry = await readFile(new URL('../dist/client/embed.js', import.meta.url), 'utf8')
    const oldChunk = entry.match(/assets\/embed\/element-host-[\w-]+\.js/)?.[0]
    if (!oldChunk) throw new Error('the embed entry has no lazy host chunk')
    const newChunk = 'assets/embed/element-host-deployed.js'
    const chunk = await readFile(new URL(`../dist/client/${oldChunk}`, import.meta.url))
    for (const failRefresh of [false, true]) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
      const p = await ctx.newPage()
      const fetched = []
      let deployed = false
      let refreshUnavailable = false
      try {
        p.on('request', (r) => { if (r.url().startsWith(local.origin)) fetched.push(r.url()) })
        await p.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Deploy test</title><script type="module" src="${local.origin}/embed.js"></script><obpal-remote></obpal-remote>` }))
        await p.route((url) => url.origin === local.origin && (url.pathname === '/embed.js' || url.pathname.startsWith('/assets/embed/')), (route) => {
          const path = route.request().url().split('?')[0].slice(local.origin.length + 1)
          const headers = { 'access-control-allow-origin': '*' }
          if (path === 'embed.js') return route.fulfill({ status: refreshUnavailable ? 503 : 200, contentType: 'text/javascript', headers, body: deployed ? entry.replaceAll(oldChunk, newChunk) : entry })
          if (path === newChunk && deployed) return route.fulfill({ status: 200, contentType: 'text/javascript', headers, body: chunk })
          if (path === oldChunk && deployed) return route.fulfill({ status: 404, contentType: 'text/plain', headers, body: 'old build removed' })
          return route.continue()
        })
        await p.goto(`${SITE}/`)
        await p.waitForFunction(() => customElements.get('obpal-remote'))
        if (fetched.some((url) => url.includes('/assets/embed/'))) throw new Error('the chunk loaded before input')
        deployed = true
        refreshUnavailable = failRefresh
        await p.evaluate(() => document.querySelector('obpal-remote').start())
        const element = p.locator('obpal-remote')
        if (failRefresh) {
          const retry = element.locator('button.retry')
          if (await element.evaluate((el) => el.status) !== 'error' || !(await retry.count())) throw new Error('failed refresh did not show Retry')
          if (fetched.filter((url) => url.includes('/embed.js?')).length !== 1) throw new Error('the failed load refreshed more than once')
          refreshUnavailable = false
          await retry.click()
        }
        await until('the element ready after the deploy', () => element.evaluate((el) => el.status === 'ready'), 10000)
        if (!fetched.some((url) => url.includes(oldChunk)) || !fetched.some((url) => url.includes(newChunk))) throw new Error(`did not switch chunks: ${fetched.join(', ')}`)
        if (!fetched.some((url) => url.includes('/embed.js?'))) throw new Error('the fresh entry was not cache-busted')
      } finally { await ctx.close() }
    }
    return 'old chunk 404, fresh entry and chunk loaded; failed refresh showed Retry and recovered'
  })

  // ---- no WebRTC ----

  await check('without WebRTC the element says it can’t pair (unsupported), and the scene runs on', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    await ctx.addInitScript(() => { delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection })
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(`${local.origin}/embed/`)
    const ready = await p.evaluate(async () => (await document.querySelector('obpal-remote').ready) === null)
    const s = await until('unsupported', () => p.evaluate(() => {
      const el = document.querySelector('obpal-remote')
      const note = document.getElementById('note')
      return el.status === 'unsupported' ? { note: note.hidden ? '' : note.textContent, chip: !!el.shadowRoot.querySelector('.obpal-chip'), frame: el.frame().connected } : null
    }), 8000)
    const moving = await p.evaluate(async () => {
      const s = window.__demo.shapes[0]
      const y0 = s.obj.position.y
      await new Promise((res) => setTimeout(res, 400))
      return Math.abs(s.obj.position.y - y0) > 1e-4
    })
    await ctx.close()
    if (!ready || s.chip || s.frame || !s.note || !moving || errors.length) throw new Error(JSON.stringify({ ready, ...s, moving, errors }))
    return `“${s.note}”`
  })
  await check('no Content Security Policy violations on any page', cspCheck)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await browser.close().catch(() => {})
  await local.close()
  await worker.close()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed.length || exitCode ? 1 : 0)

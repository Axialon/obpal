/**
 * Shared scenes end to end (CATALOGUE §5): the Viewer from this checkout's build, served by the local stand-in for
 * obpal.blackboxes.net (extension/e2e/local.mjs, signaling through this checkout's own worker), and two emulated phones that join
 * through its one invite link.
 *   - Both join, each with its own colour; the first is the lead.
 *   - Each claims a node from its scene list; a node someone else holds is refused, with a toast naming who has it.
 *   - The screen shows each hold in its participant's colour.
 *   - A phone that leaves frees what it held, and the lead passes on.
 *   - The screen can remove a phone, which then shows that it left and doesn't rejoin.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { tempScope, keepTemp } from './lib/temp.mjs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { cspCheck } from './csp-watch.mjs'
import { startLocal } from '../extension/e2e/local.mjs'
import assert from 'node:assert/strict'
import { measureButtonInk, inkError } from './lib/button-ink.mjs'

const temps = tempScope()
try {

const HEADED = process.argv.includes('--headed')
/** Where to save screenshots of the scene, the people panel and a phone (optional). */
const SHOTS = process.env.OBPAL_SHOTS || ''
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
// Several browsers on one machine: real host candidates instead of mDNS names, so WebRTC connects over loopback.
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors']
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

async function guestViews(guest) {
  for (const width of [1280, 390]) {
    await guest.setViewportSize({ width, height: 800 })
    for (const mode of ['overview', 'first-person', 'xr']) {
      await guest.evaluate(mode => window.__presence.experience.setMode(mode), mode)
      await guest.evaluate(() => document.fonts.ready)
      await guest.waitForTimeout(80)
      const chip = guest.locator('.guest-status'); assert(await chip.isVisible())
      const rect = await chip.boundingBox(), viewport = guest.viewportSize()
      assert(rect.x >= 0 && rect.x + rect.width <= viewport.width && rect.y >= 0 && rect.y + rect.height <= viewport.height)
      const ink = (await guest.evaluate(measureButtonInk)).find(r => r.classes.includes('guest-status'))
      assert(ink && inkError(ink) <= .5, `chip ink offset ${JSON.stringify(ink?.groupOffset)}`)
    }
  }
}

const local = await startLocal()
const profiles = []
const browsers = []
let exitCode = 0
try {
  console.log('ob.Pal shared scene e2e')
  const screenBrowser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  browsers.push(screenBrowser)
  const screenCtx = await screenBrowser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  // A model with semantic nodes (Box'em core: time, cost, quality, scope).
  await screenCtx.addInitScript(() => { try { localStorage.setItem('obpal.view.model', 'boxem') } catch { /* private */ } })
  const screen = await screenCtx.newPage()
  await screen.goto(`${local.origin}/view/`)
  const invite = await until('invite link', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
  console.log(`  viewer ${local.origin}/view/ · invite ${new URL(invite).origin}`)

  /** The screen's view of the scene: participants, and who holds which part (by title). */
  const scene = () => screen.evaluate(() => {
    const r = window.__obpal
    const { parts } = window.__viewer
    return {
      people: r.participants.map((p) => ({ id: p.id, name: p.name, color: p.color, lead: p.lead })),
      holds: parts.holders().map((h) => ({ who: h.id, part: h.selected.title, color: h.color })),
    }
  })

  const phones = []
  async function joinPhone({ xr = false } = {}) {
    const dir = await temps.make(join(tmpdir(), 'obpal-shared-'))
    profiles.push(dir)
    const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
    browsers.push(ctx)
    // WebXR as an Android phone with ARCore has it, reporting whatever pose the test sets (window.__fakePose).
    if (xr) await ctx.addInitScript(() => {
      // 3D by the camera (WebXR), as chosen in settings.
      try { localStorage.setItem('obpal.track3d', 'xr') } catch { /* private */ }
      window.__fakePose = { p: [0, 0, 0], q: [0, 0, 0, 1], tracked: true }
      class FakeSession extends EventTarget {
        constructor() { super(); this.renderState = { baseLayer: null } }
        updateRenderState(r) { this.renderState = { ...this.renderState, ...r } }
        async requestReferenceSpace() { return {} }
        requestAnimationFrame(cb) {
          return setTimeout(() => cb(performance.now(), {
            getViewerPose: () => {
              const f = window.__fakePose
              return { transform: { position: { x: f.p[0], y: f.p[1], z: f.p[2] }, orientation: { x: f.q[0], y: f.q[1], z: f.q[2], w: f.q[3] } }, emulatedPosition: !f.tracked }
            },
          }), 16)
        }
        async end() { this.dispatchEvent(new Event('end')) }
      }
      Object.defineProperty(navigator, 'xr', { configurable: true, value: { isSessionSupported: async (m) => m === 'immersive-ar', requestSession: async () => new FakeSession() } })
      window.XRWebGLLayer = class { constructor() { this.framebuffer = null } }
    })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(invite)
    await page.locator('.modes').waitFor({ timeout: 25000 })
    const phone = { ctx, page }
    phones.push(phone)
    return phone
  }
  /** Open the phone's scene list and tap a node by its name; returns the phone's toast, if any. */
  async function claimOn(phone, name) {
    await phone.page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    await phone.page.locator('.scene-btn').click()
    const cell = phone.page.locator('.pick', { hasText: name }).first()
    await cell.waitFor({ timeout: 5000 })
    await cell.click()
    await sleep(400)
    return phone.page.evaluate(() => document.getElementById('toast')?.textContent ?? '')
  }

  await check('watchers stay visible, never lead or ask for approval, and show host left', async () => {
    const ctx = await screenBrowser.newContext({ ignoreHTTPSErrors: true })
    let releaseIce
    const iceGate = new Promise(resolve => { releaseIce = resolve })
    try {
      const host = await ctx.newPage()
      await host.goto(`${local.origin}/sim/arm/?test=vr`)
      await host.waitForFunction(() => window.__presence && window.__obpal?.pairingUrl)
      const url = new URL(await host.evaluate(() => window.__presence.shared.shareUrl())); url.searchParams.set('test', 'vr')
      const guest = await ctx.newPage()
      await guest.route('**/api/ice*', async route => { await iceGate; await route.continue() })
      await guest.goto(url.href)
      await guest.waitForFunction(() => window.__presence?.shared.status === 'Connecting')
      await guestViews(guest)
      releaseIce()
      await guest.waitForFunction(() => window.__presence?.shared.status === 'Live')
      assert.equal(await host.evaluate(() => window.__obpal.participants.some(p => p.lead)), false)
      const phone = await ctx.newPage(); await phone.goto(await host.evaluate(() => window.__obpal.pairingUrl))
      await phone.locator('.modes').waitFor({ timeout: 25000 })
      await host.waitForFunction(() => window.__obpal.participants.length === 2)
      assert.equal(await host.evaluate(() => window.__obpal.participants.find(p => p.lead)?.caps.platform !== 'scene'), true)
      await host.locator('#chip-who').click()
      assert.equal(await host.locator('#people-list li').filter({ hasText: 'Scene visitor' }).getByRole('button', { name: 'Let in' }).count(), 0)
      assert.equal(await host.locator('#log').getByText(/Let Scene visitor in/).count(), 0)
      assert.equal(await host.locator('#note').textContent().then(text => text.includes('Scene visitor wants')), false)
      await guestViews(guest)
      assert.equal(await guest.getByRole('button', { name: 'Grab', exact: true }).count(), 0)
      assert.equal(await guest.getByRole('switch', { name: 'Drive with XR sticks' }).count(), 0)
      await host.evaluate(() => window.__obpal.disconnect(window.__obpal.participants.find(p => p.caps.platform !== 'scene').id))
      await host.waitForFunction(() => window.__obpal.participants.length === 1)
      assert.equal(await host.evaluate(() => window.__obpal.participants.some(p => p.lead)), false)
      await host.evaluate(() => window.__obpal.disconnect(window.__obpal.participants[0].id))
      await guest.waitForFunction(() => window.__presence.shared.status === 'Removed')
      await guestViews(guest)
      await guest.reload()
      await guest.waitForFunction(() => window.__presence?.shared.status === 'Live')
      await host.close()
      await guest.waitForFunction(() => window.__presence.shared.status === 'Host left')
      await guestViews(guest)
      await guest.reload()
      await guest.waitForFunction(() => window.__presence?.shared.status === 'Waiting for host')
      await guestViews(guest)
    } finally { releaseIce(); await ctx.close() }
  })

  await check('a Viewer guest follows the host model and cannot choose or open another', async () => {
    const ctx = await screenBrowser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
    try {
      const guest = await ctx.newPage()
      const url = new URL(`${local.origin}/view/?join=1&test=vr`); url.hash = new URL(invite).hash
      await guest.goto(url.href)
      await guest.waitForFunction(() => window.__presence?.shared.status === 'Live' && document.querySelector('#cap-name')?.textContent === "Box'em core")
      assert(await guest.locator('.tile').first().isDisabled())
      const before = await guest.locator('#cap-name').textContent()
      await guest.keyboard.press('ArrowRight')
      await guest.evaluate(() => document.querySelector('.tile:not([aria-current="true"])')?.click())
      await sleep(300)
      assert.equal(await guest.locator('#cap-name').textContent(), before)
      assert.equal(await guest.locator('#open').isVisible(), false)
      const next = screen.locator('.tile:not([aria-current="true"])').first()
      await next.click()
      await until('host model on guest', async () => (await guest.locator('#cap-name').textContent()) === (await screen.locator('#cap-name').textContent()) && (await guest.locator('#cap-name').textContent()) !== before)
      await screen.locator('.tile[data-id="boxem"]').click()
      await until('Box’em restored', async () => (await screen.locator('#cap-name').textContent()) === before)
    } finally { await ctx.close() }
  })

  await check('the ninth room join shows full to guests and phones within 3 seconds', async () => {
    const ctx = await screenBrowser.newContext({ ignoreHTTPSErrors: true })
    try {
      const room = await screen.evaluate(() => window.__obpal.roomId)
      await screen.evaluate(async room => {
        window.__capSockets = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
          const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/r/${room}?role=device`)
          socket.onopen = () => resolve(socket); socket.onerror = reject
        })))
      }, room)
      const guest = await ctx.newPage(), phone = await ctx.newPage()
      const url = new URL(`${local.origin}/view/?join=1&test=vr`); url.hash = new URL(invite).hash
      const start = Date.now()
      await guest.goto(url.href)
      await guest.locator('.guest-status', { hasText: 'Room full' }).waitFor({ timeout: Math.max(1, 3000 - (Date.now() - start)) })
      const guestMs = Date.now() - start
      await guestViews(guest)
      const phoneStart = Date.now(); await phone.goto(invite)
      await phone.getByText('This scene is full', { exact: true }).waitFor({ timeout: Math.max(1, 3000 - (Date.now() - phoneStart)) })
      return `guest ${guestMs} ms; phone ${Date.now() - phoneStart} ms`
    } finally {
      await screen.evaluate(() => window.__capSockets?.forEach(s => s.close()))
      await ctx.close()
      await sleep(300)
    }
  })

  let a, b
  await check('two phones join the same scene through one invite, each in its own colour', async () => {
    a = await joinPhone({ xr: true })
    b = await joinPhone()
    const s = await until('two participants', async () => { const v = await scene(); return v.people.length === 2 ? v : null })
    if (s.people[0].color === s.people[1].color) throw new Error('both got the same colour')
    if (!s.people[0].lead || s.people[1].lead) throw new Error('the first to join should lead')
    const accents = await Promise.all(phones.map((p) => p.page.evaluate(() => document.documentElement.getAttribute('data-bb-accent'))))
    if (!accents[0] || accents[0] === accents[1]) throw new Error(`phones wear ${JSON.stringify(accents)}`)
    await until('the newest phone and screen show the same compact seal', async () => {
      const newest = await b.page.locator('.link-badge .seal-compact').getAttribute('data-seal').catch(() => '')
      const host = await screen.locator('.obpal-chip .pill .seal-compact').getAttribute('data-seal').catch(() => '')
      return newest && newest === host
    })
    await until('both connection seals persist in the QR footprint', async () => {
      const seals = await screen.locator('.obpal-chip .seal-stage .connection-seal').all()
      if (seals.length !== 2 || !(await Promise.all(seals.map(seal => seal.isVisible()))).every(Boolean)) return false
      const values = await Promise.all(seals.map(seal => seal.getAttribute('data-seal')))
      return (await Promise.all(phones.map(p => p.page.locator('.link-badge .connection-seal').getAttribute('data-seal')))).every(value => values.includes(value))
    })
    await until('scene lists on both phones', async () => (await Promise.all(phones.map((p) => p.page.locator('.scene-btn').count()))).every((n) => n > 0), 15000)
    return `${s.people.map((p) => p.color).join(' · ')}; phones wear ${accents.join(' · ')}`
  })

  await check('each claims its own node, and a node someone else holds is refused', async () => {
    await claimOn(a, 'Time')
    let s = await until('A holds Time', async () => { const v = await scene(); return v.holds.some((h) => h.part === 'Time') ? v : null })
    const aId = s.people[0].id
    if (s.holds.find((h) => h.part === 'Time').who !== aId) throw new Error(`Time is held by ${JSON.stringify(s.holds)}`)
    const toast = await claimOn(b, 'Time')
    s = await scene()
    if (s.holds.find((h) => h.part === 'Time').who !== aId) throw new Error('B took a node A holds')
    if (!/has/.test(toast)) throw new Error(`no refusal toast on B (saw "${toast}")`)
    await claimOn(b, 'Budget')
    s = await until('B holds Budget', async () => { const v = await scene(); return v.holds.some((h) => h.part === 'Budget') ? v : null })
    const colours = s.holds.map((h) => `${h.part} ${h.color}`).join(', ')
    if (SHOTS) {
      await sleep(800)
      await screen.screenshot({ path: join(SHOTS, 'shared-screen.png') })
      await screen.locator('#chip-who').click()
      await sleep(400)
      await screen.screenshot({ path: join(SHOTS, 'shared-people.png') })
      await screen.locator('#chip-who').click()
      await b.page.screenshot({ path: join(SHOTS, 'shared-phone.png') })
    }
    for (const h of s.holds) if (h.color !== s.people.find((p) => p.id === h.who)?.color) throw new Error(`halo colours ${colours}`)
    return `B was told "${toast}"; ${colours}`
  })

  await check('3D: the lead, holding nothing, moves the whole scene as the phone moves through space', async () => {
    // A lets go of Time (tapping what you hold lets it go), so its 3D moves the scene.
    await claimOn(a, 'Time')
    await until('A let go of Time', async () => !(await scene()).holds.some((h) => h.part === 'Time'), 5000)
    const where = () => screen.evaluate(() => { const p = window.__viewer.holder.position; return { x: p.x, y: p.y, z: p.z, d: window.__viewer.controls.distance } })
    await a.page.locator('.modes [data-tab=track]').click()
    await a.page.locator('#track-start').click()
    await until('tracking', () => a.page.evaluate(() => document.getElementById('surface').classList.contains('tracking')), 5000)
    const before = await where()
    const cdp = await a.ctx.newCDPSession(a.page)
    const box = await a.page.locator('#pad').boundingBox()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] })
    await sleep(300)
    for (let i = 1; i <= 10; i++) { await a.page.evaluate((y) => { window.__fakePose.p = [0, y, 0] }, 0.01 * i); await sleep(40) }
    await sleep(500)
    const after = await where()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const rise = after.y - before.y
    const want = before.d * 1.2 * 0.1
    if (rise < want * 0.5) throw new Error(`the scene rose ${rise.toFixed(3)} for a 10 cm move (about ${want.toFixed(3)} expected)`)
    // Back to Rotate, holding Time again, for the checks after this one.
    await a.page.locator('.modes [data-tab=rotate]').click()
    await claimOn(a, 'Time')
    await until('A holds Time again', async () => (await scene()).holds.some((h) => h.part === 'Time'), 5000)
    return `hand +10 cm → scene +${rise.toFixed(2)} (view distance ${before.d.toFixed(2)})`
  })

  await check('letting go shows: the chip on the phone flashes and fades out, and its control area flashes', async () => {
    // B lets go of Budget by picking it again in its scene list.
    await claimOn(b, 'Budget')
    const seen = await b.page.evaluate(() => new Promise((res) => {
      const chip = document.getElementById('pad-part')
      const area = document.getElementById('pad')
      const got = { leaving: chip.classList.contains('leaving'), flash: area.classList.contains('ctl-flash'), hiddenAtOnce: chip.hidden }
      setTimeout(() => res({ ...got, hiddenAfter: chip.hidden }), 800)
    }))
    if (!seen.leaving || seen.hiddenAtOnce) throw new Error(`chip ${JSON.stringify(seen)}`)
    if (!seen.flash) throw new Error('the control area did not flash')
    if (!seen.hiddenAfter) throw new Error('the chip stayed after fading')
    const s = await scene()
    if (s.holds.some((h) => h.part === 'Budget')) throw new Error('Budget still held')
    await claimOn(b, 'Budget')
    return 'faded out over ~0.56 s'
  })

  await check('a phone that leaves frees what it held, and the lead passes on', async () => {
    await a.page.close()
    const s = await until('A gone', async () => { const v = await scene(); return v.people.length === 1 ? v : null }, 15000)
    if (s.holds.some((h) => h.part === 'Time')) throw new Error('Time is still held')
    if (!s.people[0].lead) throw new Error('B did not become the lead')
    return `${s.people[0].name} leads; ${s.holds.map((h) => h.part).join(', ') || 'nothing'} held`
  })

  await check('the screen can remove a phone, which then shows that it left', async () => {
    const [p] = (await scene()).people
    await screen.evaluate((id) => window.__obpal.disconnect(id), p.id)
    await b.page.getByText('You left the scene').waitFor({ timeout: 8000 })
    await until('scene empty', async () => (await scene()).people.length === 0, 8000)
    await sleep(1500)
    if ((await scene()).people.length) throw new Error('the removed phone rejoined')
    return 'no rejoin'
  })
  await check('no Content Security Policy violations on any page', cspCheck)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await Promise.allSettled(browsers.map((b) => b.close()))
  await local.close()
  await Promise.allSettled(profiles.map((d) => (keepTemp() ? Promise.resolve() : rm(d, { recursive: true, force: true }))))
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exitCode = (failed.length || exitCode ? 1 : 0)

} finally { await temps.cleanup() }

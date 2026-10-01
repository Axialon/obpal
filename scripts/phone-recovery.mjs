/**
 * How the phone carries on when things aren't ideal, for e2e:phone: motion refused, and a person who disconnects and
 * comes back. The Viewer from this checkout's build is the screen; every phone is a browser emulating one.
 *   - Motion refused, as on an iPhone (or a Chrome whose site setting says no): asked at load and refused there and then
 *     (a remembered refusal), or asked by the Start gate's tap and refused then. Either way the controls come, the gyro
 *     says motion is off, the screen is told the phone is touch-only, and the trackpad still moves the screen's view.
 *   - Disconnect, then Reconnect: the Disconnected screen's button brings the phone back to the same screen with one
 *     participant, and its buttons and trackpad move the screen again.
 * Nothing here is measured. What the browser doesn't do on its own (a person tapping "Don't Allow"; sensors going
 * quiet) is played by the page's stand-ins, so this is evidence of the page's own recovery paths, not of any phone's.
 */
import { devices } from 'playwright'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 15000, every = 100) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}

/** The tiers the phone reports (packages/core/src/state.ts Tier): 0 is touch only. */
const TOUCH_ONLY = 0

/**
 * A page whose motion permission is refused, before any of its scripts. `remembered`: the request is answered
 * 'denied' at once, as a phone that was refused before does. Otherwise it needs a tap first (it rejects until the page
 * has been touched, which the controller reads as "ask again from a gesture"), and the tap's answer is 'denied'. A
 * refusal delivers no sensor events, so none are let through. `window.__asked` counts the requests.
 */
function motionRefused(remembered) {
  window.__asked = 0
  const ask = async () => {
    window.__asked++
    if (!remembered && !navigator.userActivation.isActive) throw new DOMException('A gesture is needed', 'NotAllowedError')
    return 'denied'
  }
  DeviceMotionEvent.requestPermission = DeviceOrientationEvent.requestPermission = ask
  const add = window.addEventListener
  window.addEventListener = function (type, ...rest) {
    if (type === 'deviceorientation' || type === 'devicemotion') return undefined
    return add.call(this, type, ...rest)
  }
  // The first-use hints float over the controls; they aren't what this is about.
  for (const k of ['gyro', 'models', 'more', 'point', 'lock', 'track']) try { sessionStorage.setItem(`obpal.hint.${k}`, '1') } catch { /* private */ }
}

export async function phoneRecovery({ browser, origin, check, shots }) {
  const screens = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const contexts = [screens]
  const errors = []
  screens.on('page', (p) => p.on('pageerror', (e) => errors.push(`screen: ${e.message}`)))

  /** A fresh Viewer, counting what it is sent. */
  const viewer = async () => {
    const screen = await screens.newPage()
    await screen.goto(`${origin}/view/`)
    const invite = await until('the pairing link', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
    await screen.evaluate(() => {
      window.__btns = []; window.__inputs = 0
      window.__obpal.on('button', (e) => window.__btns.push(`${e.id}:${e.ev}`))
      window.__obpal.on('input', () => window.__inputs++)
    })
    return { screen, invite }
  }
  /** A phone (Pixel 7) with `init` run first, joined to a screen, its controls up. */
  const join = async (invite, init, arg) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    contexts.push(ctx)
    if (init) await ctx.addInitScript(init, arg)
    const phone = await ctx.newPage()
    phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`))
    await phone.goto(invite)
    return { ctx, phone, cdp: await ctx.newCDPSession(phone) }
  }
  const controls = (phone) => phone.locator('.modes').waitFor({ timeout: 25000 })
  const camera = (screen) => screen.evaluate(() => window.__viewer.camera.position.toArray())
  const away = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  /** A one-finger drag across the trackpad, as a finger makes it (touch events through the browser's own input). */
  const drag = async ({ phone, cdp }, dx, dy) => {
    const box = await phone.locator('#pad').boundingBox()
    const x = box.x + box.width / 2 - dx / 2, y = box.y + box.height / 2 - dy / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 12, y: y + (dy * i) / 12, id: 1 }] })
      await sleep(24)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  /**
   * The trackpad moves the screen's view: the camera comes to rest first (a view still settling after a phone joins
   * is nothing the trackpad did), then a drag moves it, and the screen counted packets from the phone meanwhile.
   * Returns how far it went.
   */
  const trackpadMoves = async (p, screen) => {
    let rest = await camera(screen)
    await until('the view at rest', async () => {
      await sleep(500)
      const now = await camera(screen)
      const still = away(rest, now) < 1e-3
      rest = now
      return still
    }, 12000, 0)
    const inputs = await screen.evaluate(() => window.__inputs)
    await drag(p, 120, -60)
    const moved = await until('the view moved', async () => { const d = away(rest, await camera(screen)); return d > 0.1 ? d : 0 }, 6000)
    if ((await screen.evaluate(() => window.__inputs)) <= inputs) throw new Error('the screen took no packets from the trackpad')
    return moved
  }
  const people = (screen) => screen.evaluate(() => window.__obpal.participants.map((q) => ({ id: q.id, tier: q.caps?.tier })))

  try {
    for (const remembered of [true, false]) {
      await check(remembered
        ? 'motion refused and remembered (answered at load): the controls come with no gate, motion is off, and the trackpad still moves the screen'
        : 'motion refused at the Start tap: the gate goes, the controls come, motion is off, and the trackpad still moves the screen', async () => {
        const { screen, invite } = await viewer()
        const p = await join(invite, motionRefused, remembered)
        const { phone } = p
        if (!remembered) {
          await phone.locator('#gate #start').waitFor({ timeout: 25000 })
          await until('a persistent seal in the motion-permission gate', () => phone.locator('.gate-card .trust-first .seal-compact').isVisible(), 8000)
          await phone.locator('#gate #start').click()
          await until('the gate gone', () => phone.evaluate(() => !document.getElementById('gate')), 8000)
        }
        await controls(phone)
        if (remembered && (await phone.evaluate(() => !!document.getElementById('gate')))) throw new Error('a refusal already given still put up the Start gate')
        // The page's sensor search runs every 0.7 s; give it a few rounds to find nothing.
        await sleep(2200)
        const asked = await phone.evaluate(() => window.__asked)
        if (!asked) throw new Error('the page never asked for motion, so nothing was refused')
        const ui = await phone.evaluate(() => {
          const g = document.getElementById('gyro')
          return { off: g?.getAttribute('aria-disabled'), pressed: g?.getAttribute('aria-pressed'), title: g?.title ?? '', calm: !!document.querySelector('.no-motion') }
        })
        if (ui.off !== 'true' || ui.title !== 'Motion is off on this phone' || !ui.calm) throw new Error(`the controls after a refusal: ${JSON.stringify(ui)}`)
        // Tapping the motion button says why nothing happens, and leaves it off.
        await phone.locator('#gyro').click({ force: true })
        const said = await until('what it says', () => phone.evaluate(() => document.getElementById('toast')?.textContent ?? '').then((t) => /Motion is off/.test(t) ? t : ''), 3000)
        if ((await phone.locator('#gyro').getAttribute('aria-pressed')) !== 'false') throw new Error('the motion button turned on with no motion')
        const who = await until('the phone at the screen', async () => { const l = await people(screen); return l.length === 1 ? l : null }, 8000)
        if (who[0].tier !== TOUCH_ONLY) throw new Error(`the screen was told tier ${who[0].tier}, not touch only (${TOUCH_ONLY})`)
        const moved = await trackpadMoves(p, screen)
        if (shots) await phone.screenshot({ path: `${shots}/motion-refused-${remembered ? 'remembered' : 'tap'}.png` })
        await p.ctx.close()
        await screen.close()
        return `asked ${asked}×; “${said.trim()}”; the screen was told touch-only; the view moved ${moved.toFixed(1)}`
      })
    }

    await check('Disconnect, then Reconnect: the phone is back at the screen, once, and its buttons and trackpad move it again', async () => {
      const { screen, invite } = await viewer()
      const p = await join(invite)
      const { phone } = p
      await controls(phone)
      await phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
      await until('the screen has the phone', async () => (await people(screen)).length === 1)
      const first = (await people(screen))[0].id
      await phone.locator('#gear').click()
      await phone.locator('.sheet.settings').waitFor({ timeout: 3000 })
      await sleep(350)
      await phone.locator('#disc').click()
      await phone.locator('#disc').click()
      await phone.locator('.msg h1', { hasText: 'Disconnected' }).waitFor({ timeout: 5000 })
      await until('the screen lets it go', async () => (await people(screen)).length === 0, 8000)
      // Nothing comes back by itself: the person left on purpose.
      await sleep(1500)
      if ((await people(screen)).length) throw new Error('it rejoined without being asked')
      const button = phone.getByRole('button', { name: 'Reconnect', exact: true })
      await button.click()
      await controls(phone)
      const back = await until('the screen has the phone again', async () => { const l = await people(screen); return l.length === 1 ? l : null }, 15000)
      await phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
      // Buttons: in Point, volume up is A. The screen hears it from the phone that just came back.
      await phone.locator('.modes [data-tab=point]').click()
      await sleep(400)
      await screen.evaluate(() => { window.__btns.length = 0 })
      await phone.keyboard.press('AudioVolumeUp')
      await until('A at the screen', async () => (await screen.evaluate(() => window.__btns)).includes('wii-a:tap'), 5000)
      await phone.locator('.modes [data-tab=rotate]').click()
      await sleep(400)
      const moved = await trackpadMoves(p, screen)
      if (shots) await phone.screenshot({ path: `${shots}/reconnected.png` })
      await p.ctx.close()
      await screen.close()
      return `one participant before and after (${first === back[0].id ? 'same id' : 'a new id'}); A tapped; the view moved ${moved.toFixed(1)}`
    })

    await check('no page errors on the screens or phones of these checks', async () => {
      if (errors.length) throw new Error(errors.slice(0, 3).join(' | '))
      return 'none'
    })
  } finally {
    await Promise.allSettled(contexts.map((c) => c.close()))
  }
}

/**
 * The browser-side moves of the demo clips (scripts/demo-clips.mjs): an emulated phone on a pairing link, a finger dragged
 * across its trackpad and a stick pushed, the same moves scripts/demo-preflight.mjs makes. A clip is recorded while they
 * run, so none of them changes what a page shows beyond what a phone's user would (no styled screenshots, no hidden layers).
 */
import { devices } from 'playwright'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** True once the page has a pairing link. The link is never read out: it carries a secret. */
export const hasCode = (page, timeout) => page.waitForFunction(() => !!window.__obpal?.pairingUrl, null, { timeout }).then(() => true, () => false)

/** What a sim that failed to start shows (src/sim/kit/recovery.ts), or null. */
export const startFailure = (page) => page.evaluate(() => {
  const card = document.getElementById('sim-recovery')
  return card ? (card.querySelector('[role=alert],[role=status]')?.textContent ?? 'could not be loaded') : null
}).catch(() => null)

/** Clears what floats over a phone's controls (first-use hints, notices) and keeps its toast from catching a touch. */
export const quiet = (page) => page.evaluate(() => {
  document.querySelectorAll('.hint, .bt-notice').forEach((h) => h.remove())
  document.querySelectorAll('#toast').forEach((t) => { t.style.pointerEvents = 'none' })
}).catch(() => {})

/**
 * An emulated phone (a Pixel 7) on a pairing link, its controls up, its own screen recorded into `record` when given. The
 * link goes nowhere but the page's address bar.
 * @param {import('playwright').Browser} browser
 * @param {string} invite
 * @param {string} [record] folder for the phone's own video
 */
export async function joinPhone(browser, invite, record) {
  const phone = devices['Pixel 7']
  const ctx = await browser.newContext({ ...phone, ...(record ? { recordVideo: { dir: record, size: phone.viewport } } : {}) })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  const start = Date.now()
  await page.goto(invite, { waitUntil: 'load', timeout: 40_000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.modes, .gp-stick')].some((e) => e.getClientRects().length), null, { timeout: 40_000 })
  return { ctx, page, cdp, ms: Date.now() - start }
}

/**
 * Where `selector` is on the phone once it has stopped moving: a controller settles for a moment after it joins (a banner
 * folds away and the controls move up), and a touch aimed at where a control was lands on whatever took its place.
 */
export async function stableBox(phone, selector, timeout = 8000) {
  const target = phone.page.locator(selector).first()
  const end = Date.now() + timeout
  let last = null
  while (Date.now() < end) {
    const b = await target.boundingBox()
    if (b && last && Math.abs(b.x - last.x) < 1 && Math.abs(b.y - last.y) < 1) return b
    last = b
    await sleep(300)
  }
  if (last) return last
  throw new Error(`nothing to drag at ${selector}`)
}

/**
 * A one-finger drag across `selector` on the phone, as a finger makes it (touch events through the browser's input),
 * then the finger stays down for `holdMs`. `steps` and `stepMs` set how fast it travels: a flick is few and quick.
 */
export async function drag(phone, selector, dx, dy, { holdMs = 0, steps = 12, stepMs = 24 } = {}) {
  const box = await stableBox(phone, selector)
  const x = box.x + box.width / 2 - dx / 2, y = box.y + box.height / 2 - dy / 2
  await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  for (let i = 1; i <= steps; i++) {
    await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps, id: 1 }] })
    await sleep(stepMs)
  }
  if (holdMs) await sleep(holdMs)
  await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/**
 * Pushes the phone's left stick by (dx, dy) pixels and holds it for `holdMs`. The stick floats: it centres where the
 * thumb lands. The events are made in the page, in one task with the stick's own position read, so a controller that is
 * still settling cannot move it from under the touch (a thumb would not mind; a script's coordinates do).
 */
export async function pushStick(phone, dx, dy, holdMs) {
  await stableBox(phone, '.gp-stick .gp-base')
  await phone.page.evaluate(({ dx, dy }) => {
    const zone = document.querySelector('.gp-stick')
    const b = zone.querySelector('.gp-base').getBoundingClientRect()
    const x = b.x + b.width / 2, y = b.y + b.height / 2
    const send = (type, px, py) => zone.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: 'touch', isPrimary: true, clientX: px, clientY: py }))
    window.__release = () => send('pointerup', x + dx, y + dy)
    send('pointerdown', x, y)
    send('pointermove', x + dx, y + dy)
  }, { dx, dy })
  await sleep(holdMs)
  await phone.page.evaluate(() => window.__release())
}

/**
 * A gamepad the page can read, standing in for what ob.Pal Link gives a tab (Link is not loaded: a clip never starts the
 * extension or reaches ob.Pal Desktop). Run it in the page before the page's own scripts. `window.__synthPad.drive(plan)`
 * connects it after `plan.after` ms and then moves its left stick round a circle of radius `plan.radius`, turning back
 * every `plan.turn` ms.
 */
export function syntheticGamepad() {
  const pad = { id: 'ob.Pal Link (synthetic gamepad)', index: 0, connected: false, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), timestamp: 0 }
  navigator.getGamepads = () => [pad.connected ? pad : null, null, null, null]
  window.__synthPad = {
    drive({ after, radius, turn }) {
      const start = performance.now()
      setInterval(() => {
        const t = performance.now() - start
        if (t < after) return
        pad.connected = true
        const s = t - after, phase = (s / turn) | 0, a = ((s % turn) / turn) * Math.PI * 2 * (phase % 2 ? -1 : 1)
        pad.axes[0] = Math.cos(a) * radius
        pad.axes[1] = Math.sin(a) * radius
        pad.timestamp = performance.now()
      }, 16)
    },
  }
}

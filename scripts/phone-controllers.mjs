/**
 * The controller bar and the controller catalogue, for e2e:phone (CATALOGUE §9.3, src/controller/switcher.ts):
 *   - The Viewer: the bar holds a slot per controller the screen takes, each an icon, the one in use named; the
 *     catalogue rates every controller for it, and a long press on one it doesn't take says why.
 *   - Switching from the catalogue is one tap: the new face comes up, the bar follows, and the screen hears the
 *     controller (mode{c, p}): the air mouse, the steering wheel (the gamepad with the Driving profile), and back.
 *   - A sim (the rover) rated from what it names, best first: the steering wheel best, with the catalogue's spark.
 *   - The layout at 390×844, 430×932 and 844×390, on every face (the trackpad with motion on and off, the Wii remote,
 *     the 3D hand, the gamepad, the wheel, the air mouse, the keyboard's dock, the drums and the keys), in the catalogue
 *     and in settings: no control nearer the screen's edge than the controller's edge (--edge, 16 px), and no touch
 *     target under 44 px (--tap).
 *   - The node strip on the excavator's trackpad (src/controller/strip.ts): the whole, its sets and its parts, a tap
 *     that lights one and that the screen drives, and the same layout rules at 360 px too.
 */
import { devices } from 'playwright'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 15000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(100)
  }
}

/** The controller's layout rules (src/styles/controller.css): --edge and --tap. */
const EDGE = 16
const TAP = 44
const SIZES = [
  { name: '390×844', width: 390, height: 844, angle: 0 },
  { name: '430×932', width: 430, height: 932, angle: 0 },
  { name: '844×390', width: 844, height: 390, angle: 90 },
]

/**
 * In the page: every control on screen (visible, not scrolled out of its scroller) that comes nearer an edge than
 * `edge`, or whose touch target (its box, with a pseudo-element that reaches past it) is under `tap` either way.
 */
function audit({ edge, tap }) {
  const W = innerWidth, H = innerHeight
  const shown = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05 || e.inert) return false
    }
    return true
  }
  /** The part of a box its scrollers let show. */
  const clip = (el, r) => {
    let { left, top, right, bottom } = r
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (/(auto|scroll|hidden|clip)/.test(`${s.overflowX} ${s.overflowY}`)) {
        const c = e.getBoundingClientRect()
        left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom)
      }
    }
    return { left, top, right, bottom }
  }
  /**
   * A control's touch target: its box, grown by an absolutely placed ::before or ::after that reaches past it. A switch
   * or a slider inside its label is the whole label to a finger.
   */
  const target = (el, box) => {
    const label = el.matches('input') ? el.closest('label') : null
    const r = label ? label.getBoundingClientRect() : box
    let w = r.width, h = r.height
    for (const p of ['::before', '::after']) {
      const s = getComputedStyle(el, p)
      if (s.content === 'none' || s.position !== 'absolute' || s.pointerEvents === 'none') continue
      const n = (v) => (v.endsWith('px') ? Number.parseFloat(v) : 0)
      w = Math.max(w, r.width - Math.min(0, n(s.left)) - Math.min(0, n(s.right)))
      h = Math.max(h, r.height - Math.min(0, n(s.top)) - Math.min(0, n(s.bottom)))
    }
    return [w, h]
  }
  const name = (el) => (el.id ? `#${el.id}` : '') + (el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : '') || `.${[...el.classList].join('.')}` || el.tagName
  const near = [], small = []
  // The panes the controls sit on keep the edge too: the bars, the work area, the tray, the dock, the sheets.
  for (const el of document.querySelectorAll('.bar, .ctl-bar, .pad, .wii, .mouse, .music-face, .tray, .dock, .banner, .kbd:not(.up), .sheet, .gp-sys')) {
    if (!shown(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const gap = Math.min(r.left, r.top, W - r.right, H - r.bottom)
    if (gap < edge - 0.5) near.push(`${name(el)} ${gap.toFixed(1)}px`)
  }
  const controls = document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="button"], .pad, .gp-stick, .gp-dpad, .mouse-wheel')
  for (const el of controls) {
    if (!shown(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const v = clip(el, r)
    if (v.right - v.left < 1 || v.bottom - v.top < 1) continue
    const gap = Math.min(v.left, v.top, W - v.right, H - v.bottom)
    if (gap < edge - 0.5) near.push(`${name(el)} ${gap.toFixed(1)}px`)
    const [w, h] = target(el, r)
    if (Math.min(w, h) < tap - 0.5) small.push(`${name(el)} ${Math.round(w)}×${Math.round(h)}`)
  }
  return { near, small }
}

export async function phoneControllers({ browser, origin, check, shots }) {
  const screens = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const errors = []
  screens.on('page', (p) => p.on('pageerror', (e) => errors.push(`screen: ${e.message}`)))
  const contexts = [screens]

  /** A screen at `path`, and a phone joined to it, held like a remote. */
  async function join(path) {
    const screen = await screens.newPage()
    await screen.goto(`${origin}${path}`)
    const invite = await until(`${path} invite`, () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 25000)
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    contexts.push(ctx)
    // Coach hints come on timers; these checks look at the controls themselves.
    await ctx.addInitScript(() => { for (const k of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${k}`, '1') })
    const phone = await ctx.newPage()
    phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`))
    const cdp = await ctx.newCDPSession(phone)
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
    await phone.goto(invite)
    await phone.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
    const clear = () => phone.evaluate(() => document.querySelectorAll('.hint, .bt-notice').forEach((h) => h.remove()))
    const size = async (z) => {
      await phone.setViewportSize({ width: z.width, height: z.height })
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: z.width, height: z.height, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: z.angle ? 'landscapePrimary' : 'portraitPrimary', angle: z.angle } })
      await sleep(350)
    }
    /** The catalogue, opened as a person opens it: More on the bar, or the gamepad's own button. */
    const catalogue = async () => {
      await clear()
      const gp = phone.locator('.gp:not([hidden]) [data-act=controllers]')
      if (await gp.count() && await gp.isVisible()) await gp.click()
      else await phone.locator('#ctl-more').click()
      await phone.locator('.ctl-sheet').waitFor()
      await sleep(350)
    }
    const shut = async () => { await phone.keyboard.press('Escape'); await until('the catalogue closed', () => phone.evaluate(() => !document.querySelector('.ctl-wrap'))) }
    /** Every card: its fit, whether it's the best, dimmed, and in use. */
    const cards = () => phone.evaluate(() => [...document.querySelectorAll('.ctl-card')].map((c) => ({
      id: c.dataset.c, fit: Number(c.dataset.fit), best: !!c.querySelector('.ctl-best'), out: c.getAttribute('aria-disabled') === 'true', on: c.getAttribute('aria-checked') === 'true',
    })))
    const slots = () => phone.evaluate(() => [...document.querySelectorAll('.modes [data-tab]')].map((b) => ({
      face: b.dataset.tab, id: b.dataset.c, on: b.getAttribute('aria-selected') === 'true', named: getComputedStyle(b.querySelector('.ctl-tab-t')).opacity === '1', best: !!b.querySelector('.ctl-tab-best'),
    })))
    const heard = () => screen.evaluate(() => window.__obpal.participants.find((p) => p.lead) ?? window.__obpal.participants[0] ?? null)
    return { screen, phone, cdp, clear, size, catalogue, shut, cards, slots, heard, close: async () => { await ctx.close(); await screen.close() } }
  }

  try {
    const v = await join('/view/')

    await check('the controller bar: a slot per controller the Viewer takes, each an icon, the one in use named; the catalogue rates them all and says why one is out', async () => {
      const s = await v.slots()
      const want = [['rotate', 'face.trackpad'], ['point', 'face.wii'], ['track', 'face.hand'], ['gamepad', 'face.gamepad'], ['camera-hand', undefined]]
      if (JSON.stringify(s.map((x) => [x.face, x.id])) !== JSON.stringify(want)) throw new Error(`slots ${JSON.stringify(s)}`)
      const on = s.filter((x) => x.on)
      if (on.length !== 1 || on[0].face !== 'rotate' || !on[0].named) throw new Error(`in use: ${JSON.stringify(on)}`)
      if (s.some((x) => !x.on && x.named)) throw new Error('a slot not in use shows its name at 390 px')
      await v.catalogue()
      const c = await v.cards()
      const fits = Object.fromEntries(c.map((x) => [x.id, x.fit]))
      const expect = { 'face.trackpad': 3, 'face.wii': 2, 'face.hand': 2, 'face.gamepad': 2, 'face.wheel': 1, 'face.mouse': 1, 'face.keyboard': 0, 'face.drums': 0, 'face.keys': 0 }
      const off = Object.entries(expect).filter(([k, f]) => fits[k] !== f)
      if (off.length || c.length !== 9) throw new Error(`fits ${JSON.stringify(fits)}`)
      // A screen that names no controllers: its first mode's (the Viewer's tilt) is its best.
      if (c.filter((x) => x.best).map((x) => x.id).join() !== 'face.trackpad') throw new Error(`best: ${c.filter((x) => x.best).map((x) => x.id)}`)
      if (!c.find((x) => x.id === 'face.trackpad').on || c.filter((x) => x.on).length !== 1) throw new Error('the trackpad isn’t the one in use')
      if (c.filter((x) => x.out).map((x) => x.id).join() !== 'face.keyboard,face.drums,face.keys') throw new Error(`dimmed: ${c.filter((x) => x.out).map((x) => x.id)}`)
      // The ones it takes come first, best first; the dimmed ones last.
      if (c.findIndex((x) => x.out) < c.length - 3) throw new Error('a dimmed card before a lit one')
      // A long press on one it doesn't take: why, in a line over the card.
      const box = await v.phone.locator('.ctl-card[data-c="face.keyboard"]').boundingBox()
      await v.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] })
      const why = await until('the reason', () => v.phone.evaluate(() => { const t = document.querySelector('.ctl-tip.in'); return t ? t.textContent : '' }), 3000)
      await v.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      if (!/doesn’t take typing/.test(why)) throw new Error(`the tip said "${why}"`)
      // The press was a question, not a switch.
      if ((await v.cards()).find((x) => x.id === 'face.keyboard').on) throw new Error('the long press picked it')
      if (shots) await v.phone.screenshot({ path: join(shots, 'phone-catalogue-why.png') })
      await v.shut()
      return `${s.length} slots; fits ${Object.entries(fits).map(([k, f]) => `${k.slice(5)} ${f}`).join(', ')}; "${why}"`
    })

    await check('switching from the catalogue is one tap: the face comes up, the bar follows, the screen hears the controller; the wheel is the gamepad on Driving', async () => {
      const said = []
      const pick = async (id) => {
        await v.catalogue()
        await v.phone.locator(`.ctl-card[data-c="${id}"]`).click()
        await until(`${id} in use`, async () => (await v.slots()).some((x) => x.on && x.id === id))
        const p = await until(`the screen hears ${id}`, async () => { const h = await v.heard(); return h?.controller === id ? h : null })
        said.push(`${id.slice(5)}${p.profile ? `/${p.profile}` : ''}`)
        await until('the catalogue closed', () => v.phone.evaluate(() => !document.querySelector('.ctl-wrap')))
        return p
      }
      await pick('face.mouse')
      if (!(await v.phone.locator('#mouse').isVisible())) throw new Error('the air mouse face isn’t up')
      if (!(await v.phone.evaluate(() => document.getElementById('mouse').classList.contains('face-in')))) throw new Error('the face didn’t rise in')
      // The bar's pointing slot now holds the air mouse, where the Wii remote was.
      if ((await v.slots()).find((x) => x.face === 'point').id !== 'face.mouse') throw new Error('the bar kept the Wii remote')
      const wheel = await pick('face.wheel')
      if (wheel.profile !== 'driving') throw new Error(`the wheel came with profile ${wheel.profile}`)
      if (!(await v.phone.locator('.gp').isVisible())) throw new Error('the gamepad face isn’t up')
      const steer = await v.phone.getAttribute('.gp-chip[data-chip="motion.steer"]', 'aria-pressed')
      if (steer !== 'true') throw new Error('Driving didn’t switch Steer on')
      // From the gamepad's own button, back to the gamepad proper: the screen's own profile again.
      const pad = await pick('face.gamepad')
      if (pad.profile === 'driving') throw new Error('the gamepad kept Driving')
      // The gamepad's way back is drawn as the controller it goes back to.
      const back = await v.phone.getAttribute('.gp [data-act=exit]', 'aria-label')
      if (back !== 'Back to Air mouse') throw new Error(`the way back says "${back}"`)
      await v.phone.locator('.gp [data-act=exit]').click()
      await until('back on the air mouse', async () => (await v.heard())?.controller === 'face.mouse')
      await pick('face.trackpad')
      return said.join(' → ')
    })

    /**
     * Look at every face `faces` names ([controller, how to show it, what to call it]) at the three sizes (or `sizes`),
     * and the catalogue at each: what comes nearer the edge than EDGE, or is smaller than TAP to touch.
     */
    const layouts = async (p, faces, extra = [], sizes = SIZES) => {
      const bad = []
      let looked = 0
      const look = async (z, label) => {
        await p.clear()
        const a = await p.phone.evaluate(audit, { edge: EDGE, tap: TAP })
        looked++
        for (const n of a.near) bad.push(`${z.name} ${label}: ${n} from the edge`)
        for (const n of a.small) bad.push(`${z.name} ${label}: ${n} to touch`)
      }
      for (const z of sizes) {
        await p.size(z)
        for (const [id, label, then] of faces) {
          if (id) {
            await p.catalogue()
            await p.phone.locator(`.ctl-card[data-c="${id}"]`).click()
            await until('the catalogue closed', () => p.phone.evaluate(() => !document.querySelector('.ctl-wrap')))
            await sleep(400)
          }
          const undo = then ? await then(z) : null
          if (undo === false) continue
          await look(z, label)
          if (undo) await undo()
        }
        await p.catalogue()
        await look(z, 'catalogue')
        if (shots) await p.phone.screenshot({ path: join(shots, `phone-catalogue-${z.width}x${z.height}.png`) })
        await p.shut()
        for (const [label, open, close] of extra) { await open(); await look(z, label); await close() }
      }
      await p.size(SIZES[0])
      if (bad.length) throw new Error(bad.slice(0, 12).join('; '))
      return `${looked} layouts, every control ${EDGE}+ px from the edge and ${TAP}+ px to touch`
    }

    await check('the Viewer at three phone sizes, on every face, in the catalogue and in settings: nothing nearer the edge than 16 px, no touch target under 44 px', async () => {
      // The trackpad with motion on, too: the switch lit, and Tilt's level button beside the Tilt or 1:1 choice.
      const motion = async (z) => {
        if (z.angle) return false
        await v.phone.locator('[data-style="game"]').click()
        await v.phone.locator('#gyro').click()
        await until('motion on', () => v.phone.evaluate(() => document.getElementById('gyro').getAttribute('aria-pressed') === 'true'))
        await sleep(300)
        // Motion off again: the rotation lock it took goes with it.
        return async () => {
          await v.phone.locator('#gyro').click()
          await until('motion off, rotation free', () => v.phone.evaluate(() => document.getElementById('gyro').getAttribute('aria-pressed') === 'false' && document.getElementById('lock').getAttribute('aria-pressed') === 'false'))
        }
      }
      // Settings opens from the bar's gear, or from the gamepad's own button while it fills the screen.
      const gear = async () => {
        const gp = v.phone.locator('.gp:not([hidden]) [data-act=settings]')
        await (await gp.count() && await gp.isVisible() ? gp : v.phone.locator('#gear')).click()
      }
      const settings = [['settings', async () => { await gear(); await v.phone.locator('.sheet.settings').waitFor(); await sleep(350) },
        async () => { await v.phone.locator('#set-close').click(); await until('settings closed', () => v.phone.evaluate(() => !document.querySelector('.sheet.settings'))) }]]
      return layouts(v, [['face.trackpad', 'trackpad'], [null, 'trackpad with motion', motion], ['face.wii', 'Wii remote'], ['face.hand', '3D hand'], ['face.gamepad', 'gamepad']], settings)
    })

    // One screen at a time from here: the Viewer and its phone step aside for the sims'.
    await v.close()
    const rover = await join('/sim/device/?d=rover')
    await check('a sim’s ratings (the rover): best first from what it names, the steering wheel best with the spark, what it can’t take dimmed', async () => {
      // The rover suggests the wheel first: it opens as the gamepad on Driving.
      await until('the wheel opens', async () => (await rover.heard())?.controller === 'face.wheel')
      const s = await rover.slots()
      if (JSON.stringify(s.map((x) => x.id)) !== JSON.stringify(['face.wheel', 'face.trackpad', 'face.wii'])) throw new Error(`slots ${JSON.stringify(s)}`)
      if (!s[0].best || s.slice(1).some((x) => x.best)) throw new Error('the best dot isn’t on the wheel alone')
      await rover.catalogue()
      const c = await rover.cards()
      const got = c.map((x) => `${x.id.slice(5)}:${x.fit}${x.best ? '*' : ''}${x.out ? '-' : ''}`).join(' ')
      const want = 'wheel:3* gamepad:2 trackpad:2 wii:2 mouse:1 hand:0- keyboard:0- drums:0- keys:0-'
      if (got !== want) throw new Error(`cards ${got}`)
      const box = await rover.phone.locator('.ctl-card[data-c="face.hand"]').boundingBox()
      await rover.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] })
      const why = await until('the reason', () => rover.phone.evaluate(() => document.querySelector('.ctl-tip.in')?.textContent ?? ''), 3000)
      await rover.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      if (!/doesn’t take 3D motion/.test(why)) throw new Error(`the tip said "${why}"`)
      if (shots) await rover.phone.screenshot({ path: join(shots, 'phone-catalogue-rover.png') })
      await rover.shut()
      return got
    })
    await check('the rover’s steering wheel at three phone sizes: nothing nearer the edge than 16 px, no touch target under 44 px', () => layouts(rover, [['face.wheel', 'steering wheel']]))
    await rover.close()

    const lamp = await join('/sim/device/?d=lamp')
    await check('the lamp’s air mouse and the keyboard’s dock at three phone sizes: nothing nearer the edge than 16 px, no touch target under 44 px', async () => {
      const typing = async () => {
        await lamp.phone.locator('.tray-btn[aria-label="Keyboard"]').click()
        await lamp.phone.locator('.kbd').waitFor()
        await sleep(350)
        return async () => { await lamp.phone.locator('.kbd-hide').click(); await sleep(300) }
      }
      return layouts(lamp, [['face.mouse', 'air mouse'], [null, 'keyboard dock', typing]])
    })
    await lamp.close()

    const studio = await join('/sim/device/?d=studio')
    await check('the studio’s drums and keys at three phone sizes: nothing nearer the edge than 16 px, no touch target under 44 px', () => layouts(studio, [['face.drums', 'drums'], ['face.keys', 'keys']]))
    await studio.close()

    // The node strip (./strip.ts): the excavator's parts along the trackpad's thumb edge.
    const digger = await join('/sim/device/?d=excavator')
    await check('the excavator’s node strip: an icon for the whole, each set and each part, a tap lights one and the screen drives it; at 360 px and three sizes nothing nearer the edge than 16 px, no touch target under 44 px', async () => {
      await until('the excavator held', () => digger.screen.evaluate(() => !!window.__sim.claims.holder('excavator1')))
      await digger.catalogue()
      await digger.phone.locator('.ctl-card[data-c="face.trackpad"]').click()
      await digger.phone.locator('#nstrip:not([hidden])').waitFor({ timeout: 8000 })
      const strip = () => digger.phone.evaluate(() => [...document.querySelectorAll('#nstrip .ns-item')].map((b) => `${b.dataset.kind}:${b.dataset.part}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join(' '))
      const first = await strip()
      if (first !== 'whole:* set:reach set:dig part:swing part:boom part:stick part:bucket') throw new Error(`strip ${first}`)
      await digger.clear()
      await digger.phone.locator('.ns-item[data-part="reach"]').click()
      await until('Reach driven', () => digger.screen.evaluate(() => window.__device.focus(0)?.part === 'reach'))
      const lit = await strip()
      const ringed = await digger.phone.locator('.ns-item.in').evaluateAll((l) => l.map((b) => b.dataset.part).join())
      if (!lit.includes('set:reach*') || ringed !== 'boom,stick') throw new Error(`after a tap on Reach: ${lit}, ringed ${ringed}`)
      if (shots) await digger.phone.screenshot({ path: join(shots, 'phone-strip-excavator.png') })
      const shown = await layouts(digger, [[null, 'trackpad with its node strip']], [], [{ name: '360×640', width: 360, height: 640, angle: 0 }, ...SIZES])
      return `${lit}; ${shown}`
    })
    await digger.close()
    if (errors.length) throw new Error(errors[0])
  } catch (e) {
    await check('the controller bar and catalogue checks ran', async () => { throw e })
  } finally {
    await Promise.allSettled(contexts.map((c) => c.close()))
  }
}

/**
 * The decluttered phone controller and the screen it joins, for e2e:phone: the screen's pairing card folds by itself
 * after the phone's seal; on the phone, who is here is the bar's subtitle, the first connection notice (a passive
 * notice) quiets to one row with its words kept, the gamepad keeps its extras under More (light dismiss), and on a
 * phone on its side the face takes the wide column at full height.
 */
import { devices } from 'playwright'

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

export async function phoneDeclutter({ browser, origin, check }) {
  const screenCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  try {
    const screen = await screenCtx.newPage()
    await screen.goto(`${origin}/sim/device/?d=octopus`)
    const invite = await until('the screen’s invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 40000)
    const phone = await phoneCtx.newPage()
    const cdp = await phoneCtx.newCDPSession(phone)
    const size = async (width, height) => {
      await phone.setViewportSize({ width, height })
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: width > height ? 'landscapePrimary' : 'portraitPrimary', angle: width > height ? 90 : 0 } })
      await sleep(500)
    }
    await phone.goto(invite)
    await until('the phone live', () => phone.evaluate(() => document.body.classList.contains('live')), 30000)
    const joined = Date.now()

    await check('declutter: the screen’s pairing card folds by itself a few seconds after the phone’s seal, leaving the seal on the chip', async () => {
      const open = () => screen.evaluate(() => document.querySelector('.obpal-chip').shadowRoot.querySelector('.pill').getAttribute('aria-expanded') === 'true')
      await until('the card folded', async () => !(await open()), 12000, 200)
      const seal = await screen.evaluate(() => !!document.querySelector('.obpal-chip').shadowRoot.querySelector('.pill .connection-seal'))
      if (!seal) throw new Error('the folded chip lost the seal')
      return `folded ${((Date.now() - joined) / 1000).toFixed(1)} s after the phone went live`
    })

    await check('declutter: on the phone, who is here is the bar’s subtitle and the first notice quiets to one row, its words kept', async () => {
      // The octopus starts a phone on its gamepad: back to the trackpad, where the bar and the notice show.
      if (await phone.locator('.gp:not([hidden])').count()) await phone.locator('.gp:not([hidden]) [data-act="exit"]').click()
      await until('the trackpad', () => phone.locator('#pad').isVisible(), 5000)
      await until('the subtitle in the bar', () => phone.evaluate(() => !!document.querySelector('.bar > .participant-phone:not([hidden]) .watcher-count')), 10000)
      const notice = phone.locator('.trust-first')
      await until('the notice quiet', () => notice.evaluate((el) => el.hasAttribute('data-quiet')).catch(() => false), 9000, 200)
      const n = await notice.evaluate((el) => ({ h: el.getBoundingClientRect().height, text: el.textContent }))
      if (!n.text.includes('Connected to the screen showing this seal')) throw new Error('the quiet notice lost its words')
      if (n.h > 60) throw new Error(`the quiet notice is ${n.h.toFixed(0)} px tall`)
      if (!(await phone.locator('.trust-first .trust-compare').isVisible())) throw new Error('the seal went with the quiet')
      // Among the phone's notices it is a passive line: no x, and a touch on it reaches what is under it.
      const passive = await notice.evaluate((el) => { const item = el.closest('.nt-item'); return { railed: !!item, x: !!item?.querySelector('.nt-x, .trust-dismiss'), touch: getComputedStyle(el).pointerEvents !== 'none' } })
      if (!passive.railed || passive.x || passive.touch) throw new Error(`the quiet notice is not a passive notice: ${JSON.stringify(passive)}`)
      const face = await phone.evaluate(() => document.querySelector('.modes').getBoundingClientRect().bottom)
      return `notice ${n.h.toFixed(0)} px; the controller rail ends at ${face.toFixed(0)} px`
    })

    await check('declutter: the gamepad keeps its extras under More, which closes on a press outside or Escape', async () => {
      if (!(await phone.locator('.gp:not([hidden])').count())) await phone.locator('.ctl-tab[data-tab="gamepad"]').click()
      const more = phone.locator('.gp:not([hidden]) [data-act="more"]'), card = phone.locator('.gp-meta')
      await more.waitFor({ timeout: 5000 })
      if (await card.isVisible()) throw new Error('More started open')
      if (await phone.locator('.gp .link-badge').isVisible()) throw new Error('the connection badge is still on the face')
      await more.click()
      await until('More open with the connection', () => phone.locator('.gp-meta .link-badge').isVisible(), 3000)
      const box = await phone.locator('.gp-side.l').boundingBox()
      await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
      await until('a press outside closed More', async () => !(await card.isVisible()), 2000)
      await more.click(); await until('More open again', () => card.isVisible(), 2000)
      await phone.keyboard.press('Escape')
      await until('Escape closed More', async () => !(await card.isVisible()), 2000)
      const faceButtons = await phone.evaluate(() => [...document.querySelectorAll('.gp button')].filter((b) => b.checkVisibility()).length)
      await phone.locator('.gp:not([hidden]) [data-act="exit"]').click()
      await until('the trackpad', () => phone.locator('#pad').isVisible(), 5000)
      return `${faceButtons} buttons on the gamepad face`
    })

    await check('declutter: once play starts (the stick pressed above), the quiet notice goes and the badge keeps the seal', async () => {
      // The press took it away at once; the notice itself folds out over its own short exit.
      await until('the notice gone after play started', async () => !(await phone.locator('.trust-first').count()), 3000, 50).catch(() => { throw new Error('the notice stayed after play started') })
      if (!(await phone.locator('.bar .link-badge').isVisible())) throw new Error('the badge went with the notice')
      return 'notice gone; badge in the bar'
    })

    await check('declutter: on a phone on its side the trackpad takes the wide column at full height', async () => {
      await size(915, 412)
      await until('the landscape layout', () => phone.evaluate(() => document.documentElement.classList.contains('land')), 4000)
      const share = await phone.evaluate(() => { const r = document.getElementById('pad').getBoundingClientRect(); return (r.width * r.height) / (innerWidth * innerHeight) })
      if (share < 0.5) throw new Error(`the trackpad covers ${(share * 100).toFixed(0)}% of the screen`)
      const clipped = await phone.evaluate(() => [...document.querySelectorAll('.bar, .modes, .dock')].filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.bottom > innerHeight + 1 }).map((el) => el.className))
      if (clipped.length) throw new Error(`off the screen: ${clipped.join(', ')}`)
      await size(412, 915)
      return `trackpad ${(share * 100).toFixed(0)}% of 915x412`
    })
  } finally {
    await phoneCtx.close().catch(() => {})
    await screenCtx.close().catch(() => {})
  }
}

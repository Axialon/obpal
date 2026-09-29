/**
 * The quick-actions tray (src/ui/quick.ts) in real Chromium, one check per kind of page: it opens, it offers what
 * applies there in the tray's order, and each of its actions does its job (pairing opens the pairing card, the camera
 * moves the view and goes round to first person, one press away on a phone, fullscreen asks for the full screen, sound
 * switches, the theme opens the picker, reset puts the sim back). It keeps clear of the dock rail, the sidebar, the
 * pairing chip and a sim's windows, and an open pairing card folds for it on a phone on its side; the keyboard, a click
 * outside and a swipe back close it; the phone controller and the embed don't have it. Run by scripts/e2e-pages.mjs.
 */
import { checkFrost } from './lib/frost.mjs'

const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORDER = ['scan', 'pair', 'open', 'switch', 'reset', 'camera', 'stop', 'body', 'next1', 'next2', 'next3', 'fullscreen', 'sound', 'theme']

/** A page at a size; its fullscreen requests counted, since a headless screen may not grant them. */
async function open(browser, origin, path, { width = 1440, height = 900, phone = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, reducedMotion: 'reduce', ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
  await context.addInitScript(() => {
    window.__fullscreenCalls = 0
    const request = Element.prototype.requestFullscreen
    Element.prototype.requestFullscreen = function (...args) { window.__fullscreenCalls++; return request ? request.apply(this, args).catch(() => {}) : Promise.resolve() }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(origin + path)
  await page.locator('.quick-tab').waitFor({ state: 'visible', timeout: 20000 })
  return { page, context, errors }
}
const box = (page, selector) => page.evaluate((s) => {
  const el = document.querySelector(s)
  if (!el || el.hidden) return null
  const r = el.getBoundingClientRect()
  return r.width && r.height ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
}, selector)
const boxes = (page, selector) => page.locator(selector).evaluateAll((els) => els.filter((el) => !el.hidden).map((el) => {
  const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}).filter((r) => r.right > r.left && r.bottom > r.top))
const chip = (page) => page.evaluate(() => {
  const root = document.querySelector('.obpal-chip')?.shadowRoot
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }
  return { pill: r(root?.querySelector('.pill')), card: root?.querySelector('.wrap')?.hasAttribute('data-open') ? r(root.querySelector('.card')) : null }
})
const meets = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
function clear(what, of, others) {
  for (const [name, list] of Object.entries(others)) for (const r of [list].flat()) assert(!meets(of, r), `the ${what} meets ${name}: ${JSON.stringify({ of, r })}`)
}
const offered = (page) => page.locator('.quick-tray [data-quick]').evaluateAll((els) => els.map((el) => el.dataset.quick))
const isOpen = (page) => page.locator('.quick-tray').evaluate((el) => el.dataset.open === 'true')
async function openTray(page) { if (!(await isOpen(page))) { await page.locator('.quick-tab').click(); await sleep(150) } assert(await isOpen(page), 'the tray did not open') }
const action = (page, id) => page.locator(`.quick-tray [data-quick="${id}"]`)
const inOrder = (ids) => ids.every((id, i) => i === 0 || ORDER.indexOf(ids[i - 1]) < ORDER.indexOf(id))

export async function runQuick(browser, origin, checkIt) {
  // Each check names the step it failed at.
  let stage = ''
  const at = (name) => { stage = name }
  const check = (name, fn) => checkIt(name, async () => {
    stage = ''
    try { return await fn() } catch (e) { throw new Error(stage ? `${stage}: ${e.message.split('\n')[0]}` : e.message) }
  })

  /** The full card (including its last row), the safe margin, and the page width, measured after layout. */
  const fits = async (page, selector, { scroll = false } = {}) => {
    const found = await page.locator(selector).evaluate(el => {
      const r = el.getBoundingClientRect(), v = visualViewport
      const top = Math.max(v.offsetTop, ...[...document.querySelectorAll('.top, .topbar, .sim-top')].map(el => {
        const b = el.getBoundingClientRect()
        return b.width > v.width / 2 && b.top <= v.offsetTop + 12 ? b.bottom : v.offsetTop
      }))
      return { left: r.left - v.offsetLeft, top: r.top - top, right: v.offsetLeft + v.width - r.right,
        bottom: v.offsetTop + v.height - r.bottom, clipped: el.scrollHeight - el.clientHeight, sideways: el.scrollWidth - el.clientWidth,
        overflow: document.documentElement.scrollWidth - innerWidth }
    })
    assert(['left', 'top', 'right', 'bottom'].every(k => found[k] >= 11.5), `${selector} margin: ${JSON.stringify(found)}`)
    assert(!found.overflow && !found.sideways, `page or card scrolls horizontally: ${JSON.stringify(found)}`)
    assert(scroll || found.clipped <= 1, `${selector} unnecessarily scrolls: ${JSON.stringify(found)}`)
  }
  const surfaces = page => page.evaluate(() => {
    const color = selector => { const el = document.querySelector(selector); return el ? getComputedStyle(el).backgroundColor : null }
    const root = getComputedStyle(document.documentElement)
    return { body: getComputedStyle(document.body).background, bar: color('.top, .topbar, .sim-top'), tab: color('.quick-tab'), tray: color('.quick-panel'),
      card: color('.quick-themes'), accent: root.getPropertyValue('--bb-accent').trim(),
      theme: document.documentElement.dataset.theme, family: document.documentElement.dataset.bbTheme }
  })
  for (const [width, height] of [[360, 740], [375, 812], [390, 844], [430, 932], [844, 390]]) {
    await check(`quick actions: every card fits ${width}x${height}, Navy/Light/accent apply and persist, Light reads at AA`, async () => {
      for (const path of ['/', '/view/', '/sim/arm/', '/sim/studio/']) {
        const { page, context } = await open(browser, origin, path, { width, height, phone: true })
        try {
          await sleep(600)
          await openTray(page)
          for (const id of await offered(page)) {
            at(`${path} ${id} tooltip`)
            await page.evaluate(() => document.activeElement?.blur())
            await action(page, id).focus()
            await page.locator('.quick-tip').waitFor({ state: 'visible', timeout: 3000 })
            await fits(page, '.quick-tip')
          }
          at(`${path} theme picker`)
          await action(page, 'theme').click()
          await fits(page, '.quick-themes')
          const initial = await surfaces(page)
          assert(initial.theme === 'carbon' && initial.accent === '#c6ff34', `${path}: default changed`)
          const base = path === '/' ? 'rgb(10, 7, 24)' : path === '/sim/studio/' ? 'rgba(0, 0, 0, 0)' : path.startsWith('/sim/') ? 'rgb(14, 14, 15)' : 'rgb(11, 11, 12)'
          assert(initial.body.startsWith(base), `${path}: default surface changed: ${initial.body}`)
          let previous = initial
          for (const theme of ['navy', 'light']) {
            at(`${path} pick ${theme}`)
            await page.locator(`.quick-themes [data-bb-theme-id="${theme}"]`).click()
            await page.waitForTimeout(50)
            const picked = await surfaces(page)
            assert(picked.theme === theme && picked.family === theme, `${path}: theme attributes disagree`)
            for (const key of ['body', 'bar', 'tab', 'tray', 'card']) assert(picked[key] !== previous[key], `${path}: ${key} did not change to ${theme}`)
            await fits(page, '.quick-themes')
            await page.reload()
            await openTray(page)
            await action(page, 'theme').click()
            assert(JSON.stringify(await surfaces(page)) === JSON.stringify(picked), `${path}: ${theme} did not survive reload`)
            previous = picked
          }
          for (const accent of ['sky', 'rose', 'mint', 'product']) {
            at(`${path} pick ${accent}`)
            await page.locator(`.quick-themes [data-bb-accent-id="${accent}"]`).click()
            await checkFrost(page, '.quick-themes', { text: ['.bb-label', '.bb-theme'] })
            await checkFrost(page, '.quick-panel', { text: ['.quick-btn:not([data-group="primary"])'] })
          }
          await page.locator('.quick-themes [data-bb-accent-id="sky"]').click()
          const accent = await surfaces(page)
          assert(accent.accent === '#38bdf8' && accent.accent !== initial.accent, `${path}: accent did not apply`)
          await page.reload()
          await openTray(page)
          await action(page, 'theme').click()
          assert(JSON.stringify(await surfaces(page)) === JSON.stringify(accent), `${path}: accent did not survive reload`)
          await fits(page, '.quick-themes')
        } finally { await context.close() }
      }
      return 'home, viewer, arm, studio; all tooltips and theme choices'
    })
  }

  await check('quick actions: a sheet repositions through rotation and safe insets; the tab stays centred without reduced-motion slides', async () => {
    const { page, context } = await open(browser, origin, '/', { width: 375, height: 812, phone: true })
    try {
      await openTray(page)
      await action(page, 'theme').click()
      for (const viewport of [{ width: 844, height: 390 }, { width: 375, height: 812 }]) {
        await page.setViewportSize(viewport)
        await page.locator('.quick-tray').evaluate(el => {
          el.style.setProperty('--quick-safe-left', '24px')
          el.style.setProperty('--quick-safe-right', '24px')
          el.style.setProperty('--quick-safe-bottom', '20px')
          dispatchEvent(new Event('resize'))
        })
        await sleep(100)
        await fits(page, '.quick-themes')
        const layout = await page.evaluate(() => {
          const panel = document.querySelector('.quick-panel'), tab = document.querySelector('.quick-tab'), menu = document.querySelector('.quick-themes')
          const p = panel.getBoundingClientRect(), t = tab.getBoundingClientRect(), m = menu.getBoundingClientRect()
          return { centre: Math.abs(p.top + p.height / 2 - t.top - t.height / 2), left: m.left, right: innerWidth - m.right, bottom: innerHeight - m.bottom,
            motion: getComputedStyle(panel).transitionDuration }
        })
        assert(layout.centre <= 1 && layout.left >= 36 && layout.right >= 36 && layout.bottom >= 32, JSON.stringify(layout))
        assert(layout.motion.split(',').every(n => parseFloat(n) <= .001), 'reduced motion still slides')
      }
      await page.getByRole('button', { name: 'Close theme', exact: true }).click()
      assert(await page.locator('.quick-themes').evaluate(el => el.hidden), 'sheet close did not close it')
      assert(await action(page, 'theme').evaluate(el => el === document.activeElement), 'sheet close lost focus')
      await page.setViewportSize({ width: 844, height: 390 })
      await page.keyboard.press('ArrowDown')
      assert(await page.evaluate(() => document.activeElement?.getAttribute('data-bb-theme-id') === 'carbon'), 'keyboard landed on a hidden sheet control')
      await fits(page, '.quick-themes')
      await page.setViewportSize({ width: 360, height: 260 })
      await sleep(100)
      await fits(page, '.quick-themes', { scroll: true })
      await page.locator('.quick-themes').evaluate(el => { el.scrollTop = el.scrollHeight })
      await sleep(100)
      assert(await page.locator('.quick-themes').evaluate(el => el.scrollTop > 0), 'last-resort scrolling snapped back to the top')
      await page.locator('.quick-themes [data-bb-accent-id="mint"]').click()
      assert(await page.locator('.quick-themes').evaluate(el => el.scrollTop > 0), 'a choice lost the card scroll position')
    } finally { await context.close() }
  })

  for (const path of ['/sim/', '/sim/arena/', '/sim/drone/', '/link/', '/catalogue/', '/buttons/', '/sponsor/', '/donate/', '/privacy/']) {
    await check(`quick actions: ${path} applies both choices through the family tokens after reload`, async () => {
      const { page, context } = await open(browser, origin, path, { width: 390, height: 844, phone: true })
      try {
        await openTray(page)
        await action(page, 'theme').click()
        const before = await surfaces(page)
        await page.locator('.quick-themes [data-bb-theme-id="light"]').click()
        await page.locator('.quick-themes [data-bb-accent-id="sky"]').click()
        await sleep(50)
        const after = await surfaces(page)
        for (const key of ['body', 'bar', 'tab', 'tray', 'card', 'accent']) assert(before[key] === null || after[key] !== before[key], `${key} did not change`)
        await fits(page, '.quick-themes')
        await page.reload()
        await openTray(page)
        await action(page, 'theme').click()
        assert(JSON.stringify(await surfaces(page)) === JSON.stringify(after), 'surface or accent did not survive reload')
      } finally { await context.close() }
    })
  }

  await check('quick actions: home offers pairing, fullscreen and sound; each does its job; Esc closes it', async () => {
    const { page, context, errors } = await open(browser, origin, '/')
    try {
      await page.waitForFunction(() => document.querySelector('.quick-tray [data-quick="sound"]'), null, { timeout: 15000 }).catch(() => {})
      clear('tab', await box(page, '.quick-tab'), { 'the pairing card': await box(page, '[data-pair]'), 'the sound button': await box(page, '[data-sound]') })
      // From the keyboard: the tab, then the first action.
      await page.locator('.quick-tab').focus(); await page.keyboard.press('Enter'); await sleep(150)
      const ids = await offered(page)
      assert(ids.includes('pair') && ids.includes('fullscreen') && ids.includes('theme') && !ids.includes('reset') && inOrder(ids), `home offers ${ids}`)
      assert(await action(page, ids[0]).evaluate((el) => el === document.activeElement), 'the keyboard did not land on the first action')
      await page.keyboard.press('ArrowDown')
      assert(await action(page, ids[1]).evaluate((el) => el === document.activeElement), 'the arrow keys did not move through the actions')
      await page.keyboard.press('Escape'); await sleep(100)
      assert(!(await isOpen(page)) && await page.locator('.quick-tab').evaluate((el) => el === document.activeElement), 'Escape did not close it back to its tab')
      await openTray(page)
      await action(page, 'fullscreen').click()
      assert(await page.evaluate(() => window.__fullscreenCalls) === 1, 'fullscreen was not asked for')
      if (ids.includes('sound')) {
        const before = await page.locator('[data-sound]').getAttribute('data-state')
        await action(page, 'sound').click()
        await page.waitForFunction((b) => document.querySelector('[data-sound]').dataset.state !== b, before, { timeout: 5000 })
      }
      await action(page, 'pair').click(); await sleep(400)
      const card = await page.evaluate(() => { const c = document.querySelector('[data-pair]'); const r = c.getBoundingClientRect(); return { called: c.classList.contains('pair-called'), focused: c === document.activeElement, seen: r.top >= 0 && r.bottom <= innerHeight } })
      assert(card.called && card.focused && card.seen, `pairing did not bring the card up: ${JSON.stringify(card)}`)
      assert(!(await isOpen(page)), 'the tray stayed open after pairing')
      assert(!errors.length, errors.join(' | '))
      return `${ids.join(', ')}`
    } finally { await context.close() }
  })

  await check('quick actions: the sims hub offers pairing (by the viewer) and fullscreen, clear of its sidebar', async () => {
    const { page, context, errors } = await open(browser, origin, '/sim/')
    try {
      await openTray(page)
      const ids = await offered(page)
      assert(ids.join() === 'pair,next1,next2,next3,fullscreen,theme', `the hub offers ${ids}`)
      clear('open tray', await box(page, '.quick-panel'), { 'the sidebar': await box(page, '.sims-side') })
      await action(page, 'fullscreen').click()
      assert(await page.evaluate(() => window.__fullscreenCalls) === 1, 'fullscreen was not asked for')
      // A click outside (on the page's heading) closes it.
      await page.locator('h1').first().click(); await sleep(100)
      assert(!(await isOpen(page)), 'a click outside did not close it')
      await openTray(page)
      await Promise.all([page.waitForURL(/\/view\/$/), action(page, 'pair').click()])
      assert(!errors.length, errors.join(' | '))
      return ids.join(', ')
    } finally { await context.close() }
  })

  await check('quick actions: a sim offers all six, each does its job, and the tray keeps clear of the dock, the windows and the chip', async () => {
    const { page, context, errors } = await open(browser, origin, '/sim/drone/')
    try {
      await page.waitForFunction(() => window.__device && document.querySelector('.quick-tray [data-quick="camera"]') && document.querySelector('.quick-tray [data-quick="sound"]'), null, { timeout: 20000 })
      const windows = await boxes(page, '.sim-window:not([hidden])')
      const pairing = await chip(page)
      clear('tab', await box(page, '.quick-tab'), { 'the dock': await box(page, '.panel-dock'), 'a window': windows, 'the pairing pill': pairing.pill, 'the pairing card': pairing.card })
      await openTray(page)
      const ids = await offered(page)
      assert(ids.join() === 'pair,switch,reset,camera,body,fullscreen,sound,theme', `the sim offers ${ids}`)
      clear('open tray', await box(page, '.quick-panel'), { 'the dock': await box(page, '.panel-dock'), 'a window': windows, 'the pairing pill': pairing.pill, 'the pairing card': pairing.card })
      at('camera')
      const camera = () => page.evaluate(() => window.__device.stage.camera.position.toArray().map((v) => +v.toFixed(3)).join())
      const was = await camera()
      await action(page, 'camera').click()
      await page.waitForFunction((w) => window.__device.stage.camera.position.toArray().map((v) => +v.toFixed(3)).join() !== w, was, { timeout: 8000 })
      assert(await isOpen(page), 'the camera closed the tray')
      // First person is in its round (last, on a computer), and the framing after it brings the scene back.
      at('first person')
      const riding = () => page.evaluate(() => document.body.classList.contains('presence-active'))
      let presses = 1
      while (!(await riding())) {
        assert(presses < 6, 'the camera went round without first person')
        await openTray(page); await action(page, 'camera').click(); presses++; await sleep(200)
      }
      await openTray(page); await action(page, 'camera').click(); await sleep(200)
      assert(!(await riding()), 'the view after first person kept it')
      at('sound')
      // A press anywhere may already have started it: the switch turns it the other way, and back.
      const playing = () => page.evaluate(() => window.__simAudio.running && !window.__simAudio.muted)
      const before = await playing()
      await action(page, 'sound').click()
      await page.waitForFunction((b) => (window.__simAudio.running && !window.__simAudio.muted) !== b, before, { timeout: 8000 })
      assert(await action(page, 'sound').getAttribute('aria-pressed') === String(!before), 'the sound switch does not show its state')
      await action(page, 'sound').click()
      await page.waitForFunction((b) => (window.__simAudio.running && !window.__simAudio.muted) === b, before, { timeout: 8000 })
      assert(await playing() === before, 'the sound switch did not turn it back')
      at('theme')
      await action(page, 'theme').click(); await sleep(200)
      const picker = await box(page, '.quick-themes')
      assert(picker && !meets(picker, await box(page, '.quick-panel')), `the picker did not open beside the tray: ${JSON.stringify(picker)}`)
      await page.keyboard.press('Escape'); await sleep(100)
      at('fullscreen')
      await openTray(page)
      await action(page, 'fullscreen').click()
      assert(await page.evaluate(() => window.__fullscreenCalls) === 1, 'fullscreen was not asked for')
      at('reset')
      await page.evaluate(() => { const logic = window.__device.logic, home = logic.home.bind(logic); window.__homed = []; logic.home = (n) => { window.__homed.push(n); home(n) } })
      await action(page, 'reset').click(); await sleep(100)
      const units = await page.evaluate(() => window.__device.units.length)
      assert((await page.evaluate(() => window.__homed.length)) >= units, 'reset did not send every unit home')
      at('pair')
      await openTray(page)
      await page.evaluate(() => { const pill = document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.pill'); if (pill?.getAttribute('aria-expanded') === 'true') pill.click() })
      await action(page, 'pair').click()
      await page.waitForFunction(() => document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.wrap')?.hasAttribute('data-open'), null, { timeout: 5000 })
      assert(!(await isOpen(page)), 'the tray stayed open over the pairing card')
      // Clear of the card it opened, too.
      await sleep(500)
      clear('tab', await box(page, '.quick-tab'), { 'the pairing card': (await chip(page)).card })
      assert(!errors.length, errors.join(' | '))
      return `${ids.join(', ')}; first person at the camera's press ${presses}; ${units} units home`
    } finally { await context.close() }
  })

  await check('quick actions: the arena’s camera rides a player and back, and its reset clears the scores', async () => {
    const { page, context, errors } = await open(browser, origin, '/sim/arena/')
    try {
      await page.waitForFunction(() => window.__arena && document.querySelector('.quick-tray [data-quick="reset"]'), null, { timeout: 20000 })
      await openTray(page)
      const ids = await offered(page)
      assert(ids.join() === 'pair,switch,reset,camera,body,fullscreen,sound,theme', `the arena offers ${ids}`)
      await action(page, 'camera').click()
      await page.waitForFunction(() => document.body.classList.contains('presence-active'), null, { timeout: 5000 })
      await openTray(page)
      await action(page, 'camera').click()
      await page.waitForFunction(() => !document.body.classList.contains('presence-active'), null, { timeout: 5000 })
      await page.evaluate(() => { for (const s of window.__arena.slots) s.points = 3 })
      await openTray(page)
      await action(page, 'reset').click()
      assert(await page.evaluate(() => window.__arena.slots.every((s) => s.points === 0)), 'reset did not clear the scores')
      assert(!errors.length, errors.join(' | '))
      return ids.join(', ')
    } finally { await context.close() }
  })

  await check('quick actions: the viewer offers all six; the camera moves, reset brings it home, theme opens the picker', async () => {
    const { page, context, errors } = await open(browser, origin, '/view/')
    try {
      await page.waitForFunction(() => window.__viewer && document.querySelector('.quick-tray [data-quick="sound"]'), null, { timeout: 20000 })
      await openTray(page)
      const ids = await offered(page)
      assert(ids.join() === 'pair,open,reset,camera,body,fullscreen,sound,theme', `the viewer offers ${ids}`)
      clear('open tray', await box(page, '.quick-panel'), { 'the catalogue': await box(page, '#catalog') })
      // Reset brings the camera home; the camera's next view moves it; reset brings it back to the same place.
      const camera = () => page.evaluate(() => window.__viewer.camera.position.toArray().map((v) => +v.toFixed(2)).join())
      const settled = async () => { let last = ''; for (let i = 0; i < 40; i++) { const now = await camera(); if (now === last) return now; last = now; await sleep(150) } return last }
      await action(page, 'reset').click()
      const home = await settled()
      await openTray(page)
      await action(page, 'camera').click()
      await page.waitForFunction((h) => window.__viewer.camera.position.toArray().map((v) => +v.toFixed(2)).join() !== h, home, { timeout: 8000 })
      await settled()
      await openTray(page)
      await action(page, 'reset').click()
      await page.waitForFunction((h) => window.__viewer.camera.position.toArray().map((v) => +v.toFixed(2)).join() === h, home, { timeout: 8000 })
      await openTray(page)
      await action(page, 'theme').click(); await sleep(200)
      assert(await box(page, '.quick-themes'), 'the picker did not open')
      await page.keyboard.press('Escape')
      await openTray(page)
      const before = await page.evaluate(() => window.__simAudio.running && !window.__simAudio.muted)
      await action(page, 'sound').click()
      await page.waitForFunction((b) => (window.__simAudio.running && !window.__simAudio.muted) !== b, before, { timeout: 8000 })
      assert(!errors.length, errors.join(' | '))
      return ids.join(', ')
    } finally { await context.close() }
  })

  await check('quick actions: on a phone the tab is under the thumb and clear of the pairing chip; a tap opens it, first person is the camera\'s first press, a swipe back closes it', async () => {
    const { page, context, errors } = await open(browser, origin, '/sim/drone/', { width: 390, height: 844, phone: true })
    try {
      await page.waitForFunction(() => document.querySelector('.quick-tray [data-quick="camera"]'), null, { timeout: 20000 })
      await sleep(600)
      const tab = await box(page, '.quick-tab'), pairing = await chip(page)
      clear('tab', tab, { 'the pairing pill': pairing.pill, 'the pairing card': pairing.card })
      assert(tab.right >= 389 && (tab.top + tab.bottom) / 2 > 844 * 0.3, `the tab is not on the edge within reach: ${JSON.stringify(tab)}`)
      const reopen = async () => { if (!(await isOpen(page))) { await page.locator('.quick-tab').tap(); await sleep(200) } }
      await page.locator('.quick-tab').tap(); await sleep(200)
      assert(await isOpen(page), 'a tap did not open it')
      // First person, the phone's own view, one press away; the next press brings the scene back.
      at('first person')
      const riding = () => page.evaluate(() => document.body.classList.contains('presence-active'))
      await action(page, 'camera').tap(); await sleep(250)
      assert(await riding(), 'the camera\'s first press on a phone was not first person')
      await reopen()
      await action(page, 'camera').tap(); await sleep(250)
      assert(!(await riding()), 'the next press kept first person')
      at('swipe')
      await reopen()
      const panel = await box(page, '.quick-panel')
      const cdp = await context.newCDPSession(page), x = (panel.left + panel.right) / 2, y = (panel.top + panel.bottom) / 2
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      for (const dx of [10, 20, 32, 44]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y, id: 1 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(200)
      assert(!(await isOpen(page)), 'a swipe back did not close it')
      assert(!errors.length, errors.join(' | '))
      return `tab at ${Math.round((tab.top + tab.bottom) / 2)} px of 844`
    } finally { await context.close() }
  })

  await check('quick actions: on a phone on its side the tab keeps clear of the open pairing card, and the open tray never lies under it: it fits beside the card, or the card folds for it and comes back', async () => {
    const out = []
    for (const [width, height] of [[844, 390], [863, 360]]) {
      const { page, context, errors } = await open(browser, origin, '/sim/drone/', { width, height, phone: true })
      try {
        const size = `${width}x${height}`
        const card = () => page.evaluate(() => !!document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.wrap')?.hasAttribute('data-open'))
        await page.waitForFunction(() => document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.wrap')?.hasAttribute('data-open'), null, { timeout: 20000 })
        await sleep(600)
        const pairing = await chip(page)
        at(`${size} tab`)
        clear('tab', await box(page, '.quick-tab'), { 'the pairing pill': pairing.pill, 'the pairing card': pairing.card })
        at(`${size} open`)
        await page.locator('.quick-tab').tap()
        // Placed once the card has folded, if it had to: clear of what's showing, all of it on the screen.
        await sleep(1200)
        const panel = await box(page, '.quick-panel'), now = await chip(page), folded = !now.card
        clear('open tray', panel, { 'the pairing pill': now.pill, 'the pairing card': now.card })
        assert(panel.top >= 0 && panel.bottom <= height && panel.left >= 0, `the open tray runs off the screen: ${JSON.stringify(panel)}`)
        at(`${size} close`)
        await action(page, 'camera').focus(); await page.keyboard.press('Escape')
        if (folded) await page.waitForFunction(() => document.querySelector('.obpal-chip').shadowRoot.querySelector('.wrap').hasAttribute('data-open'), null, { timeout: 3000 })
        assert(await card(), 'the pairing card did not come back')
        assert(!errors.length, errors.join(' | '))
        out.push(`${size}: ${folded ? 'the card folded while it was open and came back' : 'beside the card'}, ${Math.round(panel.right - panel.left)}×${Math.round(panel.bottom - panel.top)} px`)
      } finally { await context.close() }
    }
    return out.join('; ')
  })

  await check('quick actions: the phone controller and the embed have no tray', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    try {
      const page = await context.newPage()
      for (const path of ['/p/', '/embed/']) {
        await page.goto(origin + path); await sleep(1500)
        assert(!(await page.locator('.quick-tray').count()), `${path} has a tray`)
      }
    } finally { await context.close() }
  })
}

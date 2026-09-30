/** Reach the catalogue and every sim's windows, including their scrolled controls, at the three review sizes. */
import { readFile } from 'node:fs/promises'
import { measureButtonInk, readButtonInk } from './button-ink.mjs'

export const BUTTON_SIZES = [[390, 844], [844, 390], [1440, 900]]
export const PHONE_BUTTON_ROUTES = ['arm', 'excavator', 'gimbal', 'jib', 'slider', 'telescope']
export async function buttonRoutes() {
  const registry = await readFile(new URL('../../src/sim/devices/registry.ts', import.meta.url), 'utf8')
  const devices = [...registry.matchAll(/view: \(\) => import\('\.\/([\w-]+)\.view'\)/g)].map(m => [m[1], `/sim/${m[1]}/`])
  return [['hub', '/sim/'], ['arm', '/sim/arm/'], ...['so101', 'arm5', 'desk', 'six', 'scara', 'delta'].map(k => [`arm-${k}`, `/sim/arm/?kind=${k}`]), ['arena', '/sim/arena/'], ['humanoid', '/sim/humanoid/'], ...devices]
}

export async function visitButtonStates(page, origin, path, sample) {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(origin + path)
  await page.waitForFunction(() => document.querySelector('.sim-windows, .hub, .catalogue, #controller-slot')).catch(e => { throw new Error(errors.join('; ') || e.message) })
  if (path !== '/sim/') {
    await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
    if (await page.locator('body.dev').count()) await page.locator('#dev-view button').first().waitFor({ state: 'attached' })
  }
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(700)
  const camera = page.getByRole('button', { name: 'Close camera', exact: true })
  if (await camera.isVisible()) await camera.click()
  const pill = page.locator('.obpal-chip .pill[aria-expanded="true"]')
  if (await pill.count()) { await pill.focus(); await pill.press('Escape') }
  const take = async state => {
    await sample(state, await readButtonInk(page))
  }
  await take('initial')
  const windows = await page.locator('[data-panel]').evaluateAll(els => els.map(el => el.dataset.panel))
  for (const id of windows) {
    await page.evaluate(id => {
      for (const el of document.querySelectorAll('[data-panel]:not([hidden])')) el.querySelector('[aria-label^="Minimise "]')?.click()
      document.querySelector(`[data-panel-toggle="${id}"]`)?.click()
    }, id)
    const panel = page.locator(`[data-panel="${id}"]`)
    await panel.waitFor({ state: 'visible' })
    await take(id)
    for (const extra of ['.arm-more']) {
      const buttons = panel.locator(extra)
      for (let n = 0; n < await buttons.count(); n++) {
        await buttons.nth(n).evaluate(el => el.click())
        await take(`${id}-${extra.slice(1)}-${n}`)
      }
    }
    const body = panel.locator('.panel-body')
    const steps = await body.evaluate(el => Math.ceil(el.scrollHeight / Math.max(el.clientHeight - 40, 40)))
    for (let n = 1; n < steps; n++) {
      await body.evaluate((el, n) => { el.scrollTop = n * Math.max(el.clientHeight - 40, 40) }, n)
      await take(`${id}-scroll-${n}`)
    }
    const hardware = panel.locator('.arm-hw:not([hidden])').first()
    if (await hardware.count()) {
      await hardware.evaluate(el => el.click())
      await take('hardware')
      await page.locator('#hw-close').click()
    }
  }
  await visitPresenceButtons(page, take)
  if (path === '/sim/humanoid/') {
    await page.locator('#range-calibrate').evaluate(el => el.click())
    const dialog = page.locator('dialog[open]')
    for (let step = 0; step < 8; step++) {
      await dialog.evaluate(el => { el.scrollTop = 0 })
      await take(`calibration-${step + 1}`)
      await dialog.evaluate(el => { el.scrollTop = el.scrollHeight })
      await take(`calibration-${step + 1}-actions`)
      await dialog.getByRole('button', { name: 'Skip', exact: true }).evaluate(el => el.click())
    }
    await take('calibration-complete')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }
  if (path === '/sim/') {
    const filters = page.locator('.sims-filters'), toggle = page.locator('.kit-side-toggle')
    if (await filters.isVisible()) { await filters.click(); await take('filters') }
    else if (await toggle.isVisible()) { await toggle.click(); await take('filter-rail'); await toggle.click() }
    const sidebar = page.locator('.kit-side-body')
    const steps = await sidebar.evaluate(el => Math.ceil(el.scrollHeight / Math.max(el.clientHeight - 40, 40)))
    for (let n = 0; n < steps; n++) {
      await sidebar.evaluate((el, n) => { el.scrollTop = n * Math.max(el.clientHeight - 40, 40) }, n)
      await take(`filters-scroll-${n}`)
    }
    for (const select of await page.locator('button.kit-select').all()) if (await select.isVisible()) {
      await select.click(); await take('select'); await page.keyboard.press('Escape')
    }
    const category = page.locator('#categories button').first()
    await category.evaluate(el => el.click())
    if (await page.locator('#sheet-done').isVisible()) await page.locator('#sheet-done').click()
    await take('filter-chip')
    await page.locator('#clear-filters').evaluate(el => el.click())
    const total = await page.evaluate(() => document.documentElement.scrollHeight)
    for (let top = 0; top < total; top += page.viewportSize().height - 80) {
      await page.evaluate(top => scrollTo(0, top), top); await take(`catalogue-${top}`)
    }
  }
  if (errors.length) throw new Error(errors.join('; '))
}

/** First-person actions remain in the DOM while their owning panel is closed. */
export async function visitPresenceButtons(page, take) {
  const enter = page.locator('button.presence-enter')
  if (await enter.count()) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-panel]:not([hidden])')) el.querySelector('[aria-label^="Minimise "]')?.click()
      document.querySelector('[data-panel-toggle="controls"]')?.click()
    })
    await enter.evaluate(el => el.click())
    await take('first-person')
    const options = page.locator('.presence-options')
    if (await options.count()) {
      await options.evaluate(el => { if (el.getAttribute('aria-expanded') !== 'true') el.click() })
      await take('first-person-options')
      const grab = page.getByRole('button', { name: 'Grab', exact: true })
      if (await grab.count()) {
        await grab.scrollIntoViewIfNeeded()
        const open = await grab.locator('svg').innerHTML()
        await grab.evaluate(el => el.click())
        const release = page.getByRole('button', { name: 'Release', exact: true })
        await release.waitFor()
        await release.scrollIntoViewIfNeeded()
        if (await release.locator('svg').innerHTML() === open || await release.getAttribute('data-tip') !== 'Release') throw new Error('Grab did not update its glyph and tooltip')
        await take('first-person-grabbing')
        await page.getByRole('button', { name: 'Release', exact: true }).evaluate(el => el.click())
        await page.getByRole('button', { name: 'Grab', exact: true }).waitFor()
      }
    }
  }
}

/** A real phone joins the sim; measure every part of its scrollable node strip and action tray. */
export async function visitNodeButtons(browser, origin, name, sample) {
  const screenContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  try {
    await phoneContext.addInitScript(() => {
      for (const k of ['gyro', 'models', 'more', 'point', 'lock', 'track', 'level', 'hold-part']) sessionStorage.setItem(`obpal.hint.${k}`, '1')
    })
    const screen = await screenContext.newPage(), phone = await phoneContext.newPage()
    await screen.goto(`${origin}/sim/${name}/`)
    await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
    await phone.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
    await phone.waitForFunction(() => document.body.classList.contains('live'))
    if (name === 'arm') {
      await screen.locator('#people .allow').first().click()
      await phone.locator('.scene-btn').click()
      await phone.locator('.pick', { hasText: 'Whole arm' }).first().click()
    }
    if (!(await phone.locator('.modes').isVisible())) {
      await phone.locator('.gp:not([hidden]) [data-act=controllers]').click()
      await phone.locator('.ctl-card[data-c="face.trackpad"]').click()
    } else if (await phone.locator('[data-tab="rotate"][aria-selected="false"]').count()) await phone.locator('[data-tab="rotate"]').click()
    await phone.locator('#nstrip:not([hidden])').waitFor()
    await phone.locator('#toast.show').waitFor({ state: 'hidden' })
    for (const [width, height] of BUTTON_SIZES) {
      await phone.setViewportSize({ width, height }); await phone.evaluate(() => document.fonts.ready); await phone.waitForTimeout(200)
      for (const selector of ['.ns-list', '#tray']) {
        const scroller = phone.locator(selector)
        const steps = await scroller.evaluate(el => Math.max(Math.ceil(el.scrollHeight / Math.max(el.clientHeight, 1)), Math.ceil(el.scrollWidth / Math.max(el.clientWidth, 1))))
        for (let n = 0; n < steps; n++) {
          await scroller.evaluate((el, n) => { el.scrollTop = n * el.clientHeight; el.scrollLeft = n * el.clientWidth }, n)
          await phone.waitForTimeout(100)
          const measured = (await phone.evaluate(measureButtonInk)).filter(r => /(?:^| )(ns-item|tray-btn)(?: |$)/.test(r.classes))
          await sample(phone, `${width}x${height}`, `${selector === '#tray' ? 'tray' : 'strip'}-${n}`, measured)
        }
      }
      if (['arm', 'gimbal', 'jib'].includes(name)) {
        const action = name === 'arm' ? 'grip' : 'record'
        const button = phone.locator(`#tray [data-id="${action}"]`)
        const idle = action === 'grip' ? 'Close grip' : 'Record', active = action === 'grip' ? 'Open grip' : 'Stop recording'
        const state = async (label, pressed) => {
          await phone.waitForFunction(({ action, label, pressed }) => {
            const b = document.querySelector(`#tray [data-id="${action}"]`)
            return b?.getAttribute('aria-label') === label && b.dataset.tip === label && b.getAttribute('aria-pressed') === String(pressed)
          }, { action, label, pressed })
          await button.scrollIntoViewIfNeeded()
          await phone.locator('#toast.show').waitFor({ state: 'hidden' })
          await phone.waitForTimeout(100)
          const colour = await button.evaluate((el, pressed) => {
            const glyph = el.querySelector('svg'), expected = document.createElement('span')
            expected.style.color = pressed ? 'var(--bb-accent-ink)' : getComputedStyle(el).color
            el.append(expected)
            const matches = getComputedStyle(glyph).color === getComputedStyle(expected).color
            expected.remove()
            return matches
          }, pressed)
          if (!colour) throw new Error(`${action} does not follow the family action colour`)
          await sample(phone, `${width}x${height}`, `${action}-${pressed ? 'active' : 'idle'}`, (await phone.evaluate(measureButtonInk)).filter(r => /(?:^| )(ns-item|tray-btn)(?: |$)/.test(r.classes)))
          return button.locator('svg').innerHTML()
        }
        const before = await state(idle, false)
        if (action === 'record' && !await button.locator('circle[fill="currentColor"]').count()) throw new Error('Record must be a filled dot')
        await button.click()
        const after = await state(active, true)
        if (before === after) throw new Error(`${action} did not change its glyph`)
        if (action === 'record' && !await button.locator('rect[rx]').count()) throw new Error('Stop recording must be a rounded square')
        // Home on the screen is a separate input path: the phone must follow the host, not count its own taps.
        if (name === 'arm' || name === 'jib') await screen.locator('#home-all').evaluate(el => el.click())
        else await button.click()
        if (await state(idle, false) !== before) throw new Error(`${action} did not restore its glyph`)
      }
    }
  } finally { await phoneContext.close(); await screenContext.close() }
}

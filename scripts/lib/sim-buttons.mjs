/** Reach the catalogue and every sim's windows, including their scrolled controls, at the three review sizes. */
import { readFile } from 'node:fs/promises'
import { measureButtonInk } from './button-ink.mjs'

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
    await page.evaluate(() => document.fonts.ready)
    // Let layout, mutation and visibility observers finish across real frames, including on a busy GPU runner.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
    await sample(state, await page.evaluate(measureButtonInk))
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
    }
  } finally { await phoneContext.close(); await screenContext.close() }
}

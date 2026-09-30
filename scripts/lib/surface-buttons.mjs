/** Shared traversal for the site, Viewer, embed, phone and guarded Link pages. */
import { readButtonInk, inkError, inkSummary } from './button-ink.mjs'
import { BUTTON_SIZES } from './sim-buttons.mjs'
import { setSurface } from './frost.mjs'
import { existsSync } from 'node:fs'

export { BUTTON_SIZES }
export const SITE_BUTTON_ROUTES = [['home', '/'], ['hub', '/sim/'], ...['link', 'privacy', 'sponsor', 'donate', 'catalogue', 'buttons', ...['support', 'trust'].filter(name => existsSync(new URL(`../../dist/client/${name}/index.html`, import.meta.url)))].map(name => [name, `/${name}/`]), ['phone-start', '/p/'], ['viewer', '/view/'], ['embed', '/embed/']]

export async function takeButtonInk(page, sample, state) {
  await sample(page, state, await readButtonInk(page, { surfaces: true }))
}

export async function scrollButtonInk(page, sample, state) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  for (let top = 0; top < height; top += page.viewportSize().height - 80) {
    await page.evaluate(top => scrollTo(0, top), top)
    await takeButtonInk(page, sample, `${state}-${top}`)
  }
  await page.evaluate(() => scrollTo(0, 0))
}

export async function visitSiteButtons(page, origin, path, sample) {
  await page.goto(origin + path)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(900)
  if (path === '/view/') await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
  for (const theme of ['carbon', 'light']) {
    await setSurface(page, theme)
    await scrollButtonInk(page, sample, theme)
    for (const selector of ['.top-menu', '#chip-invite', '.obpal-chip .pill', '.more-btn', '#catalog-btn', '#light-btn', '.sims-filters']) {
      const button = page.locator(selector).first()
      if (!await button.isVisible()) continue
      await button.evaluate(el => el.click())
      await takeButtonInk(page, sample, `${theme}-${selector.replace(/[^\w]/g, '')}`)
      await page.keyboard.press('Escape')
    }
    const shortcuts = page.getByRole('button', { name: 'Shortcuts', exact: true })
    if (await shortcuts.isVisible()) {
      await shortcuts.evaluate(el => el.click())
      const themeButton = page.locator('[data-quick="theme"]')
      if (await themeButton.isVisible()) {
        await themeButton.evaluate(el => el.click())
        await takeButtonInk(page, sample, `${theme}-surface-tray`)
        await page.keyboard.press('Escape')
      }
      await page.keyboard.press('Escape')
    }
  }
  if (path === '/view/') {
    const phone = await page.context().newPage()
    try {
      await phone.goto(await page.evaluate(() => window.__obpal.pairingUrl))
      await phone.waitForFunction(() => document.body.classList.contains('live'))
      await page.bringToFront()
      for (const theme of ['carbon', 'light']) {
        await setSurface(page, theme)
        await takeButtonInk(page, sample, `${theme}-paired`)
        await page.locator('.obpal-chip .pill').evaluate(el => el.click())
        await takeButtonInk(page, sample, `${theme}-paired-card`)
        await page.keyboard.press('Escape')
      }
    } finally { await phone.close() }
  }
}

export async function visitPhoneButtons(browser, origin, sample) {
  for (const [host, faces] of [['/view/', ['trackpad', 'wii', 'hand', 'gamepad', 'mouse', 'wheel']], ['/sim/device/?d=lamp', ['keyboard']], ['/sim/device/?d=studio', ['drums', 'keys']]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, hasTouch: true, reducedMotion: 'reduce', deviceScaleFactor: 2 })
    try {
      await context.addInitScript(() => {
        for (const k of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${k}`, '1')
        navigator.mediaDevices.getUserMedia = async options => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
          const stream = canvas.captureStream(10), track = stream.getVideoTracks()[0]
          track.getCapabilities = () => ({ torch: true, zoom: { min: 1, max: 2, step: 1 } })
          track.getSettings = () => ({ facingMode: options.video.facingMode.ideal, width: 64, height: 64 })
          track.applyConstraints = async () => {}
          const draw = () => { if (track.readyState === 'ended') return; canvas.getContext('2d').fillRect(0, 0, 64, 64); requestAnimationFrame(draw) }
          draw(); return stream
        }
        window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code'] } async detect() { return [] } }
      })
      const screen = await context.newPage(), phone = await context.newPage()
      await screen.goto(origin + host)
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await phone.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await phone.waitForFunction(() => document.body.classList.contains('live'))
      const close = async () => {
        for (let n = 0; n < 4 && await phone.locator('dialog[open], .sheet-wrap, .ctl-wrap').count(); n++) {
          const closed = await phone.evaluate(() => {
            const exits = [...document.querySelectorAll('dialog[open] [data-camera-close], dialog[open] [aria-label="Close"], .sheet-wrap .sheet-x, .sheet-wrap [aria-label="Close"]')].filter(el => el.checkVisibility() && el.getBoundingClientRect().height)
            const exit = exits.at(-1); exit?.click(); return !!exit
          })
          if (!closed && await phone.locator('dialog[open], .sheet-wrap').count()) await phone.keyboard.press('Escape')
          await phone.waitForTimeout(200)
        }
        const dismissed = await phone.evaluate(() => { const notice = document.querySelector('.bt-notice:not(.out) .bt-n-x'); notice?.click(); return !!notice })
        if (dismissed) await phone.waitForTimeout(200)
      }
      const catalogue = async () => {
        const gp = phone.locator('.gp:not([hidden]) [data-act=controllers]')
        await (await gp.isVisible() ? gp : phone.locator('#ctl-more')).evaluate(el => el.click())
        await phone.locator('.ctl-sheet').waitFor()
      }
      for (const [width, height] of BUTTON_SIZES) {
        await phone.setViewportSize({ width, height })
        for (const theme of ['carbon', 'light']) {
          await setSurface(phone, theme)
          // A host preference can arrive when a face mounts. Pick the review surface after that handoff as well.
          const take = async state => {
            await setSurface(phone, theme)
            const measured = await readButtonInk(phone, { surfaces: true })
            if (await phone.evaluate(() => document.documentElement.dataset.bbTheme) !== theme) throw new Error(`Phone surface changed before ${theme}-${state}`)
            await sample(phone, `${width}x${height}`, `${theme}-${state}`, measured)
          }
          for (const face of faces) {
            await close(); await catalogue(); await take('catalogue')
            await phone.locator(`.ctl-card[data-c="face.${face}"]`).evaluate(el => el.click())
            await phone.waitForTimeout(300)
            await take(face)
            if (face === 'trackpad') for (const mode of ['hand', 'body']) {
              const tab = phone.locator(`[data-tab="camera-${mode}"]`)
              if (!await tab.isVisible()) continue
              await tab.evaluate(el => el.click())
              await phone.locator(`.obpal-camera[data-mode="${mode}"][open]`).waitFor()
              await take(`camera-${mode}`); await close()
            }
            const gear = phone.locator('.gp:not([hidden]) [data-act=settings]')
            await (await gear.isVisible() ? gear : phone.locator('#gear')).evaluate(el => el.click())
            await phone.locator('.sheet.settings').waitFor(); await take(`${face}-settings`)
            const body = phone.locator('.sheet.settings')
            const steps = await body.evaluate(el => Math.ceil(el.scrollHeight / Math.max(el.clientHeight - 40, 40)))
            for (let n = 1; n < steps; n++) {
              await body.evaluate((el, n) => { el.scrollTop = n * Math.max(el.clientHeight - 40, 40) }, n)
              await take(`${face}-settings-scroll-${n}`)
            }
            await body.evaluate(el => { el.scrollTop = 0 })
            if (face === 'trackpad') {
              await phone.locator('#scan-open').evaluate(el => el.click())
              await phone.locator('.obpal-camera[open]').waitFor(); await take('camera')
              const zoom = phone.locator('[data-camera-zoom]')
              await zoom.waitFor(); await zoom.evaluate(el => el.click())
              await phone.locator('[data-camera-torch]').evaluate(el => el.click())
              await take('camera-zoom-torch')
            }
            await close()
            if (face === 'trackpad') {
              await phone.getByRole('button', { name: 'Connections', exact: true }).evaluate(el => el.click())
              await phone.locator('.connection-list[aria-busy="false"]').waitFor()
              await take('connections'); await close()
            }
          }
          const connections = phone.getByRole('button', { name: 'Connections', exact: true })
          if (await connections.isVisible()) {
            await connections.evaluate(el => el.click()); await phone.locator('.connection-list[aria-busy="false"]').waitFor()
            await take('connections'); await close()
          }
        }
      }
    } finally { await context.close() }
  }
}

export async function visitLinkButtons(page, sample) {
  for (const [width, height] of BUTTON_SIZES) {
    await page.setViewportSize({ width, height })
    for (const theme of ['carbon', 'light']) {
      await page.locator(`.look[data-theme="${theme}"]`).evaluate(el => el.click())
      await scrollButtonInk(page, (p, state, rows) => sample(p, `${width}x${height}`, state, rows), theme)
      if (await page.locator('#look').count()) {
        await page.locator('#look').evaluate(el => el.click())
        await takeButtonInk(page, (p, state, rows) => sample(p, `${width}x${height}`, state, rows), `${theme}-palette`)
        await page.keyboard.press('Escape')
        await page.evaluate(() => document.documentElement.classList.remove('in-tab'))
        await scrollButtonInk(page, (p, state, rows) => sample(p, `${width}x${height}`, state, rows), `${theme}-popup-window`)
        await page.evaluate(() => document.documentElement.classList.add('in-tab'))
      }
    }
  }
}

/** The evidence and guards fail on the same measured geometry. */
export function assertButtonInk(rows) {
  if (!rows.some(r => r.groupInk)) throw new Error('No visible control ink measured')
  const overflow = rows.filter(r => !r.occluded && r.classes.split(' ').includes('ctl-tab') && r.groupInk &&
    (r.groupInk.x < r.button.x - .5 || r.groupInk.x + r.groupInk.width > r.button.x + r.button.width + .5))
  if (overflow.length) throw new Error(`Tab ink spills outside its button: ${overflow.slice(0, 8).map(r => r.name).join(', ')}`)
  const bad = rows.filter(r => !r.occluded && inkError(r) > .5).sort((a, b) => inkError(b) - inkError(a))
  if (bad.length) throw new Error(`${bad.length} off-centre: ${bad.slice(0, 8).map(r => `${r.state ?? ''} ${r.name.slice(0, 45)} ${inkError(r).toFixed(3)}px ${JSON.stringify(r.groupOffset)}`).join('; ')}`)
  const s = inkSummary(rows)
  return `${s.measured} controls; worst ${s.worst.toFixed(3)}px, p95 ${s.p95.toFixed(3)}px`
}

export async function guardSiteButtons(browser, origin, routes, check) {
  for (const [name, path] of routes) for (const [width, height] of BUTTON_SIZES) await check(`${name} button ink ${width}x${height}, Carbon and Light`, async () => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, isMobile: width < 900, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    try {
      const rows = []
      await visitSiteButtons(await context.newPage(), origin, path, (_page, state, measured) => rows.push(...measured.map(r => ({ state, ...r }))))
      return assertButtonInk(rows)
    } finally { await context.close() }
  })
}

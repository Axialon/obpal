import sharp from 'sharp'
import { setSurface } from './lib/frost.mjs'

async function contrast(page, pc = true) {
  const box = await page.locator('#link-space').evaluate(canvas => {
    const node = canvas.hidden ? document.querySelector('#link-flat') : canvas
    const rect = node.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const { data, info } = await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const luminance = (x, y) => {
    const offset = (Math.round(y) * info.width + Math.round(x)) * 3
    return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => { const v = data[offset + i] / 255; return sum + weight * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) }, 0)
  }
  const ratios = []
  // Sample each device frame and viewport, plus both chosen connections.
  const cores = [[60, 108], [216, 108], [432, 108], [96, 108], [288, 120], [480, 108],
    ...[144, 156, 168, 180, 192, 204, 372, 384, 396, 408, 420].map(x => [x, 108])]
  for (const [gx, gy] of cores) {
    if (!pc && gx >= 372 && gx <= 420) continue
    const x = box.x + box.width / 2 + (gx - 288) * box.width / 576
    const y = box.y + box.height / 2 + (gy - 120) * box.width / 576
    const background = luminance(x + box.width / 96, y + box.width / 96)
    let ratio = 1
    for (let dy = -4; dy <= 4; dy++) for (let dx = -1; dx <= 1; dx++) {
      const core = luminance(x + dx, y + dy)
      ratio = Math.max(ratio, (Math.max(core, background) + .05) / (Math.min(core, background) + .05))
    }
    if (!Number.isFinite(ratio) || ratio < 4.5) throw new Error(`hero dot ${gx},${gy}: ${ratio.toFixed(2)} below 4.5:1`)
    ratios.push(ratio.toFixed(2))
  }
  return ratios.join(', ')
}

export async function runLinkHero(browser, origin, check) {
  for (const width of [360, 390, 1280]) for (const flat of [false, true]) {
    await check(`Link hero ${width}px ${flat ? 'flat' : 'beads'}: states, labels, contrast and reduced motion`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
      try {
        if (flat) await context.addInitScript(() => {
          const original = HTMLCanvasElement.prototype.getContext
          HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type.startsWith('webgl') ? null : original.call(this, type, ...args) }
        })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(origin + '/link/')
      await page.waitForFunction(() => ['beads', 'flat'].includes(document.querySelector('#link-space')?.dataset.dotRenderer))
        await page.locator('.constellation').scrollIntoViewIfNeeded()
        await page.waitForFunction(() => Number(document.querySelector('#link-space').dataset.dotFrames) > 0)
        if (flat !== await page.locator('#link-flat').isVisible()) throw new Error('incorrect fallback')
        const before = await page.locator('.constellation').boundingBox()
        for (const [step, state] of [['pair', 'pairing'], ['enable', 'connected'], ['try', 'connected']]) {
          await page.locator(`[data-link-step="${step}"]`).click()
          if (await page.locator('#link-space').getAttribute('data-dot-state') !== state) throw new Error('journey state not applied')
          if (await page.locator('#link-space').getAttribute('data-dot-pc') !== 'false') throw new Error('journey implicitly chose PC')
        }
        for (const theme of ['carbon', 'light']) { await setSurface(page, theme); await contrast(page, false) }
        await page.locator('#hero-pc').click()
        if (await page.locator('#link-space').getAttribute('data-dot-pc') !== 'true') throw new Error('explicit PC preview not applied')
        const values = []
        for (const theme of ['carbon', 'light']) { await setSurface(page, theme); values.push(`${theme}: ${await contrast(page)}`) }
        const after = await page.locator('.constellation').boundingBox()
        if (Math.abs(before.height - after.height) > 1) throw new Error(`preview layout shifted ${before.height} to ${after.height}`)
        const labels = await page.locator('.device-labels').evaluate(el => [...el.children].map(label => {
          const rect = label.getBoundingClientRect(), stage = document.querySelector('.hero-stage').getBoundingClientRect()
          return { text: label.textContent, centre: (rect.x + rect.width / 2 - stage.x) / stage.width, left: rect.x - stage.x, right: rect.right - stage.right }
        }))
        if (!labels[2].text.includes('optional') || labels.some((label, i) => Math.abs(label.centre - (i * 2 + 1) / 6) > .005 || label.left < 0 || label.right > 0)) throw new Error('device labels clip or misalign')
        const count = await page.locator('#link-space').getAttribute('data-dot-frames')
        await page.locator(flat ? '#link-flat' : '#link-space').dispatchEvent('pointermove', { clientX: 200, clientY: 250 })
        await page.waitForTimeout(350)
        if (count !== await page.locator('#link-space').getAttribute('data-dot-frames')) throw new Error('reduced motion redraws')
        await page.locator('#hero-reset').click()
        if (await page.locator('#link-space').getAttribute('data-dot-state') !== 'dropped' || await page.locator('#link-space').getAttribute('data-dot-pc') !== 'false') throw new Error('reset retained a PC route')
        if (errors.length) throw new Error(errors.join('; '))
        return values.join('; ')
      } finally { await context.close() }
    })
  }
  for (const flat of [false, true]) await check(`Link hero ${flat ? 'flat' : 'bead'} wave stays legible on Light while moving`, async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' })
    try {
      if (flat) await context.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type.startsWith('webgl') ? null : original.call(this, type, ...args) }
      })
      const page = await context.newPage()
      await page.goto(origin + '/link/')
      await page.waitForFunction(() => ['beads', 'flat'].includes(document.querySelector('#link-space')?.dataset.dotRenderer))
      await setSurface(page, 'light')
      await page.locator('[data-link-step="enable"]').click()
      await page.locator('#hero-pc').click()
      const ratios = []
      for (const accent of [null, '#702e21', '#30494d']) {
        if (accent) await page.evaluate(accent => {
          const hero = document.querySelector('[data-link-hero]')
          hero.style.setProperty('--ob-dot-active', accent)
          hero.style.setProperty('--ob-dot-surface', '#ffffff')
          hero.style.background = '#ffffff'
          document.documentElement.setAttribute('data-bb-accent', `dot-contrast-${accent.slice(1)}`)
          if (getComputedStyle(document.querySelector('#link-space')).getPropertyValue('--ob-dot-active').trim() !== accent) throw new Error('accent fixture did not reach the hero')
        }, accent)
        await page.locator('[data-link-step="enable"]').click()
        for (const part of ['link', 'pc-link']) {
          await page.waitForFunction(part => document.querySelector('#link-space').dataset.dotPart === part, part)
          for (let i = 0; i < 6; i++) { ratios.push(`${accent ?? 'product'} ${part}: ${await contrast(page)}`); await page.waitForTimeout(200) }
        }
      }
      return ratios.join('; ')
    } finally { await context.close() }
  })
  await check('Link hero effects stop at rest, offscreen, hidden and after history restoration', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' })
    try {
      const page = await context.newPage()
      await page.goto(origin + '/link/')
      await page.waitForFunction(() => ['beads', 'flat'].includes(document.querySelector('#link-space')?.dataset.dotRenderer))
      const frames = () => page.locator('#link-space').getAttribute('data-dot-frames')
      await page.locator('#hero-reset').click()
      await page.waitForTimeout(750)
      const rested = await frames()
      await page.waitForTimeout(350)
      if (rested !== await frames()) throw new Error('settled preview redraws')
      await page.locator('[data-link-step="pair"]').click()
      await page.waitForFunction(() => document.querySelector('#link-space').dataset.dotPart === 'phone')
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(200)
      const offscreen = await frames()
      await page.waitForTimeout(350)
      if (offscreen !== await frames()) throw new Error('offscreen preview redraws')
      await page.locator('.constellation').scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      if (await page.locator('#link-space').getAttribute('data-dot-part') !== 'rest') throw new Error('missed effects replayed')
      await page.locator('[data-link-step="enable"]').click()
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
      const hidden = await frames()
      await page.waitForTimeout(350)
      if (hidden !== await frames()) throw new Error('hidden preview redraws')
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })) })
      await page.waitForFunction(() => ['beads', 'flat'].includes(document.querySelector('#link-space')?.dataset.dotRenderer))
      await page.waitForTimeout(300)
      const restored = await frames()
      await page.waitForTimeout(350)
      if (restored !== await frames() || await page.locator('#link-space').getAttribute('data-dot-part') !== 'rest') throw new Error('history restoration restarted effect')
      const lost = await page.locator('#link-space').evaluate(canvas => {
        const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
        extension?.loseContext(); return !!extension
      })
      if (!lost) throw new Error('cannot exercise hero context loss')
      await page.locator('#link-flat').waitFor({ state: 'visible' })
      await page.locator('[data-link-step="pair"]').click()
      await page.waitForFunction(() => document.querySelector('#link-space').dataset.dotPart === 'phone')
      await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })) })
      await page.waitForTimeout(300)
      await page.locator('#link-flat').waitFor({ state: 'visible' })
      const beforeStep = await page.locator('#link-flat').evaluate(canvas => canvas.toDataURL())
      await page.locator('[data-link-step="enable"]').click()
      await page.waitForTimeout(100)
      if (beforeStep === await page.locator('#link-flat').evaluate(canvas => canvas.toDataURL())) throw new Error('lost-context history restore left a stale flat frame')
    } finally { await context.close() }
  })
}

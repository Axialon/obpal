import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { setSurface } from './frost.mjs'
import { rawRun } from './distill.mjs'

const luminance = rgb => rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)

/** Real Tab traversal, pointer focus, and contrast against pixels beside a control on every family surface. */
export async function interactionStates(page, selector, { click = true, escape = true, surface = true, prepare, themes = ['carbon', 'navy', 'violet', 'wine', 'onyx', 'light'] } = {}) {
  const target = page.locator(selector).first(), samples = []
  if (surface) await page.waitForFunction(() => !!window.BlackboxesFamily)
  const previous = surface ? await page.evaluate(() => window.BlackboxesFamily.getTheme()) : null
  try {
    for (const theme of themes) {
      if (surface) await setSurface(page, theme)
      if (prepare) await prepare(page, theme)
      await target.scrollIntoViewIfNeeded()
      await page.mouse.move(1, page.viewportSize().height - 1)
      await page.evaluate(() => {
        let active = document.activeElement
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
        active?.blur()
      })
      await page.waitForTimeout(550)
      let reached = false
      for (let n = 0; n < 180; n++) {
        await page.keyboard.press('Tab')
        if (await target.evaluate(el => el === el.getRootNode().activeElement)) { reached = true; break }
      }
      assert(reached, `${selector}: Tab never reached the control`)
      await page.waitForTimeout(200)
      if (surface) assert.equal(await page.evaluate(() => document.documentElement.dataset.bbTheme), theme, `${selector}: requested surface did not persist through Tab focus`)
      // A style flush can start even a reduced-motion transition after a throttled frame.
      // Finish finite control transitions and paint before reading the ring's geometry.
      await target.evaluate(async el => {
        getComputedStyle(el).outline
        await Promise.all(el.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      const readState = el => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect()
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const ctx = canvas.getContext('2d'); ctx.fillStyle = s.outlineColor; ctx.fillRect(0, 0, 1, 1)
        return { visible: el.matches(':focus-visible'), style: s.outlineStyle, width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset), color: s.outlineColor, rgb: [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3), x: r.x, y: r.y, w: r.width, h: r.height }
      }
      const state = await target.evaluate(readState)
      assert(state.visible && state.style === 'solid' && state.width >= 2, `${theme}: missing solid keyboard indicator`)
      // Tab can scroll the page. Capture afterwards, in CSS pixels even on a high-DPR phone.
      // Compare the rendered ring with both adjacent edges, including its actual glass/glow backdrop.
      const snapshot = await page.screenshot({ scale: 'css' })
      const afterCapture = await target.evaluate(readState)
      const shot = await sharp(snapshot).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const edges = [
        [state.x, state.y + state.h / 2, -1, 0], [state.x + state.w, state.y + state.h / 2, 1, 0],
        [state.x + state.w / 2, state.y, 0, -1], [state.x + state.w / 2, state.y + state.h, 0, 1],
      ]
      const pixel = ([x, y]) => {
        const at = (Math.floor(y) * shot.info.width + Math.floor(x)) * shot.info.channels
        return [...shot.data.subarray(at, at + 3)]
      }
      const inside = ([x, y]) => x >= 0 && y >= 0 && x < shot.info.width && y < shot.info.height
      const measurements = edges.flatMap(([x, y, dx, dy], edge) => {
        const point = distance => [x + dx * distance, y + dy * distance]
        // At integer boundaries the nominal midpoint can land on an antialiased pixel.
        // Use the pixel closest to the declared paint within the stroke, never outside it.
        const count = Math.ceil(state.width * 2)
        const stroke = Array.from({ length: count }, (_, i) => point(state.offset + state.width * (i + 0.5) / count)).filter(inside)
        const distance = p => pixel(p).reduce((sum, value, i) => sum + (value - state.rgb[i]) ** 2, 0)
        const ring = stroke.sort((a, b) => distance(a) - distance(b))[0]
        // Step past the antialiased boundary to sample a solid adjacent pixel.
        const adjacent = [point(state.offset - 1.5), point(state.offset + state.width + 1.5)]
        return ring ? adjacent.filter(inside).map(p => ({ edge, ring, ringRgb: pixel(ring), adjacent: p, adjacentRgb: pixel(p), ratio: contrast(pixel(ring), pixel(p)) })) : []
      })
      assert(measurements.length >= 4, `${theme}: too little of ${selector}'s ring is visible to measure`)
      const minimum = Math.min(...measurements.map(sample => sample.ratio))
      if (minimum < 3) {
        const detail = await target.evaluate(el => {
          const matched = [], walk = (rules, source) => {
            for (const rule of rules) {
              if (rule.selectorText) { try { if (el.matches(rule.selectorText) && /outline|interaction-ring/.test(rule.style.cssText)) matched.push({ source, selector: rule.selectorText, css: rule.style.cssText }) } catch {} }
              else if (rule.cssRules) walk(rule.cssRules, source)
            }
          }
          for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, sheet.href || 'inline') } catch {} }
          const s = getComputedStyle(el)
          return { inline: el.getAttribute('style'), root: el.getRootNode().constructor.name, widthToken: s.getPropertyValue('--interaction-ring-width'), offsetToken: s.getPropertyValue('--interaction-ring-offset'), matched }
        })
        const out = process.env.OBPAL_E2E_EVIDENCE_ROOT ? join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'interaction-failures', `${theme}-${selector.replace(/[^a-z0-9]+/gi, '-')}`) : null
        const file = join(out ? rawRun(out) : await mkdtemp(join(tmpdir(), 'obpal-interaction-')), 'focus.png')
        await writeFile(file, snapshot)
        if (out) await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: 1, frames: [{ path: 'focus.png', failed: true }] }))
        assert.fail(`${theme}: focus ring contrast ${minimum.toFixed(2)}:1 beside ${selector}; ${JSON.stringify({ url: page.url(), state, afterCapture, detail, measurements, screenshot: file })}`)
      }
      if (click) {
        // A pointer click on an already keyboard-focused control may retain :focus-visible by design.
        await target.evaluate(el => el.blur())
        await target.click()
        assert.equal(await target.evaluate(el => el.matches(':focus-visible')), false, `${theme}: pointer click retained keyboard focus styling`)
        assert.equal(await target.evaluate(el => getComputedStyle(el).outlineStyle), 'none', `${theme}: pointer click retained an outline`)
        if (escape) await page.keyboard.press('Escape')
      }
      samples.push(`${theme} ${minimum.toFixed(2)}:1`)
    }
    return samples.join(', ')
  } finally {
    if (surface) await setSurface(page, previous)
  }
}

/** Shadow-root chip schemes own their ring backdrop even when the embedding page has unrelated colours. */
export async function chipInteractionStates(page, selector = '.obpal-chip .pill') {
  const target = page.locator(selector).first()
  const previous = await target.evaluate(el => el.closest('.wrap').getAttribute('data-scheme'))
  const samples = []
  try {
    for (const scheme of ['dark', 'light']) {
      await target.evaluate((el, value) => el.closest('.wrap').setAttribute('data-scheme', value), scheme)
      samples.push(`${scheme}: ${await interactionStates(page, selector, { surface: false, themes: [scheme] })}`)
      assert.equal(await target.evaluate(el => el.closest('.wrap').getAttribute('data-scheme')), scheme, 'Chip scheme changed during measurement')
    }
    return samples.join('; ')
  } finally {
    await target.evaluate((el, value) => value === null ? el.closest('.wrap').removeAttribute('data-scheme') : el.closest('.wrap').setAttribute('data-scheme', value), previous)
  }
}

/** Hover is a pointer state: both raised hero actions keep coloured edges without a keyboard ring. */
export async function heroHoverStates(page) {
  await page.waitForFunction(() => !!window.BlackboxesFamily)
  const previous = await page.evaluate(() => window.BlackboxesFamily.getTheme())
  const samples = []
  try {
    for (const theme of ['carbon', 'light']) {
      await setSurface(page, theme)
      for (const selector of ['.hero a.cta-main', '.hero a.cta-alt']) {
        const target = page.locator(selector)
        await page.evaluate(() => document.activeElement?.blur())
        await target.hover()
        await page.waitForTimeout(200)
        const state = await target.evaluate(el => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
          const ctx = canvas.getContext('2d')
          const rgba = color => {
            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
            return [...ctx.getImageData(0, 0, 1, 1).data]
          }
          const style = getComputedStyle(el), borders = [], rims = []
          for (const pseudo of [null, '::before', '::after']) {
            const s = getComputedStyle(el, pseudo)
            if (s.display === 'none' || Number(s.opacity) === 0 || (pseudo && ['none', 'normal'].includes(s.content))) continue
            for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
              if (parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none') borders.push(rgba(s[`border${side}Color`]))
            }
            if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) rims.push(rgba(s.outlineColor))
            for (const shadow of s.boxShadow.split(/,(?![^()]*\))/)) {
              if (!shadow.includes('inset')) continue
              const color = shadow.match(/(?:rgba?|color)\([^)]*\)|#[\da-f]+/i)?.[0]
              if (color) rims.push(rgba(color))
            }
          }
          return {
            hover: el.matches(':hover'), focus: el.matches(':focus'), keyboard: el.matches(':focus-visible'),
            edgeToken: style.getPropertyValue('--interaction-hover-edge').trim(), rimToken: style.getPropertyValue('--interaction-hover-rim').trim(),
            borders, rims,
          }
        })
        const chroma = rgb => Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3))
        const white = rgb => rgb[3] > 0 && Math.min(...rgb.slice(0, 3)) > 200 && chroma(rgb) < 12
        assert(state.hover && !state.focus && !state.keyboard, `${theme} ${selector}: hover acquired focus`)
        assert(state.edgeToken && state.rimToken, `${theme} ${selector}: missing shared hover tokens`)
        assert(state.borders.some(rgb => rgb[3] > 0 && chroma(rgb) >= 12), `${theme} ${selector}: no branded border ${JSON.stringify(state)}`)
        assert(![...state.borders, ...state.rims].some(white), `${theme} ${selector}: white hover edge or rim ${JSON.stringify(state)}`)
        samples.push(`${theme} ${selector}: coloured edge and rim, no focus`)
      }
    }
    return samples.join('; ')
  } finally { await setSurface(page, previous) }
}

export async function siteInteractionStates(browser, origin, runCheck, only = []) {
  const check = (name, run) => !only.length || only.some(prefix => name.startsWith(prefix)) ? runCheck(name, run) : Promise.resolve()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  try {
    const page = await context.newPage()
    await check('hero actions: branded mouse hover without focus in Carbon and Light', async () => {
      await page.goto(origin)
      await page.evaluate(() => document.fonts.ready)
      return heroHoverStates(page)
    })
    await check('primary hero action: branded keyboard ring and six-surface contrast', async () => {
      await page.goto(origin)
      await page.evaluate(() => document.fonts.ready)
      return interactionStates(page, '.hero .cta-main[href="/view/"]', { click: false })
    })
    for (const [name, path, selector] of [['site hero', '/', '.cta-alt[href="#see"]'], ['site nav', '/', '.top-nav a[href="#build"]'], ['viewer', '/view/', '#t-spin'], ['sims', '/sim/arm/', '#sim-sound'], ['quick panel', '/view/', '.quick-tab']]) {
      await check(`${name}: branded keyboard ring, pointer focus and six-surface contrast`, async () => {
        await page.goto(origin + path)
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(1000)
        return interactionStates(page, selector, { escape: name !== 'sims' })
      })
    }
    await check('share panel: branded keyboard ring, pointer focus and six-surface contrast', async () => {
      await page.goto(`${origin}/sim/drone/?test=vr`)
      await page.waitForFunction(() => !!window.__presence?.shared)
      await page.evaluate(() => window.__presence.shared.openShare())
      return interactionStates(page, '.share-tabs [aria-selected="true"]', {
        escape: false,
        prepare: p => p.evaluate(() => { if (!document.querySelector('.share-panel')?.open) window.__presence.shared.openShare() }),
      })
    })
    await check('phone controller: branded keyboard ring, pointer focus and six-surface contrast (emulated)', async () => {
      await page.goto(`${origin}/view/`)
      await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
      const invite = await page.evaluate(() => window.__obpal.pairingUrl)
      const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
      try {
        const phone = await phoneContext.newPage()
        await phone.goto(invite)
        await phone.locator('.ctl-tab').first().waitFor()
        return await interactionStates(phone, '.ctl-tab:first-child', { escape: false })
      } finally { await phoneContext.close() }
    })
  } finally { await context.close() }
}

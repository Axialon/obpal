/** Inline ob.Pal marks must resolve their colours from the page, including a live token change. */
import { setSurface } from './lib/frost.mjs'

export async function runBrand(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  try {
    const page = await context.newPage()
    for (const route of ['/', '/privacy/', '/view/', '/p/', '/sim/arm/']) {
      await page.goto(origin + route)
      await page.waitForFunction(() => window.BlackboxesFamily && document.querySelector('svg.mark, svg.brand-lockup'))
      const switcher = page.locator('[aria-controls="switcher"]')
      if (await switcher.count()) {
        await switcher.click()
        await page.locator('#switcher').waitFor({ state: 'visible' })
        await page.locator('#switcher [aria-current="page"] svg.bb-mark').waitFor({ state: 'visible' })
      }
      const themes = await page.evaluate(() => window.BlackboxesFamily.THEMES.map(theme => theme.id))
      const accents = await page.evaluate(() => window.BlackboxesFamily.ACCENTS.map(accent => accent.id))
      for (const theme of themes) {
        await setSurface(page, theme)
        for (const accent of accents) {
          await page.evaluate(accent => window.BlackboxesFamily.setAccent(accent), accent)
          await assertBrand(page, `${route} ${theme}/${accent}`)
        }
      }
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--bb-accent', '#e123ab')
        document.documentElement.style.setProperty('--bb-accent-text', '#ac1256')
        document.documentElement.style.setProperty('--bb-ink', '#123456')
      })
      await assertBrand(page, `${route} custom tokens`)
      await page.evaluate(() => ['--bb-accent', '--bb-accent-text', '--bb-ink'].forEach(token => document.documentElement.style.removeProperty(token)))
    }
    return '5 routes; family menu, all surface/accent combinations and custom live tokens'
  } finally { await context.close() }
}

/**
 * Judge the marks once their paint has settled. Under reduced motion every element carries a 0.01 ms transition
 * (src/styles/base.css), so a changed token reaches its computed paint a frame or two later: three on the viewer,
 * whose scene keeps frames busy. A mark that never follows the token still fails, after the limit.
 */
async function assertBrand(page, state) {
  const end = Date.now() + 2000
  let failures
  do {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    failures = await page.evaluate(markFailures)
  } while (failures.length && Date.now() < end)
  if (failures.length) throw new Error(`${state}: ${failures.join('; ')}`)
}

/** Runs in the page: every way the inline marks disagree with the page's tokens right now. */
function markFailures() {
  const failures = []
  const marks = [...document.querySelectorAll('svg.mark, svg.brand-lockup, #switcher [aria-current="page"] svg.bb-mark')]
  if (!marks.length) failures.push('no inline marks')
  const ids = marks.flatMap(mark => [...mark.querySelectorAll('[id]')].map(node => node.id))
  if (new Set(ids).size !== ids.length) failures.push('duplicate mark gradient ids')
  const normalize = (node, value) => {
    const probe = document.createElement('span')
    probe.style.color = value
    node.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }
  for (const mark of marks) {
    const identity = `${mark.getAttribute('class')} #${mark.closest('[id]')?.id || 'page'} instance ${marks.indexOf(mark) + 1}`
    const errors = []
    const accent = normalize(mark, 'var(--bb-accent)')
    const ink = normalize(mark, 'var(--bb-ink)')
    const accentText = normalize(mark, 'var(--bb-accent-text)')
    for (const [selector, property] of [['ellipse', 'stroke'], ['circle[r="4.8"]', 'fill'], ['linearGradient[id$="s"] stop', 'stopColor']]) {
      const nodes = [...mark.querySelectorAll(selector)]
      if (!nodes.length) errors.push(`${selector} missing`)
      for (const node of nodes) if (getComputedStyle(node)[property] !== accent) errors.push(`${selector} ${property} is ${getComputedStyle(node)[property]}, expected ${accent}`)
    }
    for (const node of mark.querySelectorAll('[fill], [stroke], [stop-color]')) {
      for (const attribute of ['fill', 'stroke', 'stop-color']) if (/^#c6ff34$/i.test(node.getAttribute(attribute) || '')) errors.push(`fixed lime ${attribute}`)
    }
    for (const node of mark.querySelectorAll('.wordmark path:not(.brand-point path)')) {
      if (getComputedStyle(node).fill !== ink) errors.push(`wordmark fill is ${getComputedStyle(node).fill}, expected ${ink}`)
    }
    for (const node of mark.querySelectorAll('.brand-point path')) {
      if (getComputedStyle(node).fill !== accentText) errors.push(`wordmark dot fill is ${getComputedStyle(node).fill}, expected ${accentText}`)
    }
    failures.push(...errors.map(error => `${identity}: ${error}`))
  }
  return failures
}

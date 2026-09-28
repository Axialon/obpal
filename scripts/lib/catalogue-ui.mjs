/**
 * The sim catalogue's glass UI end to end (scripts/e2e-catalogue.mjs runs it, --only=ui): the sidebar folds to its
 * rail and remembers it, a tablet's rail opens as a drawer, the glass select works by keyboard and type-ahead and is
 * never the system's list, a phone's filters open as a bottom sheet that a finger drags away, and nothing scrolls
 * sideways at any of the five sizes, closed or open. Helpers for the other catalogue checks choose a controller the
 * way a person does.
 */

/** The five sizes the catalogue is designed for: two computers, a tablet, and a phone upright and sideways. */
export const SIZES = [[1920, 1080], [1440, 900], [1024, 768], [390, 844], [844, 390]]
const phone = (w, h) => w <= 700 || h <= 500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Choose a controller in the glass select (`''` for all of them), as a person does: open it, click the option. */
export async function chooseFace(page, face) {
  const button = page.locator('#controller-filter')
  if ((await button.getAttribute('data-value')) === face) return
  await button.scrollIntoViewIfNeeded()
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  await page.locator(`.kit-listbox [role="option"][data-value="${face}"]`).click()
  await page.waitForFunction((f) => document.getElementById('controller-filter')?.dataset.value === f, face, { timeout: 5000 })
}

/** The chosen controller. */
export const faceOf = (page) => page.locator('#controller-filter').getAttribute('data-value')

/** The glass select's options as it lists them: value, count, name and whether they can be chosen. */
export async function faceOptions(page) {
  const button = page.locator('#controller-filter')
  await button.scrollIntoViewIfNeeded()
  await button.click()
  const options = await page.locator('.kit-listbox [role="option"]').evaluateAll((els) => els.map((el) => ({
    face: el.dataset.value, n: Number(el.querySelector('.kit-option-badge')?.textContent), label: el.querySelector('.kit-option-label').textContent, disabled: el.getAttribute('aria-disabled') === 'true',
  })))
  await page.keyboard.press('Escape')
  return options
}

/** What scrolls or spills sideways: the page wider than its window, a box showing a sideways scrollbar, a control past the right edge. */
export function sideways(page) {
  return page.evaluate(() => {
    const out = []
    const root = document.documentElement
    if (root.scrollWidth > innerWidth) out.push(`the page is ${root.scrollWidth}px wide in ${innerWidth}px`)
    const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join('')}`
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el)
      if (!el.getClientRects().length || s.visibility === 'hidden') continue
      if (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1) out.push(`${name(el)} scrolls sideways (${el.scrollWidth} in ${el.clientWidth})`)
      if (el.matches('button, a[href], input, [role="option"], [role="radio"]') && !el.closest('[inert]')) {
        const r = el.getBoundingClientRect()
        if (r.width && r.right > innerWidth + 1 && r.left < innerWidth) out.push(`${name(el)} runs past the right edge (${Math.round(r.right)} in ${innerWidth})`)
      }
    }
    return out.slice(0, 6)
  })
}

async function fresh(browser, origin, [width, height], query = '') {
  const small = phone(width, height)
  const context = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, isMobile: small, hasTouch: small, deviceScaleFactor: small ? 2 : 1, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${origin}/sim/${query}`)
  await page.waitForFunction(() => window.__sims?.cards().length > 0)
  await page.evaluate(() => document.fonts.ready)
  return { page, context, errors }
}

const side = (page) => page.evaluate(() => window.__sims.side())
const box = (page, selector) => page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } })

export async function runCatalogueUi({ browser, origin, check, until }) {
  await check('catalogue ui: nothing scrolls sideways at any of the five sizes, with the sidebar, drawer, sheet or list open or shut', async () => {
    const seen = []
    for (const size of SIZES) {
      const { page, context, errors } = await fresh(browser, origin, size)
      try {
        const at = `${size[0]}x${size[1]}`
        const shut = await sideways(page)
        if (shut.length) throw new Error(`${at}: ${shut.join('; ')}`)
        const { mode } = await side(page)
        // Open what this size has: the rail (docked), the drawer (tablet) or the sheet (phone).
        await page.locator(mode === 'sheet' ? '#filters-open' : '#side-toggle').click()
        await sleep(350)
        const open = await sideways(page)
        if (open.length) throw new Error(`${at} ${mode} open: ${open.join('; ')}`)
        if (mode !== 'sheet') {
          await page.locator('#controller-filter').click()
          const listed = await sideways(page)
          if (listed.length) throw new Error(`${at} with the list open: ${listed.join('; ')}`)
          await page.keyboard.press('Escape')
        }
        if (errors.length) throw new Error(`${at}: ${errors.join(' | ')}`)
        seen.push(`${at} ${mode}`)
      } finally { await context.close() }
    }
    return seen.join(', ')
  })

  await check('catalogue ui: the sidebar folds to an icon rail, keeps it across a reload, filters from the rail, and unfolds', async () => {
    const { page, context } = await fresh(browser, origin, [1440, 900])
    try {
      await page.evaluate(() => localStorage.removeItem('obpal.sims.sidebar'))
      await page.reload()
      await page.waitForFunction(() => window.__sims?.cards().length > 0)
      const toggle = page.locator('#side-toggle')
      if ((await side(page)).mode !== 'docked' || await toggle.getAttribute('aria-expanded') !== 'true') throw new Error(`not docked open: ${JSON.stringify(await side(page))}`)
      const wide = (await box(page, '#sims-side')).width
      const before = (await box(page, '.sims-main')).width
      await toggle.click()
      await until('folded', async () => (await box(page, '#sims-side')).width < 90)
      if (await toggle.getAttribute('aria-expanded') !== 'false' || await toggle.getAttribute('aria-label') !== 'Expand the sidebar') throw new Error('the toggle does not say it is folded')
      if (await page.evaluate(() => localStorage.getItem('obpal.sims.sidebar')) !== 'collapsed') throw new Error('the fold was not remembered')
      const railTip = await page.locator('[data-category="flying"]').getAttribute('data-tip')
      if (railTip !== 'Flying') throw new Error(`the rail's icon has no tooltip: ${railTip}`)
      // The icons keep their names for assistive tech.
      await page.getByRole('button', { name: /^Flying/ }).click()
      await until('the rail filters', () => page.evaluate(() => new URL(location.href).searchParams.get('category') === 'flying'))
      const cards = (await box(page, '.sims-main')).width
      if (cards < before + wide - 90) throw new Error(`the cards did not take the room: ${before} → ${cards}`)
      await page.reload()
      await page.waitForFunction(() => window.__sims?.cards().length > 0)
      if ((await box(page, '#sims-side')).width > 90 || (await side(page)).mode !== 'docked') throw new Error('the rail was not remembered across a reload')
      // The rail's controller opens its list beside the rail.
      await page.locator('#controller-filter').click()
      const rail = await box(page, '#sims-side'), list = await box(page, '.kit-listbox')
      if (list.left < rail.right) throw new Error(`the list covers the rail: ${JSON.stringify({ rail, list })}`)
      await page.keyboard.press('Escape')
      // "/" opens the sidebar at its search.
      await page.locator('.sims-hero h1').click()
      await page.keyboard.press('/')
      await until('search focused', () => page.evaluate(() => document.activeElement?.id === 'search'))
      if ((await box(page, '#sims-side')).width < wide - 2) await until('unfolded', async () => (await box(page, '#sims-side')).width >= wide - 2)
      if (await page.evaluate(() => localStorage.getItem('obpal.sims.sidebar')) !== 'expanded') throw new Error('unfolding was not remembered')
      await toggle.focus()
      await page.keyboard.press('Enter')
      await until('folded by the keyboard', async () => (await toggle.getAttribute('aria-expanded')) === 'false')
      await page.keyboard.press('Space')
      await until('unfolded by the keyboard', async () => (await toggle.getAttribute('aria-expanded')) === 'true')
      return `${Math.round(wide)}px ↔ rail; remembered; list beside the rail`
    } finally { await context.close() }
  })

  await check('catalogue ui: on a tablet the rail opens as a drawer over the cards; Escape, the scrim and Tab behave', async () => {
    const { page, context } = await fresh(browser, origin, [1024, 768])
    try {
      const { mode, expanded } = await side(page)
      if (mode !== 'drawer' || expanded) throw new Error(`not a shut drawer: ${mode} ${expanded}`)
      const rail = await box(page, '#sims-side')
      if (rail.width > 90) throw new Error(`the rail is ${rail.width}px`)
      const card = await box(page, '.dcard')
      const toggle = page.locator('#side-toggle')
      await toggle.click()
      await until('open', async () => (await side(page)).expanded)
      const drawer = await box(page, '#sims-side')
      const state = await page.evaluate(() => {
        const el = document.getElementById('sims-side')
        return { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), inert: !!document.querySelector('.sims-main').closest('[inert]'), focus: el.contains(document.activeElement) }
      })
      if (drawer.width < 250 || state.role !== 'dialog' || state.modal !== 'true' || !state.inert || !state.focus) throw new Error(`drawer: ${JSON.stringify({ drawer, state })}`)
      if (Math.abs((await box(page, '.dcard')).left - card.left) > 1) throw new Error('the cards moved under the drawer')
      for (let i = 0; i < 16; i++) await page.keyboard.press('Tab')
      if (!(await page.evaluate(() => document.getElementById('sims-side').contains(document.activeElement)))) throw new Error('Tab left the drawer')
      await page.locator('#sims-side [data-category="games"]').click()
      await until('filtered from the drawer', () => page.evaluate(() => new URL(location.href).searchParams.get('category') === 'games'))
      await page.keyboard.press('Escape')
      await until('shut by Escape', async () => !(await side(page)).expanded)
      if (!(await page.evaluate(() => document.activeElement?.id === 'side-toggle'))) throw new Error('focus did not return to the toggle')
      if (await page.evaluate(() => !!document.querySelector('[inert]'))) throw new Error('the page stayed inert')
      await toggle.click()
      await until('open again', async () => (await side(page)).expanded)
      await page.mouse.click(900, 600)
      await until('shut by the scrim', async () => !(await side(page)).expanded)
      return `rail ${Math.round(rail.width)}px, drawer ${Math.round(drawer.width)}px over still cards`
    } finally { await context.close() }
  })

  await check('catalogue ui: the glass select works by keyboard and type-ahead, passes over empty controllers, and is never the system list', async () => {
    const { page, context } = await fresh(browser, origin, [1440, 900], '?category=robotics')
    try {
      if (await page.locator('select').count()) throw new Error('a native select is on the page')
      const button = page.getByRole('combobox', { name: 'Controller', exact: true })
      const active = () => page.evaluate(() => { const id = document.getElementById('controller-filter').getAttribute('aria-activedescendant'); return id && document.getElementById(id)?.dataset.value })
      await button.focus()
      await page.keyboard.press('ArrowDown')
      if (await button.getAttribute('aria-expanded') !== 'true') throw new Error('ArrowDown did not open it')
      const look = await page.locator('.kit-listbox').evaluate((el) => { const s = getComputedStyle(el); return { blur: s.backdropFilter, radius: parseFloat(s.borderTopLeftRadius), role: el.getAttribute('role') } })
      if (!look.blur || look.blur === 'none' || look.radius < 12 || look.role !== 'listbox') throw new Error(`not frosted glass: ${JSON.stringify(look)}`)
      if (await active() !== '') throw new Error(`opened on ${await active()}`)
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      // Robotics has no wheel sims: Down passes from Gamepad over Wheel to Wii.
      if (await active() !== 'face.wii') throw new Error(`Down went to ${await active()}`)
      await page.keyboard.type('tr')
      if (await active() !== 'face.trackpad') throw new Error(`"tr" went to ${await active()}`)
      await page.keyboard.press('Enter')
      await until('Trackpad chosen', async () => (await faceOf(page)) === 'face.trackpad')
      if (await button.getAttribute('aria-expanded') !== 'false' || !page.url().includes('face=trackpad')) throw new Error(`Enter: ${page.url()}`)
      if (!(await page.evaluate(() => document.activeElement?.id === 'controller-filter'))) throw new Error('focus left the button')
      await page.keyboard.press('End')
      const last = await active()
      await page.keyboard.press('Home')
      if (await active() !== '') throw new Error(`Home went to ${await active()}`)
      await page.keyboard.press('Escape')
      if (await faceOf(page) !== 'face.trackpad' || await button.getAttribute('aria-expanded') !== 'false') throw new Error('Escape changed the choice')
      // Typing opens it too; one letter again and again steps through the names that start with it.
      await page.keyboard.press('g')
      if (await active() !== 'face.gamepad') throw new Error(`"g" went to ${await active()}`)
      await sleep(600)
      await page.keyboard.press('w')
      if (await active() !== 'face.wii') throw new Error(`"w" went to ${await active()}`)
      await page.keyboard.press('Tab')
      await until('Tab chose Wii', async () => (await faceOf(page)) === 'face.wii')
      if (await page.evaluate(() => document.activeElement?.id === 'controller-filter')) throw new Error('Tab kept the focus')
      // A mouse: the button opens it, a click elsewhere shuts it.
      await button.click()
      await page.mouse.click(900, 200)
      if (await button.getAttribute('aria-expanded') !== 'false') throw new Error('a click outside left it open')
      return `End: ${last}; frosted, ${look.radius}px corners`
    } finally { await context.close() }
  })

  for (const size of [[390, 844], [844, 390]]) {
    await check(`catalogue ui: at ${size[0]}x${size[1]} the filters open as a bottom sheet; its choices, Escape, the scrim and a drag shut it`, async () => {
      const { page, context } = await fresh(browser, origin, size)
      try {
        const cdp = await context.newCDPSession(page)
        if ((await side(page)).mode !== 'sheet') throw new Error(`mode ${(await side(page)).mode}`)
        if (await page.locator('#sims-side').isVisible()) throw new Error('the sheet shows before it is opened')
        const inner = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
        // Open, and risen into view (it slides up, even if only for a frame under reduced motion).
        const open = async () => {
          await page.locator('#filters-open').click()
          await until('sheet open', async () => (await side(page)).expanded && (await box(page, '#sims-side')).bottom <= inner.h + 1)
        }
        await open()
        const sheet = await box(page, '#sims-side')
        if (sheet.bottom > inner.h + 1 || sheet.top < 0 || sheet.height > inner.h * 0.9 + 1) throw new Error(`sheet ${JSON.stringify(sheet)} in ${JSON.stringify(inner)}`)
        if (await page.locator('#sims-side').getAttribute('aria-modal') !== 'true') throw new Error('not a modal dialog')
        await page.locator('#sims-side [data-category="vehicles"]').click()
        await page.getByRole('radiogroup', { name: 'Controller', exact: true }).locator('[data-value="face.wheel"]').click()
        const shown = await page.evaluate(() => window.__sims.cards().length)
        const cta = await page.locator('#sheet-done').textContent()
        if (!cta.includes(`Show ${shown} sim`)) throw new Error(`the sheet says "${cta}" for ${shown}`)
        await page.locator('#sheet-done').click()
        await until('shut by its button', async () => !(await side(page)).expanded)
        if (await page.locator('#filters-n').textContent() !== '2') throw new Error('the Filters button does not count two filters')
        if (!(await page.evaluate(() => document.activeElement?.id === 'filters-open'))) throw new Error('focus did not return to Filters')
        await open()
        await page.keyboard.press('Escape')
        await until('shut by Escape', async () => !(await side(page)).expanded)
        await open()
        await page.mouse.click(inner.w / 2, 12)
        await until('shut by the scrim', async () => !(await side(page)).expanded)
        // A finger drags it down by its head.
        await open()
        const head = await box(page, '.sims-sheet-head')
        const x = head.left + head.width / 2, y = head.top + 12
        const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([px, py]) => ({ x: px, y: py, id: 1 })) })
        await touch('touchStart', [[x, y]])
        for (let i = 1; i <= 10; i++) { await touch('touchMove', [[x, y + i * sheet.height * 0.06]]); await sleep(16) }
        await touch('touchEnd', [])
        await until('dragged away', async () => !(await side(page)).expanded)
        await open()
        await page.getByRole('button', { name: 'Clear', exact: true }).click()
        if (new URL(page.url()).search || await page.getByRole('radiogroup', { name: 'Controller', exact: true }).locator('[aria-checked="true"]').getAttribute('data-value') !== '') throw new Error('Clear left filters')
        return `${Math.round(sheet.height)}px sheet, ${shown} sims for vehicles on the wheel`
      } finally { await context.close() }
    })
  }
}

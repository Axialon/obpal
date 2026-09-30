/** Community pack adoption, credits and proposal UI, exercised by the pages and phone suites. */
import { devices } from 'playwright'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 25000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100) }
  throw new Error('Timed out waiting for pack UI')
}
async function shot(page, name, shots) {
  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name) }) }
}

export async function runPackCatalogue({ browser, origin, check, shots = process.env.OBPAL_PACK_SHOTS }) {
  await check('packs: community search, previews, external scenes and credits', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })
    try {
      const page = await context.newPage(), errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${origin}/catalogue/`)
      await page.locator('[data-pack="obpal/crane"]').waitFor()
      if (await page.locator('#community-packs article').count() !== 4) throw new Error('Missing community pack')
      await page.locator('[data-pack="obpal/crane"] .pack-options > summary').click()
      await page.locator('[data-pack="obpal/crane"] .pack-handoff summary').click()
      if (!await page.locator('[data-pack="obpal/crane"] .pack-handoff svg').isVisible()) throw new Error('No phone handoff code')
      await shot(page, 'after-phone-handoff.png', shots)
      await page.locator('[data-pack="obpal/crane"] .pack-handoff summary').click()
      await page.locator('[data-pack="obpal/crane"] .pack-options > summary').click()
      for (const card of await page.locator('#community-packs article').all()) {
        if (await card.locator('.st').textContent() !== 'Example' || await card.locator('.pack-credit').count() !== 1 || await card.locator('.pack-primary').count() !== 1 || await card.locator('.pack-kind svg').count() !== 1) throw new Error('Pack card lost its example label or restrained hierarchy')
        if (((await card.innerText()).match(/by ob.Pal/g) ?? []).length !== 1) throw new Error('Repeated card attribution')
      }
      await page.locator('#community').scrollIntoViewIfNeeded()
      await shot(page, 'after-community.png', shots)
      await page.locator('#pack-search').fill('Hello')
      if (await page.locator('#community-packs article').count() !== 1) throw new Error('Search did not filter')
      await page.locator('#community-packs .pack-options > summary').click()
      await page.locator('#community-packs .pack-data > summary').click()
      if (!(await page.locator('#community-packs pre').textContent()).includes('head.yaw')) throw new Error('No mode data preview')
      await page.locator('#pack-search').fill('')
      const scene = page.locator('[data-pack="obpal/embed-demo"] .pack-primary')
      if (await scene.getAttribute('target') !== '_blank' || !((await scene.getAttribute('rel')) ?? '').includes('noreferrer')) throw new Error('Scene did not open externally')
      if (await page.locator('#community-packs .seal, #community-packs .origin-mark').count()) throw new Error('Community inherited a trust mark')
      const credits = page.locator('#pack-credits')
      if (await credits.locator('li').count() !== 4 || !(await credits.textContent()).includes('Hello by ob.Pal · MIT')) throw new Error('Missing attribution')
      await page.locator('#credits').scrollIntoViewIfNeeded()
      await shot(page, 'after-credits.png', shots)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('#community').scrollIntoViewIfNeeded()
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Community overflows phone')
      if (errors.length) throw new Error(errors.join('; '))
      await page.route('**/catalogue.json', async (route) => {
        const response = await route.fetch(), catalogue = await response.json()
        const thirdParty = structuredClone(catalogue.community.find((p) => p.kind === 'profile'))
        thirdParty.id = 'maker/crane'; thirdParty.author = { name: 'Community maker' }; thirdParty.attribution = 'Crane by Community maker · MIT'
        catalogue.community.push(thirdParty)
        await route.fulfill({ response, json: catalogue })
      })
      await page.reload()
      await page.locator('[data-pack="maker/crane"]').waitFor()
      if (await page.locator('[data-pack="maker/crane"] .st').textContent() !== 'Community') throw new Error('Third-party pack was marked as an example')
      return 'four examples; one credit and action; third-party badge; search and preview; external scene; four credits'
    } finally { await context.close() }
  })
  await check('packs: Propose pack includes a checked attributed envelope in the issue', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ignoreHTTPSErrors: true })
    try {
      const page = await context.newPage()
      await page.goto(`${origin}/catalogue/#build`)
      await page.locator('#pid').fill('example/steady-crane')
      await page.locator('#pname').fill('Steady crane')
      await page.locator('#pfor').fill('Slow tilt for a simulation')
      await page.locator('#pauthor').fill('Example author')
      await page.locator('#pcredit').fill('Steady crane by Example author · MIT')
      await until(async () => (await page.locator('#propose').getAttribute('aria-disabled')) === 'false')
      const url = new URL(await page.locator('#propose').getAttribute('href'))
      const draft = JSON.parse(await page.locator('#json').textContent())
      if (draft.id !== 'example/steady-crane' || draft.body.id !== 'steady-crane' || draft.author.name !== 'Example author' || draft.license !== 'MIT' || !url.searchParams.get('body').includes(draft.attribution)) throw new Error('Issue lost the envelope or attribution')
      if (await page.locator('#propose').textContent() !== 'Propose pack') throw new Error('Old proposal label')
      await page.locator('#build').scrollIntoViewIfNeeded()
      await shot(page, 'after-propose-pack.png', shots)
      await page.locator('#pname').fill('Official ob.Pal')
      if (await page.locator('#propose').getAttribute('aria-disabled') !== 'true') throw new Error('Impersonating draft accepted')
      return 'complete envelope; credit; issue body; project-status claim rejected'
    } finally { await context.close() }
  })
}

export async function runPhonePacks({ browser, origin, check, shots = process.env.OBPAL_PACK_SHOTS }) {
  await check('packs: phone profile and mapping attribution, mode compatibility and offline reuse', async () => {
    const hostContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const context = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    try {
      const screen = await hostContext.newPage(), page = await context.newPage(), errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await screen.goto(`${origin}/view/`)
      const invite = await until(() => screen.evaluate(() => window.__obpal?.pairingUrl || ''))
      await screen.evaluate(() => {
        window.__packValues = []
        window.__obpal.on('value', (e) => window.__packValues.push({ id: e.id, v: e.v }))
        window.__obpal.setLayout({ v: 1, controllers: ['face.gamepad'], tray: [], rig: 'humanoid-v1', modePacks: ['obpal/hello@1.0.0'] })
      })
      const arrival = new URL(invite); arrival.searchParams.set('pack', 'obpal/crane')
      await page.goto(arrival.href)
      await page.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
      const chip = page.locator('.gp:not([hidden]) [data-act="profile"]')
      await until(async () => (await chip.textContent()).includes('by ob.Pal · MIT'))
      await shot(page, 'after-phone-chip.png', shots)
      await chip.click()
      const choice = page.locator('[data-profile="obpal/crane"]')
      if (!(await choice.textContent()).includes('Crane by ob.Pal · MIT')) throw new Error('Picker lost attribution')
      await shot(page, 'after-phone-picker.png', shots)
      const hello = page.locator('.gp-sheet [data-pack="obpal/hello"]')
      if (await hello.isDisabled()) throw new Error('Compatible exact mode was disabled')
      await hello.click()
      await until(() => screen.evaluate(() => window.__packValues.some((e) => e.id === 'pack-mode' && e.v === 'obpal/hello@1.0.0')))
      await page.locator('.gp-sheet [data-pack="obpal/tesana-flight"]').click()
      if (!(await chip.textContent()).includes('Tesana flight buttons · by ob.Pal · MIT')) throw new Error('Mapping credit missing')
      await page.locator('[data-clear-mapping]').click()
      await choice.click()
      await page.locator('.gp-sheet').waitFor({ state: 'hidden' })
      await screen.evaluate(() => window.__obpal.setLayout({ v: 1, controllers: ['face.gamepad'], tray: [], rig: 'humanoid-v1', modePacks: ['obpal/hello@2.0.0'] }))
      await sleep(300)
      await chip.click()
      if (!await hello.isDisabled()) throw new Error('Unsupported mode version was enabled')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => navigator.serviceWorker?.controller !== null)
      await page.route('**/catalogue.json', (route) => route.abort())
      await page.reload()
      await until(async () => (await chip.textContent()).includes('by ob.Pal · MIT'))
      await chip.click()
      if (!(await choice.textContent()).includes('Crane by ob.Pal · MIT')) throw new Error('Cached picker credit missing')
      await page.keyboard.press('Escape')
      await context.setOffline(true)
      await page.reload()
      await until(async () => (await page.locator('body').textContent()).includes('Crane') || await page.evaluate(() => !!localStorage.getItem('obpal.packs.v1')))
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('obpal.packs.v1')).community)
      if (!saved.some((p) => p.id === 'obpal/crane' && p.attribution === 'Crane by ob.Pal · MIT')) throw new Error('Offline credit not cached')
      if (errors.length) throw new Error(errors.join('; '))
      return 'chip and picker credit; mapping credit; exact mode request; mismatch disabled; offline cache'
    } finally { await context.close(); await hostContext.close() }
  })
}

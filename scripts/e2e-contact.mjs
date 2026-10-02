/** Geometry contacts while real test phones drive each catalogue entry. All output is temporary. */
import { tempScope } from './lib/temp.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { deviceExercises } from './lib/catalogue-devices.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'

const temps = tempScope()
try {

const baseline = process.argv.includes('--baseline')
const only = (process.argv.find(a => a.startsWith('--only='))?.slice(7) ?? process.env.OBPAL_E2E_CONTACT_ONLY ?? process.env.OBPAL_CONTACT_ONLY)?.split(',')
const out = await temps.make(join(tmpdir(), 'obpal-contact-'))
const arms = ['arm5', 'six', 'scara', 'delta', 'desk', 'so101']
const registry = await readFile('src/sim/devices/registry.ts', 'utf8')
const ids = [...registry.matchAll(/entry\(\{ spec: (\w+)_SPEC/g)].map(m => m[1].toLowerCase())
const models = new Set((await readdir('public/models')).filter(n => n.endsWith('.glb')).map(n => n.slice(0, -4)))
const modelFor = id => ['slider', 'jib'].includes(id) ? 'film-camera' : models.has(id) ? id : null
for (const name of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  assert(process.env[name], `${name} is required`)
  await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(+process.env[name], '127.0.0.1', () => s.close(resolve)) })
}
const local = await startLocal({ dist: process.env.OBPAL_E2E_SITE_DIST }), report = [], failures = []
const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true,
  args: ['--ignore-certificate-errors', '--disable-features=WebRtcHideLocalIpsWithMdns'] }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function summary(frames) {
  const parts = new Map()
  for (const frame of frames) for (const r of frame) {
    const row = parts.get(r.part) ?? { part: r.part, mode: r.mode, minMm: Infinity, maxMm: -Infinity, frames: 0, missing: 0, shadow: r.castsShadow && r.receivesShadow }
    row.frames++
    row.shadow &&= r.castsShadow && r.receivesShadow
    row.expectedGapMm = (r.expectedGap ?? 0) * 1000
    if (r.gap !== null) { row.rawMinMm = Math.min(row.rawMinMm ?? Infinity, r.gap * 1000); row.rawMaxMm = Math.max(row.rawMaxMm ?? -Infinity, r.gap * 1000) }
    if (r.lowestGapMm !== null && r.lowestGapMm !== undefined) { row.lowestMinMm = Math.min(row.lowestMinMm ?? Infinity, r.lowestGapMm); row.lowestMaxMm = Math.max(row.lowestMaxMm ?? -Infinity, r.lowestGapMm) }
    if (r.gapMm === null) row.missing++
    else { row.minMm = Math.min(row.minMm, r.gapMm); row.maxMm = Math.max(row.maxMm, r.gapMm) }
    if (r.mode === 'touch' && r.gapMm !== null) row.touchMaxMm = Math.max(row.touchMaxMm ?? 0, Math.abs(r.gapMm))
    if (r.mode === 'clear' && r.gapMm !== null) row.clearMinMm = Math.min(row.clearMinMm ?? Infinity, r.gapMm)
    if (r.mode !== 'free' && r.gapMm !== null) row.penetrationMm = Math.max(row.penetrationMm ?? 0, -r.gapMm)
    row.penetrationMm = Math.max(row.penetrationMm ?? 0, r.penetrationMm ?? 0)
    parts.set(r.part, row)
  }
  return [...parts.values()]
}

async function phoneAt(invite, errors) {
  const context = await browser.newContext({ ...devices['Pixel 7 landscape'], ignoreHTTPSErrors: true, deviceScaleFactor: 1 })
  const page = await context.newPage(), cdp = await context.newCDPSession(page)
  page.on('pageerror', e => errors.push(`phone: ${e.message}`))
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  await page.goto(invite)
  await page.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 30000 })
  // Hints float and can fade before a stable click. Dismiss through their real DOM action.
  await page.addLocatorHandler(page.locator('.hint.in'), hint => hint.getByRole('button', { name: 'Dismiss hint' }).evaluate(button => button.click()))
  await page.evaluate(() => document.querySelectorAll('.hint').forEach(h => h.remove()))
  const touch = (type, points = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) })
  const move = async id => {
    const e = deviceExercises.find(e => e.id === id)
    let selector = e?.drag?.[0] ?? e?.hold
    if (id === 'rover' || id === 'plane') selector = '.gp-trig[data-trig="1"]'
    if (id === 'drone') { await page.keyboard.press('KeyT'); selector = '.gp-stick[data-stick="1"]' }
    if (id === 'studio') selector = '[data-drum="0"]'
    if (e?.key && ['pinball', 'football', 'trebuchet', 'pendulum', 'marblerun', 'helicopter', 'tank', 'sorting', 'excavator'].includes(id)) await page.keyboard.press(e.key)
    if (id === 'claw') await page.keyboard.press('Space')
    if (!selector || !await page.locator(selector).first().isVisible()) {
      selector = await page.locator('.gp-stick[data-stick="0"]').isVisible() ? '.gp-stick[data-stick="0"]' : '#pad'
    }
    if (await page.locator(selector).first().isVisible()) {
      const target = page.locator(selector).first()
      await target.click({ trial: true })
      const b = await target.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2
      await touch('touchStart', [[x, y]])
      const dx = e?.drag?.[1] ?? 20, dy = e?.drag?.[2] ?? -40
      for (let j = 1; j <= 16; j++) {
        const drag = selector.includes('stick') || selector === '#pad'
        await touch('touchMove', [[x + (drag ? dx * j / 16 : 0), y + (drag ? dy * j / 16 : 0)]])
        await sleep(35)
      }
      for (let j = 0; j < 16; j++) { await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10 + j, beta: 70, gamma: j * .5 }); await sleep(30) }
      await touch('touchEnd')
    } else {
      for (let j = 0; j < 25; j++) { await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10 + j, beta: 70, gamma: 0 }); await sleep(40) }
    }
  }
  const hold = async (selector, action) => {
    const target = page.locator(selector).first(); await target.click({ trial: true })
    const b = await target.boundingBox()
    await touch('touchStart', [[b.x + b.width / 2, b.y + b.height / 2]])
    try { await action() } finally { await touch('touchEnd') }
  }
  return { page, context, move, hold }
}

async function sideView(page, target) {
  await page.evaluate(target => {
    const d = window.__device, api = window.__contacts
    const readings = api.sample(), props = ['maze', 'marblerun', 'airhockey', 'pinball', 'claw', 'sorting', 'trebuchet']
    const wanted = props.includes(d?.spec.id) ? /puck|ball|marble|prize|item|load/ : /foot|wheel|base|stock|instrument/
    const reading = readings.find(r => wanted.test(r.part)) ?? readings[0]
    if (!reading && !target) return
    const [x, y, z] = target ?? reading.point, camera = api.camera
    if (d) { d.stage.controls.target.set(x, y + .2, z); camera.position.set(x + 2, y + .24, z + .7); d.stage.view.invalidate() }
    else window.__arm?.view([x + 1.3, y + .16, z + .3], [x, y + .1, z])
  }, target)
  await page.waitForTimeout(200)
}

try {
  for (const id of [...ids, ...arms, 'arena', 'viewer']) {
    if (only && !only.includes(id)) continue
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true,
      recordVideo: { dir: out, size: { width: 960, height: 600 } } })
    const page = await context.newPage(), errors = [], rows = []
    const began = Date.now()
    page.on('pageerror', e => errors.push(e.message))
    let phone, release
    const extraPhones = []
    try {
      const arm = arms.includes(id), model = modelFor(id)
      const gate = new Promise(resolve => { release = resolve })
      if (model) await page.route(`**/models/${model}.glb`, async route => { await gate; await route.continue() })
      const path = arm ? `/sim/arm/?kind=${id}` : id === 'arena' ? '/sim/arena/?' : id === 'viewer' ? '/view/?' : `/sim/device/?d=${id}`
      await page.goto(`${local.origin}${path}&test=contact&quality=native`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__obpal?.pairingUrl && (window.__contacts || window.__viewer), null, { timeout: 30000 })
      phone = await phoneAt(await page.evaluate(() => window.__obpal.pairingUrl), errors)
      if (arm || id === 'arena') {
        const allow = page.locator('#people .allow').first()
        if (await allow.count()) await allow.click()
        await phone.page.locator('.scene-btn').click()
        await phone.page.locator('.pick', { hasText: arm ? 'Whole arm' : 'Player 1' }).first().click()
        if (arm) await phone.page.locator('.modes [data-tab=rotate]').click()
      }
      if (id === 'arena') {
        for (let n = 2; n <= 4; n++) {
          const player = await phoneAt(await page.evaluate(() => window.__obpal.pairingUrl), errors)
          extraPhones.push(player)
          const allow = page.locator('#people .allow').first(); if (await allow.count()) await allow.click()
          await player.page.locator('.scene-btn').click()
          await player.page.locator('.pick', { hasText: `Player ${n}` }).first().click()
        }
        await page.waitForFunction(() => window.__contacts.sample().length === 4)
      }
      const move = () => Promise.all([phone, ...extraPhones].map(p => p.move(id)))
      if (id === 'viewer') {
        await phone.move(id)
        report.push({ id, note: 'Shared assembly viewer: intentional free-space manipulation; no support or collision contract.', rows: [] })
        console.log(`  ✓ ${id}: free-space assembly`)
        continue
      }
      const record = async (phase, action) => {
        const atSeconds = (Date.now() - began) / 1000
        await page.evaluate(() => window.__contacts.start())
        await action()
        await page.waitForFunction(() => window.__contacts.count() > 1, null, { timeout: 15000 })
        const frames = await page.evaluate(() => window.__contacts.stop())
        if (phase === 'floor-contact') for (const frame of frames) for (const r of frame) if (r.part.startsWith('a1/') && r.part.includes('finger')) r.mode = 'touch'
        assert(frames.length > 0, `${phase}: frames`)
        rows.push({ phase, atSeconds, frames: frames.length, parts: summary(frames) })
      }
      await record('placeholder-rest', () => page.waitForTimeout(300))
      await record('placeholder-motion', move)
      if (model) await record('swap', async () => { release(); await page.waitForFunction(model => performance.getEntriesByName(`obpal:${model}:visible`).length > 0, model, { timeout: 30000 }); await page.waitForTimeout(100) })
      else release()
      const overview = page.getByRole('button', { name: 'Overview', exact: true })
      if (await overview.count()) await overview.click()
      await page.screenshot({ path: join(out, `${id}-overview.png`) })
      await record('model-motion', move)
      await sideView(page)
      await record('side-motion', () => Promise.all([move(), sleep(500).then(() => page.screenshot({ path: join(out, `${id}-moving-side.png`) }))]))
      if (['claw', 'tank', 'sorting'].includes(id)) await record('settle', () => page.waitForTimeout(5000))
      const home = phone.page.locator('.tray-btn[aria-label="Home"]')
      if (await home.isVisible()) await home.click()
      await page.waitForTimeout(600)
      await record('model-rest', () => page.waitForTimeout(300))
      await sideView(page)
      await page.screenshot({ path: join(out, `${id}-side.png`) })
      if (id === 'submarine') {
        await record('limits', () => phone.hold('.gp-trig[data-trig="0"]', () => page.waitForFunction(() => window.__device.logic.units[0].y <= .65001, null, { timeout: 45000 })))
        await record('seabed-rest', () => page.waitForTimeout(400))
        await sideView(page)
        await page.screenshot({ path: join(out, `${id}-seabed.png`) })
      }
      if (arm) {
        // Phone-driven joint motion above is followed by the existing repeatable IK fixture used in e2e:sims.
        await phone.context.close(); phone = null; await page.waitForTimeout(400)
        const floorHeight = await page.evaluate(() => window.__arm.kind().floorHeight)
        const at = await page.evaluate(height => {
          const api = window.__arm, s = api.stand('a1'), length = Math.hypot(s.x, s.z), stock = api.blocks().map((_, n) => api.block(n))
          for (const f of [.5, .35, .65]) for (const side of [0, -.18, .18]) {
            const x = s.x * f - s.z / length * side, z = s.z * f + s.x / length * side
            if (stock.every(b => Math.hypot(b.x - x, b.z - z) > .13) && api.solve('a1', x, z, height)) return { x, z }
          }
          return { x: s.x * .5, z: s.z * .5 }
        }, floorHeight)
        const go = async (height, open, ms) => {
          const pose = await page.evaluate(({ x, z, height }) => window.__arm.solve('a1', x, z, height), { ...at, height })
          assert(pose, `${id}: cannot reach ${height}`)
          await page.evaluate(({ pose, open }) => window.__arm.goTo('a1', pose, open), { pose, open })
          await page.waitForTimeout(ms)
        }
        await go(.22, 1, 2200)
        await sideView(page, [at.x, 0, at.z])
        await page.addStyleTag({ content: 'body > :not(#stage) { opacity: 0 !important; pointer-events: none !important }' })
        await page.evaluate(() => window.__contacts.camera.clearViewOffset())
        await record('floor-reach', async () => {
          for (let h = .2; h >= .05; h -= .015) await go(h, 1, 150)
          await go(floorHeight, 1, 700)
          await page.waitForFunction(() => {
            const fingers = window.__contacts.sample().filter(r => r.part.startsWith('a1/') && r.part.includes('finger'))
            return fingers.length >= 2 && fingers.every(r => r.gapMm !== null && Math.abs(r.gapMm) <= 2)
          }, null, { timeout: 45000 }).catch(async error => {
            const state = await page.evaluate(() => ({ fingers: window.__contacts.sample().filter(r => r.part.includes('finger')), arm: window.__arm.arms()[0] }))
            throw new Error(`${error.message}; floor ${floorHeight}, at ${JSON.stringify(at)}; ${JSON.stringify(state)}`)
          })
          await page.screenshot({ path: join(out, `${id}-floor.png`) })
        })
        await record('floor-contact', () => page.waitForTimeout(300))
        await go(.22, 1, 1700)
        await page.evaluate(({ x, z }) => window.__arm.placeBlock(0, x, z, 25), at)
        await record('block-reach', async () => {
          for (let h = .2; h >= .05; h -= .015) await go(h, 1, 150)
          await go(.0355, 1, 600); await go(.0355, 0, 1500)
          await page.waitForFunction(() => window.__arm.blocks()[0] === 'a1', null, { timeout: 30000 })
          await page.screenshot({ path: join(out, `${id}-block.png`) })
        })
        assert.equal(await page.evaluate(() => window.__arm.blocks()[0]), 'a1', `${id}: gripper contacts and holds the block`)
      }
      const metrics = await page.evaluate(() => window.__gfx?.())
      const entry = { id, model, rows, metrics, errors }
      report.push(entry)
      const measured = rows.flatMap(r => r.parts)
      assert(measured.length, `${id}: missing contact coverage`)
      if (!baseline) {
        const bad = measured.filter(r => r.missing && r.mode !== 'free' || (r.touchMaxMm ?? 0) > 2.001 || (r.penetrationMm ?? 0) > 2.001)
        assert.deepEqual(bad.map(r => [r.part, r.minMm, r.maxMm, r.missing]), [], `${id}: 2 mm contact bounds`)
        assert.deepEqual([...new Set(measured.filter(r => r.touchMaxMm !== undefined && !r.shadow).map(r => r.part))], [], `${id}: supported parts cast onto receiving surfaces`)
        assert(metrics.calls <= 150 && metrics.triangles <= 250000, `${id}: render budget (${metrics.calls} draws, ${metrics.triangles} triangles)`)
      }
      assert.deepEqual(errors, [], `${id}: browser errors`)
      console.log(`  ✓ ${id}: ${new Set(measured.map(r => r.part)).size} parts, ${rows.reduce((n, r) => n + r.frames, 0)} frames`)
    } catch (error) {
      failures.push({ id, message: error.message })
      if (!report.some(r => r.id === id)) report.push({ id, rows, errors, error: error.message })
      console.log(`  ✗ ${id}: ${error.message.slice(0, 700)}`)
      await page.screenshot({ path: join(out, `${id}-failure.png`) }).catch(() => {})
    } finally {
      const video = basename(await page.video().path())
      const entry = report.find(r => r.id === id); if (entry) entry.video = video
      release?.(); await phone?.context.close(); await Promise.all(extraPhones.map(p => p.context.close())); await context.close()
      await writeFile(join(out, 'contacts.json'), JSON.stringify({ baseline, report, failures }, null, 2))
    }
  }
} finally { await browser.close(); await local.close() }
if (process.env.OBPAL_E2E_EVIDENCE_ROOT) {
  const evidence = process.env.OBPAL_E2E_EVIDENCE_ROOT
  await mkdir(evidence, { recursive: true })
  await copyFile(join(out, 'contacts.json'), join(evidence, 'contacts.json'))
  for (const { id } of failures) await copyFile(join(out, `${id}-failure.png`), join(evidence, `${id}-failure.png`)).catch(() => {})
}
console.log(`Contact evidence: ${out}`)
console.log(`${report.length - failures.length}/${report.length} passed`)
process.exitCode = failures.length ? 1 : 0

} finally { await temps.cleanup() }

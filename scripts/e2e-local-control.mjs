/** Local input proofs use the real frame loop and UI; synthetic pads replace only the browser API. */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { measureButtonInk } from './lib/button-ink.mjs'
import { assertButtonInk } from './lib/surface-buttons.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'
import { rawRun } from './lib/distill.mjs'
import { execFileSync } from 'node:child_process'

const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; while (!await fn()) { if (Date.now() > end) throw new Error(`Local controls: ${label}`); await sleep(50) } }
const scenarios = [
  ['drone', '/sim/device/?d=drone', 'w'], ['kart', '/sim/device/?d=kart', 'w'],
  ['so101', '/sim/arm/?kind=so101', 'd'], ['marblerun', '/sim/device/?d=marblerun', 'd'],
  ['pendulum', '/sim/device/?d=pendulum', 'w'], ['humanoid', '/sim/humanoid/?test=humanoid', 'w'],
  ['rover', '/sim/device/?d=rover', 'w'],
  ['arena', '/sim/arena/', 'w'],
]
const sample = page => page.evaluate(() => {
  if (window.__arm) return window.__arm.arms().map(a => a.joints.map(j => j.angle))
  if (window.__humanoid) return window.__humanoid.snapshot().actors.map(a => a.position)
  if (window.__arena) return window.__arena.slots.map(s => [s.pos.x, s.pos.y])
  return (window.__device.logic.units ?? window.__device.logic.rovers ?? window.__device.logic.drones).map(u => Object.fromEntries(['x', 'y', 'z', 'tiltX', 'tiltZ', 'length', 'damping', 'pan', 'angle'].filter(k => typeof u[k] === 'number').map(k => [k, u[k]])))
})
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b)
const clearPoint = page => page.evaluate(() => {
  const canvas = window.__device?.stage.renderer.domElement ?? document.querySelector('canvas')
  for (let y = 140; y < innerHeight - 80; y += 35) for (let x = innerWidth - 80; x > 80; x -= 35) if (document.elementFromPoint(x, y) === canvas) return { x, y }
  throw new Error('no uncovered play surface')
})

export async function runLocalControl(local, check, { baseline = false } = {}) {
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] }))
  const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT || 'artifacts/local-control', baseline ? 'before' : 'after')
  await mkdir(out, { recursive: true })
  const report = [], errors = [], raw = rawRun(out)
  try {
    await runTouchReleaseEvidence(browser, local.origin, check, out, baseline)
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500, isMobile: viewport.width < 500, deviceScaleFactor: 1, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
      await context.addInitScript(() => {
        window.__localPads = [{ index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }]
        Object.defineProperty(navigator, 'getGamepads', { value: () => window.__localPads })
      })
      try {
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
        for (const [id, path, key] of scenarios) {
          if (baseline && id !== 'marblerun') continue
          await page.goto(`${local.origin}${path}`)
          await page.waitForFunction(() => !!window.__obpal?.pairingUrl, { timeout: 30000 })
          await page.evaluate(() => document.fonts.ready)
          if (baseline) { await page.screenshot({ path: join(raw, `scene-${viewport.width}.png`) }); continue }
          if (id === 'marblerun') await page.screenshot({ path: join(raw, `scene-${viewport.width}.png`) })
          if (!await page.locator('[data-panel="local-control"]').isVisible()) {
            if (viewport.width < 500) await page.locator('.panel-dock-handle').click()
            await page.locator('[data-panel-toggle="local-control"]').click()
          }
          const panel = page.locator('[data-panel="local-control"]')
          await check(`${id} local keyboard drives state at ${viewport.width}`, async () => {
            await panel.locator('[data-source="keyboard"]').click()
            await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
            if (id === 'pendulum') { await page.keyboard.press('h'); await page.waitForTimeout(80) }
            const before = await sample(page)
            if (id === 'drone') await page.keyboard.press('Enter')
            await page.keyboard.down(key)
            if (id === 'drone') await page.keyboard.down('Space')
            await page.waitForTimeout(700)
            await page.keyboard.up(key); if (id === 'drone') await page.keyboard.up('Space')
            const after = await sample(page)
            assert(changed(before, after), 'keyboard did not change state')
            report.push({ id, viewport, source: 'keyboard', before, after })
            await page.keyboard.press('Escape')
          })
          await check(`${id} synthetic standard gamepad drives state at ${viewport.width}`, async () => {
            await panel.locator('[data-source="gamepad"]').click()
            await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
            const before = await sample(page)
            await page.evaluate(id => { const p = window.__localPads[0]; p.axes = [.65, -.65, .5, -.5]; p.buttons[7].value = .8; if (id === 'drone') p.buttons[0].pressed = true }, id)
            await page.waitForTimeout(700)
            const after = await sample(page)
            assert(changed(before, after), 'gamepad did not change state')
            report.push({ id, viewport, source: 'gamepad', before, after })
            await page.evaluate(() => { window.__localPads[0].axes = [0, 0, 0, 0]; window.__localPads[0].buttons.forEach(b => { b.pressed = false; b.value = 0 }) })
            await page.keyboard.press('Escape')
          })
          await check(`${id} focused mouse drag drives state at ${viewport.width}`, async () => {
            await panel.locator('[data-source="keyboard"]').click()
            await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
            if (id === 'pendulum') { await page.keyboard.press('h'); await page.waitForTimeout(80) }
            const before = await sample(page), { x, y } = await clearPoint(page)
            await page.mouse.move(x, y); await page.mouse.down()
            for (let n = 1; n <= 20; n++) { await page.mouse.move(x - n * 8, y + n * 8); await page.waitForTimeout(25) }
            await page.mouse.up()
            const after = await sample(page); assert(changed(before, after), 'mouse drag did not change state')
            report.push({ id, viewport, source: 'mouse', before, after }); await page.keyboard.press('Escape')
          })
          if (id === 'marblerun') {
            await check(`picker and bindings centring guard at ${viewport.width}`, async () => {
              await page.mouse.move(0, 0); await page.screenshot({ path: join(raw, `picker-${viewport.width}.png`) })
              await panel.getByRole('button', { name: 'Bindings', exact: true }).click()
              await page.waitForTimeout(200)
              const rows = (await page.evaluate(measureButtonInk, { surfaces: true })).filter(r => r.classes.includes('local-') || r.path?.includes('local-control'))
              // The control window may scroll; measure every visible picker action and binding.
              assert(rows.length > 0, 'no local controls measured')
              await writeFile(join(out, `ink-${viewport.width}.json`), JSON.stringify(rows, null, 2))
              const detail = assertButtonInk(rows)
              await page.screenshot({ path: join(raw, `bindings-${viewport.width}.png`) })
              await page.getByRole('button', { name: 'Close bindings', exact: true }).click()
              return detail
            })
            await check(`same-device touch drives the marble board at ${viewport.width}`, async () => {
              await panel.locator('[data-source="keyboard"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
              const before = await sample(page)
              // Dispatch pointer movement on the focused canvas, through the production listeners.
              const cdp = await context.newCDPSession(page)
              const x = viewport.width < 500 ? 150 : 680
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 200, id: 1 }] })
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 50, y: 170, id: 1 }] })
              await page.waitForTimeout(300)
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach()
              const after = await sample(page); assert(changed(before, after), 'touch did not tilt the board')
              report.push({ id, viewport, source: 'touch', before, after })
            })
            await check(`controller-window option opens and local choice persists at ${viewport.width}`, async () => {
              const popup = page.waitForEvent('popup')
              await panel.locator('[data-source="window"]').click()
              const controller = await popup; await controller.waitForURL(/\/p\//); await controller.close()
              await panel.locator('[data-source="keyboard"]').click()
              await page.reload(); await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
              if (!await page.locator('[data-panel="local-control"]').isVisible()) { if (viewport.width < 500) await page.locator('.panel-dock-handle').click(); await page.locator('[data-panel-toggle="local-control"]').click() }
              assert(await page.locator('[data-source="keyboard"]').getAttribute('aria-pressed') === 'true', 'source not persisted')
              assert(await page.getByRole('button', { name: 'Enable local controls', exact: true }).count() === 1, 'reload rearmed controls')
            })
          }
        }
      } finally { await context.close() }
    }
    if (!baseline) await runLocalSharing(browser, local.origin, check, out)
    if (!baseline) await check('local-control pages have no JavaScript errors', () => { assert(!errors.length, errors.join(' | ')) })
    if (!baseline) await runUniversalFaces(browser, local.origin, check, out)
    await writeFile(join(out, 'state-changes.json'), JSON.stringify(report, null, 2))
  } finally { await browser.close() }
}

/** Reproducible live poses; only the simulation clock is paused for matched stills. */
async function runTouchReleaseEvidence(browser, origin, check, out, baseline) {
  const proof = join(out, 'touch-release'), raw = rawRun(proof), frames = [], measurements = []
  const compactBaseline = baseline || process.env.OBPAL_CONTROLLER_COMPACT_BASELINE === '1'
  for (const [name, viewport, touch, hybrid] of [
    ['desktop', { width: 1280, height: 800 }, false, false],
    ['phone', { width: 390, height: 844 }, true, false],
    ['tablet', { width: 1024, height: 768 }, true, false],
    ['hybrid', { width: 1024, height: 600 }, true, true],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: name === 'phone', deviceScaleFactor: 1, ignoreHTTPSErrors: true, reducedMotion: name === 'hybrid' ? 'reduce' : 'no-preference' })
    if (process.env.OBPAL_CONTROLLER_COMPACT_EVIDENCE === '1') await context.addInitScript(() => {
      Object.defineProperty(navigator, 'getGamepads', { value: () => [{ index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }] })
    })
    // Emulate the explicit media-query combination of a touch tablet with an attached fine pointer.
    if (hybrid) await context.addInitScript(() => { const native = matchMedia.bind(window); window.matchMedia = query => query === '(any-pointer: fine)' ? { ...native(query), matches: true, media: query, addEventListener() {}, removeEventListener() {} } : native(query) })
    try {
      const page = await context.newPage()
      await page.goto(`${origin}/sim/device/?d=trebuchet`)
      await page.waitForFunction(() => !!window.__device?.logic && !!window.__obpal?.pairingUrl)
      await page.evaluate(() => document.fonts.ready)
      await openLocalPicker(page)
      const capture = async (phase, failed = false) => {
        if (await page.evaluate(() => !!window.__releaseStep)) await page.waitForFunction(() => [...document.querySelectorAll('#dev-units li')].every((li, n) => li.querySelector('.tele > .kit-sr')?.textContent === window.__device.logic.readout(n)))
        if (await page.evaluate(() => !!window.__releaseStep)) measurements.push({ name, capturePhase: phase, units: await page.evaluate(() => window.__device.logic.units.map((u, n) => ({ phase: u.phase, readout: window.__device.logic.readout(n), visibleReadout: document.querySelectorAll('#dev-units li')[n]?.querySelector('.tele > .kit-sr')?.textContent }))) })
        const path = `${name}/${phase}/frame.png`; await mkdir(join(raw, name, phase), { recursive: true }); await page.screenshot({ path: join(raw, path) }); frames.push({ path, failed, scenario: name, phase }) }
      await capture('controls-cold')
      await page.waitForTimeout(500); await capture('controls-warm')
      if (process.env.OBPAL_CONTROLLER_COMPACT_EVIDENCE === '1') {
        await check(`compact source actions and header at ${name}`, async () => {
          const panel = page.locator('[data-panel="local-control"]')
          const snapshot = async phase => {
            const state = await page.evaluate(() => {
              const rect = el => ({ name: el.getAttribute('aria-label') || el.textContent, ...el.getBoundingClientRect().toJSON() })
              const logo = document.querySelector('.sim-top .logo')
              return { source: document.querySelector('.local-choice[aria-pressed="true"]').dataset.source, header: { ...rect(logo), mark: !!logo.querySelector('.mark'), wordmark: !!logo.querySelector('.brand-lockup'), href: logo.getAttribute('href') }, actions: [...document.querySelectorAll('.local-actions button')].filter(el => el.checkVisibility()).map(rect), helpOpen: document.querySelector('.local-bindings').checkVisibility(), saved: localStorage.getItem('obpal.local:trebuchet'), bindings: [...document.querySelectorAll('.local-bindings button[aria-label^="Remap"]')].map(el => el.getAttribute('aria-label')) }
            })
            measurements.push({ name, compact: phase, baseline: compactBaseline, mocked: 'Standard gamepad API only; native chooser and scene', state }); await capture(`compact-${phase}`); return state
          }
          try {
            await panel.locator('[data-source="keyboard"]').click()
            await panel.getByRole('button', { name: 'Bindings', exact: true }).click()
            await page.getByRole('button', { name: 'Remap Forward', exact: true }).click()
            const keyboard = await snapshot('keyboard-remap')
            if (name === 'phone') {
              // The phone's bindings region covers the chooser. Share remains visible above it.
              await page.getByRole('button', { name: 'Share scene', exact: true }).click()
              await page.getByRole('tab', { name: 'Play', exact: true }).click()
              await page.locator('.share-panel').getByRole('button', { name: 'On-screen touch controls', exact: true }).click()
            } else await panel.locator('[data-source="gamepad"]').click()
            const interruptedHelp = await snapshot('source-change-with-pending-remap')
            await page.keyboard.press('p')
            const saved = await page.evaluate(() => localStorage.getItem('obpal.local:trebuchet'))
            measurements.push({ name, pendingRemapProbe: { event: 'native key p after source change', before: keyboard.saved, after: saved } })
            if (!compactBaseline) {
              assert(!interruptedHelp.helpOpen, 'obsolete help survived source change')
              assert(JSON.stringify(JSON.parse(saved).bindings) === JSON.stringify(JSON.parse(keyboard.saved).bindings), 'pending remap consumed a key after source change')
            }
            if (name === 'phone') {
              await page.getByRole('button', { name: 'Leave local play', exact: true }).click()
              if (await page.getByRole('button', { name: 'Close bindings', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close bindings', exact: true }).click()
              await openLocalPicker(page)
              await panel.locator('[data-source="gamepad"]').click()
            }
            const gamepad = await snapshot('gamepad-source-change')
            if (!compactBaseline) {
              assert(gamepad.actions.some(a => a.name === 'Gamepad help') && !gamepad.actions.some(a => /Bindings|Lock mouse/.test(a.name)), 'gamepad actions include keyboard controls')
              await panel.getByRole('button', { name: 'Gamepad help', exact: true }).click()
              const help = await snapshot('gamepad-help')
              assert(help.bindings.length === 0, 'gamepad help exposes keyboard remapping')
            }
            await panel.locator('[data-source="touch"]').click()
            await page.locator('.phone-play').waitFor()
            const touch = await snapshot('touch-toolbar')
            if (!compactBaseline) {
              assert(!touch.helpOpen && !touch.actions.some(a => /Bindings|Gamepad help|Lock mouse/.test(a.name)), 'touch actions include keyboard controls')
              assert(touch.header.mark && !touch.header.wordmark && touch.header.name && touch.header.width >= 44 && touch.header.height >= 44 && touch.header.href === '/', 'sim home mark or target lost')
              await page.getByRole('button', { name: 'Leave local play', exact: true }).click()
              await openLocalPicker(page)
              const touchChooser = await snapshot('touch-chooser')
              assert(touchChooser.source === 'touch' && !touchChooser.helpOpen && touchChooser.actions.length === 0, 'visible touch chooser retains keyboard actions')
              await panel.locator('[data-source="phone"]').click()
              const phone = await snapshot('phone-choice')
              assert(!phone.helpOpen && !phone.actions.some(a => /Bindings|Gamepad help|Lock mouse/.test(a.name)), 'phone choice retains obsolete actions')
              await page.keyboard.press('Escape'); await openLocalPicker(page)
              const popup = page.waitForEvent('popup')
              await panel.locator('[data-source="window"]').click()
              const controller = await popup
              try {
                const windowChoice = await snapshot('controller-window-choice')
                assert(!windowChoice.helpOpen && !windowChoice.actions.some(a => /Bindings|Gamepad help|Lock mouse/.test(a.name)), 'controller window choice retains obsolete actions')
              } finally { await controller.close() }
            }
          } catch (error) { await capture('compact-failure', true); throw error }
          finally {
            if (await page.locator('.phone-play').count()) await page.getByRole('button', { name: 'Leave local play', exact: true }).click()
            if (await page.getByRole('button', { name: 'Close bindings', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close bindings', exact: true }).click()
            await openLocalPicker(page)
            await panel.locator('[data-source="keyboard"]').click()
          }
        })
        // Each original input proof starts from its own clean scene and focused chooser.
        await page.goto(`${origin}/sim/device/?d=trebuchet`)
        await page.waitForFunction(() => !!window.__device?.logic && !!window.__obpal?.pairingUrl)
        await openLocalPicker(page)
      }
      if (!baseline) { await runTouchBehavior(page, context, check, name, capture, measurements); await page.goto(`${origin}/sim/device/?d=trebuchet`); await page.waitForFunction(() => !!window.__device?.logic && !!window.__obpal?.pairingUrl); await openLocalPicker(page) }
      await check(`trebuchet ${baseline ? 'baseline' : 'release'} world geometry at ${name}`, async () => {
        await page.evaluate(() => {
          const d = window.__device, step = d.logic.step.bind(d.logic)
          d.logic.step = () => {}; window.__releaseStep = () => step([null, null], .01)
          window.__releasePose = n => {
            d.stage.scene.updateMatrixWorld(true)
            const root = d.stage.scene.getObjectByName(`trebuchet-${n + 1}`), cup = root.getObjectByName('sling-cup'), waiting = cup.children.find(o => o.geometry?.type === 'SphereGeometry')
            const point = waiting.position.clone().set(0, 0, 0); waiting.localToWorld(point)
            const u = d.logic.units[n]
            const arm = root.getObjectByName('throwing-arm'), positions = []
            for (const offset of [-1e-6, 1e-6]) { arm.rotation.x = u.arm + offset; cup.rotation.x = -arm.rotation.x; d.stage.scene.updateMatrixWorld(true); positions.push(waiting.localToWorld(point.clone().set(0, 0, 0)).toArray()) }
            arm.rotation.x = u.arm; cup.rotation.x = -u.arm; d.stage.scene.updateMatrixWorld(true)
            const direction = u.arm > 0 ? 1 : -1
            return { arm: u.arm, phase: u.phase, load: point.toArray(), projectile: [n * 5, u.y, u.z], velocity: [0, u.vy, u.vz], tangent: positions[1].map((v, j) => direction * (v - positions[0][j]) / 2e-6), angle: u.release }
          }
          window.__releaseHome = () => d.logic.units.forEach((u, n) => d.logic.home(n))
        })
        await capture('rest')
        await page.evaluate(() => { for (const u of window.__device.logic.units) { u.phase = 'winding'; u.clock = 0; u.release = u.angle; u.power = u.weight } for (let j = 0; j < 32; j++) window.__releaseStep() })
        await page.waitForTimeout(60); await capture('winding')
        await page.evaluate(() => { while (window.__device.logic.units[0].phase === 'winding') window.__releaseStep() })
        await page.waitForTimeout(60)
        const release = await page.evaluate(() => [0, 1].map(window.__releasePose))
        await capture('first-flight')
        for (const r of release) {
          const gap = Math.hypot(...r.load.map((v, j) => v - r.projectile[j]))
          measurements.push({ name, viewport, hybridMediaQueryMock: hybrid, release: r, gap })
          if (baseline) assert(gap > 2, `baseline discontinuity not reproduced: ${gap}`)
          else {
            assert(gap < 1e-8, `release position gap ${gap}`)
            const dot = r.tangent.reduce((sum, v, j) => sum + v * r.velocity[j], 0) / (Math.hypot(...r.tangent) * Math.hypot(...r.velocity))
            assert(dot > 1 - 1e-8 && r.tangent[2] < 0, `visible release tangent disagrees with launch: ${dot}`)
          }
        }
        await page.evaluate(() => { for (let j = 0; j < 600 && window.__device.logic.units.some(u => u.phase === 'flight'); j++) window.__releaseStep() })
        await page.waitForTimeout(60); await capture('landing')
        await page.evaluate(() => window.__releaseHome()); await page.waitForTimeout(60); await capture('reset')
        if (!baseline) for (const angle of [20, 75]) {
          await page.evaluate(angle => { window.__releaseHome(); for (const u of window.__device.logic.units) { u.phase = 'winding'; u.clock = 0; u.angle = u.release = angle; u.power = u.weight } while (window.__device.logic.units[0].phase === 'winding') window.__releaseStep() }, angle)
          await page.waitForTimeout(60)
          const limits = await page.evaluate(() => [0, 1].map(window.__releasePose))
          for (const r of limits) {
            const gap = Math.hypot(...r.load.map((v, j) => v - r.projectile[j])), a = angle * Math.PI / 180, norm = Math.hypot(...r.tangent)
            measurements.push({ name, angle, release: r, gap })
            assert(gap < 1e-8 && Math.abs(r.tangent[1] / norm - Math.sin(a)) < 1e-8 && Math.abs(r.tangent[2] / norm + Math.cos(a)) < 1e-8, `angle ${angle}: release mismatch`)
          }
          await capture(`release-${angle}`)
        }
        return release
      })
    } finally { await context.close() }
  }
  if (!baseline) await runTouchTakeover(browser, origin, check, measurements)
  await writeFile(join(proof, 'geometry.json'), JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), browser: browser.version(), deviceScope: 'Chromium viewport/touch emulation; hybrid fine-pointer media query explicitly mocked. Motion stills pause only the simulation clock. No physical-device performance claim.', baseline, measurements }, null, 2))
  await writeFile(join(proof, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, frames }, null, 2))
}

async function runTouchTakeover(browser, origin, check, measurements) {
  const host = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, ignoreHTTPSErrors: true })
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true })
  try {
    const screen = await host.newPage(), controller = await phone.newPage()
    await screen.goto(`${origin}/sim/device/?d=trebuchet`); await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
    await screen.getByRole('button', { name: 'Play here', exact: true }).click()
    await screen.locator('[data-source="touch"]').click()
    await check('paired phone takes over local touch; reconnect and local retry never evict or rearm', async () => {
      await controller.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await controller.locator('.scene-btn').waitFor({ state: 'visible', timeout: 30000 })
      const notice = controller.getByRole('button', { name: 'Dismiss connection notice', exact: true }); if (await notice.isVisible()) await notice.click()
      await controller.addLocatorHandler(controller.locator('.hint.in'), hint => hint.getByRole('button', { name: 'Dismiss hint' }).click())
      await controller.locator('.scene-btn').click(); await controller.locator('.pick').filter({ hasText: 'Trebuchet 1' }).first().click()
      await screen.waitForFunction(() => { const d = window.__device, r = window.__obpal, holder = window.__sim.claims.holder(d.units[0].id); return !!holder && !r.isLocal(holder) && !r.participants.some(p => r.isLocal(p.id)) })
      if (!await screen.locator('[data-panel="local-control"]').isVisible()) await openLocalPicker(screen)
      await screen.locator('[data-source="touch"]').click()
      assert(await screen.locator('.phone-play').count() === 0, 'local touch evicted paired phone')
      await controller.reload(); await controller.locator('.scene-btn').waitFor({ state: 'visible', timeout: 30000 })
      assert(await screen.locator('.phone-play').count() === 0, 'phone reconnect enabled local input')
      measurements.push({ takeover: true, localSeats: await screen.evaluate(() => window.__obpal.participants.filter(p => window.__obpal.isLocal(p.id)).length), reconnectLocalRearm: false })
    })
  } finally { await host.close(); await phone.close() }
}

async function runTouchBehavior(page, context, check, name, capture, measurements) {
  const panel = page.locator('[data-panel="local-control"]'), cdp = await context.newCDPSession(page)
  const mouse = ['desktop', 'hybrid'].includes(name)
  let finger = 0, heldAt = null
  if (!mouse) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  const runCase = (title, run) => check(title, async () => {
    try { return await run() }
    catch (error) { await capture(`failure-${title.replace(/[^a-z0-9]+/gi, '-').slice(0, 90)}`, true); measurements.push({ name, failure: title, error: error.message, events: await page.evaluate(() => window.__stickEvents ?? []), input: await pad() }); throw error }
    finally {
      if (heldAt) {
        try { if (mouse) await page.mouse.up(); else await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }) }
        catch (error) { measurements.push({ name, cleanupError: error.message }) }
        heldAt = null
      }
      await page.evaluate(() => { if (Object.hasOwn(document, 'hidden')) { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) } })
    }
  })
  const pad = () => page.evaluate(() => { const p = window.__obpal.participants.find(p => window.__obpal.isLocal(p.id)); return p ? window.__obpal.padOf(p.id) : null })
  const neutral = async () => until(async () => { const p = await pad(); return !p || p.axes.every(v => v === 0) }, 'held on-screen input released')
  const hold = async (label = 'Counterweight') => {
    await page.bringToFront()
    const stick = page.getByRole('group', { name: label, exact: true }); await stick.scrollIntoViewIfNeeded()
    const b = await stick.boundingBox(); assert(b, 'stick absent')
    await stick.evaluate(el => el.addEventListener('pointerdown', e => { window.__stickPointer = e.pointerId }, { once: true }))
    await stick.evaluate(el => { window.__stickEvents = []; if (el.dataset.proofObserved) return; el.dataset.proofObserved = '1'; for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) el.addEventListener(type, e => { if (window.__stickEvents.length < 32) window.__stickEvents.push({ type, id: e.pointerId, pointerType: e.pointerType, trusted: e.isTrusted, x: e.clientX, y: e.clientY, pressure: e.pressure, timeMs: performance.now() }) }) })
    const x = b.x + b.width / 2, y = b.y + b.height / 2 - 28
    assert(await stick.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), { x, y }), 'stick is covered')
    heldAt = { x, y, id: ++finger }
    if (mouse) { await page.mouse.move(x, y); await page.mouse.down() }
    else {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...heldAt, y: b.y + b.height / 2 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [heldAt] })
    }
    await until(async () => (await pad())?.axes.some(v => Math.abs(v) > .1), 'real pointer reached PAD')
  }
  const end = async () => { if (mouse) await page.mouse.up(); else await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); heldAt = null }
  const heldSource = () => page.evaluate(() => { const r = window.__obpal, p = r.participants.find(p => r.isLocal(p.id)); return { id: p?.id, pad: p ? r.padOf(p.id) : null, timeMs: performance.now() } })
  const interrupted = async (action, before) => {
    const after = await page.evaluate(id => {
      const r = window.__obpal, local = r.participants.filter(p => r.isLocal(p.id))
      return { timeMs: performance.now(), previousPad: r.padOf(id) ?? null, currentPads: local.map(p => r.padOf(p.id) ?? null), localSeats: local.length, events: [...(window.__stickEvents ?? [])] }
    }, before.id)
    measurements.push({ name, interruption: action, injected: true, beforePointerCleanup: true, before, after })
    assert(before.pad?.axes.some(v => Math.abs(v) > .1), `${action}: input was not held`)
    assert(after.events.every(e => !['pointerup', 'pointercancel'].includes(e.type)), `${action}: pointer ended before interruption was measured`)
    const idle = p => !p || p.axes.every(v => v === 0) && p.buttons === 0 && p.triggers.every(v => v === 0)
    assert(idle(after.previousPad) && after.currentPads.every(idle), `${action}: PAD was not neutral immediately before cleanup`)
    return after
  }
  try {
    await runCase(`explicit same-scene touch movement and launch, selected lane, no extra tab at ${name}`, async () => {
      await chooseVisibleUnit(page, panel, 'Local unit', '1', measurements, name)
      await panel.locator('[data-source="touch"]').click()
      const before = await page.evaluate(() => window.__device.logic.units.map(u => u.weight))
      await hold(); await page.waitForTimeout(250); await end(); await neutral()
      const after = await page.evaluate(() => window.__device.logic.units.map(u => u.weight))
      assert(after[1] > before[1] && after[0] === before[0], 'touch did not exclusively adjust selected counterweight')
      await page.getByRole('button', { name: 'Launch', exact: true }).click()
      await page.waitForFunction(() => window.__device.logic.units[1].shots === 1)
      assert(context.pages().length === 1, 'same-device action opened another tab')
      await chooseVisibleUnit(page, page.locator('.phone-play'), 'On-screen unit', await page.evaluate(() => window.__device.units[0].id), measurements, name)
      const toolbarBefore = await page.evaluate(() => window.__device.logic.units.map(u => u.weight))
      await hold(); await page.waitForTimeout(250); await end(); await neutral()
      const toolbarAfter = await page.evaluate(() => window.__device.logic.units.map(u => u.weight))
      measurements.push({ name, visibleToolbarRouting: { before: toolbarBefore, after: toolbarAfter } })
      assert(toolbarAfter[0] > toolbarBefore[0] && toolbarAfter[1] === toolbarBefore[1], 'visible toolbar selection did not exclusively route to first lane')
      await chooseVisibleUnit(page, page.locator('.phone-play'), 'On-screen unit', await page.evaluate(() => window.__device.units[1].id), measurements, name)
      await capture('touch-launch')
      const layout = await page.locator('.phone-play').evaluate(el => {
        const rect = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } }
        return { box: rect(el), overflow: document.documentElement.scrollWidth > innerWidth, targets: [...el.querySelectorAll('button,select')].map(e => ({ name: e.getAttribute('aria-label') || e.textContent, ...rect(e), visible: e.getBoundingClientRect().height > 0 })), regions: [...el.querySelectorAll('.phone-stick,.phone-play-buttons')].map(e => ({ name: e.getAttribute('aria-label') || e.className, ...rect(e) })) }
      })
      measurements.push({ name, touch: { before, after, tabs: context.pages().length, pointer: mouse ? 'native mouse on on-screen controls' : 'CDP touch', layout } })
      assert(!layout.overflow && layout.box.x >= 0 && layout.box.x + layout.box.width <= await page.evaluate(() => innerWidth), 'toolbar overflow')
      const targetSize = process.env.OBPAL_CONTROLLER_COMPACT_BASELINE === '1' ? 40 : 44
      assert(layout.targets.filter(t => t.visible).every(t => t.name?.trim() && t.height >= targetSize && t.width >= targetSize), `unnamed or small touch target: ${JSON.stringify(layout.targets)}`)
      for (let a = 0; a < layout.regions.length; a++) for (let b = a + 1; b < layout.regions.length; b++) { const x = layout.regions[a], y = layout.regions[b]; assert(x.x + x.width <= y.x || y.x + y.width <= x.x || x.y + x.height <= y.y || y.y + y.height <= x.y, `overlapping sticks/actions: ${JSON.stringify([x, y])}`) }
    })
    for (const release of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'hidden', 'camera']) await runCase(`on-screen ${release} releases held PAD at ${name}`, async () => {
      await hold()
      if (release === 'pointerup') await end()
      else if (release === 'pointercancel') { if (mouse) await page.getByRole('group', { name: 'Counterweight', exact: true }).evaluate(el => el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__stickPointer }))); else { await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); heldAt = null } }
      else if (release === 'lostpointercapture') {
        // Capture is pending after pointerdown. Establish it with a native event before releasing it.
        if (mouse) { heldAt.x++; await page.mouse.move(heldAt.x, heldAt.y) }
        else { heldAt.x++; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [heldAt] }) }
        await page.waitForFunction(() => window.__stickEvents.some(e => e.type === 'gotpointercapture' && e.trusted))
        await page.getByRole('group', { name: 'Counterweight', exact: true }).evaluate(el => el.releasePointerCapture(window.__stickPointer))
        // Attempt the same-position move first. Chromium touch emulation suppresses unchanged points.
        if (mouse) await page.mouse.move(heldAt.x, heldAt.y)
        else {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [heldAt] })
          const samePositionObserved = await page.evaluate(() => window.__stickEvents.some(e => e.type === 'lostpointercapture' && e.trusted))
          if (!samePositionObserved) { heldAt.x++; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [heldAt] }) }
          measurements.push({ name, captureProcessing: { samePositionMoveIssued: true, samePositionObserved, additionalNativeMovePixels: samePositionObserved ? 0 : 1 } })
        }
      }
      else if (release === 'blur') await page.evaluate(() => dispatchEvent(new Event('blur')))
      else if (release === 'hidden') await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
      else await page.getByRole('button', { name: 'Camera mode', exact: true }).evaluate(el => el.click())
      if (release === 'lostpointercapture') await page.waitForFunction(() => window.__stickEvents.some(e => e.type === 'lostpointercapture' && e.trusted))
      await neutral()
      if (release === 'hidden') await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
      if (release !== 'pointerup' && release !== 'pointercancel') await end()
      if (release === 'pointercancel' && mouse) await end()
      if (release === 'camera') await page.getByRole('button', { name: 'Camera mode', exact: true }).click()
      measurements.push({ name, release, injected: ['blur', 'hidden'].includes(release) || release === 'pointercancel' && mouse, events: await page.evaluate(() => window.__stickEvents), pad: await pad() })
    })
    await runCase(`on-screen unit/source/exit/reload release and never accumulate seats at ${name}`, async () => {
      // Separate injected interruption from the visible selection proof above: keep the pointer held.
      await hold(); const unitBefore = await heldSource()
      await page.locator('.phone-play select[aria-label="On-screen unit"]').selectOption(await page.evaluate(() => window.__device.units[0].id), { force: true })
      await interrupted('unit native-change injection', unitBefore); await end(); await neutral()
      assert(await page.evaluate(() => window.__obpal.participants.filter(p => window.__obpal.isLocal(p.id)).length) === 1, 'unit switch accumulated local seats')
      await hold(); const sourceBefore = await heldSource()
      await page.getByRole('button', { name: 'Choose controls', exact: true }).evaluate(el => el.click())
      await interrupted('source button-handler injection', sourceBefore); await end(); await neutral()
      assert(await page.locator('.phone-play').count() === 0, 'source chooser left touch active')
      await panel.locator('[data-source="touch"]').click(); await hold(); const exitBefore = await heldSource()
      await page.getByRole('button', { name: 'Leave local play', exact: true }).evaluate(el => el.click())
      await interrupted('exit button-handler injection', exitBefore); await end(); await neutral()
      await panel.locator('[data-source="touch"]').click(); await hold(); await page.reload()
      await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
      // Navigation cancelled the preceding pointer; per-case finally cleans the CDP gesture.
      assert(await page.locator('.phone-play').count() === 0 && await page.evaluate(() => window.__obpal.participants.filter(p => window.__obpal.isLocal(p.id)).length) === 0, 'reload rearmed or leaked touch seat')
    })
    await runCase(`Play here and sim chip choose locally without a new tab at ${name}`, async () => {
      const exit = page.getByRole('button', { name: 'Leave local play', exact: true }); if (await exit.isVisible()) await exit.click()
      await openSceneControls(page)
      await page.getByRole('button', { name: 'Play here', exact: true }).click()
      assert(await panel.isVisible() && await page.locator('.phone-play').count() === 0, 'Play here armed without choice')
      // Use the dock to make space for the native chip card; no forced or synthetic entry click.
      for (const id of await page.locator('.sim-window[data-state="open"]').evaluateAll(els => els.map(el => el.dataset.panel))) await minimisePanel(page, id)
      const pill = page.locator('.obpal-chip .pill')
      if (await pill.getAttribute('aria-expanded') !== 'true') {
        // A phone's folded pill scans other screens; its existing tray opens this screen's own card.
        const ownCode = page.locator('[data-quick="pair"]')
        if (await ownCode.count()) { await page.getByRole('button', { name: 'Shortcuts', exact: true }).click(); await ownCode.click() }
        else await pill.click()
      }
      const here = page.locator('.obpal-chip a.here')
      if (!await here.isVisible()) await page.locator('.obpal-chip .scan-cues > summary').click()
      const linkBox = await here.boundingBox(); measurements.push({ name, entry: 'visible sim chip Play here', linkBox, tabsBefore: context.pages().length })
      await here.click()
      assert(context.pages().length === 1 && await panel.isVisible(), 'sim chip opened another tab')
    })
    await runCase(`Share launches explicit touch on this scene at ${name}`, async () => {
      await page.getByRole('button', { name: 'Share scene', exact: true }).click()
      await page.getByRole('dialog', { name: 'Share this scene' }).getByRole('tab', { name: 'Play', exact: true }).click()
      await page.getByRole('dialog', { name: 'Share this scene' }).getByRole('button', { name: 'On-screen touch controls', exact: true }).click()
      await page.locator('.phone-play').waitFor({ state: 'visible' })
      assert(context.pages().length === 1, 'Share launched another tab')
      await page.getByRole('button', { name: 'Leave local play', exact: true }).click()
    })
    await runCase(`humanoid existing motion consumes same-scene stick and action at ${name}`, async () => {
      await page.goto(`${new URL(page.url()).origin}/sim/humanoid/?test=humanoid`)
      await page.waitForFunction(() => !!window.__humanoid?.snapshot && !!window.__obpal?.pairingUrl, { timeout: 30000 })
      await openLocalPicker(page); await panel.locator('[data-source="touch"]').click()
      const before = await sample(page); await hold('Move'); await page.waitForTimeout(350); await end(); await neutral()
      const after = await sample(page); assert(changed(before, after), 'humanoid did not move')
      await page.locator('.phone-play-buttons button').filter({ hasText: 'Wave' }).click()
      await page.waitForFunction(() => window.__humanoid.snapshot().actors.some(a => a.preset === 'wave'))
      await capture('humanoid-touch'); measurements.push({ name, humanoid: { before, after, action: 'wave', tabs: context.pages().length } })
      await page.getByRole('button', { name: 'Leave local play', exact: true }).click()
    })
  } finally { await cdp.detach() }
}

async function revealDock(page) {
  const handle = page.locator('.panel-dock-handle')
  if (await handle.isVisible() && await handle.getAttribute('aria-expanded') !== 'true') await handle.click()
}
async function minimisePanel(page, id) {
  await revealDock(page)
  await page.locator(`[data-panel-toggle="${id}"]`).click()
}
async function focusPanel(page, id) {
  const panel = page.locator(`[data-panel="${id}"]`)
  if (await panel.isVisible() && await panel.getAttribute('data-focused') === 'true') return
  if (await panel.isVisible()) await minimisePanel(page, id)
  await revealDock(page); await page.locator(`[data-panel-toggle="${id}"]`).click()
}
async function openLocalPicker(page) { await focusPanel(page, 'local-control') }
async function openSceneControls(page) {
  await focusPanel(page, 'controls')
  const details = page.locator('.local-play-entry').locator('xpath=ancestor::details')
  for (let n = await details.count() - 1; n >= 0; n--) if (!await details.nth(n).evaluate(el => el.open)) await details.nth(n).locator(':scope > summary').click()
}
async function chooseVisibleUnit(page, scope, label, value, measurements, name) {
  const combo = scope.getByRole('combobox', { name: label, exact: true })
  await combo.click()
  const list = await combo.getAttribute('aria-controls')
  const option = page.locator(`[id="${list}"] [role="option"][data-value="${value}"]`)
  const receipt = { label, value, comboBox: await combo.boundingBox(), optionBox: await option.boundingBox(), optionName: await option.innerText() }
  measurements.push({ name, visibleSelection: receipt })
  assert(receipt.comboBox && receipt.optionBox, 'visible unit choice has no target rectangle')
  await option.click()
  assert(await combo.getAttribute('data-value') === value, `visible ${label} did not select ${value}`)
}

export async function runUniversalFaces(browser, origin, check, out) {
  if (out) await mkdir(out, { recursive: true })
  const raw = out ? rawRun(join(out, 'universal-faces')) : null
  for (const [id, path, faces] of [
    ['marblerun', '/sim/device/?d=marblerun', ['face.wheel', 'face.mouse', 'face.keys']],
    ['kart', '/sim/device/?d=kart', ['face.trackpad', 'face.mouse', 'face.keys']],
    ['so101', '/sim/arm/?kind=so101', ['face.wheel', 'face.mouse', 'face.keys']],
  ]) {
    const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    try {
      await phone.addInitScript(() => { for (const key of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${key}`, '1') })
      const screen = await host.newPage(), page = await phone.newPage(), cdp = await phone.newCDPSession(page)
      await screen.goto(`${origin}${path}`)
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta: 70, gamma: 0 })
      await page.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await page.locator('.modes').waitFor({ state: 'attached', timeout: 30000 })
      const notice = page.getByRole('button', { name: 'Dismiss connection notice', exact: true })
      if (await notice.isVisible()) await notice.click()
      await page.addLocatorHandler(page.locator('.hint.in'), hint => hint.getByRole('button', { name: 'Dismiss hint' }).click())
      if (id === 'so101') {
        await page.locator('.scene-btn').click(); await page.locator('.pick').filter({ hasText: 'Whole arm' }).first().click()
        await screen.locator('#people .allow').first().click()
        await page.locator('.scene-btn').click(); await page.locator('.pick').filter({ hasText: 'Whole arm' }).first().click()
      }
      const position = page.locator('[data-id="control.position"]')
      if (await position.isVisible()) await position.click()
      for (const face of faces) await check(`${id} phone non-recommended ${face} changes real state`, async () => {
        await page.getByRole('button', { name: 'All controllers', exact: true }).filter({ visible: true }).click()
        const choices = page.locator('.ctl-card[data-c]')
        assert(await choices.count() === 9, 'not every catalogue face is offered')
        assert(await choices.evaluateAll(buttons => buttons.every(b => b.getAttribute('aria-disabled') === 'false')), 'a face is still gated')
        await page.locator(`.ctl-card[data-c="${face}"]`).click()
        await page.locator('.ctl-wrap').waitFor({ state: 'detached' })
        await until(() => screen.evaluate(face => window.__obpal.participants.some(p => p.controller === face), face), 'face switch reached host')
        await page.waitForTimeout(250)
        if (await position.isVisible()) await position.click()
        const before = await sample(screen)
        if (face === 'face.keys') {
          for (let n = 0; n < 8; n++) {
            await page.locator('.tone-key').nth(1).click()
            if (id === 'marblerun' && n === 0) await screen.waitForFunction(() => window.__device.logic.units.some(u => Math.abs(u.tiltX) + Math.abs(u.tiltZ) > .001))
            await page.waitForTimeout(70)
          }
        } else {
          const target = page.locator(face === 'face.wheel' ? '.gp-trig[data-trig="1"]' : face === 'face.mouse' ? '#mouse-left' : '#pad')
          await target.scrollIntoViewIfNeeded()
          const box = await target.boundingBox(); assert(box, 'face surface missing')
          const x = box.x + box.width / 2, y = box.y + box.height / 2
          const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[id]')?.id, { x, y })
          const cover = await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.outerHTML.slice(0,180), {x,y})
          assert(await target.evaluate((el, {x, y}) => el.contains(document.elementFromPoint(x, y)), {x, y}), `touch surface covered by ${hit}; ${cover}; ${JSON.stringify(box)}`)
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
          for (let n = 1; n <= 12; n++) {
            if (face === 'face.mouse' || face === 'face.wheel') await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: n * 2, beta: 70 + n, gamma: -n })
            else await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.min(60, box.width * .25) * n / 12, y: y - Math.min(60, box.height * .25) * n / 12, id: 1 }] })
            await page.evaluate(() => dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })))
            await page.waitForTimeout(45)
          }
          if (out) await writeFile(join(out, `held-${id}-${face.slice(5)}.json`), JSON.stringify(await screen.evaluate(() => {
            const r = window.__obpal, s = window.__sim, p = r.participants[0]
            return { person: p.controller, claims: s.claims.snapshot(), scope: s.control.scope(p.id), awaiting: s.control.awaitingPosition(p.id), pad: r.padOf(p.id), aim: s.control.aim(p.id), seen: window.__device?.seen[p.id], arm: window.__arm?.arms() }
          }), null, 2))
          if (id === 'marblerun') {
            const during = await sample(screen)
            assert(during.some((u, n) => u.tiltX !== before[n].tiltX || u.tiltZ !== before[n].tiltZ), 'held face did not tilt the board')
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        }
        await screen.waitForTimeout(250)
        const after = await sample(screen)
        assert(changed(before, after), `${face} did not change state`)
        if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, `phone-${id}-${face.slice(5)}.json`), JSON.stringify({ id, face, before, after }, null, 2)); await page.screenshot({ path: join(raw, `phone-${id}-${face.slice(5)}.png`) }) }
      })
    } finally { await host.close(); await phone.close() }
  }
}

async function runLocalSharing(browser, origin, check, out) {
  const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true })
  try {
    await host.addInitScript(() => {
      window.__localPads = [0, 1].map(index => ({ index, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }))
      Object.defineProperty(navigator, 'getGamepads', { value: () => window.__localPads })
    })
    const page = await host.newPage()
    await page.goto(`${origin}/sim/device/?d=rover`); await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
    await page.locator('[data-panel-toggle="local-control"]').click()
    const panel = page.locator('[data-panel="local-control"]')
    await check('two standard pads drive distinct rover units, unplug releases input', async () => {
      await panel.locator('[data-source="gamepad"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
      const before = await sample(page)
      await page.evaluate(() => window.__localPads.forEach((p, n) => { p.axes = [.3, n ? .8 : -.8, 0, 0] }))
      await page.waitForTimeout(750)
      const after = await sample(page)
      assert(changed(before[0], after[0]) && changed(before[1], after[1]), 'separate pads did not move both units')
      assert(await page.locator('#dev-units small').filter({hasText:'Local gamepad'}).count() === 2, 'local sources missing from seat list')
      assert(!changed(before[2], after[2]), 'a third unassigned unit moved')
      await reportSharing(before, after)
      await page.evaluate(() => { window.__localPads = [] })
      await until(() => panel.getByRole('button', { name: 'Enable local controls', exact: true }).isVisible(), 'unplug releases local enable')
      assert(!await panel.locator('[data-source="gamepad"]').isVisible(), 'gamepad detection was stale')
    })
    await check('phone owns its claimed rover while another local pad keeps driving', async () => {
      await page.evaluate(() => { window.__localPads = [0, 1].map(index => ({ index, connected: true, mapping: 'standard', axes: [0, -.8, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) })) })
      await panel.locator('[data-source="gamepad"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
      const controller = await phone.newPage(); await controller.goto(await page.evaluate(() => window.__obpal.pairingUrl))
      await until(() => panel.locator('.local-status').textContent().then(s => s.includes('Phone active')), 'phone priority status')
      const before = await sample(page); await page.waitForTimeout(750); const after = await sample(page)
      assert(changed(before[1], after[1]), 'phone stopped the other local player')
      const speeds = await page.evaluate(() => window.__device.logic.rovers.map(r => Math.abs(r.v)))
      assert(speeds[0] < speeds[1], 'claimed phone did not override the held local throttle')
      await writeFile(join(out, 'multi-unit.json'), JSON.stringify({ before, after, speeds }, null, 2))
      await controller.close()
      await until(() => page.evaluate(() => !window.__sim.claims.holder('rover1')), 'phone released its claim')
    })
    await check('Tab, forms, modified shortcuts and explicit pointer lock keep their normal behaviour', async () => {
      await panel.locator('[data-source="keyboard"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
      await page.keyboard.press('Tab'); assert(await page.evaluate(() => document.activeElement?.tagName !== 'CANVAS'), 'Tab trapped focus')
      await page.evaluate(() => { const input = document.createElement('input'); input.id = 'local-form-proof'; document.body.append(input); input.focus() })
      await page.keyboard.type('wasd qe'); assert(await page.locator('#local-form-proof').inputValue() === 'wasd qe', 'play keys intercepted typing')
      await page.evaluate(() => { document.getElementById('local-form-proof').remove(); document.querySelector('canvas').focus(); window.__shortcutPrevented = null; window.addEventListener('keydown', e => { if (e.ctrlKey && e.code === 'KeyQ') window.__shortcutPrevented = e.defaultPrevented }, { once: true }) })
      await page.keyboard.press('Control+q'); assert(await page.evaluate(() => !window.__shortcutPrevented), 'modified shortcut was intercepted')
      assert(await page.evaluate(() => !document.pointerLockElement), 'mouse locked implicitly')
      await panel.getByRole('button', { name: 'Lock mouse · Esc releases', exact: true }).click()
      await page.waitForFunction(() => !!document.pointerLockElement)
      await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.pointerLockElement)
    })
    await check('focused local mouse wheel changes PTZ zoom through its normal pad consumer', async () => {
      await page.goto(`${origin}/sim/device/?d=ptz`); await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await page.locator('[data-panel-toggle="local-control"]').click()
      const controls = page.locator('[data-panel="local-control"]')
      await controls.locator('[data-source="keyboard"]').click(); await controls.getByRole('button', {name:'Enable local controls',exact:true}).click()
      const before = await page.evaluate(() => window.__device.logic.cams[0].zoom)
      const {x,y} = await clearPoint(page); await page.mouse.move(x,y); await page.mouse.wheel(0,-120); await page.waitForTimeout(100)
      const after = await page.evaluate(() => window.__device.logic.cams[0].zoom)
      assert(after > before, 'wheel did not zoom')
      await writeFile(join(out,'wheel-zoom.json'), JSON.stringify({before,after},null,2))
    })
    async function reportSharing(before, after) { await writeFile(join(out, 'pads.json'), JSON.stringify({ before, after }, null, 2)) }
  } finally { await host.close(); await phone.close() }
}

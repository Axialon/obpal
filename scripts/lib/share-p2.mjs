import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rawRun } from './distill.mjs'
import { measureButtonInk, inkError } from './button-ink.mjs'

/** Local sim and phone proofs; these never connect a driver or the installed helper. */
export async function shareP2({ browser, origin, check }) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 844 } })
  const phoneCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT || 'artifacts/share-p2/after', 'participation'), raw = rawRun(out), frames = []
  const metrics = { promoteMs: [], demoteMs: [], queue: [], ink: [] }
  const shot = async (page, name, failed = false) => { mkdirSync(join(raw, name), { recursive: true }); const path = `${name}/0.png`; await page.screenshot({ path: join(raw, path) }); frames.push({ path, timeMs: 0, failed }) }
  const recordCheck = check
  check = (name, fn) => recordCheck(name, async () => {
    try { return await fn() } catch (error) {
      for (const [n, page] of [...ctx.pages(), ...phoneCtx.pages()].entries()) if (!page.isClosed()) await shot(page, `failure-${frames.length}-${n}`, true)
      throw error
    }
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const choose = async (page, label, name) => { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name, exact: true }).click() }
  const touches = new WeakMap()
  const stick = async (page, selector, x, y) => {
    let touch = touches.get(page)
    if (!touch) { touch = { session: await page.context().newCDPSession(page), started: false }; touches.set(page, touch) }
    const r = await page.locator(selector).first().boundingBox()
    if (touch.started) await touch.session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await touch.session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: r.x + r.width / 2 + x * r.width * .38, y: r.y + r.height / 2 + y * r.height * .38 }] }); touch.started = true
  }
  try {
    const host = await ctx.newPage(), phone = await phoneCtx.newPage()
    await host.goto(`${origin}/sim/rover/?test=vr`)
    await host.waitForFunction(() => window.__obpal?.watchFragment && window.__presence)
    await phone.goto(await host.evaluate(() => window.__obpal.pairingUrl)); await phone.locator('.participant-row').waitFor()
    const watchers = []
    for (let n = 0; n < 2; n++) { const page = await ctx.newPage(), url = new URL(await host.evaluate(() => window.__presence.shared.shareUrl())); url.searchParams.set('test', 'vr'); await page.goto(url.href); await page.waitForFunction(() => window.__presence?.shared.status === 'Live'); watchers.push(page) }
    const [a, b] = watchers, ids = await Promise.all(watchers.map(p => p.evaluate(() => window.__presence.shared.id)))
    const phoneId = await host.evaluate(() => window.__obpal.participants.find(p => p.capability === 'play').id)
    await check('P2 presence: one phone and two watchers have distinct shapes and a live role count', async () => {
      await host.waitForFunction(() => window.__obpal.participants.length === 3)
      assert.equal(await host.locator('.participant[data-role=play]').count(), 1); assert.equal(await host.locator('.participant[data-role=watch]').count(), 2)
      assert.match(await phone.locator('.participant-row').getAttribute('aria-label'), /1 players, 2 watchers/)
      assert.match(await host.locator('.participant[data-role=play]').innerText(), /Rover 1/)
      await shot(host, 'presence-1280'); await shot(phone, 'presence-phone-390')
    })
    await check('P2 Ask and Accept promote in two taps within 1 s without Play or hardware authority', async () => {
      await a.getByRole('button', { name: 'Ask to play', exact: true }).click(); await host.getByRole('button', { name: 'Accept', exact: true }).waitFor()
      const began = performance.now()
      await host.getByRole('button', { name: 'Accept', exact: true }).click(); await a.locator('.phone-play').waitFor(); metrics.promoteMs.push(Number((performance.now() - began).toFixed(3)))
      assert(metrics.promoteMs.at(-1) <= 1000)
      const granted = await host.evaluate(id => { const r = window.__obpal, p = r.participants.find(p => p.id === id); return { capability: p.capability, role: p.role, grant: p.simSeat, hardware: r.canDriveHardware(id), raw: r.consumeOf(id).connected } }, ids[0])
      assert.equal(granted.capability, 'watch'); assert.equal(granted.role, 'play'); assert.equal(granted.grant, 'rover2'); assert.equal(granted.hardware, false); assert.equal(granted.raw, false)
      const before = await host.evaluate(() => window.__device.logic.rovers[1].z)
      await stick(a, '.phone-play .phone-stick', 0, -1)
      await host.waitForFunction(z => Math.abs(window.__device.logic.rovers[1].z - z) > .05, before)
      await shot(a, 'promoted-watcher-1280'); return `${metrics.promoteMs.at(-1)} ms`
    })
    await check('P2 demotion clears held input and the seat within 300 ms', async () => {
      await host.locator('.participant-strip summary').click()
      const start = Date.now(); await host.getByRole('button', { name: /Watch: Scene visitor/ }).click()
      await host.waitForFunction(id => !window.__obpal.simPadOf(id) && !window.__sim.claims.held(id) && window.__obpal.participants.find(p => p.id === id).role === 'watch', ids[0], { polling: 10 })
      metrics.demoteMs.push(Date.now() - start); assert(metrics.demoteMs.at(-1) <= 300)
      await a.locator('.phone-play').waitFor({ state: 'detached' }); return `${metrics.demoteMs.at(-1)} ms`
    })
    await check('P2 the phone gives its seat to a second watcher and becomes a watcher', async () => {
      await phone.getByRole('combobox', { name: 'Give to…', exact: true }).click(); await phone.locator(`[role="option"][data-value="${ids[1]}"]`).click(); await b.locator('.phone-play').waitFor()
      await host.waitForFunction(({ phoneId, target }) => window.__sim.claims.holder('rover1') === target && window.__obpal.participants.find(p => p.id === phoneId).role === 'watch', { phoneId, target: ids[1] })
      assert.equal(await host.evaluate(id => window.__obpal.canDriveHardware(id), ids[1]), false)
      await phone.getByRole('button', { name: 'Ask to play', exact: true }).waitFor()
      await host.evaluate(id => window.__obpal.setSimSeat(id, null), ids[1])
    })
    await check('P2 Queue rotates watcher turns, rejects out-of-turn and Off input', async () => {
      await host.getByLabel('Turn seconds', { exact: true }).fill('1'); await host.getByLabel('Turn seconds', { exact: true }).press('Tab')
      await choose(host, 'Audience model', 'Rover 3'); await choose(host, 'Audience mode', 'Queue')
      await a.getByRole('button', { name: 'Join queue', exact: true }).click(); await b.getByRole('button', { name: 'Join queue', exact: true }).click()
      await host.waitForFunction(id => window.__presence.shared.audience.snapshot(performance.now(), new Set(window.__obpal.participants.filter(p => p.role === 'watch').map(p => p.id))).turn === id, ids[0])
      const vote = await b.evaluate(() => { const shared = window.__presence.shared; shared.link.sendCtl({ t: 'sim', v: 1, kind: 'audience', seq: ++shared.seq, data: { x: 1, y: -1 } }); return Date.now() })
      await sleep(100)
      assert.equal(await host.evaluate(id => window.__presence.shared.audience.snapshot(performance.now(), new Set(window.__obpal.participants.map(p => p.id))).votes.some(v => v.id === id), ids[1]), false)
      await host.waitForFunction(id => window.__presence.shared.audience.snapshot(performance.now(), new Set(window.__obpal.participants.map(p => p.id))).turn === id, ids[1], { polling: 10 })
      metrics.queue.push({ first: ids[0], next: ids[1], observedMs: Date.now() - vote }); await shot(host, 'queue-1280')
      await choose(host, 'Audience mode', 'Off')
      assert.equal(await host.evaluate(() => window.__sim.claims.held('audience')), undefined)
      await a.evaluate(() => { const s = window.__presence.shared; s.link.sendCtl({ t: 'sim', v: 1, kind: 'audience', seq: ++s.seq, data: { x: 1, y: -1 } }) }); await sleep(100)
      assert.deepEqual(await host.evaluate(() => window.__presence.shared.audience.snapshot(performance.now(), new Set(window.__obpal.participants.map(p => p.id))).direction), [0, 0])
    })
    await check('P2 Crowd moves the reserved normal sim unit and displays individual votes', async () => {
      await choose(host, 'Audience model', 'Rover 3'); await choose(host, 'Audience mode', 'Crowd')
      await a.locator('.audience-stick').waitFor(); await b.locator('.audience-stick').waitFor()
      await sleep(300)
      assert.equal(await host.locator('.audience-votes i').count(), 0, 'idle viewers must not dilute active votes')
      const before = await host.evaluate(() => window.__device.logic.rovers[2].z)
      await stick(a, '.audience-stick', .2, -1); await stick(b, '.audience-stick', .2, -1)
      await host.waitForFunction(z => Math.abs(window.__device.logic.rovers[2].z - z) > .05, before)
      assert(await host.locator('.audience-votes i').count() >= 2)
      assert.equal(await host.evaluate(() => window.__obpal.participants.filter(p => p.capability === 'play').length), 1)
      await shot(host, 'crowd-1280')
    })
    await check('P2 stream view hides Play links, codes and QR until the host explicitly shows Watch QR', async () => {
      await host.getByRole('button', { name: 'Stream view', exact: true }).click()
      assert.equal(await host.locator('.obpal-chip').isVisible(), false); assert.equal(await host.locator('.share-panel').isVisible(), false); assert.equal(await host.locator('.stream-watch-qr').isVisible(), false)
      await host.getByRole('button', { name: 'Show watch QR', exact: true }).click(); await host.locator('.stream-watch-qr svg').waitFor()
      await shot(host, 'stream-1280'); await host.getByRole('button', { name: 'Show watch QR', exact: true }).click()
    })
    await check('P2 phone and broadcast controls stay within safe areas with centred ink and readable contrast', async () => {
      for (const page of [host, a, phone]) for (const [width, height] of [[1280, 844], [390, 844], [915, 412]]) {
        await page.setViewportSize({ width, height })
        const guard = await page.evaluate(() => {
          const el = document.querySelector('.participant-strip'), r = el.getBoundingClientRect(), s = getComputedStyle(el)
          return { inBounds: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight, ink: s.color, background: s.backgroundColor, overflow: el.scrollWidth - el.clientWidth }
        })
        assert(guard.inBounds, `${width}px ${JSON.stringify(guard)}`); assert(guard.overflow <= 1); assert.notEqual(guard.ink, guard.background)
        await page.evaluate(() => document.fonts.ready)
        const ink = (await page.evaluate(measureButtonInk)).filter(r => (r.classes.includes('participant-action') || r.classes.includes('stream-qr-toggle')) && r.groupInk)
        assert(ink.length, 'no participation controls measured')
        for (const r of ink) { const error = inkError(r); metrics.ink.push({ width, label: r.name, error }); assert(error <= .5, `${r.name}: ${error}px`) }
        const contrast = await page.evaluate(() => {
          const luminance = rgb => { const v = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return v[0] * .2126 + v[1] * .7152 + v[2] * .0722 }
          return [...document.querySelectorAll('.participant-strip button')].filter(b => b.checkVisibility() && !b.disabled).map(b => { const s = getComputedStyle(b), a = luminance(s.color), z = luminance(s.backgroundColor); return (Math.max(a, z) + .05) / (Math.min(a, z) + .05) })
        })
        assert(contrast.every(r => r >= 4.5), `text contrast ${JSON.stringify(contrast)}`)
        if (width === 390) await shot(page, page === host ? 'stream-390' : page === phone ? 'phone-watcher-390' : 'audience-watcher-390')
      }
    })
    await check('P2 scoped arm and joint input stays sim-only and demotion holds every driven joint', async () => {
      const arm = await ctx.newPage(), guest = await phoneCtx.newPage()
      await arm.goto(`${origin}/sim/arm/?test=vr`); await arm.waitForFunction(() => window.__obpal?.watchFragment && window.__presence && window.__arm)
      const url = new URL(await arm.evaluate(() => window.__presence.shared.shareUrl())); url.searchParams.set('test', 'vr')
      await guest.goto(url.href); await guest.getByRole('button', { name: 'Ask to play', exact: true }).click()
      await arm.getByRole('button', { name: 'Accept', exact: true }).click(); await guest.locator('.phone-play').waitFor()
      const id = await arm.evaluate(() => window.__obpal.participants[0].id), before = await arm.evaluate(() => window.__arm.toolPosition('a1'))
      await stick(guest, '.phone-play .phone-stick', 1, -.4)
      await arm.waitForFunction(before => Math.hypot(...window.__arm.toolPosition('a1').map((v, i) => v - before[i])) > .015, before)
      assert.equal(await arm.evaluate(id => window.__obpal.canDriveHardware(id), id), false)
      await arm.evaluate(id => window.__obpal.setSimSeat(id, null), id)
      assert(await arm.evaluate(() => window.__arm.arms()[0].joints.every(j => j.target === null && j.vel === 0)))
      await guest.locator('.phone-play').waitFor({ state: 'detached' })
      await arm.evaluate(id => window.__obpal.setSimSeat(id, 'a1.shoulder'), id); await guest.locator('.phone-play').waitFor()
      const angle = await arm.evaluate(() => window.__arm.arms()[0].joints.find(j => j.node === 'a1.shoulder').angle)
      await stick(guest, '.phone-play .phone-stick', 1, 0)
      await arm.waitForFunction(angle => Math.abs(window.__arm.arms()[0].joints.find(j => j.node === 'a1.shoulder').angle - angle) > 1, angle)
      await shot(guest, 'arm-joint-grant-390')
      await arm.evaluate(id => window.__obpal.setSimSeat(id, null), id)
      assert(await arm.evaluate(() => window.__arm.arms()[0].joints.every(j => j.target === null && j.vel === 0)))
      await guest.close(); await arm.close()
    })
    await check('P2 long participant names fit the phone stream layout and its demotion controls', async () => {
      await host.evaluate(id => {
        for (const p of window.__obpal.peers.values()) if (p.bound) p.name = 'GuestWithAVeryLongUnbrokenParticipantNameForThePresenceAndHandoverLayout'
        window.__presence.shared.handoverAction('host', 'accept', id)
      }, ids[1])
      await host.setViewportSize({ width: 390, height: 844 }); await host.locator('.participant-strip summary').click()
      const bounds = await host.evaluate(() => {
        const strip = document.querySelector('.participant-strip'), r = strip.getBoundingClientRect()
        return { overflow: strip.scrollWidth - strip.clientWidth, buttons: [...strip.querySelectorAll('button')].filter(b => b.checkVisibility()).every(b => { const q = b.getBoundingClientRect(); return q.left >= r.left && q.right <= r.right && q.bottom <= innerHeight }) }
      })
      assert(bounds.overflow <= 1 && bounds.buttons, JSON.stringify(bounds)); await shot(host, 'long-names-stream-390')
    })
  } finally {
    writeFileSync(join(out, 'metrics.json'), JSON.stringify(metrics, null, 2)); writeFileSync(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, frames }, null, 2))
    await phoneCtx.close(); await ctx.close()
  }
}

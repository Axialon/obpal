import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { measureButtonInk, inkError } from './button-ink.mjs'

/** P1 proofs use only the local worker, simulated models and the runner's Chromium. */
export async function shareP1({ browser, origin, check, shots }) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
  const samples = { firstFrameMs: [], reloads: 0, revokeMs: 0, dropMs: 0, phone: [], ink: [] }
  try {
    const host = await ctx.newPage()
    await host.goto(`${origin}/sim/drone/?test=vr`)
    await host.waitForFunction(() => window.__device && window.__presence && window.__obpal?.watchFragment)
    const watchUrl = await host.evaluate(() => window.__presence.shared.shareUrl())
    const visitors = []
    await check('short Watch and Play URLs resolve locally and preserve cryptographic roles', async () => {
      for (const capability of ['watch', 'play']) {
        const page = await ctx.newPage()
        try {
          const short = await host.evaluate(key => window.__obpal.shortShareUrl(key), capability)
          assert(short.length < (await host.evaluate(key => window.__presence.shared.shareUrl(key), capability)).length)
          await page.goto(short)
          await page.waitForURL(url => url.pathname === '/sim/drone/' && (capability === 'watch' ? url.searchParams.get('watch') === '1' : url.searchParams.get('join') === 'play'))
          await page.getByRole('status').filter({ hasText: capability === 'watch' ? 'Watching' : 'Playing' }).waitFor()
          await host.waitForFunction(key => window.__obpal.participants.some(p => p.capability === key), capability)
        } finally { await page.close() }
      }
      await host.waitForFunction(() => window.__obpal.participants.length === 0)
    })
    await check('watcher replay cannot claim, press, drive, arm or change the host camera; safe drops reach every viewer', async () => {
      const phone = await ctx.newPage()
      let captured
      try {
        await phone.addInitScript(() => {
          const send = RTCDataChannel.prototype.send
          window.__capturedPlay = { pads: [], button: null }
          RTCDataChannel.prototype.send = function(data) {
            if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 0x12) { window.__capturedPlay.pads.push([...new Uint8Array(data)]); return }
            if (typeof data === 'string') { const m = JSON.parse(data); if (m.t === 'btn' && m.id === 'fly') { window.__capturedPlay.button = m; return } }
            return send.call(this, data)
          }
        })
        await phone.goto(await host.evaluate(() => window.__obpal.pairingUrl))
        await phone.locator('.gp-stick').first().waitFor()
        await phone.evaluate(() => {
          const stick = document.querySelector('.gp-stick'), r = stick.getBoundingClientRect()
          stick.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
          stick.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 71, clientX: r.x + r.width / 2 + 35, clientY: r.y + r.height / 2 - 45 }))
          document.querySelector('#tray button[aria-label="Take off"]').click()
        })
        await phone.waitForFunction(() => window.__capturedPlay.button && window.__capturedPlay.pads.some(p => new DataView(Uint8Array.from(p).buffer).getInt16(14, true) < -1000))
        captured = await phone.evaluate(() => ({ button: window.__capturedPlay.button, pad: window.__capturedPlay.pads.find(p => new DataView(Uint8Array.from(p).buffer).getInt16(14, true) < -1000) }))
        assert.equal(captured.pad.length, 24, 'captured production PAD framing')
      } finally { await phone.close() }
      await host.waitForFunction(() => window.__obpal.participants.length === 0)
      for (let n = 0; n < 2; n++) {
        const page = await ctx.newPage(), start = Date.now(), url = new URL(watchUrl); url.searchParams.set('test', 'vr')
        await page.goto(url.href); await page.waitForFunction(() => window.__presence?.shared.status === 'Live')
        samples.firstFrameMs.push(Date.now() - start); visitors.push(page)
      }
      const before = await host.evaluate(() => ({ state: window.__presence.shared.adapter.capture(), camera: window.__presence.state().camera }))
      for (let replay = 0; replay < 2; replay++) {
        await visitors[0].evaluate(button => { const link = window.__presence.shared.link; link.sendCtl({ t: 'claim', node: 'drone1' }); link.sendCtl(button); link.sendCtl({ t: 'value', id: 'arm', v: true }) }, captured.button)
        await host.waitForFunction(n => window.__obpal.blockedInputs.length >= n, replay * 7 + 3, { timeout: 3000 })
        for (const [i, header] of [0x11, 0x12, 0x16, 0x17].entries()) {
          await visitors[0].evaluate(({ header, pad }) => { const bytes = header === 0x12 ? Uint8Array.from(pad) : new Uint8Array(128); bytes[0] = header; window.__presence.shared.link.st.send(bytes.buffer) }, { header, pad: captured.pad })
          await host.waitForFunction(n => window.__obpal.blockedInputs.length >= n, replay * 7 + i + 4, { timeout: 3000 })
        }
      }
      assert.equal(await host.evaluate(() => window.__sim.claims.holder('drone1')), undefined)
      assert.equal(await host.evaluate(() => window.__obpal.participants.some(p => p.lead)), false)
      const after = await host.evaluate(() => window.__presence.shared.adapter.capture())
      assert.deepEqual(after.drones.map(d => [d.x, d.y, d.z]), before.state.drones.map(d => [d.x, d.y, d.z]))
      await visitors[0].mouse.move(600, 350); await visitors[0].mouse.down(); await visitors[0].mouse.move(760, 410, { steps: 8 }); await visitors[0].mouse.up()
      assert.deepEqual(await host.evaluate(() => window.__presence.state().camera), before.camera)
      const start = Date.now()
      await visitors[0].evaluate(() => window.__presence.shared.requestDrop('ball', [6, 1, 6]))
      await Promise.all([host, ...visitors].map(p => p.waitForFunction(() => [...window.__presence.shared.world.bodies].some(b => b.p[0] > 5.8 && b.p[2] > 5.8), null, { timeout: 5000 })))
      samples.dropMs = Date.now() - start; assert(samples.dropMs <= 1000, `drop propagation ${samples.dropMs} ms`)
      const counts = await Promise.all([host, ...visitors].map(p => p.evaluate(() => window.__presence.shared.world.bodies.length)))
      assert(counts.every(n => n === counts[0]))
      if (shots) { await visitors[0].setViewportSize({ width: 390, height: 844 }); await visitors[0].screenshot({ path: join(shots, 'watcher-tray-390.png') }); await visitors[0].setViewportSize({ width: 1280, height: 800 }) }
      await host.evaluate(() => window.__presence.shared.controlDrops('undo'))
      await Promise.all(visitors.map(p => p.waitForFunction(count => window.__presence.shared.world.bodies.length === count - 1, counts[0])))
      return `drop ${samples.dropMs} ms; 14 replay attempts blocked`
    })

    await check('24 WebRTC watchers and 8 players bind together; the 25th watcher receives Room full', async () => {
      const fragments = await host.evaluate(() => ({ watch: window.__obpal.watchFragment, play: new URL(window.__obpal.pairingUrl).hash.slice(1) }))
      try {
        await visitors[0].evaluate(async fragments => {
          const Link = window.__presence.shared.link.constructor
          const bytes = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))
          window.__poolLinks = []
          await Promise.all([...Array(22).fill(fragments.watch), ...Array(8).fill(fragments.play)].map(fragment => new Promise((resolve, reject) => {
            const [, role, room, secret, fp] = fragment.split('.')
            const link = new Link({ pairing: { secret: bytes(secret), fp: bytes(fp), room, capability: role === 'w' ? 'watch' : 'play' }, service: location.origin, name: 'Pool proof', caps: () => ({ tier: 0, sensorApi: 'none', haptics: 'none', platform: 'scene' }) })
            window.__poolLinks.push(link)
            link.on('status', status => { if (status === 'connected') resolve(); else if (['removed', 'full'].includes(status)) reject(new Error(status)) })
            void link.start()
          })))
        }, fragments)
        await host.waitForFunction(() => window.__obpal.participants.length === 32)
        const counts = await host.evaluate(() => ({ watch: window.__obpal.participants.filter(p => p.capability === 'watch').length, play: window.__obpal.participants.filter(p => p.capability === 'play').length }))
        assert.deepEqual(counts, { watch: 24, play: 8 })
        const excess = await ctx.newPage(), url = new URL(watchUrl); url.searchParams.set('test', 'vr')
        await excess.goto(url.href); await excess.waitForFunction(() => window.__presence?.shared.status === 'Room full'); await excess.close()
      } finally {
        await visitors[0].evaluate(() => window.__poolLinks?.forEach(link => link.close()))
        await host.waitForFunction(() => window.__obpal.participants.length === 2)
      }
      return '32 authenticated peer connections, separate capability counts'
    })

    await check('a Play link opens a controllable scene with its own camera and a player claim', async () => {
      const url = await host.evaluate(() => window.__presence.shared.shareUrl('play')), page = await ctx.newPage(); await page.setViewportSize({ width: 390, height: 844 })
      try {
        const playUrl = new URL(url); playUrl.searchParams.set('test', 'vr'); await page.goto(playUrl.href)
        await page.getByRole('toolbar', { name: 'On-screen controls' }).waitFor()
        await page.waitForFunction(() => window.__presence?.shared.status === 'Live')
        const id = await host.evaluate(() => window.__obpal.participants.find(p => p.name === 'Scene player')?.id)
        assert(id); assert.equal(await host.evaluate(id => window.__obpal.participants.find(p => p.id === id)?.capability, id), 'play')
        assert(await host.evaluate(id => !!window.__sim.claims.held(id), id))
        const camera = await host.evaluate(() => window.__presence.state().camera)
        await page.getByRole('button', { name: 'Camera mode', exact: true }).click()
        await page.mouse.move(150, 260); await page.mouse.down(); await page.mouse.move(240, 340, { steps: 8 }); await page.mouse.up()
        assert.deepEqual(await host.evaluate(() => window.__presence.state().camera), camera)
        if (shots) await page.screenshot({ path: join(shots, 'play-link-scene-390.png') })
      } finally { await page.close() }
    })

    await check('a paired phone can clear, undo, disable drops and open its scene', async () => {
      const page = await ctx.newPage()
      try {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(await host.evaluate(() => window.__obpal.pairingUrl))
        const toggle = page.getByRole('button', { name: 'Drop-ins', exact: true })
        // On the gamepad a shared scene's drop-ins live under More (src/controller/gamepad.ts).
        const more = page.locator('.gp:not([hidden]) [data-act="more"]')
        await page.locator('button[aria-label="Drop-ins"]:visible, .gp:not([hidden]) [data-act="more"]').first().waitFor()
        if (await more.isVisible() && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
        await toggle.waitFor(); await page.getByRole('button', { name: 'Open scene', exact: true }).waitFor()
        await page.getByRole('button', { name: 'Undo drop', exact: true }).click()
        await page.getByRole('button', { name: 'Clear drops', exact: true }).click()
        await toggle.click(); await host.waitForFunction(() => !window.__presence.shared.drops.enabled)
        await toggle.click(); await host.waitForFunction(() => window.__presence.shared.drops.enabled)
        await page.getByRole('button', { name: 'Open scene', exact: true }).click()
        await page.waitForURL(/join=play/); await page.getByRole('toolbar', { name: 'On-screen controls' }).waitFor()
      } finally { await page.close() }
    })

    await check('marble and claw drop-ins enter native physics and replicate to the watcher', async () => {
      for (const [sim, object, key] of [['marblerun', 'marble', 'units'], ['claw', 'orb', 'prizes']]) {
        const screen = await ctx.newPage(), watcher = await ctx.newPage()
        try {
          await screen.goto(`${origin}/sim/${sim}/?test=vr`); await screen.waitForFunction(() => window.__obpal?.watchFragment && window.__presence)
          const url = new URL(await screen.evaluate(() => window.__presence.shared.shareUrl())); url.searchParams.set('test', 'vr')
          await watcher.goto(url.href); await watcher.waitForFunction(() => window.__presence?.shared.status === 'Live')
          const count = await screen.evaluate(key => key === 'units' ? window.__device.logic.units[0].marbles.length : window.__device.logic.prizes[0].length, key)
          await watcher.locator(`button[data-drop="${object}"]`).click(); await watcher.getByRole('button', { name: 'Drop near the player', exact: true }).click()
          await screen.waitForFunction(([key, n]) => (key === 'units' ? window.__device.logic.units[0].marbles.length : window.__device.logic.prizes[0].length) === n + 1, [key, count], { timeout: 5000 })
          await watcher.waitForFunction(([key, n]) => (key === 'units' ? window.__device.logic.units[0].marbles.length : window.__device.logic.prizes[0].length) === n + 1, [key, count], { timeout: 1000 })
          await screen.evaluate(() => window.__presence.shared.controlDrops('undo'))
          await watcher.waitForFunction(([key, n]) => (key === 'units' ? window.__device.logic.units[0].marbles.length : window.__device.logic.prizes[0].length) === n, [key, count])
        } finally { await watcher.close(); await screen.close() }
      }
    })

    await check('100 host reloads retain both links and reconnect guests with a new epoch', async () => {
      const play = await host.evaluate(() => window.__obpal.pairingUrl)
      for (let n = 0; n < 100; n++) {
        const epoch = await visitors[0].evaluate(() => window.__presence.shared.receivedEpoch), start = Date.now()
        await host.reload(); await host.waitForFunction(() => window.__device && window.__obpal?.watchFragment)
        assert.equal(await host.evaluate(() => window.__presence.shared.shareUrl()), watchUrl)
        assert.equal(await host.evaluate(() => window.__obpal.pairingUrl), play)
        await visitors[0].waitForFunction(epoch => window.__presence?.shared.status === 'Live' && window.__presence.shared.receivedEpoch !== epoch, epoch, { timeout: 10000 })
        samples.firstFrameMs.push(Date.now() - start); samples.reloads++
      }
      return `${samples.reloads}/100; unchanged QR keys and certificate`
    })

    await check('Share panel centring, contrast, native-share affordance and both capability tabs at 390 px and desktop', async () => {
      for (const width of [1280, 390]) {
        await host.setViewportSize({ width, height: 844 }); await host.evaluate(() => window.__presence.shared.openShare())
        for (const tab of ['Watch', 'Play']) {
          await host.getByRole('tab', { name: tab, exact: true }).click(); await host.evaluate(() => document.fonts.ready); await host.waitForTimeout(120)
          const panel = host.locator('.share-panel'), box = await panel.boundingBox()
          assert(box.x >= 0 && box.x + box.width <= width)
          assert.equal(await panel.locator('.share-qr svg').count(), 1)
          const measured = await host.evaluate(measureButtonInk)
          const controls = measured.filter(r => ['Watch', 'Play', 'Copy link', 'Share link', 'Stop sharing', 'New link', 'Close sharing'].includes(r.name))
          assert(controls.length >= 7, `only ${controls.length} sharing controls measured`)
          assert(controls.every(r => inkError(r) <= .5), JSON.stringify(controls.map(r => ({ name: r.name, error: inkError(r) }))))
          samples.ink.push({ width, tab, measured: controls.length, max: Math.max(0, ...controls.map(inkError)) })
          const contrast = await host.evaluate(() => {
            const luminance = rgb => { const values = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return values[0] * .2126 + values[1] * .7152 + values[2] * .0722 }
            const root = document.querySelector('.share-panel'), bg = getComputedStyle(root).backgroundColor
            return [...root.querySelectorAll('button')].filter(b => !b.disabled && b.checkVisibility()).map(b => { const s = getComputedStyle(b), background = s.backgroundColor === 'rgba(0, 0, 0, 0)' ? bg : s.backgroundColor, a = luminance(s.color), z = luminance(background); return (Math.max(a, z) + .05) / (Math.min(a, z) + .05) })
          })
          assert(contrast.every(r => r >= 4.5), `contrast ${JSON.stringify(contrast)}`)
          if (shots) await host.screenshot({ path: join(shots, `share-${tab.toLowerCase()}-${width}.png`) })
        }
        await host.getByRole('button', { name: 'Close sharing', exact: true }).click()
      }
    })

    await check('Stop sharing closes watchers within two seconds, old admission stays closed and New link rotates only Watch', async () => {
      const play = await host.evaluate(() => window.__obpal.pairingUrl), start = Date.now()
      await host.evaluate(() => window.__obpal.stopSharing('watch'))
      await Promise.all(visitors.map(p => p.waitForFunction(() => window.__presence.shared.status === 'Removed', { timeout: 2000 })))
      samples.revokeMs = Date.now() - start; assert(samples.revokeMs <= 2000)
      await visitors[0].reload(); await visitors[0].waitForFunction(() => window.__presence?.shared.status === 'Removed')
      await host.reload(); await host.waitForFunction(() => window.__obpal?.pairingUrl)
      assert.equal(await host.evaluate(() => window.__obpal.sharingOpen('watch')), false)
      await host.evaluate(() => window.__obpal.newShareLink('watch'))
      assert.notEqual(await host.evaluate(() => window.__presence.shared.shareUrl()), watchUrl)
      assert.equal(await host.evaluate(() => window.__obpal.pairingUrl), play)
      return `${samples.revokeMs} ms`
    })

    await check('Share Play here starts the native keyboard source without a phone claim', async () => {
      const page = await ctx.newPage()
      try {
        await page.goto(`${origin}/sim/drone/?test=vr`)
        await page.waitForFunction(() => window.__device && window.__obpal?.pairingUrl)
        await page.evaluate(() => window.__presence.shared.openShare())
        await page.getByRole('tab', { name: 'Play', exact: true }).click()
        await page.locator('.share-panel').getByRole('button', { name: 'Play here', exact: true }).click()
        await page.waitForFunction(() => document.activeElement === window.__device.stage.renderer.domElement)
        const panel = page.locator('[data-panel="local-control"]')
        await panel.getByRole('button', { name: 'Release local controls', exact: true }).waitFor()
        assert.equal(await page.evaluate(() => window.__obpal.participants.length), 0)
        await page.keyboard.press('Enter'); await page.keyboard.down('Space')
        await page.waitForFunction(() => window.__device.logic.drones[0].y > .25)
        await page.keyboard.up('Space'); await page.keyboard.press('Escape')
        await panel.getByRole('button', { name: 'Enable local controls', exact: true }).waitFor()
        if (shots) await page.screenshot({ path: join(shots, 'play-here-desktop.png') })
        await page.goto(`${origin}/sim/kart/?local=here`)
        await page.waitForFunction(() => window.__device && document.activeElement === window.__device.stage.renderer.domElement)
        await page.locator('[data-panel="local-control"]').getByRole('button', { name: 'Release local controls', exact: true }).waitFor()
      } finally { await page.close() }
    })

    await check('arm, humanoid and arena watchers have no native local input; arena cameras stay independent', async () => {
      for (const sim of ['arm', 'humanoid', 'arena']) {
        const screen = await ctx.newPage(), watcher = await ctx.newPage()
        try {
          await screen.goto(`${origin}/sim/${sim}/?test=vr`)
          await screen.waitForFunction(() => window.__obpal?.watchFragment && window.__presence)
          const url = new URL(await screen.evaluate(() => window.__presence.shared.shareUrl())); url.searchParams.set('test', 'vr')
          await watcher.goto(url.href); await watcher.waitForFunction(() => window.__presence?.shared.status === 'Live')
          assert.equal(await watcher.locator('[data-panel="local-control"], .local-play-entry, .phone-play').count(), 0)
          await watcher.evaluate(() => dispatchEvent(new CustomEvent('obpal:localplay', { detail: 'local' })))
          assert.equal(await watcher.locator('[data-panel="local-control"], .phone-play').count(), 0)
          if (sim === 'arena') {
            const hostCamera = await screen.evaluate(() => window.__presence.state().camera), guestCamera = await watcher.evaluate(() => window.__presence.state().camera)
            await watcher.mouse.move(600, 350); await watcher.mouse.down(); await watcher.mouse.move(760, 410, { steps: 8 }); await watcher.mouse.up()
            assert.notDeepEqual(await watcher.evaluate(() => window.__presence.state().camera), guestCamera)
            assert.deepEqual(await screen.evaluate(() => window.__presence.state().camera), hostCamera)
          }
          if (sim === 'humanoid') {
            const moved = await watcher.evaluate(() => new Promise(resolve => {
              const capture = () => window.__presence.shared.adapter.capture().actors.map(a => a.p)
              const before = capture(), start = performance.now(); let distance = 0
              dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW' }))
              const frame = () => {
                capture().forEach((p, n) => { distance = Math.max(distance, Math.hypot(...p.map((v, i) => v - before[n][i]))) })
                if (performance.now() - start < 250) requestAnimationFrame(frame)
                else { dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW' })); resolve(distance) }
              }
              frame()
            }))
            assert(moved < .001, `watcher keyboard moved humanoid ${moved} m`)
          }
        } finally { await watcher.close(); await screen.close() }
      }
    })

    await check('phone-only on-screen controls drive drone, kart, marble run and simulated arm at 390 px', async () => {
      const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 })
      try {
      for (const sim of ['drone', 'kart', 'marblerun', 'arm']) {
        const page = await phoneContext.newPage()
        await page.goto(`${origin}/sim/${sim}/?test=vr&local=phone`)
        await page.waitForFunction(() => window.__presence && window.__obpal?.participants.some(p => p.caps.platform === 'local-phone'))
        await page.getByRole('toolbar', { name: 'On-screen controls' }).waitFor()
        if (sim === 'marblerun') await page.locator('.phone-play').getByRole('button', { name: 'Run / build', exact: true }).click()
        const before = await page.evaluate(() => window.__presence.shared.adapter.capture())
        const stick = await page.locator('.phone-stick').first().boundingBox()
        await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2); await page.mouse.down(); await page.mouse.move(stick.x + stick.width * .8, stick.y + stick.height * .15, { steps: 4 })
        assert(await page.evaluate(() => { const p = window.__obpal.participants.find(p => p.caps.platform === 'local-phone'); return !!p && window.__obpal.padOf(p.id)?.axes.some(x => Math.abs(x) > .3) }))
        await page.waitForTimeout(650); await page.mouse.up()
        const after = await page.evaluate(() => window.__presence.shared.adapter.capture())
        assert.notDeepEqual(after, before, `${sim} did not respond to on-screen input`)
        if (sim === 'drone') assert(after.drones[0].y > before.drones[0].y + .1, 'drone did not climb')
        if (sim === 'kart') assert(Math.hypot(after.units[0].x - before.units[0].x, after.units[0].z - before.units[0].z) > .1, 'kart did not drive')
        if (sim === 'marblerun') assert(Math.abs(after.units[0].tiltX - before.units[0].tiltX) + Math.abs(after.units[0].tiltZ - before.units[0].tiltZ) > .01, 'marble board did not tilt')
        if (sim === 'arm') assert(after.arms[0].angles.some((angle, n) => Math.abs(angle - before.arms[0].angles[n]) > .01), 'arm joints did not move')
        const camera = await page.evaluate(() => window.__presence.state().camera), touch = await phoneContext.newCDPSession(page)
        await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 130, y: 220, id: 1 }, { x: 220, y: 220, id: 2 }] })
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 95, y: 240, id: 1 }, { x: 270, y: 280, id: 2 }] })
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        assert.notDeepEqual(await page.evaluate(() => window.__presence.state().camera), camera, `${sim} two-finger camera did not move`)
        await touch.detach()
        const box = await page.locator('.phone-play').boundingBox(); assert(box.x >= 0 && box.x + box.width <= 390)
        samples.phone.push(sim)
        if (shots) await page.screenshot({ path: join(shots, `phone-only-${sim}-390.png`) })
        await page.close()
      }
      } finally { await phoneContext.close() }
      return 'Chromium phone layout emulation; no physical hardware'
    })
  } finally {
    if (shots) { await mkdir(shots, { recursive: true }); await writeFile(join(shots, 'share-p1-measurements.json'), JSON.stringify(samples, null, 2)) }
    await ctx.close()
  }
}
